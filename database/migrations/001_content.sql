-- Apply once, with a migration owner. No credentials or LOGIN roles are created.
BEGIN;
CREATE SCHEMA nb;
CREATE SCHEMA nb_api;
REVOKE ALL ON SCHEMA nb, nb_api FROM PUBLIC;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='nb_reader') THEN CREATE ROLE nb_reader NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='nb_writer') THEN CREATE ROLE nb_writer NOLOGIN; END IF;
  IF EXISTS(SELECT FROM pg_roles WHERE rolname IN ('nb_reader','nb_writer') AND
      (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) OR
    EXISTS(SELECT FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname IN ('nb_reader','nb_writer')) THEN
    RAISE EXCEPTION 'NB_ROLE_CONFIGURATION_INVALID'; END IF;
END $$;
GRANT USAGE ON SCHEMA nb_api TO nb_reader, nb_writer;
ALTER DEFAULT PRIVILEGES IN SCHEMA nb REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA nb_api REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

CREATE TABLE nb.state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  protocol text NOT NULL DEFAULT 'notionblog-sync-v1',
  schema_digest text,
  revision bigint NOT NULL DEFAULT 0,
  epoch bigint NOT NULL DEFAULT 0,
  config_digest text,
  freshness_seconds integer NOT NULL DEFAULT 0,
  current_run uuid,
  lease_run uuid,
  fence bigint NOT NULL DEFAULT 0,
  lease_until timestamptz
);
INSERT INTO nb.state(singleton) VALUES(true);
CREATE TABLE nb.migrations(version text PRIMARY KEY,digest text,applied_at timestamptz NOT NULL DEFAULT clock_timestamp());
INSERT INTO nb.migrations(version) VALUES('001');
CREATE TABLE nb.sources (
  key text PRIMARY KEY, kind text NOT NULL CHECK(kind IN ('status','course','study-note')),
  mode text NOT NULL CHECK(mode IN ('all','allowlist') AND (mode<>'all' OR kind='status')),
  data_source_id text, database_parent_id text,
  CHECK(data_source_id IS NOT NULL AND (kind<>'study-note' OR database_parent_id IS NOT NULL)),
  CHECK(kind<>'status' OR mode='all')
);
CREATE TABLE nb.permits (
  id text PRIMARY KEY, kind text NOT NULL CHECK(kind IN ('course','study-note')),
  source_key text NOT NULL REFERENCES nb.sources(key), course_id text, parent_id text,
  CHECK((kind='course' AND course_id IS NULL AND parent_id IS NULL) OR
        (kind='study-note' AND course_id IS NOT NULL AND parent_id IS NOT NULL))
);
CREATE TABLE nb.denied (id text PRIMARY KEY);
CREATE TABLE nb.runs (
  id uuid PRIMARY KEY, fence bigint NOT NULL, revision bigint NOT NULL, epoch bigint NOT NULL,
  config_digest text NOT NULL, started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz, valid_until timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'staging' CHECK(status IN ('staging','published','failed')),
  record_count integer, media_count integer
);
CREATE TABLE nb.records (
  run_id uuid NOT NULL REFERENCES nb.runs(id), id text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('status','course','study-note')),
  source_key text NOT NULL, course_id text, parent_id text, ordinal integer NOT NULL,
  item jsonb NOT NULL, document jsonb,
  PRIMARY KEY(run_id,id)
);
CREATE UNIQUE INDEX records_slug ON nb.records(run_id,kind,(item->>'slug'));
CREATE INDEX records_course ON nb.records(run_id,course_id,parent_id,ordinal);
CREATE TABLE nb.media (
  run_id uuid NOT NULL REFERENCES nb.runs(id), asset_id text NOT NULL,
  owner_page_id text NOT NULL, descriptor jsonb NOT NULL,
  PRIMARY KEY(run_id,asset_id),
  FOREIGN KEY(run_id,owner_page_id) REFERENCES nb.records(run_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE nb.tombstones (
  run_id uuid NOT NULL REFERENCES nb.runs(id),id text NOT NULL,
  reason text NOT NULL CHECK(reason IN ('archived','deleted','out-of-scope')),
  PRIMARY KEY(run_id,id)
);
-- Defense in depth: direct table access is forbidden, including Supabase API roles.
ALTER TABLE nb.state ENABLE ROW LEVEL SECURITY;
ALTER TABLE nb.sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE nb.permits ENABLE ROW LEVEL SECURITY;
ALTER TABLE nb.denied ENABLE ROW LEVEL SECURITY;
ALTER TABLE nb.runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE nb.records ENABLE ROW LEVEL SECURITY;
ALTER TABLE nb.media ENABLE ROW LEVEL SECURITY;
ALTER TABLE nb.tombstones ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA nb FROM PUBLIC, nb_reader, nb_writer;

-- Migration owner only. A policy edit invalidates old snapshots until a full resync.
CREATE FUNCTION nb_api.configure_policy(p_digest text,p_freshness integer,p_sources jsonb,p_permits jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,nb,pg_temp AS $$
BEGIN
  IF p_digest IS NULL OR p_digest !~ '^[a-f0-9]{64}$' OR p_freshness IS NULL OR p_freshness NOT BETWEEN 1 AND 86400
    OR jsonb_typeof(p_sources) IS DISTINCT FROM 'array' OR jsonb_typeof(p_permits) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'NB_POLICY_INVALID'; END IF;
  PERFORM 1 FROM nb.state FOR UPDATE;
  DELETE FROM nb.permits; DELETE FROM nb.sources;
  INSERT INTO nb.sources SELECT x->>'key',x->>'kind',x->>'mode',x->>'dataSourceId',x->>'databaseParentId'
    FROM jsonb_array_elements(p_sources) x;
  INSERT INTO nb.permits SELECT x->>'id',x->>'kind',x->>'sourceKey',x->>'courseId',x->>'parentId'
    FROM jsonb_array_elements(p_permits) x;
  IF EXISTS (SELECT FROM nb.permits p JOIN nb.sources s ON s.key=p.source_key WHERE s.kind<>p.kind
      OR (p.kind='study-note' AND s.database_parent_id<>p.course_id))
    OR EXISTS (SELECT FROM nb.permits p WHERE p.kind='study-note' AND
      (NOT EXISTS(SELECT FROM nb.permits c WHERE c.id=p.course_id AND c.kind='course') OR
       NOT EXISTS(SELECT FROM nb.permits q WHERE q.id=p.parent_id AND
          (q.id=p.course_id OR (q.kind='study-note' AND q.course_id=p.course_id AND q.source_key=p.source_key))))) THEN
    RAISE EXCEPTION 'NB_POLICY_PARENT_INVALID'; END IF;
  -- Every note must reach its selected course; reject cycles and disconnected ancestry.
  IF EXISTS (WITH RECURSIVE reachable AS (
      SELECT id FROM nb.permits WHERE kind='course'
      UNION SELECT p.id FROM nb.permits p JOIN reachable r ON p.parent_id=r.id
    ) SELECT FROM nb.permits p WHERE NOT EXISTS(SELECT FROM reachable r WHERE r.id=p.id)) THEN
    RAISE EXCEPTION 'NB_POLICY_CYCLE'; END IF;
  UPDATE nb.runs SET status='failed',finished_at=clock_timestamp() WHERE id=(SELECT lease_run FROM nb.state) AND status='staging';
  UPDATE nb.state SET config_digest=p_digest,freshness_seconds=p_freshness,epoch=epoch+1,revision=revision+1,lease_run=NULL,lease_until=NULL;
END $$;
CREATE FUNCTION nb_api.set_denied(p_id text,p_denied boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,nb,pg_temp AS $$
BEGIN
  PERFORM 1 FROM nb.state FOR UPDATE;
  IF p_denied THEN INSERT INTO nb.denied VALUES(p_id) ON CONFLICT DO NOTHING;
  ELSE DELETE FROM nb.denied WHERE id=p_id; END IF;
  UPDATE nb.runs SET status='failed',finished_at=clock_timestamp() WHERE id=(SELECT lease_run FROM nb.state) AND status='staging';
  UPDATE nb.state SET revision=revision+1,lease_run=NULL,lease_until=NULL;
END $$;

CREATE FUNCTION nb.assert_lease(p_run uuid,p_fence bigint) RETURNS nb.runs
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,nb,pg_temp AS $$
DECLARE s nb.state; r nb.runs;
BEGIN
  SELECT * INTO s FROM nb.state FOR UPDATE;
  SELECT * INTO r FROM nb.runs WHERE id=p_run;
  IF p_fence IS NULL OR r.id IS NULL OR r.status<>'staging' OR s.lease_run IS DISTINCT FROM p_run OR
      s.fence<>p_fence OR r.fence<>p_fence OR s.lease_until IS NULL OR s.lease_until<=clock_timestamp() OR
      r.revision<>s.revision OR r.epoch<>s.epoch OR r.valid_until<=clock_timestamp() THEN
    RAISE EXCEPTION 'NB_LEASE_INVALID'; END IF;
  RETURN r;
END $$;
CREATE FUNCTION nb_api.begin_run(p_run uuid,p_protocol text,p_schema text,p_digest text,p_seconds integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,nb,pg_temp AS $$
DECLARE s nb.state; r nb.runs;
BEGIN
  SELECT * INTO s FROM nb.state FOR UPDATE;
  IF p_protocol IS DISTINCT FROM s.protocol OR p_schema IS NULL OR p_schema IS DISTINCT FROM s.schema_digest OR p_digest IS DISTINCT FROM s.config_digest OR
     s.freshness_seconds=0 OR p_run IS NULL OR p_seconds IS NULL OR p_seconds NOT BETWEEN 1 AND 900 THEN RAISE EXCEPTION 'NB_HANDSHAKE_INVALID'; END IF;
  IF s.lease_run=p_run AND s.lease_until>clock_timestamp() THEN
    r:=nb.assert_lease(p_run,s.fence);
  ELSE
    IF s.lease_until>clock_timestamp() THEN RAISE EXCEPTION 'NB_BUSY'; END IF;
    UPDATE nb.runs SET status='failed',finished_at=clock_timestamp() WHERE id=s.lease_run AND status='staging';
    UPDATE nb.state SET fence=fence+1,lease_run=p_run,lease_until=clock_timestamp()+make_interval(secs=>p_seconds)
      RETURNING * INTO s;
    INSERT INTO nb.runs(id,fence,revision,epoch,config_digest,valid_until)
      VALUES(p_run,s.fence,s.revision,s.epoch,p_digest,clock_timestamp()+make_interval(secs=>s.freshness_seconds))
      RETURNING * INTO r;
  END IF;
  RETURN jsonb_build_object('runId',p_run,'fence',s.fence::text,'revision',s.revision::text,'configDigest',p_digest,
    'deniedPageIds',(SELECT COALESCE(jsonb_agg(id),'[]') FROM nb.denied));
END $$;
CREATE FUNCTION nb_api.renew_run(p_run uuid,p_fence bigint,p_seconds integer) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,nb,pg_temp AS $$
BEGIN
  PERFORM nb.assert_lease(p_run,p_fence);
  IF p_seconds IS NULL OR p_seconds NOT BETWEEN 1 AND 900 THEN RAISE EXCEPTION 'NB_LEASE_INVALID'; END IF;
  UPDATE nb.state SET lease_until=clock_timestamp()+make_interval(secs=>p_seconds);
END $$;

CREATE FUNCTION nb.record_eligible(p_run uuid,p_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,nb,pg_temp AS $$
  WITH RECURSIVE chain AS (
    SELECT r.id,r.parent_id,ARRAY[r.id] AS path FROM nb.records r WHERE r.run_id=p_run AND r.id=p_id
    UNION ALL SELECT r.id,r.parent_id,c.path||r.id FROM nb.records r JOIN chain c ON r.id=c.parent_id
      WHERE r.run_id=p_run AND NOT r.id=ANY(c.path)
  ) SELECT EXISTS(SELECT FROM chain) AND
    NOT EXISTS(SELECT FROM chain c JOIN nb.denied d ON d.id=c.id) AND
    EXISTS(SELECT FROM chain WHERE parent_id IS NULL)
$$;
CREATE FUNCTION nb.permit_eligible(p_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,nb,pg_temp AS $$
  WITH RECURSIVE chain AS (
    SELECT p.id,p.parent_id,ARRAY[p.id] AS path FROM nb.permits p WHERE p.id=p_id
    UNION ALL SELECT p.id,p.parent_id,c.path||p.id FROM nb.permits p JOIN chain c ON p.id=c.parent_id
      WHERE NOT p.id=ANY(c.path)
  ) SELECT EXISTS(SELECT FROM chain) AND
    NOT EXISTS(SELECT FROM chain c JOIN nb.denied d ON d.id=c.id) AND
    EXISTS(SELECT FROM chain WHERE parent_id IS NULL)
$$;
CREATE FUNCTION nb.confirmed_absent(p_run uuid,p_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,nb,pg_temp AS $$
  WITH RECURSIVE chain AS (
    SELECT p.id,p.parent_id,ARRAY[p.id] AS path FROM nb.permits p WHERE p.id=p_id
    UNION ALL SELECT p.id,p.parent_id,c.path||p.id FROM nb.permits p JOIN chain c ON p.id=c.parent_id
      WHERE NOT p.id=ANY(c.path)
  ) SELECT EXISTS(SELECT FROM chain c JOIN nb.tombstones t ON t.id=c.id WHERE t.run_id=p_run)
$$;
CREATE FUNCTION nb_api.stage_batch(p_run uuid,p_fence bigint,p_records jsonb,p_media jsonb,p_absences jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,nb,pg_temp AS $$
DECLARE x jsonb; i jsonb; e jsonb; s nb.sources; p nb.permits;
BEGIN
  PERFORM nb.assert_lease(p_run,p_fence);
  IF jsonb_typeof(p_records) IS DISTINCT FROM 'array' OR jsonb_typeof(p_media) IS DISTINCT FROM 'array' OR jsonb_typeof(p_absences) IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_records)>100 OR jsonb_array_length(p_media)>100 OR jsonb_array_length(p_absences)>100 THEN RAISE EXCEPTION 'NB_BATCH_TOO_LARGE'; END IF;
  FOR x IN SELECT value FROM jsonb_array_elements(p_records) LOOP
    i:=x->'detail'->'item'; e:=x->'evidence';
    SELECT * INTO s FROM nb.sources WHERE key=e->>'sourceKey';
    SELECT * INTO p FROM nb.permits WHERE id=i->>'id';
    IF s.key IS NULL OR i->>'kind' IS DISTINCT FROM s.kind OR
      e->>'dataSourceId' IS DISTINCT FROM s.data_source_id OR
      e->>'databaseParentId' IS DISTINCT FROM s.database_parent_id OR
      (i->>'kind'='status' AND (s.mode<>'all' OR e->>'parentId' IS NOT NULL OR e->>'courseId' IS NOT NULL)) OR
      (i->>'kind'<>'status' AND (p.id IS NULL OR p.source_key<>s.key OR p.kind IS DISTINCT FROM i->>'kind' OR
        p.parent_id IS DISTINCT FROM e->>'parentId' OR p.course_id IS DISTINCT FROM e->>'courseId')) OR
      (i->>'kind'='study-note' AND (i->>'courseId' IS DISTINCT FROM p.course_id OR i->>'parentId' IS DISTINCT FROM
        CASE WHEN p.parent_id=p.course_id THEN NULL ELSE p.parent_id END)) THEN
      RAISE EXCEPTION 'NB_SCOPE_INVALID'; END IF;
    IF EXISTS(SELECT FROM nb.denied WHERE id=i->>'id') THEN RAISE EXCEPTION 'NB_SCOPE_DENIED'; END IF;
    INSERT INTO nb.records VALUES(p_run,i->>'id',i->>'kind',s.key,p.course_id,p.parent_id,(e->>'ordinal')::integer,i,
      NULLIF(x->'detail'->'document','null'::jsonb))
    ON CONFLICT(run_id,id) DO UPDATE SET kind=EXCLUDED.kind,source_key=EXCLUDED.source_key,
      course_id=EXCLUDED.course_id,parent_id=EXCLUDED.parent_id,ordinal=EXCLUDED.ordinal,item=EXCLUDED.item,document=EXCLUDED.document;
  END LOOP;
  FOR x IN SELECT value FROM jsonb_array_elements(p_media) LOOP
    IF x->>'assetId' !~ '^a1\.[a-f0-9]{64}$' OR x->>'objectKey' !~ '^sha256/[a-f0-9]{64}$' OR
      x->>'objectKey'<>'sha256/'||(x->>'sha256') OR (x->>'byteSize')::bigint NOT BETWEEN 1 AND 20971520 OR
      x->>'mime' NOT IN ('image/jpeg','image/png','image/webp','image/gif','image/avif') THEN RAISE EXCEPTION 'NB_MEDIA_INVALID'; END IF;
    IF NOT EXISTS(SELECT FROM nb.records WHERE run_id=p_run AND id=x->>'ownerPageId') THEN RAISE EXCEPTION 'NB_MEDIA_OWNER_INVALID'; END IF;
    INSERT INTO nb.media VALUES(p_run,x->>'assetId',x->>'ownerPageId',x)
      ON CONFLICT(run_id,asset_id) DO UPDATE SET owner_page_id=EXCLUDED.owner_page_id,descriptor=EXCLUDED.descriptor;
  END LOOP;
  FOR x IN SELECT value FROM jsonb_array_elements(p_absences) LOOP
    IF NOT EXISTS(SELECT FROM nb.permits WHERE id=x->>'id') OR x->>'reason' IS NULL OR
      x->>'reason' NOT IN ('archived','deleted','out-of-scope') THEN RAISE EXCEPTION 'NB_ABSENCE_INVALID'; END IF;
    INSERT INTO nb.tombstones VALUES(p_run,x->>'id',x->>'reason')
      ON CONFLICT(run_id,id) DO UPDATE SET reason=EXCLUDED.reason;
  END LOOP;
END $$;
CREATE FUNCTION nb_api.promote_run(p_run uuid,p_fence bigint,p_records integer,p_media integer,p_complete boolean,p_absent integer) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,nb,pg_temp AS $$
BEGIN
  -- A lost success response can be retried without publishing a second generation.
  IF EXISTS(SELECT FROM nb.runs r JOIN nb.state s ON s.current_run=r.id WHERE r.id=p_run AND r.fence=p_fence
    AND r.status='published' AND r.record_count=p_records AND r.media_count=p_media AND p_complete
    AND p_absent=(SELECT count(*) FROM nb.tombstones WHERE run_id=p_run)) THEN RETURN; END IF;
  PERFORM nb.assert_lease(p_run,p_fence);
  IF p_complete IS DISTINCT FROM true OR p_records IS NULL OR p_media IS NULL OR p_absent IS NULL OR p_records<0 OR p_media<0 OR p_absent<0
    OR p_absent<>(SELECT count(*) FROM nb.tombstones WHERE run_id=p_run) OR p_records<>(SELECT count(*) FROM nb.records WHERE run_id=p_run) OR
    p_media<>(SELECT count(*) FROM nb.media WHERE run_id=p_run) THEN RAISE EXCEPTION 'NB_INCOMPLETE'; END IF;
  IF EXISTS(SELECT FROM nb.records r WHERE r.run_id=p_run AND (NOT nb.record_eligible(p_run,r.id) OR nb.confirmed_absent(p_run,r.id))) OR
    EXISTS(SELECT FROM nb.permits p WHERE nb.permit_eligible(p.id) AND NOT nb.confirmed_absent(p_run,p.id)
      AND NOT EXISTS(SELECT FROM nb.records r WHERE r.run_id=p_run AND r.id=p.id)) THEN
    RAISE EXCEPTION 'NB_INCOMPLETE_SCOPE'; END IF;
  IF EXISTS(SELECT FROM nb.records WHERE run_id=p_run AND document IS NULL) THEN RAISE EXCEPTION 'NB_BODY_MISSING'; END IF;
  IF EXISTS(SELECT FROM nb.records r CROSS JOIN LATERAL jsonb_path_query(
    jsonb_build_array(r.item,r.document),'$.** ? (@.src != null && @.id != null)') img
    WHERE r.run_id=p_run AND NOT EXISTS(SELECT FROM nb.media m WHERE m.run_id=p_run
      AND m.owner_page_id=r.id AND m.asset_id=img->>'id' AND img->>'src'='/media/'||m.asset_id)) THEN
    RAISE EXCEPTION 'NB_MEDIA_MISSING'; END IF;
  UPDATE nb.runs SET status='published',finished_at=clock_timestamp(),record_count=p_records,media_count=p_media WHERE id=p_run;
  UPDATE nb.state SET current_run=p_run,lease_run=NULL,lease_until=NULL;
END $$;
CREATE FUNCTION nb_api.fail_run(p_run uuid,p_fence bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,nb,pg_temp AS $$
BEGIN
  PERFORM 1 FROM nb.state FOR UPDATE;
  UPDATE nb.runs SET status='failed',finished_at=clock_timestamp() WHERE id=p_run AND fence=p_fence AND status='staging';
  UPDATE nb.state SET lease_run=NULL,lease_until=NULL WHERE lease_run=p_run AND fence=p_fence;
END $$;

CREATE FUNCTION nb.current_snapshot() RETURNS nb.runs
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,nb,pg_temp AS $$
DECLARE r nb.runs; s nb.state;
BEGIN
  SELECT * INTO s FROM nb.state;
  SELECT * INTO r FROM nb.runs WHERE id=s.current_run;
  IF r.id IS NULL OR r.status<>'published' OR r.epoch<>s.epoch OR r.valid_until<=statement_timestamp() THEN
    RAISE EXCEPTION 'NB_UNAVAILABLE'; END IF;
  RETURN r;
END $$;
CREATE FUNCTION nb_api.read_content(p_kind text,p_slug text,p_course text,p_filters jsonb,
  p_offset integer,p_limit integer,p_run uuid,p_revision bigint,p_document boolean)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,nb,pg_temp AS $$
DECLARE r nb.runs; rev bigint; result jsonb; links jsonb; images jsonb; n integer;
BEGIN
  r:=nb.current_snapshot(); SELECT revision INTO rev FROM nb.state;
  IF (p_run IS NOT NULL AND p_run<>r.id) OR (p_revision IS NOT NULL AND p_revision<>rev) THEN RAISE EXCEPTION 'NB_CURSOR_INVALID'; END IF;
  IF p_offset IS NULL OR p_limit IS NULL OR p_offset<0 OR p_offset>100000 OR p_limit NOT BETWEEN 1 AND 5000 THEN RAISE EXCEPTION 'NB_QUERY_INVALID'; END IF;
  WITH selected AS (
    SELECT x.*,COALESCE(x.item->'recordedAt'->>'start',x.item->'date'->>'start')::timestamptz AS occurred
    FROM nb.records x WHERE x.run_id=r.id AND x.kind=p_kind AND nb.record_eligible(r.id,x.id)
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
  SELECT COALESCE(jsonb_agg(item->>'href'),'[]') INTO links FROM nb.records x WHERE x.run_id=r.id AND nb.record_eligible(r.id,x.id);
  SELECT COALESCE(jsonb_agg(asset_id),'[]') INTO images FROM nb.media m WHERE m.run_id=r.id AND nb.record_eligible(r.id,m.owner_page_id);
  RETURN jsonb_build_object('runId',r.id,'revision',rev::text,'schemaDigest',(SELECT schema_digest FROM nb.state),
    'records',result,'hasMore',n>p_limit,'links',links,'mediaIds',images);
END $$;
CREATE FUNCTION nb_api.read_media(p_asset text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,nb,pg_temp AS $$
DECLARE r nb.runs; result jsonb;
BEGIN
  r:=nb.current_snapshot();
  SELECT descriptor INTO result FROM nb.media m WHERE run_id=r.id AND asset_id=p_asset AND nb.record_eligible(r.id,owner_page_id);
  RETURN jsonb_build_object('schemaDigest',(SELECT schema_digest FROM nb.state),'media',result);
END $$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA nb,nb_api FROM PUBLIC,nb_reader,nb_writer;
DO $$ DECLARE r text; BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS(SELECT FROM pg_roles WHERE rolname=r) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA nb,nb_api FROM %I',r);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA nb FROM %I',r);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA nb,nb_api FROM %I',r);
    END IF;
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION nb_api.begin_run(uuid,text,text,text,integer),nb_api.renew_run(uuid,bigint,integer),
  nb_api.stage_batch(uuid,bigint,jsonb,jsonb,jsonb),nb_api.promote_run(uuid,bigint,integer,integer,boolean,integer),nb_api.fail_run(uuid,bigint) TO nb_writer;
GRANT EXECUTE ON FUNCTION nb_api.read_content(text,text,text,jsonb,integer,integer,uuid,bigint,boolean),nb_api.read_media(text) TO nb_reader;
COMMIT;
