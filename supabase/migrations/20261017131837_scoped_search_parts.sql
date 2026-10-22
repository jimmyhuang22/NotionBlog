-- Search carries strings plus optional target/media guards, without rebuilding a text AST.
BEGIN;
INSERT INTO nb_read.migrations VALUES(2,NULL);

CREATE FUNCTION nb_read.search_part_runs(p_runs jsonb,p_media text DEFAULT NULL) RETURNS SETOF jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT CASE WHEN p_media IS NULL AND r->'link'->>'kind' IS DISTINCT FROM 'internal' THEN r->'text'
    ELSE jsonb_build_array(r->'text',CASE WHEN r->'link'->>'kind'='internal' THEN r->'link'->'href' ELSE NULL END,p_media) END
  FROM jsonb_array_elements(p_runs) r WHERE r->'link'->>'kind' IS DISTINCT FROM 'unavailable'
$$;

CREATE FUNCTION nb_read.search_parts(p_blocks jsonb,p_depth integer DEFAULT 0) RETURNS SETOF jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE b jsonb; child jsonb; row_value jsonb; cell jsonb; media text;
BEGIN
  IF p_depth>32 OR jsonb_typeof(p_blocks)<>'array' OR jsonb_array_length(p_blocks)>20000 THEN RAISE EXCEPTION 'NB_UNAVAILABLE'; END IF;
  FOR b IN SELECT value FROM jsonb_array_elements(p_blocks) LOOP
    IF b->>'type'='image' THEN
      media:=CASE WHEN b->'image'->>'src' LIKE '/media/%' THEN b->'image'->>'id' ELSE NULL END;
      RETURN QUERY SELECT * FROM nb_read.search_part_runs(b->'caption',media); CONTINUE;
    END IF;
    IF b?'text' THEN RETURN QUERY SELECT * FROM nb_read.search_part_runs(b->'text'); END IF;
    CASE b->>'type'
      WHEN 'code' THEN RETURN NEXT b->'code';
      WHEN 'equation' THEN RETURN NEXT b->'expression';
      WHEN 'toggle' THEN
        RETURN QUERY SELECT * FROM nb_read.search_part_runs(b->'title');
        RETURN QUERY SELECT * FROM nb_read.search_parts(b->'children',p_depth+1);
      WHEN 'callout' THEN RETURN QUERY SELECT * FROM nb_read.search_parts(b->'children',p_depth+1);
      WHEN 'list' THEN FOR child IN SELECT value FROM jsonb_array_elements(b->'items') LOOP
        RETURN QUERY SELECT * FROM nb_read.search_part_runs(child->'text');
        RETURN QUERY SELECT * FROM nb_read.search_parts(child->'children',p_depth+1);
      END LOOP;
      WHEN 'columns' THEN FOR child IN SELECT value FROM jsonb_array_elements(b->'columns') LOOP
        RETURN QUERY SELECT * FROM nb_read.search_parts(child->'blocks',p_depth+1);
      END LOOP;
      WHEN 'table' THEN FOR row_value IN SELECT value FROM jsonb_array_elements(b->'rows') LOOP
        FOR cell IN SELECT value FROM jsonb_array_elements(row_value) LOOP
          RETURN QUERY SELECT * FROM nb_read.search_part_runs(cell);
        END LOOP;
      END LOOP;
      WHEN 'bookmark' THEN RETURN NEXT b->'title'; RETURN NEXT to_jsonb(COALESCE(b->>'description',''));
      ELSE NULL;
    END CASE;
    IF b?'caption' THEN RETURN QUERY SELECT * FROM nb_read.search_part_runs(b->'caption'); END IF;
  END LOOP;
END $$;

