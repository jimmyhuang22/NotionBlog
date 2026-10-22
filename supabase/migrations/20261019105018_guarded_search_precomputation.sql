-- Rebuildable search text only. No trigger, producer change, role or cloud activation.
BEGIN;
CREATE SCHEMA nb_search;
REVOKE ALL ON SCHEMA nb_search FROM PUBLIC,nb_reader,nb_writer;
ALTER DEFAULT PRIVILEGES IN SCHEMA nb_search REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
CREATE TABLE nb_search.state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  migration_digest text CHECK(migration_digest ~ '^[a-f0-9]{64}$'),
  generation_mode text CHECK(generation_mode IN ('staging','qualified','published')),
  generation_run uuid REFERENCES nb_v2.runs(id) ON DELETE SET NULL,
  generation_fence bigint, generation_revision bigint, generation_until timestamptz
);
INSERT INTO nb_search.state(singleton) VALUES(true);
CREATE TABLE nb_search.parts (
  run_id uuid NOT NULL, id text NOT NULL,
  algorithm text NOT NULL,
  document_sha256 bytea NOT NULL CHECK(octet_length(document_sha256)=32),
  parts_sha256 bytea NOT NULL CHECK(octet_length(parts_sha256)=32),
  parts jsonb NOT NULL CHECK(jsonb_typeof(parts)='array' AND jsonb_array_length(parts)<=20000 AND octet_length(parts::text)<=1048576),
  PRIMARY KEY(run_id,id),
  FOREIGN KEY(run_id,id) REFERENCES nb_v2.records(run_id,id) ON DELETE CASCADE
);
ALTER TABLE nb_search.state ENABLE ROW LEVEL SECURITY;
ALTER TABLE nb_search.parts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA nb_search FROM PUBLIC,nb_reader,nb_writer;

-- Freeze the reviewed depth-first extractor in this extension; a future change
-- to nb_read.search_parts must not silently reinterpret stored parts.
CREATE FUNCTION nb_search.extract_parts(p_blocks jsonb,p_depth integer DEFAULT 0) RETURNS SETOF jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE stack jsonb[]:=ARRAY[jsonb_build_array(0,p_depth,NULL,p_blocks)]; top integer:=1;
  frame jsonb; value jsonb; b jsonb; child jsonb; row_value jsonb; run jsonb; media text; depth integer; kind integer; i integer; j integer;
BEGIN
  WHILE top>0 LOOP
    frame:=stack[top]; stack[top]:=NULL; top:=top-1;
    kind:=(frame->>0)::integer; depth:=(frame->>1)::integer; media:=frame->>2; value:=frame->3;
    IF value IS NULL OR value='null'::jsonb THEN CONTINUE; END IF;
    IF kind=0 THEN
      IF depth>32 OR jsonb_typeof(value)<>'array' OR jsonb_array_length(value)>20000 THEN RAISE EXCEPTION 'NB_UNAVAILABLE'; END IF;
      FOR i IN REVERSE jsonb_array_length(value)-1..0 LOOP
        top:=top+1; stack[top]:=jsonb_build_array(1,depth,NULL,value->i);
      END LOOP;
    ELSIF kind=2 THEN
      FOR i IN 0..jsonb_array_length(value)-1 LOOP
        run:=value->i;
        IF run->'link'->>'kind'='unavailable' THEN CONTINUE; END IF;
        IF media IS NULL AND run->'link'->>'kind' IS DISTINCT FROM 'internal' THEN RETURN NEXT run->'text';
        ELSE RETURN NEXT jsonb_build_array(run->'text',CASE WHEN run->'link'->>'kind'='internal' THEN run->'link'->'href' ELSE NULL END,media); END IF;
      END LOOP;
    ELSIF kind=3 THEN RETURN NEXT value;
    ELSE
      b:=value;
      IF b->>'type'='image' THEN
        top:=top+1; stack[top]:=jsonb_build_array(2,depth,CASE WHEN b->'image'->>'src' LIKE '/media/%' THEN b->'image'->>'id' ELSE NULL END,b->'caption');
        CONTINUE;
      END IF;
      -- LIFO tasks are pushed in reverse documentPlainText order.
      IF b?'caption' THEN top:=top+1; stack[top]:=jsonb_build_array(2,depth,NULL,b->'caption'); END IF;
      CASE b->>'type'
        WHEN 'code' THEN top:=top+1; stack[top]:=jsonb_build_array(3,depth,NULL,b->'code');
        WHEN 'equation' THEN top:=top+1; stack[top]:=jsonb_build_array(3,depth,NULL,b->'expression');
        WHEN 'toggle' THEN
          top:=top+1; stack[top]:=jsonb_build_array(0,depth+1,NULL,b->'children');
          top:=top+1; stack[top]:=jsonb_build_array(2,depth,NULL,b->'title');
        WHEN 'callout' THEN top:=top+1; stack[top]:=jsonb_build_array(0,depth+1,NULL,b->'children');
        WHEN 'list' THEN FOR i IN REVERSE jsonb_array_length(b->'items')-1..0 LOOP
          child:=b->'items'->i;
          top:=top+1; stack[top]:=jsonb_build_array(0,depth+1,NULL,child->'children');
          top:=top+1; stack[top]:=jsonb_build_array(2,depth,NULL,child->'text');
        END LOOP;
        WHEN 'columns' THEN FOR i IN REVERSE jsonb_array_length(b->'columns')-1..0 LOOP
          top:=top+1; stack[top]:=jsonb_build_array(0,depth+1,NULL,b->'columns'->i->'blocks');
        END LOOP;
        WHEN 'table' THEN FOR i IN REVERSE jsonb_array_length(b->'rows')-1..0 LOOP
          row_value:=b->'rows'->i;
          FOR j IN REVERSE jsonb_array_length(row_value)-1..0 LOOP
            top:=top+1; stack[top]:=jsonb_build_array(2,depth,NULL,row_value->j);
          END LOOP;
        END LOOP;
        WHEN 'bookmark' THEN
          top:=top+1; stack[top]:=jsonb_build_array(3,depth,NULL,COALESCE(b->>'description',''));
          top:=top+1; stack[top]:=jsonb_build_array(3,depth,NULL,b->'title');
        ELSE NULL;
      END CASE;
      IF b?'text' THEN top:=top+1; stack[top]:=jsonb_build_array(2,depth,NULL,b->'text'); END IF;
    END IF;
  END LOOP;
