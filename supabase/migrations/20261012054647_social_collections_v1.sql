-- Additive collection domain; old payloads, views, roles and protocol versions remain unchanged.
BEGIN;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM social_sync.meta WHERE singleton AND version=1) OR
     NOT EXISTS(SELECT 1 FROM social_sync.reader_meta WHERE singleton AND version=1) THEN RAISE EXCEPTION 'NB_SOCIAL_PROTOCOL'; END IF;
END $$;
CREATE FUNCTION social_sync.collection_key(account_id text,kind text,collection_id text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
  SELECT encode(sha256(convert_to('["bilibili","'||account_id||'","'||kind||'","'||collection_id||'"]','UTF8')),'hex')
$$;
CREATE FUNCTION social_sync.collection_exact_keys(p jsonb,keys text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT CASE WHEN jsonb_typeof(p)='object' THEN p ?& keys AND (SELECT count(*) FROM jsonb_object_keys(p))=cardinality(keys) ELSE false END
$$;
CREATE FUNCTION social_sync.collection_member_digest(m jsonb) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
  SELECT encode(sha256(convert_to('["'||(m->>'id')||'",['||
    (SELECT string_agg('"'||value||'"',',' ORDER BY value) FROM jsonb_array_elements_text(m->'parts'))||'],'||(m->>'partsComplete')||']','UTF8')),'hex')
$$;
CREATE FUNCTION social_sync.valid_collection(p jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE t jsonb;m jsonb;v jsonb;name text;last_id text;last_part text;part text;parts integer:=0;representative text;found_representative boolean:=false; BEGIN
  IF NOT social_sync.collection_exact_keys(p,ARRAY['version','source','target','title','observedAt','firstPublishedAt','membershipComplete','members','metrics','responseSha256','websitePublicationApproved']) OR
    p->'version' IS DISTINCT FROM '1'::jsonb OR p->>'source' IS DISTINCT FROM 'bilibili-collection-ssr' OR
    p->'membershipComplete' IS DISTINCT FROM 'true'::jsonb OR p->'websitePublicationApproved' IS DISTINCT FROM 'false'::jsonb OR
    jsonb_typeof(p->'title') IS DISTINCT FROM 'string' OR length(btrim(p->>'title'))=0 OR length(p->>'title')>1000 OR
    jsonb_typeof(p->'observedAt') IS DISTINCT FROM 'string' OR NOT social_sync.valid_time(p->'observedAt') OR
    NOT social_sync.valid_time(p->'firstPublishedAt') OR
    (p->>'firstPublishedAt')::timestamptz>(p->>'observedAt')::timestamptz+interval '30 seconds' OR
    jsonb_typeof(p->'responseSha256') IS DISTINCT FROM 'string' OR p->>'responseSha256' !~ '^[a-f0-9]{64}$' OR octet_length(p::text)>524288 THEN RETURN false; END IF;
  t:=p->'target';
  IF NOT social_sync.collection_exact_keys(t,ARRAY['platform','kind','accountId','collectionId','representativeUrl']) THEN RETURN false; END IF;
  FOREACH name IN ARRAY ARRAY['platform','kind','accountId','collectionId','representativeUrl'] LOOP
    IF jsonb_typeof(t->name) IS DISTINCT FROM 'string' THEN RETURN false; END IF;
  END LOOP;
  IF t->>'platform'<>'bilibili' OR t->>'kind' NOT IN ('season','multi-part') OR t->>'accountId' !~ '^[1-9][0-9]{0,19}$' OR
    t->>'representativeUrl' !~ '^https://www\.bilibili\.com/video/BV[0-9A-Za-z]{10}/$' THEN RETURN false; END IF;
  representative:=split_part(t->>'representativeUrl','/',5);
  IF (t->>'kind'='season' AND (t->>'collectionId' !~ '^[1-9][0-9]{0,19}$' OR p->'firstPublishedAt'<>'null'::jsonb)) OR
     (t->>'kind'='multi-part' AND t->>'collectionId'<>representative) THEN RETURN false; END IF;
  IF jsonb_typeof(p->'members') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'members') NOT BETWEEN 1 AND 1000 THEN RETURN false; END IF;
  FOR m IN SELECT value FROM jsonb_array_elements(p->'members') LOOP
    IF NOT social_sync.collection_exact_keys(m,ARRAY['id','publishedAt','parts','partsComplete']) OR
      jsonb_typeof(m->'id') IS DISTINCT FROM 'string' OR m->>'id' !~ '^BV[0-9A-Za-z]{10}$' OR
      (last_id IS NOT NULL AND m->>'id'<=last_id COLLATE "C") OR NOT social_sync.valid_time(m->'publishedAt') OR
      (m->>'publishedAt')::timestamptz>(p->>'observedAt')::timestamptz+interval '30 seconds' OR
      jsonb_typeof(m->'partsComplete') IS DISTINCT FROM 'boolean' OR jsonb_typeof(m->'parts') IS DISTINCT FROM 'array' OR
      jsonb_array_length(m->'parts') NOT BETWEEN 1 AND 2000 THEN RETURN false; END IF;
    last_id:=m->>'id';last_part:=NULL;parts:=parts+jsonb_array_length(m->'parts');
    IF last_id=representative THEN found_representative:=true; END IF;
    FOR v IN SELECT value FROM jsonb_array_elements(m->'parts') LOOP
      part:=v#>>'{}';
      IF jsonb_typeof(v)<>'string' OR part !~ '^[1-9][0-9]{0,19}$' OR (last_part IS NOT NULL AND part<=last_part COLLATE "C") THEN RETURN false; END IF;
      last_part:=part;
    END LOOP;
  END LOOP;
  IF parts>2000 OR NOT found_representative OR (t->>'kind'='multi-part' AND
    (jsonb_array_length(p->'members')<>1 OR p->'members'->0->'partsComplete'<>'true'::jsonb OR
     jsonb_array_length(p->'members'->0->'parts')<2 OR p->'members'->0->'publishedAt'<>p->'firstPublishedAt')) THEN RETURN false; END IF;
  m:=p->'metrics';
  IF NOT social_sync.collection_exact_keys(m,ARRAY['views','likes','comments','shares','collections','coins','danmaku']) THEN RETURN false; END IF;
  FOREACH name IN ARRAY ARRAY['views','likes','comments','shares','collections','coins','danmaku'] LOOP
    IF NOT social_sync.valid_count(m->name) THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false; END $$;

CREATE TABLE social_sync.collection_meta(singleton boolean PRIMARY KEY CHECK(singleton),version integer NOT NULL CHECK(version=1));
INSERT INTO social_sync.collection_meta VALUES(true,1);
CREATE TABLE social_sync.collection_bindings(
  account_id text NOT NULL CHECK(account_id ~ '^[1-9][0-9]{0,19}$'),kind text NOT NULL CHECK(kind IN ('season','multi-part')),
  collection_id text NOT NULL,enabled boolean NOT NULL DEFAULT false,
  collection_key text GENERATED ALWAYS AS (social_sync.collection_key(account_id,kind,collection_id)) STORED PRIMARY KEY,
  CHECK((kind='season' AND collection_id ~ '^[1-9][0-9]{0,19}$') OR (kind='multi-part' AND collection_id ~ '^BV[0-9A-Za-z]{10}$'))
);
CREATE TABLE social_sync.collection_states(
  collection_key text PRIMARY KEY REFERENCES social_sync.collection_bindings(collection_key),observed_at text NOT NULL,
  payload_sha256 text NOT NULL CHECK(payload_sha256 ~ '^[a-f0-9]{64}$'),payload jsonb NOT NULL CHECK(social_sync.valid_collection(payload)),
  seen_videos jsonb NOT NULL,part_baselines jsonb NOT NULL,card jsonb NOT NULL,
  member_review_keys jsonb NOT NULL,member_publication_keys jsonb NOT NULL,
  CHECK(observed_at=payload->>'observedAt'),CHECK(octet_length(payload::text)+octet_length(seen_videos::text)+octet_length(part_baselines::text)<=2097152)
);
CREATE TABLE social_sync.collection_visibility(
  collection_key text PRIMARY KEY REFERENCES social_sync.collection_bindings(collection_key),
  title text NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 1000),approved boolean NOT NULL DEFAULT false,
  checked_at timestamptz NOT NULL,valid_until timestamptz NOT NULL CHECK(valid_until>checked_at AND valid_until<=checked_at+interval '24 hours'),
  outbound_url text,link_checked_at timestamptz,
  CHECK((outbound_url IS NULL)=(link_checked_at IS NULL)),
  CHECK(link_checked_at IS NULL OR (link_checked_at<=checked_at AND link_checked_at>=checked_at-interval '5 minutes'))
);
CREATE TABLE social_sync.collection_member_reviews(
  collection_key text NOT NULL REFERENCES social_sync.collection_bindings(collection_key),member_sha text NOT NULL CHECK(member_sha ~ '^[a-f0-9]{64}$'),
  approved boolean NOT NULL DEFAULT false,checked_at timestamptz NOT NULL,
  valid_until timestamptz NOT NULL CHECK(valid_until>checked_at AND valid_until<=checked_at+interval '24 hours'),PRIMARY KEY(collection_key,member_sha)
);
CREATE TABLE social_sync.collection_standalone_overrides(
  publication_key text PRIMARY KEY REFERENCES social_sync.bindings(publication_key),keep_standalone boolean NOT NULL DEFAULT false
);

-- Derived history/card fields are not writable by the worker. Every payload write computes them here.
CREATE FUNCTION social_sync.guard_collection() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE p jsonb:=NEW.payload;t jsonb:=p->'target';m jsonb;id text;old_parts jsonb;merged_parts jsonb;new_member boolean;
  seen jsonb:='[]';baselines jsonb:='{}';reviews jsonb:='[]';publications jsonb:='[]';
  activity jsonb:='null';addition jsonb:='null';added_videos integer:=0;added_parts integer:=0;part_total integer:=0;
  all_parts boolean:=true;all_published boolean:=true;latest_published text;latest_added text;added_date text; BEGIN
  IF NOT social_sync.valid_collection(p) OR NEW.observed_at<>p->>'observedAt' OR
    (NEW.observed_at)::timestamptz>clock_timestamp()+interval '30 seconds' OR
    NEW.collection_key<>social_sync.collection_key(t->>'accountId',t->>'kind',t->>'collectionId') THEN RAISE EXCEPTION 'NB_COLLECTION_BAD_PAYLOAD'; END IF;
  PERFORM 1 FROM social_sync.collection_bindings b WHERE b.collection_key=NEW.collection_key AND b.enabled;
  IF NOT FOUND THEN RAISE EXCEPTION 'NB_COLLECTION_UNREGISTERED'; END IF;
  IF TG_OP='UPDATE' THEN
    IF NEW.collection_key<>OLD.collection_key OR NEW.observed_at<OLD.observed_at THEN RAISE EXCEPTION 'NB_COLLECTION_STALE'; END IF;
    IF NEW.observed_at=OLD.observed_at THEN
      IF NEW.payload<>OLD.payload OR NEW.payload_sha256<>OLD.payload_sha256 THEN RAISE EXCEPTION 'NB_COLLECTION_CONFLICT'; END IF;
      NEW.seen_videos:=OLD.seen_videos;NEW.part_baselines:=OLD.part_baselines;NEW.card:=OLD.card;
      NEW.member_review_keys:=OLD.member_review_keys;NEW.member_publication_keys:=OLD.member_publication_keys;RETURN NEW;
    END IF;
    seen:=OLD.seen_videos;baselines:=OLD.part_baselines;activity:=OLD.card->'activity';addition:=OLD.card->'latestAddition';
  END IF;
  FOR m IN SELECT value FROM jsonb_array_elements(p->'members') LOOP
    id:=m->>'id';new_member:=NOT(seen ? id);
    IF TG_OP='UPDATE' AND new_member AND t->>'kind'='season' THEN
      added_videos:=added_videos+1;
      IF m->>'publishedAt' IS NULL OR m->>'publishedAt'<OLD.observed_at THEN all_published:=false;
      ELSIF latest_added IS NULL OR m->>'publishedAt'>latest_added THEN latest_added:=m->>'publishedAt'; END IF;
    END IF;
    old_parts:=baselines->id->'ids';
    IF TG_OP='UPDATE' AND NOT new_member AND old_parts IS NOT NULL AND m->'partsComplete'='true'::jsonb THEN
      added_parts:=added_parts+(SELECT count(*) FROM jsonb_array_elements_text(m->'parts') WHERE NOT(old_parts ? value));
    END IF;
    IF new_member THEN seen:=seen||jsonb_build_array(id); END IF;
    IF m->'partsComplete'='true'::jsonb THEN
      SELECT jsonb_agg(value ORDER BY value COLLATE "C") INTO merged_parts FROM (
        SELECT value FROM jsonb_array_elements_text(coalesce(old_parts,'[]')) UNION SELECT value FROM jsonb_array_elements_text(m->'parts')
      ) ids;
      baselines:=jsonb_set(baselines,ARRAY[id],jsonb_build_object('ids',merged_parts,'observedAt',NEW.observed_at),true);
    ELSE all_parts:=false; END IF;
    part_total:=part_total+jsonb_array_length(m->'parts');
    IF latest_published IS NULL OR m->>'publishedAt'>latest_published THEN latest_published:=m->>'publishedAt'; END IF;
    reviews:=reviews||jsonb_build_array(social_sync.collection_member_digest(m));
    publications:=publications||jsonb_build_array(social_sync.publication_key('bilibili',t->>'accountId',id));
  END LOOP;
  IF jsonb_array_length(seen)>10000 OR (SELECT coalesce(sum(jsonb_array_length(value->'ids')),0) FROM jsonb_each(baselines))>20000 THEN RAISE EXCEPTION 'NB_COLLECTION_HISTORY_LIMIT'; END IF;
  IF TG_OP='INSERT' AND latest_published IS NOT NULL THEN activity:=jsonb_build_object('at',latest_published,'basis','member-published'); END IF;
  IF added_videos+added_parts>0 THEN
    IF added_videos>0 AND added_parts=0 AND all_published THEN added_date:=latest_added; END IF;
    addition:=jsonb_build_object('detectedAt',NEW.observed_at,'publishedAt',added_date,'addedVideos',added_videos,'addedParts',added_parts);
    activity:=jsonb_build_object('at',coalesce(added_date,NEW.observed_at),'basis',CASE WHEN added_date IS NULL THEN 'addition-detected' ELSE 'member-published' END);
  END IF;
  NEW.seen_videos:=seen;NEW.part_baselines:=baselines;NEW.member_review_keys:=reviews;NEW.member_publication_keys:=publications;
  NEW.card:=jsonb_build_object('id','bc_'||left(NEW.collection_key,40),'platform','bilibili','kind',t->>'kind','title',p->>'title',
    'memberCount',CASE WHEN t->>'kind'='season' THEN jsonb_array_length(p->'members') ELSE part_total END,
    'partCount',CASE WHEN all_parts THEN part_total ELSE NULL END,'firstPublishedAt',p->'firstPublishedAt',
    'latestMemberPublishedAt',latest_published,'observedAt',NEW.observed_at,'metricsScope',CASE WHEN t->>'kind'='season' THEN 'bilibili-season' ELSE 'bilibili-multi-part' END,
    'metrics',p->'metrics','activity',activity,'latestAddition',addition,'originalUrl',NULL);
  RETURN NEW;
END $$;
CREATE TRIGGER collection_guard BEFORE INSERT OR UPDATE ON social_sync.collection_states FOR EACH ROW EXECUTE FUNCTION social_sync.guard_collection();
CREATE FUNCTION social_sync.ingest_collection(collection_key text,payload_sha256 text,payload_text text)
RETURNS TABLE(key text,sha256 text) LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE p jsonb;old social_sync.collection_states; BEGIN
  IF payload_text IS NULL OR collection_key IS NULL OR payload_sha256 IS NULL OR octet_length(payload_text)>524288 OR
    collection_key !~ '^[a-f0-9]{64}$' OR payload_sha256 !~ '^[a-f0-9]{64}$' OR
    encode(sha256(convert_to(payload_text,'UTF8')),'hex')<>payload_sha256 THEN RAISE EXCEPTION 'NB_COLLECTION_BAD_DIGEST'; END IF;
  BEGIN p:=payload_text::jsonb;EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'NB_COLLECTION_BAD_PAYLOAD';END;
  IF NOT social_sync.valid_collection(p) OR collection_key<>social_sync.collection_key(p->'target'->>'accountId',p->'target'->>'kind',p->'target'->>'collectionId') THEN RAISE EXCEPTION 'NB_COLLECTION_BAD_PAYLOAD'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('collection:'||ingest_collection.collection_key,0));
  PERFORM 1 FROM social_sync.collection_bindings b WHERE b.collection_key=ingest_collection.collection_key AND b.enabled;
  IF NOT FOUND THEN RAISE EXCEPTION 'NB_COLLECTION_UNREGISTERED'; END IF;
  SELECT * INTO old FROM social_sync.collection_states s WHERE s.collection_key=ingest_collection.collection_key FOR UPDATE;
  IF FOUND THEN
    IF p->>'observedAt'<old.observed_at THEN RAISE EXCEPTION 'NB_COLLECTION_STALE'; END IF;
    IF p->>'observedAt'=old.observed_at THEN
      IF old.payload_sha256<>ingest_collection.payload_sha256 OR old.payload<>p THEN RAISE EXCEPTION 'NB_COLLECTION_CONFLICT'; END IF;
      RETURN QUERY SELECT old.collection_key,old.payload_sha256;RETURN;
    END IF;
  END IF;
  INSERT INTO social_sync.collection_states(collection_key,observed_at,payload_sha256,payload)
    VALUES(ingest_collection.collection_key,p->>'observedAt',ingest_collection.payload_sha256,p)
    ON CONFLICT ON CONSTRAINT collection_states_pkey DO UPDATE SET observed_at=excluded.observed_at,payload_sha256=excluded.payload_sha256,payload=excluded.payload;
  RETURN QUERY SELECT s.collection_key,s.payload_sha256 FROM social_sync.collection_states s WHERE s.collection_key=ingest_collection.collection_key;