CREATE FUNCTION nb_read.search_scope(p_run uuid,p_records jsonb,p_hrefs text[],p_ids text[]) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  WITH hrefs AS MATERIALIZED (SELECT DISTINCT unnest(p_hrefs) AS href),
  referenced_links AS MATERIALIZED (
    SELECT x.id,x.item->>'href' AS href FROM nb_v2.records x JOIN hrefs h ON h.href=x.item->>'href' WHERE x.run_id=p_run
  ), ids AS MATERIALIZED (SELECT DISTINCT id FROM unnest(p_ids) id WHERE id ~ '^a1\.[a-f0-9]{64}$'),
  referenced_media AS MATERIALIZED (SELECT m.asset_id,m.owner_page_id FROM nb_v2.media m JOIN ids ON ids.id=m.asset_id WHERE m.run_id=p_run),
  owners AS MATERIALIZED (SELECT DISTINCT owner_page_id FROM referenced_media),
  eligible_owners AS MATERIALIZED (SELECT owner_page_id FROM owners WHERE nb_v2.record_eligible(p_run,owner_page_id))
  SELECT jsonb_build_object('runId',p_run,'revision',s.revision::text,'schemaDigest',s.schema_digest,'records',p_records,
    'links',(SELECT COALESCE(jsonb_agg(h.href),'[]') FROM referenced_links h WHERE nb_v2.record_eligible(p_run,h.id)),
    'mediaIds',(SELECT COALESCE(jsonb_agg(m.asset_id),'[]') FROM referenced_media m JOIN eligible_owners e USING(owner_page_id)))
  FROM nb_v2.state s WHERE singleton
$$;

CREATE FUNCTION nb_read_api.check_search_parts(p_digest text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT EXISTS(SELECT FROM nb_read.migrations WHERE version=2 AND digest=p_digest AND p_digest ~ '^[a-f0-9]{64}$')
$$;

CREATE FUNCTION nb_read_api.read_search_parts(p_mode text,p_kinds text[]) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r nb_v2.runs; x record; entry jsonb; parts jsonb; items jsonb[]:=ARRAY[]::jsonb[];
  hrefs text[]:=ARRAY[]::text[]; ids text[]:=ARRAY[]::text[]; link_ids text[]; media_ids text[]; used integer:=2; n integer:=0;
BEGIN
  r:=nb_read.current_snapshot(p_mode);
  IF p_kinds IS NULL OR cardinality(p_kinds)>10 OR EXISTS(SELECT FROM unnest(p_kinds) k WHERE k IS NULL OR k NOT IN
    ('status','course','study-note','post','album','book','movie','game','project','page')) THEN RAISE EXCEPTION 'NB_QUERY_INVALID'; END IF;
  FOR x IN SELECT rec.* FROM nb_v2.records rec WHERE rec.run_id=r.id AND rec.kind=ANY(p_kinds)
      AND nb_v2.record_eligible(r.id,rec.id) ORDER BY rec.id LIMIT 20001 LOOP
    n:=n+1; IF n>20000 THEN RAISE EXCEPTION 'NB_UNAVAILABLE'; END IF;
    SELECT COALESCE(jsonb_agg(p),'[]') INTO parts FROM nb_read.search_parts(x.document->'blocks') p;
    SELECT array_agg(DISTINCT p->>1) FILTER(WHERE p->>1 IS NOT NULL),array_agg(DISTINCT p->>2) FILTER(WHERE p->>2 IS NOT NULL)
      INTO link_ids,media_ids FROM jsonb_array_elements(parts) p WHERE jsonb_typeof(p)='array';
    hrefs:=array_append(hrefs,x.item->>'href')||COALESCE(link_ids,ARRAY[]::text[]);
    ids:=ids||COALESCE(media_ids,ARRAY[]::text[]);
    entry:=jsonb_build_object('item',jsonb_build_object('id',x.item->'id','kind',x.item->'kind',
      'slug',x.item->'slug','href',x.item->'href','title',x.item->'title','summary',x.item->'summary','updatedAt',x.item->'updatedAt'),
      'document',NULL,'parts',parts);
    used:=used+octet_length(entry::text)+CASE WHEN cardinality(items)>0 THEN 2 ELSE 0 END;
    IF used>33554432 THEN RAISE EXCEPTION 'NB_UNAVAILABLE'; END IF;
    items:=array_append(items,entry);
  END LOOP;
  RETURN nb_read.search_scope(r.id,to_jsonb(items),hrefs,ids);
END $$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA nb_read FROM PUBLIC,nb_reader,nb_writer;
REVOKE EXECUTE ON FUNCTION nb_read_api.check_search_parts(text),nb_read_api.read_search_parts(text,text[]) FROM PUBLIC,nb_writer;
GRANT EXECUTE ON FUNCTION nb_read_api.check_search_parts(text),nb_read_api.read_search_parts(text,text[]) TO nb_reader;
DO $$ DECLARE role_name text; BEGIN
  FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA nb_read FROM %I',role_name);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION nb_read_api.check_search_parts(text),nb_read_api.read_search_parts(text,text[]) FROM %I',role_name);
  END LOOP;
END $$;
-- Register the reviewed second migration SHA in version=2 before enabling this reader.
COMMIT;
