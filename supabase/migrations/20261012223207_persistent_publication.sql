-- Opt-in publication pointer. Qualified v1/v2 functions and their expiry remain unchanged.
BEGIN;
CREATE SCHEMA nb_publication;
CREATE SCHEMA nb_publication_api;
REVOKE ALL ON SCHEMA nb_publication,nb_publication_api FROM PUBLIC;
GRANT USAGE ON SCHEMA nb_publication_api TO nb_reader,nb_writer;
ALTER DEFAULT PRIVILEGES IN SCHEMA nb_publication REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA nb_publication_api REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
CREATE TABLE nb_publication.state (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 version integer NOT NULL DEFAULT 1 CHECK(version=1),
 migration_digest text,
 run_id uuid REFERENCES nb_v2.runs(id),
 published_at timestamptz
);
INSERT INTO nb_publication.state(singleton) VALUES(true);
ALTER TABLE nb_publication.state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON nb_publication.state FROM PUBLIC,nb_reader,nb_writer;

CREATE FUNCTION nb_publication_api.check_capability(p_digest text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM nb_publication.state WHERE singleton AND version=1
  AND migration_digest=p_digest AND p_digest ~ '^[a-f0-9]{64}$')
$$;

-- A writer may explicitly adopt only the current, complete and still qualified publication.
-- Installation never adopts old content, and future qualified runs do not change this pointer.
CREATE FUNCTION nb_publication_api.activate(p_run uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s nb_v2.state; r nb_v2.runs; p nb_publication.state;
BEGIN
 SELECT * INTO s FROM nb_v2.state WHERE singleton FOR UPDATE;
 SELECT * INTO p FROM nb_publication.state WHERE singleton FOR UPDATE;
 SELECT * INTO r FROM nb_v2.runs WHERE id=p_run;
 IF p.version IS DISTINCT FROM 1 OR p.migration_digest IS NULL OR p_run IS NULL
  OR r.status IS DISTINCT FROM 'published'
  OR r.epoch IS DISTINCT FROM s.epoch OR r.config_digest IS DISTINCT FROM s.config_digest
  OR r.finished_at IS NULL
  OR r.record_count IS NULL OR r.media_count IS NULL THEN RAISE EXCEPTION 'NB_PUBLICATION_INVALID'; END IF;
 IF p.run_id IS DISTINCT FROM p_run THEN
  IF s.current_run IS DISTINCT FROM p_run OR r.valid_until<=clock_timestamp() THEN RAISE EXCEPTION 'NB_PUBLICATION_INVALID'; END IF;
  UPDATE nb_publication.state SET run_id=p_run,published_at=clock_timestamp() WHERE singleton;
 END IF;
END $$;

-- Freshness is no longer display eligibility after explicit activation.
-- Current policy epochs, central withdrawal and per-record ownership remain mandatory.
CREATE FUNCTION nb_publication.current_snapshot() RETURNS nb_v2.runs
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s nb_v2.state; p nb_publication.state; r nb_v2.runs;
BEGIN
 SELECT * INTO s FROM nb_v2.state WHERE singleton;
 SELECT * INTO p FROM nb_publication.state WHERE singleton;
 SELECT * INTO r FROM nb_v2.runs WHERE id=p.run_id;
 IF p.version IS DISTINCT FROM 1 OR p.migration_digest IS NULL OR r.id IS NULL
  OR r.status IS DISTINCT FROM 'published' OR r.epoch IS DISTINCT FROM s.epoch
  OR r.config_digest IS DISTINCT FROM s.config_digest THEN RAISE EXCEPTION 'NB_UNAVAILABLE'; END IF;
 RETURN r;
END $$;

CREATE FUNCTION nb_publication_api.read_content(p_kind text,p_slug text,p_course text,p_filters jsonb,
  p_offset integer,p_limit integer,p_run uuid,p_revision bigint,p_document boolean)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,nb_v2,pg_temp AS $$
DECLARE r nb_v2.runs; rev bigint; result jsonb; links jsonb; images jsonb; n integer;
BEGIN
  r:=nb_publication.current_snapshot(); SELECT revision INTO rev FROM nb_v2.state;
  IF (p_run IS NOT NULL AND p_run<>r.id) OR (p_revision IS NOT NULL AND p_revision<>rev) THEN RAISE EXCEPTION 'NB_CURSOR_INVALID'; END IF;
  IF p_offset IS NULL OR p_limit IS NULL OR p_offset<0 OR p_offset>100000 OR p_limit NOT BETWEEN 1 AND 5000 THEN RAISE EXCEPTION 'NB_QUERY_INVALID'; END IF;
  WITH selected AS (
    SELECT x.*,COALESCE(x.item->'recordedAt'->>'start',x.item->'date'->>'start')::timestamptz AS occurred
    FROM nb_v2.records x WHERE x.run_id=r.id AND x.kind=p_kind AND nb_v2.record_eligible(r.id,x.id)
      AND (p_slug IS NULL OR x.item->>'slug'=p_slug) AND (p_course IS NULL OR x.course_id=p_course)
      AND (NOT p_filters?'tag' OR (x.item->'tags') ? (p_filters->>'tag'))
      AND (NOT p_filters?'semester' OR x.item->>'semester'=p_filters->>'semester')
  ), page AS (
    SELECT * FROM selected ORDER BY
      CASE WHEN p_course IS NOT NULL THEN ordinal END ASC,
      CASE WHEN COALESCE(p_filters->>'order','date-desc')='date-desc' THEN occurred END DESC NULLS LAST,
      CASE WHEN p_filters->>'order'='date-asc' THEN occurred END ASC NULLS LAST,
      item->>'title' COLLATE "C",id LIMIT p_limit+1 OFFSET p_offset
  ) SELECT COALESCE(jsonb_agg(jsonb_build_object('item',item,'document',CASE WHEN p_document THEN document ELSE NULL END)), '[]'),count(*)
    INTO result,n FROM page;
  IF n>p_limit THEN result:=result-p_limit; END IF;
  SELECT COALESCE(jsonb_agg(item->>'href'),'[]') INTO links FROM nb_v2.records x WHERE x.run_id=r.id AND nb_v2.record_eligible(r.id,x.id);
  SELECT COALESCE(jsonb_agg(asset_id),'[]') INTO images FROM nb_v2.media m WHERE m.run_id=r.id AND nb_v2.record_eligible(r.id,m.owner_page_id);
  RETURN jsonb_build_object('runId',r.id,'revision',rev::text,'schemaDigest',(SELECT schema_digest FROM nb_v2.state),
    'records',result,'hasMore',n>p_limit,'links',links,'mediaIds',images);
END $$;

CREATE FUNCTION nb_publication_api.read_snapshot(p_kinds text[],p_documents boolean) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,nb_v2,pg_temp AS $$
DECLARE r nb_v2.runs; rev bigint; records jsonb; links jsonb; images jsonb;
BEGIN
  r:=nb_publication.current_snapshot(); SELECT revision INTO rev FROM nb_v2.state;
  IF p_kinds IS NULL OR cardinality(p_kinds)>10 OR p_documents IS NULL OR
    EXISTS(SELECT FROM unnest(p_kinds) k WHERE k IS NULL OR k NOT IN ('status','course','study-note','post','album','book','movie','game','project','page')) THEN RAISE EXCEPTION 'NB_QUERY_INVALID'; END IF;
  IF (SELECT count(*) FROM nb_v2.records x WHERE x.run_id=r.id AND x.kind=ANY(p_kinds) AND nb_v2.record_eligible(r.id,x.id))>20000 THEN RAISE EXCEPTION 'NB_UNAVAILABLE'; END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('item',item,'document',CASE WHEN p_documents OR kind='status' THEN document ELSE NULL END) ORDER BY id),'[]') INTO records
    FROM nb_v2.records x WHERE x.run_id=r.id AND x.kind=ANY(p_kinds) AND nb_v2.record_eligible(r.id,x.id);
  IF octet_length(records::text)>16777216 THEN RAISE EXCEPTION 'NB_UNAVAILABLE'; END IF;
  SELECT COALESCE(jsonb_agg(item->>'href'),'[]') INTO links FROM nb_v2.records x WHERE x.run_id=r.id AND nb_v2.record_eligible(r.id,x.id);
  SELECT COALESCE(jsonb_agg(asset_id),'[]') INTO images FROM nb_v2.media m WHERE m.run_id=r.id AND nb_v2.record_eligible(r.id,m.owner_page_id);
  RETURN jsonb_build_object('runId',r.id,'revision',rev::text,'schemaDigest',(SELECT schema_digest FROM nb_v2.state),'records',records,'links',links,'mediaIds',images);