END $$;

CREATE FUNCTION social_sync.guard_collection_review() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE b social_sync.collection_bindings; BEGIN
  IF NEW.checked_at>statement_timestamp()+interval '30 seconds' THEN RAISE EXCEPTION 'NB_COLLECTION_REVIEW_FUTURE'; END IF;
  SELECT * INTO b FROM social_sync.collection_bindings WHERE collection_key=NEW.collection_key;
  IF NOT FOUND THEN RAISE EXCEPTION 'NB_COLLECTION_UNREGISTERED'; END IF;
  IF TG_TABLE_NAME='collection_visibility' THEN
    IF NEW.outbound_url IS NOT NULL AND NEW.outbound_url<>(CASE WHEN b.kind='season'
      THEN 'https://space.bilibili.com/'||b.account_id||'/lists/'||b.collection_id||'?type=season'
      ELSE 'https://www.bilibili.com/video/'||b.collection_id||'/' END) THEN RAISE EXCEPTION 'NB_COLLECTION_LINK_INVALID'; END IF;
  ELSIF NEW.approved AND NOT EXISTS(SELECT 1 FROM social_sync.collection_states s WHERE s.collection_key=NEW.collection_key AND s.member_review_keys ? NEW.member_sha) THEN
    RAISE EXCEPTION 'NB_COLLECTION_MEMBER_UNKNOWN';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER collection_visibility_guard BEFORE INSERT OR UPDATE ON social_sync.collection_visibility FOR EACH ROW EXECUTE FUNCTION social_sync.guard_collection_review();
