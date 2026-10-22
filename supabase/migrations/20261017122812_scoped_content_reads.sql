-- Opt-in read projection. Existing qualified/published functions and writer leases stay unchanged.
BEGIN;
CREATE SCHEMA nb_read;
CREATE SCHEMA nb_read_api;
REVOKE ALL ON SCHEMA nb_read,nb_read_api FROM PUBLIC,nb_reader,nb_writer;
GRANT USAGE ON SCHEMA nb_read_api TO nb_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA nb_read REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA nb_read_api REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
CREATE TABLE nb_read.migrations(version integer PRIMARY KEY,digest text);
INSERT INTO nb_read.migrations VALUES(1,NULL);
ALTER TABLE nb_read.migrations ENABLE ROW LEVEL SECURITY;
CREATE INDEX records_read_href ON nb_v2.records(run_id,(item->>'href'));

CREATE FUNCTION nb_read.current_snapshot(p_mode text) RETURNS nb_v2.runs
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r nb_v2.runs;
BEGIN
  IF p_mode='qualified' THEN r:=nb_v2.current_snapshot();
  ELSIF p_mode='published' THEN
    -- Optional publication extension is resolved only when explicitly selected.
    EXECUTE 'SELECT * FROM nb_publication.current_snapshot()' INTO r;
  ELSE RAISE EXCEPTION 'NB_QUERY_INVALID'; END IF;
  RETURN r;
END $$;

CREATE FUNCTION nb_read.assert_pin(p_mode text,p_run uuid,p_revision bigint) RETURNS nb_v2.runs
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r nb_v2.runs; rev bigint;
BEGIN
  r:=nb_read.current_snapshot(p_mode); SELECT revision INTO rev FROM nb_v2.state;
  IF (p_run IS NOT NULL AND p_run<>r.id) OR (p_revision IS NOT NULL AND p_revision<>rev) THEN
    RAISE EXCEPTION 'NB_CURSOR_INVALID'; END IF;
  RETURN r;
END $$;

-- Only the references actually present in this projection are qualified. A media
-- owner is checked once per statement, regardless of the number of its images.
CREATE FUNCTION nb_read.project(p_run uuid,p_records jsonb,p_more boolean DEFAULT false) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  WITH hrefs AS MATERIALIZED (
    SELECT DISTINCT v#>>'{}' AS href FROM jsonb_path_query(p_records,'$.**.href') v
  ), referenced_links AS MATERIALIZED (
    SELECT x.id,x.item->>'href' AS href FROM nb_v2.records x
      JOIN hrefs h ON h.href=x.item->>'href' WHERE x.run_id=p_run
  ), ids AS MATERIALIZED (
    SELECT DISTINCT v#>>'{}' AS id FROM jsonb_path_query(p_records,'$.**.id') v
    WHERE jsonb_typeof(v)='string' AND v#>>'{}' ~ '^a1\.[a-f0-9]{64}$'
  ), referenced_media AS MATERIALIZED (
    SELECT m.asset_id,m.owner_page_id FROM nb_v2.media m JOIN ids ON ids.id=m.asset_id WHERE m.run_id=p_run
  ), owners AS MATERIALIZED (
    SELECT owner_page_id FROM referenced_media GROUP BY owner_page_id
  ), eligible_owners AS MATERIALIZED (
    SELECT owner_page_id FROM owners WHERE nb_v2.record_eligible(p_run,owner_page_id)
  ) SELECT jsonb_build_object('runId',p_run,'revision',s.revision::text,'schemaDigest',s.schema_digest,
    'records',p_records,'hasMore',p_more,
    'links',(SELECT COALESCE(jsonb_agg(h.href),'[]'::jsonb) FROM referenced_links h WHERE nb_v2.record_eligible(p_run,h.id)),
    'mediaIds',(SELECT COALESCE(jsonb_agg(m.asset_id),'[]'::jsonb) FROM referenced_media m JOIN eligible_owners e USING(owner_page_id)))
  FROM nb_v2.state s WHERE singleton
$$;