END $$;

CREATE FUNCTION nb_read_api.check_search_precomputed(p_digest text,p_algorithm text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT EXISTS(SELECT FROM nb_search.state WHERE singleton AND migration_digest=p_digest
    AND p_digest ~ '^[a-f0-9]{64}$' AND p_algorithm='scoped-walk-e6d3b166-v1')
$$;

-- Locks the same authority row as publication/withdrawal. Never extends a lease.
CREATE FUNCTION nb_search.assert_target(p_mode text,p_run uuid,p_fence bigint,p_revision bigint) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE s nb_v2.state; r nb_v2.runs;
BEGIN
  SELECT * INTO s FROM nb_v2.state WHERE singleton FOR UPDATE;
  IF p_run IS NULL OR p_fence IS NULL OR p_revision IS NULL OR p_revision IS DISTINCT FROM s.revision THEN
    RAISE EXCEPTION 'NB_SEARCH_TARGET_INVALID'; END IF;
  IF p_mode='staging' THEN r:=nb_v2.assert_lease(p_run,p_fence);
  ELSIF p_mode IN ('qualified','published') THEN r:=nb_read.current_snapshot(p_mode);
  ELSE RAISE EXCEPTION 'NB_SEARCH_TARGET_INVALID'; END IF;
  IF r.id IS DISTINCT FROM p_run OR r.fence IS DISTINCT FROM p_fence THEN RAISE EXCEPTION 'NB_SEARCH_TARGET_INVALID'; END IF;
END $$;

-- Owner only: authorizes one exact run for at most 15 minutes, not future runs.
CREATE FUNCTION nb_search.configure_generation(p_mode text,p_run uuid,p_fence bigint,p_revision bigint,p_seconds integer) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF p_seconds IS NULL OR p_seconds NOT BETWEEN 1 AND 900 OR
    NOT EXISTS(SELECT FROM nb_search.state WHERE singleton AND migration_digest ~ '^[a-f0-9]{64}$') THEN
    RAISE EXCEPTION 'NB_SEARCH_CONFIGURATION_INVALID'; END IF;
  PERFORM nb_search.assert_target(p_mode,p_run,p_fence,p_revision);
  UPDATE nb_search.state SET generation_mode=p_mode,generation_run=p_run,generation_fence=p_fence,
    generation_revision=p_revision,generation_until=clock_timestamp()+make_interval(secs=>p_seconds) WHERE singleton;
END $$;
CREATE FUNCTION nb_search.disable_generation() RETURNS void
LANGUAGE sql SET search_path=pg_catalog AS $$
  UPDATE nb_search.state SET generation_mode=NULL,generation_run=NULL,generation_fence=NULL,generation_revision=NULL,generation_until=NULL WHERE singleton
$$;

-- Explicit owner transaction only, after staging or against an exact current run.
-- No scheduler/trigger invokes this. Any failure rolls back the whole batch.
CREATE FUNCTION nb_search.generate_batch(p_run uuid,p_fence bigint,p_revision bigint,p_after text,p_limit integer,p_max_bytes integer,p_millis integer) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE cfg nb_search.state; x record; parts jsonb; document_text text; used integer:=0; n integer:=0;
  last_id text:=p_after; started timestamptz:=clock_timestamp();
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 25 OR p_max_bytes IS NULL OR p_max_bytes NOT BETWEEN 1 AND 4194304
    OR p_millis IS NULL OR p_millis NOT BETWEEN 1 AND 1000 OR octet_length(p_after)>1024 THEN RAISE EXCEPTION 'NB_SEARCH_BUDGET_INVALID'; END IF;
  -- Always lock v2 authority before extension state, matching configure_generation.
  PERFORM 1 FROM nb_v2.state WHERE singleton FOR UPDATE;
  SELECT * INTO cfg FROM nb_search.state WHERE singleton FOR UPDATE;
  IF cfg.generation_run IS DISTINCT FROM p_run OR cfg.generation_fence IS DISTINCT FROM p_fence OR
    cfg.generation_revision IS DISTINCT FROM p_revision OR cfg.generation_until IS NULL OR cfg.generation_until<=clock_timestamp() THEN
    RAISE EXCEPTION 'NB_SEARCH_DISABLED'; END IF;
  PERFORM nb_search.assert_target(cfg.generation_mode,p_run,p_fence,p_revision);
  FOR x IN SELECT id,document FROM nb_v2.records WHERE run_id=p_run AND (p_after IS NULL OR id>p_after) ORDER BY id LIMIT p_limit LOOP
    document_text:=COALESCE(x.document,'null'::jsonb)::text;
    IF octet_length(document_text)>1048576 THEN RAISE EXCEPTION 'NB_SEARCH_DOCUMENT_TOO_LARGE'; END IF;
    used:=used+octet_length(document_text);
    IF used>p_max_bytes OR clock_timestamp()>started+make_interval(secs=>p_millis/1000.0) THEN RAISE EXCEPTION 'NB_SEARCH_BUDGET_EXCEEDED'; END IF;
    SELECT COALESCE(jsonb_agg(p),'[]') INTO parts FROM (SELECT p FROM nb_search.extract_parts(x.document->'blocks') p LIMIT 20001) bounded;
    IF jsonb_array_length(parts)>20000 OR octet_length(parts::text)>1048576 OR EXISTS(
      SELECT FROM jsonb_array_elements(parts) p WHERE jsonb_typeof(p) IS DISTINCT FROM 'string' AND
      (jsonb_typeof(p) IS DISTINCT FROM 'array' OR jsonb_array_length(p)<>3 OR jsonb_typeof(p->0) IS DISTINCT FROM 'string'
       OR jsonb_typeof(p->1) NOT IN ('string','null') OR jsonb_typeof(p->2) NOT IN ('string','null'))) THEN
      RAISE EXCEPTION 'NB_SEARCH_PARTS_INVALID'; END IF;
    used:=used+octet_length(parts::text);
    IF used>p_max_bytes OR clock_timestamp()>started+make_interval(secs=>p_millis/1000.0) THEN RAISE EXCEPTION 'NB_SEARCH_BUDGET_EXCEEDED'; END IF;
    INSERT INTO nb_search.parts VALUES(p_run,x.id,'scoped-walk-e6d3b166-v1',sha256(convert_to(document_text,'UTF8')),sha256(convert_to(parts::text,'UTF8')),parts)
      ON CONFLICT(run_id,id) DO UPDATE SET algorithm=EXCLUDED.algorithm,document_sha256=EXCLUDED.document_sha256,parts_sha256=EXCLUDED.parts_sha256,parts=EXCLUDED.parts;
    n:=n+1; last_id:=x.id;
  END LOOP;
  -- Recheck expiry and staging lease after all extraction, before committing.
  IF clock_timestamp()>=cfg.generation_until THEN RAISE EXCEPTION 'NB_SEARCH_DISABLED'; END IF;
  PERFORM nb_search.assert_target(cfg.generation_mode,p_run,p_fence,p_revision);
  RETURN jsonb_build_object('count',n,'lastId',last_id,'bytes',used);
END $$;

CREATE FUNCTION nb_read_api.read_search_precomputed(p_mode text,p_kinds text[]) RETURNS jsonb
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
    SELECT c.parts INTO parts FROM nb_search.parts c WHERE c.run_id=r.id AND c.id=x.id
      AND c.algorithm='scoped-walk-e6d3b166-v1'
      AND c.document_sha256=sha256(convert_to(COALESCE(x.document,'null'::jsonb)::text,'UTF8'))
      AND c.parts_sha256=sha256(convert_to(c.parts::text,'UTF8'));
    IF NOT FOUND THEN
      SELECT COALESCE(jsonb_agg(p),'[]') INTO parts FROM nb_search.extract_parts(x.document->'blocks') p;
    END IF;
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

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA nb_search FROM PUBLIC,nb_reader,nb_writer;
REVOKE EXECUTE ON FUNCTION nb_read_api.check_search_precomputed(text,text),nb_read_api.read_search_precomputed(text,text[]) FROM PUBLIC,nb_writer;
GRANT EXECUTE ON FUNCTION nb_read_api.check_search_precomputed(text,text),nb_read_api.read_search_precomputed(text,text[]) TO nb_reader;
DO $$ DECLARE role_name text; BEGIN
  FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE ALL ON SCHEMA nb_search FROM %I',role_name);
    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA nb_search FROM %I',role_name);
    EXECUTE format('REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA nb_search FROM %I',role_name);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION nb_read_api.check_search_precomputed(text,text),nb_read_api.read_search_precomputed(text,text[]) FROM %I',role_name);
  END LOOP;
END $$;
-- After reviewing the exact SQL, the migration owner registers its SHA-256 in
-- nb_search.state.migration_digest. Generation and application opt-in stay off.
COMMIT;