CREATE TRIGGER collection_member_review_guard BEFORE INSERT OR UPDATE ON social_sync.collection_member_reviews FOR EACH ROW EXECUTE FUNCTION social_sync.guard_collection_review();
CREATE FUNCTION social_sync.collection_members_approved(key text,member_keys jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
  SELECT NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(member_keys) m WHERE NOT EXISTS(
    SELECT 1 FROM social_sync.collection_member_reviews r WHERE r.collection_key=key AND r.member_sha=m.value AND r.approved
      AND r.checked_at<=statement_timestamp()+interval '30 seconds' AND r.valid_until>statement_timestamp()))
$$;
ALTER TABLE social_sync.collection_meta ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_sync.collection_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_sync.collection_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_sync.collection_visibility ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_sync.collection_member_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_sync.collection_standalone_overrides ENABLE ROW LEVEL SECURITY;
CREATE POLICY collection_meta_select ON social_sync.collection_meta FOR SELECT TO nb_social_worker,nb_social_reader USING(true);
CREATE POLICY collection_worker_binding_select ON social_sync.collection_bindings FOR SELECT TO nb_social_worker USING(enabled);
CREATE POLICY collection_reader_binding_select ON social_sync.collection_bindings FOR SELECT TO nb_social_reader USING(enabled AND
  EXISTS(SELECT 1 FROM social_sync.collection_visibility v WHERE v.collection_key=collection_bindings.collection_key));
