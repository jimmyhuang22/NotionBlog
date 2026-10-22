-- Independent private social projection. Does not alter any content/website protocol.
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='social_sync') OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname='nb_social_worker') THEN
    RAISE EXCEPTION 'NB_SOCIAL_ALREADY_EXISTS';
  END IF;
END $$;
CREATE ROLE nb_social_worker NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2;
CREATE SCHEMA social_sync;
REVOKE ALL ON SCHEMA social_sync FROM PUBLIC,anon,authenticated,service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA social_sync REVOKE ALL ON TABLES FROM PUBLIC,anon,authenticated,service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA social_sync REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION social_sync.publication_key(platform text, account_id text, publication_id text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
  SELECT encode(sha256(convert_to('["'||platform||'","'||account_id||'","'||publication_id||'"]','UTF8')),'hex')
$$;
CREATE FUNCTION social_sync.valid_time(v jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE s text; BEGIN
  IF v='null'::jsonb THEN RETURN true; END IF;
  IF jsonb_typeof(v) IS DISTINCT FROM 'string' THEN RETURN false; END IF;
  s:=v#>>'{}';
  RETURN s ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$' AND
    to_char(s::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')=s;
EXCEPTION WHEN OTHERS THEN RETURN false; END $$;
CREATE FUNCTION social_sync.valid_count(v jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT CASE WHEN v='null'::jsonb THEN true WHEN jsonb_typeof(v)='number' AND (v#>>'{}') ~ '^[0-9]+$'
    THEN (v#>>'{}')::numeric <= 9007199254740991 ELSE false END
$$;
CREATE FUNCTION social_sync.valid_observation(p jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE xhs boolean; keys text[]; m text; v jsonb; s text; BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR p->>'platform' NOT IN ('bilibili','xiaohongshu') THEN RETURN false; END IF;
  xhs:=p->>'platform'='xiaohongshu';
  keys:=ARRAY['version','platform','workId','accountId','publicationId','kind','originalUrl','title','description','coverUrl',
    'publishedAt','observedAt','metricsScope','metrics','collection','source','responseSha256','websitePublicationApproved'];
  IF xhs THEN keys:=keys||ARRAY['updatedAt','metricDisplay']; END IF;
  IF NOT (p ?& keys) OR (SELECT count(*) FROM jsonb_object_keys(p))<>cardinality(keys) THEN RETURN false; END IF;
  FOREACH m IN ARRAY ARRAY['platform','workId','accountId','publicationId','kind','originalUrl','title','observedAt','metricsScope','source','responseSha256'] LOOP
    IF jsonb_typeof(p->m) IS DISTINCT FROM 'string' THEN RETURN false; END IF;
  END LOOP;
  IF p->'websitePublicationApproved' IS DISTINCT FROM 'false'::jsonb OR jsonb_typeof(p->'workId')<>'string' OR
    p->>'workId' !~ '^[a-z0-9][a-z0-9_-]{0,63}$' OR jsonb_typeof(p->'accountId')<>'string' OR jsonb_typeof(p->'publicationId')<>'string' OR
    jsonb_typeof(p->'title')<>'string' OR length(btrim(p->>'title'))=0 OR length(p->>'title')>1000 OR
    jsonb_typeof(p->'responseSha256')<>'string' OR p->>'responseSha256' !~ '^[a-f0-9]{64}$' OR
    jsonb_typeof(p->'observedAt')<>'string' OR NOT social_sync.valid_time(p->'observedAt') OR NOT social_sync.valid_time(p->'publishedAt') THEN RETURN false; END IF;
  IF xhs THEN
    IF p->'version'<>'2'::jsonb OR p->>'kind' NOT IN ('video','image-note') OR p->>'metricsScope'<>'individual-note' OR
      p->>'source'<>'browser-note-state' OR p->>'accountId' !~ '^[a-f0-9]{24}$' OR p->>'publicationId' !~ '^[a-f0-9]{24}$' OR
      p->'collection'<>'null'::jsonb OR p->'description'<>'null'::jsonb OR NOT social_sync.valid_time(p->'updatedAt') OR
      p->>'originalUrl'<>'https://www.xiaohongshu.com/explore/'||(p->>'publicationId') THEN RETURN false; END IF;
  ELSE
    IF p->'version'<>'1'::jsonb OR p->>'kind'<>'video' OR p->>'metricsScope'<>'individual-video' OR p->>'source'<>'public-video-page-ssr' OR
      p->>'accountId' !~ '^[1-9][0-9]{0,19}$' OR p->>'publicationId' !~ '^BV[0-9A-Za-z]{10}$' OR
      p->>'originalUrl'<>'https://www.bilibili.com/video/'||(p->>'publicationId')||'/' THEN RETURN false; END IF;
    IF p->'description'<>'null'::jsonb AND (jsonb_typeof(p->'description')<>'string' OR length(btrim(p->>'description'))=0 OR length(p->>'description')>20000) THEN RETURN false; END IF;
    IF p->'collection'<>'null'::jsonb THEN
      v:=p->'collection';
      IF jsonb_typeof(v)<>'object' OR NOT(v ?& ARRAY['id','title','episodeCount']) OR (SELECT count(*) FROM jsonb_object_keys(v))<>3 OR
        jsonb_typeof(v->'id')<>'string' OR v->>'id' !~ '^[1-9][0-9]{0,19}$' OR jsonb_typeof(v->'title')<>'string' OR
        length(btrim(v->>'title'))=0 OR length(v->>'title')>1000 OR NOT social_sync.valid_count(v->'episodeCount') THEN RETURN false; END IF;
    END IF;
  END IF;
  IF p->'coverUrl'<>'null'::jsonb THEN
    s:=p->>'coverUrl';
    IF jsonb_typeof(p->'coverUrl')<>'string' OR length(s)>2048 OR
      (xhs AND s !~ '^https://[a-z0-9-]+\.xhscdn\.com/') OR (NOT xhs AND s !~ '^https://i[0-9]+\.hdslb\.com/') THEN RETURN false; END IF;
  END IF;
  v:=p->'metrics';
  IF jsonb_typeof(v)<>'object' OR NOT(v ?& ARRAY['views','likes','comments','shares','collections','coins','danmaku']) OR (SELECT count(*) FROM jsonb_object_keys(v))<>7 THEN RETURN false; END IF;
  FOREACH m IN ARRAY ARRAY['views','likes','comments','shares','collections','coins','danmaku'] LOOP
    IF NOT social_sync.valid_count(v->m) THEN RETURN false; END IF;
  END LOOP;
  IF xhs THEN
    IF v->'views'<>'null'::jsonb OR v->'coins'<>'null'::jsonb OR v->'danmaku'<>'null'::jsonb OR jsonb_typeof(p->'metricDisplay')<>'object' OR
      NOT(p->'metricDisplay' ?& ARRAY['likes','comments','shares','collections']) OR (SELECT count(*) FROM jsonb_object_keys(p->'metricDisplay'))<>4 THEN RETURN false; END IF;
    FOREACH m IN ARRAY ARRAY['likes','comments','shares','collections'] LOOP
      s:=p->'metricDisplay'->>m;
      IF p->'metricDisplay'->m='null'::jsonb THEN
        IF v->m<>'null'::jsonb THEN RETURN false; END IF;
      ELSE
        IF jsonb_typeof(p->'metricDisplay'->m)<>'string' OR length(s)>32 OR s<>btrim(s) THEN RETURN false; END IF;
        IF s ~ '^[0-9]+$' THEN
          IF jsonb_typeof(v->m)<>'number' OR s::numeric<>(v->>m)::numeric THEN RETURN false; END IF;
        ELSIF s ~ '^[0-9]+(\.[0-9]+)?(万|亿|[kKmMwW])\+?$' OR s ~ '^[0-9]+\+$' THEN
          IF v->m<>'null'::jsonb THEN RETURN false; END IF;
        ELSE RETURN false; END IF;
      END IF;
    END LOOP;
  END IF;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false; END $$;

CREATE TABLE social_sync.meta(singleton boolean PRIMARY KEY CHECK(singleton),version integer NOT NULL CHECK(version=1));
INSERT INTO social_sync.meta VALUES(true,1);
CREATE TABLE social_sync.bindings(
  platform text NOT NULL CHECK(platform IN ('bilibili','xiaohongshu')),
  account_id text NOT NULL,publication_id text NOT NULL,
  work_id text NOT NULL CHECK(work_id ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),enabled boolean NOT NULL DEFAULT false,
  publication_key text GENERATED ALWAYS AS (social_sync.publication_key(platform,account_id,publication_id)) STORED PRIMARY KEY,
  UNIQUE(publication_key,work_id),
  CHECK((platform='bilibili' AND account_id ~ '^[1-9][0-9]{0,19}$' AND publication_id ~ '^BV[0-9A-Za-z]{10}$') OR
    (platform='xiaohongshu' AND account_id ~ '^[a-f0-9]{24}$' AND publication_id ~ '^[a-f0-9]{24}$'))
);
CREATE TABLE social_sync.publications(
  publication_key text PRIMARY KEY,observed_at text NOT NULL,payload_sha256 text NOT NULL CHECK(payload_sha256 ~ '^[a-f0-9]{64}$'),
  payload jsonb NOT NULL CHECK(social_sync.valid_observation(payload)),
  work_id text GENERATED ALWAYS AS (payload->>'workId') STORED,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(publication_key,work_id) REFERENCES social_sync.bindings(publication_key,work_id),
  CHECK(publication_key=social_sync.publication_key(payload->>'platform',payload->>'accountId',payload->>'publicationId')),
  CHECK(observed_at=payload->>'observedAt'),CHECK(octet_length(payload::text)<=196608)
);
CREATE INDEX social_publications_work ON social_sync.publications(work_id);
CREATE INDEX social_publications_binding ON social_sync.publications(publication_key,work_id);
ALTER TABLE social_sync.meta ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_sync.bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_sync.publications ENABLE ROW LEVEL SECURITY;
CREATE POLICY social_meta_reader ON social_sync.meta FOR SELECT TO nb_social_worker USING(true);
CREATE POLICY social_binding_reader ON social_sync.bindings FOR SELECT TO nb_social_worker USING(enabled);
CREATE POLICY social_publication_reader ON social_sync.publications FOR SELECT TO nb_social_worker
  USING(EXISTS(SELECT 1 FROM social_sync.bindings b WHERE b.publication_key=publications.publication_key AND b.work_id=publications.work_id));
CREATE POLICY social_publication_insert ON social_sync.publications FOR INSERT TO nb_social_worker
  WITH CHECK(EXISTS(SELECT 1 FROM social_sync.bindings b WHERE b.publication_key=publications.publication_key AND b.work_id=publications.work_id));
CREATE POLICY social_publication_update ON social_sync.publications FOR UPDATE TO nb_social_worker
  USING(EXISTS(SELECT 1 FROM social_sync.bindings b WHERE b.publication_key=publications.publication_key AND b.work_id=publications.work_id))
  WITH CHECK(EXISTS(SELECT 1 FROM social_sync.bindings b WHERE b.publication_key=publications.publication_key AND b.work_id=publications.work_id));

CREATE FUNCTION social_sync.guard_publication() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$ BEGIN
  IF NOT social_sync.valid_observation(NEW.payload) OR NEW.observed_at<>NEW.payload->>'observedAt' OR
    (NEW.observed_at)::timestamptz>clock_timestamp()+interval '30 seconds' THEN RAISE EXCEPTION 'NB_SOCIAL_BAD_PAYLOAD'; END IF;
  IF TG_OP='UPDATE' THEN
    IF NEW.publication_key<>OLD.publication_key OR NEW.observed_at<OLD.observed_at THEN RAISE EXCEPTION 'NB_SOCIAL_STALE'; END IF;
    IF NEW.observed_at=OLD.observed_at AND (NEW.payload_sha256<>OLD.payload_sha256 OR NEW.payload<>OLD.payload) THEN RAISE EXCEPTION 'NB_SOCIAL_CONFLICT'; END IF;
  END IF;
  NEW.received_at:=clock_timestamp(); RETURN NEW;
END $$;
CREATE TRIGGER social_publication_guard BEFORE INSERT OR UPDATE ON social_sync.publications FOR EACH ROW EXECUTE FUNCTION social_sync.guard_publication();

CREATE FUNCTION social_sync.ingest(publication_key text,payload_sha256 text,payload_text text)
RETURNS TABLE(key text,sha256 text) LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE p jsonb; old social_sync.publications%ROWTYPE; BEGIN
  IF octet_length(payload_text)>196608 OR payload_sha256 !~ '^[a-f0-9]{64}$' OR publication_key !~ '^[a-f0-9]{64}$' OR
    payload_sha256 IS NULL OR publication_key IS NULL OR payload_text IS NULL OR
    encode(sha256(convert_to(payload_text,'UTF8')),'hex')<>payload_sha256 THEN RAISE EXCEPTION 'NB_SOCIAL_BAD_DIGEST'; END IF;
  BEGIN p:=payload_text::jsonb; EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'NB_SOCIAL_BAD_PAYLOAD'; END;
  IF NOT social_sync.valid_observation(p) OR social_sync.publication_key(p->>'platform',p->>'accountId',p->>'publicationId')<>publication_key THEN RAISE EXCEPTION 'NB_SOCIAL_BAD_PAYLOAD'; END IF;
  -- Serialize initial inserts and updates for this publication without granting the worker binding-write privileges.
  PERFORM pg_advisory_xact_lock(hashtextextended(ingest.publication_key,0));
  PERFORM 1 FROM social_sync.bindings b WHERE b.publication_key=ingest.publication_key AND b.work_id=p->>'workId';
  IF NOT FOUND THEN RAISE EXCEPTION 'NB_SOCIAL_UNREGISTERED'; END IF;
  -- The row lock serializes updates; a concurrent initial insert is handled by ON CONFLICT and re-read below.
  SELECT r.* INTO old FROM social_sync.publications r WHERE r.publication_key=ingest.publication_key FOR UPDATE;
  IF FOUND THEN
    IF p->>'observedAt'<old.observed_at THEN RAISE EXCEPTION 'NB_SOCIAL_STALE'; END IF;
    IF p->>'observedAt'=old.observed_at THEN
      IF old.payload_sha256<>ingest.payload_sha256 OR old.payload<>p THEN RAISE EXCEPTION 'NB_SOCIAL_CONFLICT'; END IF;
      RETURN QUERY SELECT old.publication_key,old.payload_sha256; RETURN;
    END IF;
  END IF;
  INSERT INTO social_sync.publications(publication_key,observed_at,payload_sha256,payload)
    VALUES(ingest.publication_key,p->>'observedAt',ingest.payload_sha256,p)
    ON CONFLICT ON CONSTRAINT publications_pkey DO UPDATE SET observed_at=excluded.observed_at,payload_sha256=excluded.payload_sha256,payload=excluded.payload
    WHERE social_sync.publications.observed_at<excluded.observed_at;
  SELECT r.* INTO old FROM social_sync.publications r WHERE r.publication_key=ingest.publication_key;
  IF old.payload_sha256<>ingest.payload_sha256 OR old.payload<>p THEN RAISE EXCEPTION 'NB_SOCIAL_CONFLICT'; END IF;
  RETURN QUERY SELECT old.publication_key,old.payload_sha256;
END $$;

-- Operator-only credential configuration; secrets never enter migration text/history.
CREATE FUNCTION social_sync.configure_password(password text) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$ BEGIN
  IF password IS NULL OR password !~ '^[A-Za-z0-9_-]{48,128}$' THEN RAISE EXCEPTION 'NB_SOCIAL_CREDENTIAL_INVALID'; END IF;
  EXECUTE format('ALTER ROLE nb_social_worker LOGIN PASSWORD %L',password);
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA social_sync FROM PUBLIC,anon,authenticated,service_role,nb_social_worker;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA social_sync FROM PUBLIC,anon,authenticated,service_role,nb_social_worker;
GRANT USAGE ON SCHEMA social_sync TO nb_social_worker;
GRANT SELECT ON social_sync.meta,social_sync.bindings,social_sync.publications TO nb_social_worker;
GRANT INSERT(publication_key,observed_at,payload_sha256,payload),UPDATE(observed_at,payload_sha256,payload) ON social_sync.publications TO nb_social_worker;
GRANT EXECUTE ON FUNCTION social_sync.publication_key(text,text,text),social_sync.valid_time(jsonb),social_sync.valid_count(jsonb),
  social_sync.valid_observation(jsonb),social_sync.guard_publication(),social_sync.ingest(text,text,text) TO nb_social_worker;
COMMIT;