END $$;

CREATE FUNCTION nb_publication_api.read_media(p_asset text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,nb_v2,pg_temp AS $$
DECLARE r nb_v2.runs; result jsonb;
BEGIN
  r:=nb_publication.current_snapshot();
  SELECT descriptor INTO result FROM nb_v2.media m WHERE run_id=r.id AND asset_id=p_asset AND nb_v2.record_eligible(r.id,owner_page_id);
  RETURN jsonb_build_object('schemaDigest',(SELECT schema_digest FROM nb_v2.state),'media',result);
END $$;

CREATE FUNCTION nb_publication_api.promote_run(p_run uuid,p_fence bigint,p_records integer,p_media integer,p_complete boolean,p_absent integer) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 PERFORM nb_v2_api.promote_run(p_run,p_fence,p_records,p_media,p_complete,p_absent);
 PERFORM nb_publication_api.activate(p_run);
END $$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA nb_publication,nb_publication_api FROM PUBLIC,nb_reader,nb_writer;
-- Supabase installations may have broad owner defaults; strip inherited grants explicitly.
DO $$ DECLARE role_name text; BEGIN
 FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role') LOOP
  EXECUTE format('REVOKE ALL ON SCHEMA nb_publication,nb_publication_api FROM %I',role_name);
  EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA nb_publication FROM %I',role_name);
  EXECUTE format('REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA nb_publication,nb_publication_api FROM %I',role_name);
 END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION nb_publication_api.check_capability(text) TO nb_reader,nb_writer;
GRANT EXECUTE ON FUNCTION nb_publication_api.activate(uuid),nb_publication_api.promote_run(uuid,bigint,integer,integer,boolean,integer) TO nb_writer;
GRANT EXECUTE ON FUNCTION nb_publication_api.read_content(text,text,text,jsonb,integer,integer,uuid,bigint,boolean),
 nb_publication_api.read_snapshot(text[],boolean),nb_publication_api.read_media(text) TO nb_reader;
COMMIT;