CREATE POLICY collection_worker_select ON social_sync.collection_states FOR SELECT TO nb_social_worker USING(EXISTS(SELECT 1 FROM social_sync.collection_bindings b WHERE b.collection_key=collection_states.collection_key));
CREATE POLICY collection_worker_insert ON social_sync.collection_states FOR INSERT TO nb_social_worker WITH CHECK(EXISTS(SELECT 1 FROM social_sync.collection_bindings b WHERE b.collection_key=collection_states.collection_key));
CREATE POLICY collection_worker_update ON social_sync.collection_states FOR UPDATE TO nb_social_worker
  USING(EXISTS(SELECT 1 FROM social_sync.collection_bindings b WHERE b.collection_key=collection_states.collection_key))
  WITH CHECK(EXISTS(SELECT 1 FROM social_sync.collection_bindings b WHERE b.collection_key=collection_states.collection_key));
CREATE POLICY collection_visibility_select ON social_sync.collection_visibility FOR SELECT TO nb_social_reader USING(approved AND checked_at<=statement_timestamp()+interval '30 seconds' AND valid_until>statement_timestamp());
CREATE POLICY collection_reviews_select ON social_sync.collection_member_reviews FOR SELECT TO nb_social_reader USING(approved AND checked_at<=statement_timestamp()+interval '30 seconds' AND valid_until>statement_timestamp());
CREATE POLICY collection_overrides_select ON social_sync.collection_standalone_overrides FOR SELECT TO nb_social_reader USING(keep_standalone);
CREATE POLICY collection_reader_select ON social_sync.collection_states FOR SELECT TO nb_social_reader USING(
  observed_at>=to_char((statement_timestamp()-interval '24 hours') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AND
  observed_at<=to_char((statement_timestamp()+interval '30 seconds') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AND
  EXISTS(SELECT 1 FROM social_sync.collection_bindings b WHERE b.collection_key=collection_states.collection_key) AND
  EXISTS(SELECT 1 FROM social_sync.collection_visibility v WHERE v.collection_key=collection_states.collection_key) AND
  social_sync.collection_members_approved(collection_key,member_review_keys));
CREATE VIEW social_sync.website_collections WITH(security_invoker=true,security_barrier=true) AS
  SELECT s.collection_key,b.account_id,b.kind,b.collection_id,
    s.card||jsonb_build_object('title',v.title,'originalUrl',v.outbound_url,
      'linkVerifiedAt',to_char(v.link_checked_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS collection
  FROM social_sync.collection_states s JOIN social_sync.collection_bindings b USING(collection_key)
    JOIN social_sync.collection_visibility v USING(collection_key)
  WHERE b.enabled AND v.approved AND v.valid_until>statement_timestamp();
CREATE VIEW social_sync.website_collection_members WITH(security_invoker=true,security_barrier=true) AS
  SELECT s.collection_key,m.value AS publication_key FROM social_sync.collection_states s,
    LATERAL jsonb_array_elements_text(s.member_publication_keys) m;

REVOKE ALL ON social_sync.collection_meta,social_sync.collection_bindings,social_sync.collection_states,social_sync.collection_visibility,
  social_sync.collection_member_reviews,social_sync.collection_standalone_overrides,social_sync.website_collections,social_sync.website_collection_members
  FROM PUBLIC,anon,authenticated,service_role,nb_social_worker,nb_social_reader;
REVOKE EXECUTE ON FUNCTION social_sync.collection_key(text,text,text),social_sync.collection_exact_keys(jsonb,text[]),social_sync.collection_member_digest(jsonb),
  social_sync.valid_collection(jsonb),social_sync.guard_collection(),social_sync.ingest_collection(text,text,text),social_sync.guard_collection_review(),
  social_sync.collection_members_approved(text,jsonb) FROM PUBLIC,anon,authenticated,service_role,nb_social_worker,nb_social_reader;
GRANT SELECT ON social_sync.collection_meta,social_sync.collection_bindings,social_sync.collection_states TO nb_social_worker;
GRANT INSERT(collection_key,observed_at,payload_sha256,payload),UPDATE(observed_at,payload_sha256,payload) ON social_sync.collection_states TO nb_social_worker;
GRANT EXECUTE ON FUNCTION social_sync.collection_key(text,text,text),social_sync.collection_exact_keys(jsonb,text[]),social_sync.collection_member_digest(jsonb),
  social_sync.valid_collection(jsonb),social_sync.guard_collection(),social_sync.ingest_collection(text,text,text) TO nb_social_worker;
GRANT SELECT ON social_sync.collection_meta,social_sync.collection_bindings,social_sync.collection_visibility,social_sync.collection_member_reviews,
  social_sync.collection_standalone_overrides,social_sync.website_collections,social_sync.website_collection_members TO nb_social_reader;
GRANT SELECT(collection_key,observed_at,card,member_review_keys,member_publication_keys) ON social_sync.collection_states TO nb_social_reader;
GRANT EXECUTE ON FUNCTION social_sync.collection_members_approved(text,jsonb) TO nb_social_reader;
COMMIT;
