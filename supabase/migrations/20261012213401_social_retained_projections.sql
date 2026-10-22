-- Retain the last reviewed projection; source collection and editorial approval stay separate.
BEGIN;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM social_sync.reader_meta WHERE singleton AND version=1) OR
     NOT EXISTS(SELECT 1 FROM social_sync.collection_meta WHERE singleton AND version=1) THEN
    RAISE EXCEPTION 'NB_SOCIAL_RETAINED_PROTOCOL';
  END IF;
END $$;

CREATE TABLE social_sync.retained_meta(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),version integer NOT NULL CHECK(version=1));
INSERT INTO social_sync.retained_meta VALUES(true,1);
CREATE TABLE social_sync.retained_publications(
  publication_key text PRIMARY KEY,
  work_id text NOT NULL REFERENCES social_sync.works(work_id),
  approved boolean NOT NULL DEFAULT false,
  reviewed_at timestamptz NOT NULL,
  reviewed_kind text NOT NULL CHECK(reviewed_kind IN ('video','image-note')),
  approved_source_sha256 text NOT NULL CHECK(approved_source_sha256 ~ '^[a-f0-9]{64}$'),
  source_sha256 text NOT NULL CHECK(source_sha256 ~ '^[a-f0-9]{64}$'),
  observed_at text,
  publication jsonb,
  outbound_url text,link_checked_at timestamptz,
  FOREIGN KEY(publication_key,work_id) REFERENCES social_sync.bindings(publication_key,work_id),
  CHECK((outbound_url IS NULL)=(link_checked_at IS NULL)),
  CHECK(link_checked_at IS NULL OR link_checked_at<=reviewed_at),
  CHECK(NOT approved OR (observed_at IS NOT NULL AND publication IS NOT NULL)),
  CHECK(publication IS NULL OR octet_length(publication::text)<=196608)
);
CREATE INDEX retained_publications_work ON social_sync.retained_publications(work_id);
CREATE TABLE social_sync.retained_collections(
  collection_key text PRIMARY KEY REFERENCES social_sync.collection_bindings(collection_key),
  approved boolean NOT NULL DEFAULT false,
  reviewed_at timestamptz NOT NULL,
  title text NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 1000),
  approved_source_sha256 text NOT NULL CHECK(approved_source_sha256 ~ '^[a-f0-9]{64}$'),
  source_sha256 text NOT NULL CHECK(source_sha256 ~ '^[a-f0-9]{64}$'),
  approved_member_keys jsonb NOT NULL,
  member_publication_keys jsonb,
  account_id text,kind text,collection_id text,
  observed_at text,card jsonb,
  outbound_url text,link_checked_at timestamptz,
  CHECK((outbound_url IS NULL)=(link_checked_at IS NULL)),
  CHECK(link_checked_at IS NULL OR link_checked_at<=reviewed_at),
  CHECK(jsonb_typeof(approved_member_keys)='array' AND jsonb_array_length(approved_member_keys) BETWEEN 1 AND 1000),
  CHECK(NOT approved OR (observed_at IS NOT NULL AND card IS NOT NULL AND member_publication_keys IS NOT NULL AND account_id IS NOT NULL AND kind IS NOT NULL AND collection_id IS NOT NULL)),
  CHECK(card IS NULL OR octet_length(card::text)<=524288)
);