CREATE FUNCTION nb_read_api.check_capability(p_digest text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT EXISTS(SELECT FROM nb_read.migrations WHERE version=1 AND digest=p_digest AND p_digest ~ '^[a-f0-9]{64}$')
$$;
CREATE FUNCTION nb_read_api.read_version(p_mode text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r nb_v2.runs;
BEGIN
  r:=nb_read.current_snapshot(p_mode);
  RETURN nb_read.project(r.id,'[]'::jsonb);
END $$;

CREATE FUNCTION nb_read_api.read_content(p_mode text,p_kind text,p_slug text,p_course text,p_filters jsonb,
  p_offset integer,p_limit integer,p_run uuid,p_revision bigint,p_document boolean,p_index boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r nb_v2.runs; x record; entry jsonb; items jsonb[]:=ARRAY[]::jsonb[]; used integer:=2; n integer:=0; more boolean:=false;
BEGIN
  r:=nb_read.assert_pin(p_mode,p_run,p_revision);
  IF p_offset IS NULL OR p_limit IS NULL OR p_offset<0 OR p_offset>100000 OR p_limit NOT BETWEEN 1 AND 5000
    OR p_document IS NULL OR p_filters IS NULL OR p_index IS NULL OR (p_index AND p_kind<>'status') THEN RAISE EXCEPTION 'NB_QUERY_INVALID'; END IF;
  FOR x IN WITH selected AS (
    SELECT rec.*,COALESCE(rec.item->'recordedAt'->>'start',rec.item->'date'->>'start')::timestamptz AS occurred
    FROM nb_v2.records rec WHERE rec.run_id=r.id AND rec.kind=p_kind
      AND (p_slug IS NULL OR rec.item->>'slug'=p_slug) AND (p_course IS NULL OR rec.course_id=p_course)
      AND (NOT p_filters?'tag' OR (rec.item->'tags') ? (p_filters->>'tag'))
      AND (NOT p_filters?'semester' OR rec.item->>'semester'=p_filters->>'semester')
      AND nb_v2.record_eligible(r.id,rec.id)
  ) SELECT * FROM selected ORDER BY CASE WHEN p_course IS NOT NULL THEN ordinal END ASC,
      CASE WHEN COALESCE(p_filters->>'order','date-desc')='date-desc' THEN occurred END DESC NULLS LAST,
      CASE WHEN p_filters->>'order'='date-asc' THEN occurred END ASC NULLS LAST,
      item->>'title' COLLATE "C",id LIMIT p_limit+1 OFFSET p_offset LOOP
    n:=n+1; IF n>p_limit THEN more:=true; EXIT; END IF;
    entry:=jsonb_build_object('item',CASE WHEN p_index THEN jsonb_build_object(
      'id',x.item->'id','kind',x.item->'kind','slug',x.item->'slug','href',x.item->'href','title',x.item->'title','tags',x.item->'tags','recordedAt',x.item->'recordedAt') ELSE x.item END,
      'document',CASE WHEN p_document AND NOT p_index THEN x.document ELSE NULL END);
    used:=used+octet_length(entry::text)+CASE WHEN cardinality(items)>0 THEN 2 ELSE 0 END;
    IF used>16777216 THEN RAISE EXCEPTION 'NB_UNAVAILABLE'; END IF;
    items:=array_append(items,entry);
  END LOOP;
  RETURN nb_read.project(r.id,to_jsonb(items),more);
END $$;

CREATE FUNCTION nb_read_api.read_selected(p_mode text,p_kind text,p_slugs text[],p_run uuid,p_revision bigint) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r nb_v2.runs; x record; entry jsonb; items jsonb[]:=ARRAY[]::jsonb[]; used integer:=2;
BEGIN
  r:=nb_read.assert_pin(p_mode,p_run,p_revision);
  IF p_slugs IS NULL OR cardinality(p_slugs)>50 OR array_position(p_slugs,NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'NB_QUERY_INVALID'; END IF;
  FOR x IN SELECT item,document FROM nb_v2.records rec WHERE rec.run_id=r.id AND rec.kind=p_kind AND rec.item->>'slug'=ANY(p_slugs)
      AND nb_v2.record_eligible(r.id,rec.id) ORDER BY rec.id LOOP
    entry:=jsonb_build_object('item',x.item,'document',x.document);
    used:=used+octet_length(entry::text)+CASE WHEN cardinality(items)>0 THEN 2 ELSE 0 END;
    IF used>16777216 THEN RAISE EXCEPTION 'NB_UNAVAILABLE'; END IF;
    items:=array_append(items,entry);
  END LOOP;
  RETURN nb_read.project(r.id,to_jsonb(items));
END $$;

-- p_index excludes every body, including Status. Ordinary read_snapshot retains
-- its original Status/export semantics and its 16 MiB boundary.
CREATE FUNCTION nb_read_api.read_snapshot(p_mode text,p_kinds text[],p_documents boolean,p_index boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r nb_v2.runs; x record; entry jsonb; items jsonb[]:=ARRAY[]::jsonb[]; used integer:=2; n integer:=0;
BEGIN
  r:=nb_read.current_snapshot(p_mode);
  IF p_kinds IS NULL OR cardinality(p_kinds)>10 OR p_documents IS NULL OR p_index IS NULL OR
    EXISTS(SELECT FROM unnest(p_kinds) k WHERE k IS NULL OR k NOT IN
      ('status','course','study-note','post','album','book','movie','game','project','page')) THEN RAISE EXCEPTION 'NB_QUERY_INVALID'; END IF;
  FOR x IN SELECT rec.* FROM nb_v2.records rec WHERE rec.run_id=r.id AND rec.kind=ANY(p_kinds)
      AND nb_v2.record_eligible(r.id,rec.id) ORDER BY rec.id LIMIT 20001 LOOP
    n:=n+1; IF n>20000 THEN RAISE EXCEPTION 'NB_UNAVAILABLE'; END IF;
    entry:=jsonb_build_object('item',CASE WHEN p_index AND x.kind='status'
      THEN x.item || jsonb_build_object('text','[]'::jsonb) ELSE x.item END,'document',
      CASE WHEN NOT p_index AND (p_documents OR x.kind='status') THEN x.document ELSE NULL END);
    used:=used+octet_length(entry::text)+CASE WHEN cardinality(items)>0 THEN 2 ELSE 0 END;
    IF used>16777216 THEN RAISE EXCEPTION 'NB_UNAVAILABLE'; END IF;
    items:=array_append(items,entry);
  END LOOP;
  RETURN nb_read.project(r.id,to_jsonb(items));
END $$;

-- Stream a compact text AST. Recursion follows validated block depth (<=32),
-- without a recursive JSON-path CTE or a cross product of ancestor documents.
-- Runs keep their original reference annotations for application redaction;
-- image captions retain their image so a withdrawn image removes its caption.
CREATE FUNCTION nb_read.search_runs(p_runs jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('text',r->'text') ||
    CASE WHEN r->'link'->>'kind' IN ('internal','unavailable') THEN jsonb_build_object('link',r->'link') ELSE '{}'::jsonb END),'[]')
  FROM jsonb_array_elements(p_runs) r
$$;
CREATE FUNCTION nb_read.search_blocks(p_blocks jsonb,p_depth integer DEFAULT 0) RETURNS SETOF jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE b jsonb; child jsonb; row_value jsonb; cell jsonb;
BEGIN
  IF p_depth>32 OR jsonb_typeof(p_blocks)<>'array' OR jsonb_array_length(p_blocks)>20000 THEN
    RAISE EXCEPTION 'NB_UNAVAILABLE'; END IF;
  FOR b IN SELECT value FROM jsonb_array_elements(p_blocks) LOOP
    IF b->>'type'='image' THEN RETURN NEXT b || jsonb_build_object('caption',nb_read.search_runs(b->'caption')); CONTINUE; END IF;
    IF b?'text' THEN RETURN NEXT jsonb_build_object('id','search-part','type','paragraph','text',nb_read.search_runs(b->'text')); END IF;
    CASE b->>'type'
      WHEN 'code' THEN RETURN NEXT jsonb_build_object('id','search-part','type','paragraph','text',jsonb_build_array(jsonb_build_object('text',b->>'code')));
      WHEN 'equation' THEN RETURN NEXT jsonb_build_object('id','search-part','type','paragraph','text',jsonb_build_array(jsonb_build_object('text',b->>'expression')));
      WHEN 'toggle' THEN
        RETURN NEXT jsonb_build_object('id','search-part','type','paragraph','text',nb_read.search_runs(b->'title'));
        RETURN QUERY SELECT * FROM nb_read.search_blocks(b->'children',p_depth+1);
      WHEN 'callout' THEN RETURN QUERY SELECT * FROM nb_read.search_blocks(b->'children',p_depth+1);
      WHEN 'list' THEN FOR child IN SELECT value FROM jsonb_array_elements(b->'items') LOOP
        RETURN NEXT jsonb_build_object('id','search-part','type','paragraph','text',nb_read.search_runs(child->'text'));
        RETURN QUERY SELECT * FROM nb_read.search_blocks(child->'children',p_depth+1);
      END LOOP;
      WHEN 'columns' THEN FOR child IN SELECT value FROM jsonb_array_elements(b->'columns') LOOP
        RETURN QUERY SELECT * FROM nb_read.search_blocks(child->'blocks',p_depth+1);
      END LOOP;
      WHEN 'table' THEN FOR row_value IN SELECT value FROM jsonb_array_elements(b->'rows') LOOP
        FOR cell IN SELECT value FROM jsonb_array_elements(row_value) LOOP
          RETURN NEXT jsonb_build_object('id','search-part','type','paragraph','text',nb_read.search_runs(cell));
        END LOOP;
      END LOOP;
      WHEN 'bookmark' THEN
        RETURN NEXT jsonb_build_object('id','search-part','type','paragraph','text',jsonb_build_array(
          jsonb_build_object('text',b->>'title'),jsonb_build_object('text',COALESCE(b->>'description',''))));
      ELSE NULL;
    END CASE;
    IF b?'caption' THEN RETURN NEXT jsonb_build_object('id','search-part','type','paragraph','text',nb_read.search_runs(b->'caption')); END IF;
  END LOOP;
END $$;

CREATE FUNCTION nb_read_api.read_search(p_mode text,p_kinds text[]) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r nb_v2.runs; x record; entry jsonb; items jsonb[]:=ARRAY[]::jsonb[]; used integer:=2; n integer:=0;
BEGIN
  r:=nb_read.current_snapshot(p_mode);
  IF p_kinds IS NULL OR cardinality(p_kinds)>10 OR EXISTS(SELECT FROM unnest(p_kinds) k WHERE k IS NULL OR k NOT IN
    ('status','course','study-note','post','album','book','movie','game','project','page')) THEN RAISE EXCEPTION 'NB_QUERY_INVALID'; END IF;
  FOR x IN SELECT rec.* FROM nb_v2.records rec WHERE rec.run_id=r.id AND rec.kind=ANY(p_kinds)
      AND nb_v2.record_eligible(r.id,rec.id) ORDER BY rec.id LIMIT 20001 LOOP
    n:=n+1; IF n>20000 THEN RAISE EXCEPTION 'NB_UNAVAILABLE'; END IF;
    entry:=jsonb_build_object('item',jsonb_build_object('id',x.item->'id','kind',x.item->'kind',
      'slug',x.item->'slug','href',x.item->'href','title',x.item->'title','summary',x.item->'summary','updatedAt',x.item->'updatedAt'),
      'document',CASE WHEN x.document IS NULL THEN NULL ELSE jsonb_build_object('toc','[]'::jsonb,'completeness','complete',
        'blocks',(SELECT COALESCE(jsonb_agg(block),'[]') FROM nb_read.search_blocks(x.document->'blocks') block)) END);
    used:=used+octet_length(entry::text)+CASE WHEN cardinality(items)>0 THEN 2 ELSE 0 END;
    IF used>33554432 THEN RAISE EXCEPTION 'NB_UNAVAILABLE'; END IF;
    items:=array_append(items,entry);
  END LOOP;
  RETURN nb_read.project(r.id,to_jsonb(items));
END $$;

REVOKE ALL ON ALL TABLES IN SCHEMA nb_read FROM PUBLIC,nb_reader,nb_writer;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA nb_read,nb_read_api FROM PUBLIC,nb_reader,nb_writer;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA nb_read_api TO nb_reader;
DO $$ DECLARE role_name text; BEGIN
  FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE ALL ON SCHEMA nb_read,nb_read_api FROM %I',role_name);
    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA nb_read FROM %I',role_name);
    EXECUTE format('REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA nb_read,nb_read_api FROM %I',role_name);
  END LOOP;
END $$;
-- The installation owner records this reviewed file's SHA-256 in migrations.digest.
COMMIT;
