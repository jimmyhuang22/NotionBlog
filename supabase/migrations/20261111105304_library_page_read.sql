-- Optional live SSR library reader. Installation alone does not activate it.
BEGIN;
-- The two calls share a selector fingerprint, not a persistent DB transaction.
-- STABLE ensures all requalification and hydration in the second call use its
-- single statement snapshot. Item-only updates are read fresh in phase two.
CREATE SCHEMA nb_library;
CREATE SCHEMA nb_library_api;
REVOKE ALL ON SCHEMA nb_library,nb_library_api FROM PUBLIC,nb_reader,nb_writer;
GRANT USAGE ON SCHEMA nb_library_api TO nb_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA nb_library,nb_library_api REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

CREATE TABLE nb_library.state (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 migration_digest text CHECK(migration_digest IS NULL OR migration_digest ~ '^[a-f0-9]{64}$')
);
ALTER TABLE nb_library.state ENABLE ROW LEVEL SECURITY;
INSERT INTO nb_library.state VALUES(true,NULL);
REVOKE ALL ON ALL TABLES IN SCHEMA nb_library FROM PUBLIC,nb_reader,nb_writer;

CREATE FUNCTION nb_library.selector(p_item jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT coalesce(jsonb_object_agg(key,value),'{}'::jsonb) FROM jsonb_each(p_item)
 WHERE key=ANY(ARRAY['id','kind','slug','href','title','tags'] || CASE p_item->>'kind'
  WHEN 'movie' THEN ARRAY['status','mediaType','watchedDate']
  WHEN 'book' THEN ARRAY['status','readingDate']
  WHEN 'game' THEN ARRAY['status','platforms','playedDate','lastPlayedDate','firstPlayedDate','archiveDate']
  ELSE ARRAY[]::text[] END)
$$;

CREATE FUNCTION nb_library.view(p_mode text,p_kind text,p_run uuid,p_revision bigint,p_digest text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r nb_v2.runs; s nb_v2.state; records jsonb; identities jsonb; n integer; fingerprint text;
BEGIN
 IF NOT EXISTS(SELECT FROM nb_library.state WHERE singleton AND migration_digest=p_digest AND p_digest ~ '^[a-f0-9]{64}$') THEN RAISE EXCEPTION 'NB_UNAVAILABLE'; END IF;
 IF p_mode IS NULL OR p_mode NOT IN ('qualified','published') OR p_kind IS NULL OR p_kind NOT IN ('movie','book','game') OR ((p_run IS NULL)<>(p_revision IS NULL)) THEN RAISE EXCEPTION 'NB_QUERY_INVALID'; END IF;
 IF NOT nb_read_api.check_capability('68300dd8b4955bd2bbdf7bdf2883617f7da1ec75116111625db25cc378dedde3') OR NOT nb_read_api.check_search_parts('cff660d247ded490f6875f7888b11cb6dff52317bd4982e87fd6e287a1c8e6a7') OR NOT nb_read_api.check_search_walk('e6d3b166401bd2ad88f4be87e9813898e74575beaf2cfcfd1db56f8d4ce3f7c5') THEN RAISE EXCEPTION 'NB_UNAVAILABLE'; END IF;
 IF p_mode='published' AND NOT nb_publication_api.check_capability('6b1b7e2ab295284814330536bb7095972831d3356e63c6b542d1d7b92d9b79bf') THEN RAISE EXCEPTION 'NB_UNAVAILABLE'; END IF;
 r:=nb_read.assert_pin(p_mode,p_run,p_revision);
 SELECT * INTO s FROM nb_v2.state WHERE singleton;
 WITH eligible AS MATERIALIZED (
  SELECT x.id,x.kind,x.source_key,x.course_id,x.parent_id,nb_library.selector(x.item) AS item
  FROM nb_v2.records x WHERE x.run_id=r.id AND x.kind=p_kind AND nb_v2.record_eligible(r.id,x.id)
  ORDER BY x.id COLLATE "C" LIMIT 20001
 ) SELECT count(*),coalesce(jsonb_agg(jsonb_build_object('item',item,'document',NULL) ORDER BY id COLLATE "C"),'[]'::jsonb),
   coalesce(jsonb_agg(jsonb_build_array(id,kind,source_key,course_id,parent_id) ORDER BY id COLLATE "C"),'[]'::jsonb)
 INTO n,records,identities FROM eligible;
 IF n>20000 OR octet_length(records::text)>16777216 THEN RAISE EXCEPTION 'NB_UNAVAILABLE'; END IF;
 -- Canonical jsonb keys and explicit row order make the digest deterministic.
 -- Preserve JSON null versus absent optional fields by selecting existing keys.
 fingerprint:=encode(sha256(convert_to(jsonb_build_array(p_mode,p_kind,r.id,s.revision::text,s.epoch::text,s.config_digest,s.schema_digest,records,identities)::text,'UTF8')),'hex');
 RETURN jsonb_build_object('runId',r.id,'revision',s.revision::text,'schemaDigest',s.schema_digest,
  'records',records,'links','[]'::jsonb,'mediaIds','[]'::jsonb,'hasMore',false,'viewFingerprint',fingerprint);
END $$;

CREATE FUNCTION nb_library_api.read_selectors(p_mode text,p_kind text,p_digest text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT nb_library.view(p_mode,p_kind,NULL,NULL,p_digest)
$$;

CREATE FUNCTION nb_library_api.read_selected(p_mode text,p_kind text,p_slugs text[],p_run uuid,p_revision bigint,p_fingerprint text,p_digest text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE current_view jsonb; records jsonb; n integer; projection jsonb;
BEGIN
 IF p_run IS NULL OR p_revision IS NULL OR p_fingerprint IS NULL OR p_fingerprint !~ '^[a-f0-9]{64}$' OR
  p_slugs IS NULL OR cardinality(p_slugs)>50 OR array_position(p_slugs,NULL) IS NOT NULL OR
  EXISTS(SELECT FROM unnest(p_slugs) v WHERE v !~ '^[a-zA-Z0-9_-]{1,128}$') OR
  (SELECT count(DISTINCT v) FROM unnest(p_slugs) v)<>cardinality(p_slugs) THEN RAISE EXCEPTION 'NB_QUERY_INVALID'; END IF;
 -- Empty selection still revalidates all eligibility, selectors, and the pin.
 current_view:=nb_library.view(p_mode,p_kind,p_run,p_revision,p_digest);
 IF current_view->>'viewFingerprint' IS DISTINCT FROM p_fingerprint THEN RAISE EXCEPTION 'NB_CURSOR_INVALID'; END IF;
 SELECT count(*),coalesce(jsonb_agg(jsonb_build_object('item',x.item,'document',NULL) ORDER BY x.id COLLATE "C"),'[]'::jsonb)
 INTO n,records FROM nb_v2.records x WHERE x.run_id=p_run AND x.kind=p_kind
  AND x.item->>'slug'=ANY(p_slugs) AND nb_v2.record_eligible(p_run,x.id);
 IF n<>cardinality(p_slugs) THEN RAISE EXCEPTION 'NB_CURSOR_INVALID'; END IF;
 IF octet_length(records::text)>16777216 THEN RAISE EXCEPTION 'NB_UNAVAILABLE'; END IF;
 -- Reuse current reference qualification without reading or exporting document.
 projection:=nb_read.project(p_run,records,false);
 RETURN projection || jsonb_build_object('viewFingerprint',current_view->>'viewFingerprint');
END $$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA nb_library,nb_library_api FROM PUBLIC,nb_reader,nb_writer;
GRANT EXECUTE ON FUNCTION nb_library_api.read_selectors(text,text,text),nb_library_api.read_selected(text,text,text[],uuid,bigint,text,text) TO nb_reader;
DO $$ DECLARE role_name text; BEGIN
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF EXISTS(SELECT FROM pg_roles WHERE rolname=role_name) THEN
   EXECUTE format('REVOKE ALL ON SCHEMA nb_library,nb_library_api FROM %I',role_name);
   EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA nb_library FROM %I',role_name);
   EXECUTE format('REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA nb_library,nb_library_api FROM %I',role_name);
  END IF;
 END LOOP;
END $$;

-- The installation owner registers this reviewed file SHA before explicit activation.
COMMIT;