CREATE FUNCTION social_sync.retained_publication_projection(p jsonb,key text,url text,checked timestamptz) RETURNS jsonb
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('id',key,'platform',p->'platform','publicationId',p->'publicationId','kind',p->'kind',
  'publishedAt',p->'publishedAt','observedAt',p->'observedAt','metricsScope',p->'metricsScope','metrics',p->'metrics',
  'metricDisplay',coalesce(p->'metricDisplay','{"likes":null,"comments":null,"shares":null,"collections":null}'::jsonb),
  'originalUrl',url,'linkVerifiedAt',to_char(checked AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
$$;
CREATE FUNCTION social_sync.retained_members_equal(a jsonb,b jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT CASE WHEN jsonb_typeof(a)='array' AND jsonb_typeof(b)='array' THEN
  jsonb_array_length(a)=jsonb_array_length(b) AND
  NOT EXISTS((SELECT value FROM jsonb_array_elements(a)) EXCEPT (SELECT value FROM jsonb_array_elements(b))) AND
  NOT EXISTS((SELECT value FROM jsonb_array_elements(b)) EXCEPT (SELECT value FROM jsonb_array_elements(a))) ELSE false END
$$;

CREATE FUNCTION social_sync.guard_retained_publication() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE s social_sync.publications; b social_sync.bindings; BEGIN
 IF TG_OP='UPDATE' AND (NEW.publication_key<>OLD.publication_key OR NEW.work_id<>OLD.work_id) THEN RAISE EXCEPTION 'NB_SOCIAL_RETAINED_IDENTITY'; END IF;
 IF NEW.reviewed_at>statement_timestamp()+interval '30 seconds' THEN RAISE EXCEPTION 'NB_SOCIAL_RETAINED_FUTURE'; END IF;
 IF NOT NEW.approved THEN RETURN NEW; END IF;
 SELECT * INTO b FROM social_sync.bindings WHERE publication_key=NEW.publication_key AND work_id=NEW.work_id AND enabled;
 IF NOT FOUND THEN RAISE EXCEPTION 'NB_SOCIAL_RETAINED_BINDING'; END IF;
 SELECT * INTO s FROM social_sync.publications WHERE publication_key=NEW.publication_key AND work_id=NEW.work_id;
 IF NOT FOUND OR NEW.source_sha256 IS DISTINCT FROM s.payload_sha256 OR NEW.reviewed_kind IS DISTINCT FROM s.payload->>'kind' THEN RAISE EXCEPTION 'NB_SOCIAL_RETAINED_SOURCE'; END IF;
 IF TG_OP='INSERT' OR NOT OLD.approved OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at OR
    NEW.reviewed_kind IS DISTINCT FROM OLD.reviewed_kind OR NEW.approved_source_sha256 IS DISTINCT FROM OLD.approved_source_sha256 THEN
  IF NEW.approved_source_sha256 IS DISTINCT FROM s.payload_sha256 THEN RAISE EXCEPTION 'NB_SOCIAL_RETAINED_REVIEW'; END IF;
 END IF;
 IF NEW.outbound_url IS NOT NULL THEN
  IF b.platform='bilibili' THEN
   IF NEW.outbound_url<>'https://www.bilibili.com/video/'||b.publication_id||'/' THEN RAISE EXCEPTION 'NB_SOCIAL_RETAINED_LINK'; END IF;
  ELSIF NEW.outbound_url !~ ('^https://www\.xiaohongshu\.com/discovery/item/'||b.publication_id||
    '\?source=webshare&xhsshare=pc_web&xsec_token=[A-Za-z0-9_=-]{16,255}&xsec_source=pc_share$') THEN RAISE EXCEPTION 'NB_SOCIAL_RETAINED_LINK'; END IF;
 END IF;
 NEW.observed_at:=s.observed_at;
 NEW.publication:=social_sync.retained_publication_projection(s.payload,s.publication_key,NEW.outbound_url,NEW.link_checked_at);
 RETURN NEW;
END $$;
CREATE FUNCTION social_sync.guard_retained_collection() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE s social_sync.collection_states; b social_sync.collection_bindings; review_changed boolean; expected_url text; BEGIN
 IF TG_OP='UPDATE' AND NEW.collection_key<>OLD.collection_key THEN RAISE EXCEPTION 'NB_SOCIAL_RETAINED_IDENTITY'; END IF;
 IF NEW.reviewed_at>statement_timestamp()+interval '30 seconds' THEN RAISE EXCEPTION 'NB_SOCIAL_RETAINED_FUTURE'; END IF;
 IF NOT NEW.approved THEN RETURN NEW; END IF;
 SELECT * INTO b FROM social_sync.collection_bindings WHERE collection_key=NEW.collection_key AND enabled;
 IF NOT FOUND THEN RAISE EXCEPTION 'NB_SOCIAL_RETAINED_BINDING'; END IF;
 SELECT * INTO s FROM social_sync.collection_states WHERE collection_key=NEW.collection_key;
 IF NOT FOUND OR NEW.source_sha256 IS DISTINCT FROM s.payload_sha256 OR social_sync.retained_members_equal(NEW.approved_member_keys,s.member_review_keys) IS DISTINCT FROM true THEN RAISE EXCEPTION 'NB_SOCIAL_RETAINED_SOURCE'; END IF;
 review_changed:=TG_OP='INSERT' OR NOT OLD.approved OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at OR
    NEW.approved_member_keys IS DISTINCT FROM OLD.approved_member_keys OR NEW.approved_source_sha256 IS DISTINCT FROM OLD.approved_source_sha256;
 IF review_changed THEN
  IF NEW.approved_source_sha256 IS DISTINCT FROM s.payload_sha256 THEN RAISE EXCEPTION 'NB_SOCIAL_RETAINED_REVIEW'; END IF;
 END IF;
 expected_url:=CASE WHEN b.kind='season'
  THEN 'https://space.bilibili.com/'||b.account_id||'/lists/'||b.collection_id||'?type=season'
  ELSE 'https://www.bilibili.com/video/'||b.collection_id||'/' END;
 IF NEW.outbound_url IS NOT NULL AND NEW.outbound_url IS DISTINCT FROM expected_url THEN RAISE EXCEPTION 'NB_SOCIAL_RETAINED_LINK'; END IF;
 NEW.account_id:=b.account_id;NEW.kind:=b.kind;NEW.collection_id:=b.collection_id;
 NEW.observed_at:=s.observed_at;NEW.member_publication_keys:=s.member_publication_keys;
 NEW.card:=s.card||jsonb_build_object('title',NEW.title,'originalUrl',NEW.outbound_url,
  'linkVerifiedAt',to_char(NEW.link_checked_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
 -- Statistics-only refreshes cannot inherit activity from an unreviewed addition that was later removed.
 IF NOT review_changed THEN NEW.card:=NEW.card||jsonb_build_object('activity',OLD.card->'activity','latestAddition',OLD.card->'latestAddition'); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_retained_publication BEFORE INSERT OR UPDATE ON social_sync.retained_publications FOR EACH ROW EXECUTE FUNCTION social_sync.guard_retained_publication();
CREATE TRIGGER guard_retained_collection BEFORE INSERT OR UPDATE ON social_sync.retained_collections FOR EACH ROW EXECUTE FUNCTION social_sync.guard_retained_collection();

-- Trigger-only bridge: no callable RPC and no worker grants on retained approval or projection tables.
-- Its owner can copy an already-validated source into an already-approved identity/member scope.
-- Direct SQL ingestion uses a dedicated LOGIN, not an Auth/JWT user; invocation is bound to these triggers.
CREATE FUNCTION social_sync.sync_retained_source() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF session_user NOT IN ('nb_social_worker','postgres','supabase_admin') THEN RAISE EXCEPTION 'NB_SOCIAL_RETAINED_ACTOR'; END IF;
 IF TG_TABLE_SCHEMA<>'social_sync' OR TG_LEVEL<>'ROW' OR TG_WHEN<>'AFTER' THEN RAISE EXCEPTION 'NB_SOCIAL_RETAINED_TRIGGER'; END IF;
 IF TG_TABLE_NAME='publications' THEN
  IF TG_OP='DELETE' THEN UPDATE social_sync.retained_publications SET approved=false WHERE publication_key=OLD.publication_key;
  ELSE
   UPDATE social_sync.retained_publications r SET source_sha256=NEW.payload_sha256
    WHERE r.approved AND r.publication_key=NEW.publication_key AND r.work_id=NEW.work_id AND r.reviewed_kind=NEW.payload->>'kind' AND r.observed_at<=NEW.observed_at
     AND EXISTS(SELECT 1 FROM social_sync.works w WHERE w.work_id=r.work_id AND w.approved)
     AND EXISTS(SELECT 1 FROM social_sync.bindings b WHERE b.publication_key=r.publication_key AND b.work_id=r.work_id AND b.enabled);
  END IF;
 ELSIF TG_TABLE_NAME='collection_states' THEN
  IF TG_OP='DELETE' THEN UPDATE social_sync.retained_collections SET approved=false WHERE collection_key=OLD.collection_key;
  ELSE
   UPDATE social_sync.retained_collections r SET source_sha256=NEW.payload_sha256
    WHERE r.approved AND r.collection_key=NEW.collection_key AND r.observed_at<=NEW.observed_at
     AND social_sync.retained_members_equal(r.approved_member_keys,NEW.member_review_keys)
     AND EXISTS(SELECT 1 FROM social_sync.collection_bindings b WHERE b.collection_key=r.collection_key AND b.enabled);
  END IF;
 ELSIF TG_TABLE_NAME='bindings' AND TG_OP='UPDATE' THEN
  IF NOT NEW.enabled THEN UPDATE social_sync.retained_publications SET approved=false WHERE publication_key=NEW.publication_key; END IF;
 ELSIF TG_TABLE_NAME='collection_bindings' AND TG_OP='UPDATE' THEN
  IF NOT NEW.enabled THEN UPDATE social_sync.retained_collections SET approved=false WHERE collection_key=NEW.collection_key; END IF;
 ELSE RAISE EXCEPTION 'NB_SOCIAL_RETAINED_TRIGGER';
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER retained_source_publication AFTER INSERT OR UPDATE OR DELETE ON social_sync.publications FOR EACH ROW EXECUTE FUNCTION social_sync.sync_retained_source();
CREATE TRIGGER retained_source_collection AFTER INSERT OR UPDATE OR DELETE ON social_sync.collection_states FOR EACH ROW EXECUTE FUNCTION social_sync.sync_retained_source();
CREATE TRIGGER retained_binding_publication AFTER UPDATE OF enabled ON social_sync.bindings FOR EACH ROW EXECUTE FUNCTION social_sync.sync_retained_source();
CREATE TRIGGER retained_binding_collection AFTER UPDATE OF enabled ON social_sync.collection_bindings FOR EACH ROW EXECUTE FUNCTION social_sync.sync_retained_source();

ALTER TABLE social_sync.retained_meta ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_sync.retained_publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_sync.retained_collections ENABLE ROW LEVEL SECURITY;
CREATE POLICY retained_meta_reader ON social_sync.retained_meta FOR SELECT TO nb_social_reader USING(true);
CREATE POLICY retained_publication_reader ON social_sync.retained_publications FOR SELECT TO nb_social_reader USING(
 approved AND reviewed_at<=statement_timestamp()+interval '30 seconds' AND observed_at<=to_char((statement_timestamp()+interval '30 seconds') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AND
 EXISTS(SELECT 1 FROM social_sync.works w WHERE w.work_id=retained_publications.work_id));
CREATE POLICY retained_collection_reader ON social_sync.retained_collections FOR SELECT TO nb_social_reader USING(
 approved AND reviewed_at<=statement_timestamp()+interval '30 seconds' AND observed_at<=to_char((statement_timestamp()+interval '30 seconds') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
CREATE VIEW social_sync.retained_website_publications WITH(security_invoker=true,security_barrier=true) AS
 SELECT w.work_id,w.title,w.occurred_at,r.publication FROM social_sync.retained_publications r JOIN social_sync.works w USING(work_id) WHERE r.approved AND w.approved;
CREATE VIEW social_sync.retained_website_collections WITH(security_invoker=true,security_barrier=true) AS
 SELECT collection_key,account_id,kind,collection_id,card AS collection FROM social_sync.retained_collections WHERE approved;
CREATE VIEW social_sync.retained_website_collection_members WITH(security_invoker=true,security_barrier=true) AS
 SELECT r.collection_key,m.value AS publication_key FROM social_sync.retained_collections r,LATERAL jsonb_array_elements_text(r.member_publication_keys) m WHERE r.approved;

REVOKE ALL ON social_sync.retained_meta,social_sync.retained_publications,social_sync.retained_collections,social_sync.retained_website_publications,
 social_sync.retained_website_collections,social_sync.retained_website_collection_members FROM PUBLIC,anon,authenticated,service_role,nb_social_worker,nb_social_reader;
REVOKE EXECUTE ON FUNCTION social_sync.retained_publication_projection(jsonb,text,text,timestamptz),social_sync.retained_members_equal(jsonb,jsonb),
 social_sync.guard_retained_publication(),social_sync.guard_retained_collection(),social_sync.sync_retained_source() FROM PUBLIC,anon,authenticated,service_role,nb_social_worker,nb_social_reader;
GRANT SELECT ON social_sync.retained_meta,social_sync.retained_website_publications,social_sync.retained_website_collections,social_sync.retained_website_collection_members TO nb_social_reader;
GRANT SELECT(publication_key,work_id,approved,reviewed_at,observed_at,publication) ON social_sync.retained_publications TO nb_social_reader;
GRANT SELECT(collection_key,approved,reviewed_at,observed_at,account_id,kind,collection_id,card,member_publication_keys) ON social_sync.retained_collections TO nb_social_reader;
COMMIT;
