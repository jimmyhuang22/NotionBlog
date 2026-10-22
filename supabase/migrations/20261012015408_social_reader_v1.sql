-- Optional website reader; collection bindings never grant website eligibility.
BEGIN;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM social_sync.meta WHERE singleton AND version=1) THEN RAISE EXCEPTION 'NB_SOCIAL_PROTOCOL'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='nb_social_reader') THEN RAISE EXCEPTION 'NB_SOCIAL_READER_EXISTS'; END IF;
END $$;
CREATE ROLE nb_social_reader NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 4;
ALTER ROLE nb_social_reader SET default_transaction_read_only=on;
CREATE TABLE social_sync.reader_meta(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),version integer NOT NULL CHECK(version=1));
INSERT INTO social_sync.reader_meta VALUES(true,1);
CREATE TABLE social_sync.works(
  work_id text PRIMARY KEY CHECK(work_id ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  title text NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 1000),
  occurred_at text CHECK(occurred_at IS NULL OR social_sync.valid_time(to_jsonb(occurred_at))),
  approved boolean NOT NULL DEFAULT false
);
CREATE TABLE social_sync.website_visibility(
  publication_key text PRIMARY KEY,
  work_id text NOT NULL REFERENCES social_sync.works(work_id),
  approved boolean NOT NULL DEFAULT false,
  checked_at timestamptz NOT NULL,
  valid_until timestamptz NOT NULL CHECK(valid_until>checked_at AND valid_until<=checked_at+interval '24 hours'),
  outbound_url text,
  link_checked_at timestamptz,
  CHECK((outbound_url IS NULL)=(link_checked_at IS NULL)),
  CHECK(link_checked_at IS NULL OR (link_checked_at<=checked_at AND link_checked_at>=checked_at-interval '5 minutes')),
  FOREIGN KEY(publication_key,work_id) REFERENCES social_sync.bindings(publication_key,work_id)
);
CREATE INDEX social_visibility_work ON social_sync.website_visibility(work_id);
CREATE FUNCTION social_sync.guard_visibility() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE b social_sync.bindings; BEGIN
  IF NEW.checked_at>statement_timestamp()+interval '30 seconds' THEN RAISE EXCEPTION 'NB_SOCIAL_REVIEW_FUTURE'; END IF;
  SELECT * INTO b FROM social_sync.bindings WHERE publication_key=NEW.publication_key AND work_id=NEW.work_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'NB_SOCIAL_UNREGISTERED'; END IF;
  IF NEW.outbound_url IS NOT NULL THEN
    IF b.platform='bilibili' THEN
      IF NEW.outbound_url<>'https://www.bilibili.com/video/'||b.publication_id||'/' THEN RAISE EXCEPTION 'NB_SOCIAL_LINK_INVALID'; END IF;
    ELSE
      IF NEW.outbound_url !~ ('^https://www\.xiaohongshu\.com/discovery/item/'||b.publication_id||
        '\?source=webshare&xhsshare=pc_web&xsec_token=[A-Za-z0-9_=-]{16,255}&xsec_source=pc_share$') THEN RAISE EXCEPTION 'NB_SOCIAL_LINK_INVALID'; END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_visibility BEFORE INSERT OR UPDATE ON social_sync.website_visibility FOR EACH ROW EXECUTE FUNCTION social_sync.guard_visibility();
ALTER TABLE social_sync.reader_meta ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_sync.works ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_sync.website_visibility ENABLE ROW LEVEL SECURITY;
CREATE POLICY social_reader_meta ON social_sync.reader_meta FOR SELECT TO nb_social_reader USING(true);
CREATE POLICY social_reader_works ON social_sync.works FOR SELECT TO nb_social_reader USING(approved);
CREATE POLICY social_reader_visibility ON social_sync.website_visibility FOR SELECT TO nb_social_reader USING(
  approved AND checked_at<=statement_timestamp()+interval '30 seconds' AND valid_until>statement_timestamp() AND
  EXISTS(SELECT 1 FROM social_sync.works w WHERE w.work_id=website_visibility.work_id));
CREATE POLICY social_reader_bindings ON social_sync.bindings FOR SELECT TO nb_social_reader USING(enabled AND
  EXISTS(SELECT 1 FROM social_sync.website_visibility v WHERE v.publication_key=bindings.publication_key AND v.work_id=bindings.work_id));
CREATE POLICY social_reader_publications ON social_sync.publications FOR SELECT TO nb_social_reader USING(
  observed_at>=to_char((statement_timestamp()-interval '24 hours') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AND
  observed_at<=to_char((statement_timestamp()+interval '30 seconds') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AND
  EXISTS(SELECT 1 FROM social_sync.bindings b WHERE b.publication_key=publications.publication_key AND b.work_id=publications.work_id));
CREATE VIEW social_sync.website_publications WITH(security_invoker=true,security_barrier=true) AS
  SELECT w.work_id,w.title,w.occurred_at,jsonb_build_object(
    'id',p.publication_key,'platform',p.payload->'platform','publicationId',p.payload->'publicationId',
    'kind',p.payload->'kind','publishedAt',p.payload->'publishedAt','observedAt',p.payload->'observedAt',
    'metricsScope',p.payload->'metricsScope','metrics',p.payload->'metrics',
    'metricDisplay',coalesce(p.payload->'metricDisplay','{"likes":null,"comments":null,"shares":null,"collections":null}'::jsonb),
    'originalUrl',v.outbound_url,'linkVerifiedAt',to_char(v.link_checked_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS publication
  FROM social_sync.publications p
  JOIN social_sync.bindings b ON b.publication_key=p.publication_key AND b.work_id=p.work_id
  JOIN social_sync.website_visibility v ON v.publication_key=b.publication_key AND v.work_id=b.work_id
  JOIN social_sync.works w ON w.work_id=v.work_id
  WHERE w.approved AND b.enabled AND v.approved AND v.valid_until>statement_timestamp();
CREATE FUNCTION social_sync.configure_reader_password(password text) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$ BEGIN
  IF password IS NULL OR password !~ '^[A-Za-z0-9_-]{48,128}$' THEN RAISE EXCEPTION 'NB_SOCIAL_CREDENTIAL_INVALID'; END IF;
  EXECUTE format('ALTER ROLE nb_social_reader LOGIN PASSWORD %L',password);
END $$;
REVOKE ALL ON social_sync.reader_meta,social_sync.works,social_sync.website_visibility,social_sync.website_publications FROM PUBLIC,anon,authenticated,service_role,nb_social_worker,nb_social_reader;
REVOKE EXECUTE ON FUNCTION social_sync.guard_visibility(),social_sync.configure_reader_password(text) FROM PUBLIC,anon,authenticated,service_role,nb_social_worker,nb_social_reader;
GRANT USAGE ON SCHEMA social_sync TO nb_social_reader;
GRANT SELECT ON social_sync.reader_meta,social_sync.works,social_sync.website_visibility,social_sync.website_publications TO nb_social_reader;
GRANT SELECT(publication_key,work_id,enabled) ON social_sync.bindings TO nb_social_reader;
GRANT SELECT(publication_key,work_id,observed_at,payload) ON social_sync.publications TO nb_social_reader;
COMMIT;
