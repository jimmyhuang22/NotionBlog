-- Account publication permission is installed only by the operator. Empty/default-off.
BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM social_sync.retained_meta WHERE singleton AND version=1) OR
    NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='social_sync' AND table_name='retained_collections' AND column_name='follow_public_members') THEN
  RAISE EXCEPTION 'NB_BILIBILI_ACCOUNT_PROTOCOL';
 END IF;
END $$;
CREATE TABLE social_sync.bilibili_accounts(
 account_id text PRIMARY KEY CHECK(account_id ~ '^[1-9][0-9]{0,19}$'),
 enabled boolean NOT NULL DEFAULT false,
 authorized_at timestamptz NOT NULL DEFAULT statement_timestamp()
);
CREATE TABLE social_sync.bilibili_auto_bindings(
 target_kind text NOT NULL CHECK(target_kind IN ('publication','collection')),
 target_key text NOT NULL CHECK(target_key ~ '^[a-f0-9]{64}$'),
 account_id text NOT NULL REFERENCES social_sync.bilibili_accounts(account_id),
 registered_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 PRIMARY KEY(target_kind,target_key)
);
ALTER TABLE social_sync.bilibili_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_sync.bilibili_auto_bindings ENABLE ROW LEVEL SECURITY;
CREATE POLICY bilibili_account_private ON social_sync.bilibili_accounts FOR ALL TO PUBLIC USING(false) WITH CHECK(false);
CREATE POLICY bilibili_auto_binding_private ON social_sync.bilibili_auto_bindings FOR ALL TO PUBLIC USING(false) WITH CHECK(false);
REVOKE ALL ON social_sync.bilibili_accounts,social_sync.bilibili_auto_bindings FROM PUBLIC,anon,authenticated,service_role,nb_social_worker,nb_social_reader;

-- Fixed operation, schemas and bounds. The caller cannot set account permission, grant
-- unrelated approvals, modify a manual work, re-enable a binding or resurrect a denial.
CREATE FUNCTION social_sync.ingest_bilibili_account(target_kind text,target_key text,payload_sha256 text,payload_text text)
RETURNS TABLE(key text,sha256 text) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p jsonb; account text; observed text; work text; b social_sync.bindings; c social_sync.collection_bindings;
 old_exists boolean; canonical text; checked timestamptz; BEGIN
 IF session_user<>'nb_social_worker' THEN RAISE EXCEPTION 'NB_BILIBILI_ACCOUNT_ACTOR'; END IF;
 IF target_kind IS NULL OR target_kind NOT IN ('publication','collection') OR target_key IS NULL OR target_key !~ '^[a-f0-9]{64}$' OR
    payload_sha256 IS NULL OR payload_sha256 !~ '^[a-f0-9]{64}$' OR payload_text IS NULL OR
    octet_length(payload_text)>524288 OR (target_kind='publication' AND octet_length(payload_text)>196608) OR
    encode(sha256(convert_to(payload_text,'UTF8')),'hex')<>payload_sha256 THEN RAISE EXCEPTION 'NB_BILIBILI_ACCOUNT_DIGEST'; END IF;
 BEGIN p:=payload_text::jsonb; EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'NB_BILIBILI_ACCOUNT_PAYLOAD'; END;
 IF target_kind='publication' THEN
  IF NOT social_sync.valid_observation(p) OR p->>'platform'<>'bilibili' OR p->>'kind'<>'video' OR
     social_sync.publication_key('bilibili',p->>'accountId',p->>'publicationId')<>target_key THEN RAISE EXCEPTION 'NB_BILIBILI_ACCOUNT_PAYLOAD'; END IF;
  account:=p->>'accountId';observed:=p->>'observedAt';work:=p->>'workId';
 ELSE
  IF NOT social_sync.valid_collection(p) OR social_sync.collection_key(p->'target'->>'accountId',p->'target'->>'kind',p->'target'->>'collectionId')<>target_key THEN
   RAISE EXCEPTION 'NB_BILIBILI_ACCOUNT_PAYLOAD';
  END IF;
  account:=p->'target'->>'accountId';observed:=p->>'observedAt';
 END IF;
 -- The same lock order for every enrollment also serializes the shared website capacity.
 PERFORM pg_advisory_xact_lock(hashtextextended('bilibili-account-enrollment',0));
 IF target_kind='publication' THEN
  SELECT * INTO b FROM social_sync.bindings WHERE publication_key=target_key;old_exists:=FOUND;
  IF old_exists AND (NOT b.enabled OR b.work_id<>work OR b.platform<>'bilibili' OR b.account_id<>account) THEN RAISE EXCEPTION 'NB_BILIBILI_ACCOUNT_BINDING'; END IF;
 ELSE
  SELECT * INTO c FROM social_sync.collection_bindings WHERE collection_key=target_key;old_exists:=FOUND;
  IF old_exists AND (NOT c.enabled OR c.account_id<>account) THEN RAISE EXCEPTION 'NB_BILIBILI_ACCOUNT_BINDING'; END IF;
 END IF;
 IF NOT old_exists THEN
  PERFORM 1 FROM social_sync.bilibili_accounts a WHERE a.account_id=account AND a.enabled FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NB_BILIBILI_ACCOUNT_UNAUTHORIZED'; END IF;
  IF observed::timestamptz>statement_timestamp()+interval '30 seconds' OR observed::timestamptz<statement_timestamp()-interval '24 hours' THEN RAISE EXCEPTION 'NB_BILIBILI_ACCOUNT_STALE'; END IF;
  IF (SELECT count(*) FROM social_sync.retained_publications WHERE approved)+(SELECT count(*) FROM social_sync.retained_collections WHERE approved)>=500 THEN
   RAISE EXCEPTION 'NB_BILIBILI_ACCOUNT_CAPACITY';
  END IF;
  IF target_kind='publication' THEN
   IF work<>'ba_'||left(target_key,40) OR p->'collection'<>'null'::jsonb OR
      (p->>'publishedAt')::timestamptz>observed::timestamptz+interval '30 seconds' THEN RAISE EXCEPTION 'NB_BILIBILI_ACCOUNT_WORK'; END IF;
   INSERT INTO social_sync.works(work_id,title,occurred_at,approved) VALUES(work,p->>'title',p->>'publishedAt',true);
   INSERT INTO social_sync.bindings(platform,account_id,publication_id,work_id,enabled) VALUES('bilibili',account,p->>'publicationId',work,true);
  ELSE
   INSERT INTO social_sync.collection_bindings(account_id,kind,collection_id,enabled) VALUES(account,p->'target'->>'kind',p->'target'->>'collectionId',true);
  END IF;
  INSERT INTO social_sync.bilibili_auto_bindings(target_kind,target_key,account_id) VALUES(ingest_bilibili_account.target_kind,ingest_bilibili_account.target_key,account);
 END IF;
 IF target_kind='publication' THEN
  RETURN QUERY SELECT r.key,r.sha256 FROM social_sync.ingest(target_key,payload_sha256,payload_text) r;
  IF NOT old_exists THEN
   INSERT INTO social_sync.retained_publications(publication_key,work_id,approved,reviewed_at,reviewed_kind,approved_source_sha256,source_sha256,outbound_url,link_checked_at)
    VALUES(target_key,work,true,statement_timestamp(),'video',payload_sha256,payload_sha256,p->>'originalUrl',observed::timestamptz);
  END IF;
 ELSE
  RETURN QUERY SELECT r.key,r.sha256 FROM social_sync.ingest_collection(target_key,payload_sha256,payload_text) r;
  IF NOT old_exists THEN
   -- A multi-P video's canonical URL was actually fetched. A season list link has
   -- not been visited by this HTTP sampler, so it remains unknown instead of faking proof.
   canonical:=CASE WHEN p->'target'->>'kind'='multi-part' THEN p->'target'->>'representativeUrl' ELSE NULL END;
   checked:=CASE WHEN canonical IS NULL THEN NULL ELSE observed::timestamptz END;
   INSERT INTO social_sync.retained_collections(collection_key,approved,reviewed_at,title,approved_source_sha256,source_sha256,approved_member_keys,follow_public_members,outbound_url,link_checked_at)
    SELECT s.collection_key,true,statement_timestamp(),p->>'title',s.payload_sha256,s.payload_sha256,s.member_review_keys,true,canonical,checked
    FROM social_sync.collection_states s WHERE s.collection_key=target_key;
  END IF;
 END IF;
 RETURN;
END $$;
REVOKE EXECUTE ON FUNCTION social_sync.ingest_bilibili_account(text,text,text,text) FROM PUBLIC,anon,authenticated,service_role,nb_social_reader,nb_social_worker;
GRANT EXECUTE ON FUNCTION social_sync.ingest_bilibili_account(text,text,text,text) TO nb_social_worker;

-- Register an actually visited canonical season link only on an automatically created,
-- still accepted card. The worker cannot change a manual card, revive a denial, or
-- choose another account/URL. This is link evidence, not a new statistics observation.
CREATE FUNCTION social_sync.bind_bilibili_season_link(target_key text,outbound text,checked_text text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r social_sync.retained_collections; b social_sync.collection_bindings; s social_sync.collection_states; checked timestamptz; BEGIN
 IF session_user<>'nb_social_worker' OR target_key IS NULL OR target_key !~ '^[a-f0-9]{64}$' OR outbound IS NULL OR
    checked_text IS NULL OR NOT social_sync.valid_time(to_jsonb(checked_text)) THEN RAISE EXCEPTION 'NB_BILIBILI_LINK_INVALID'; END IF;
 checked:=checked_text::timestamptz;
 IF checked>statement_timestamp()+interval '30 seconds' OR checked<statement_timestamp()-interval '24 hours' THEN RAISE EXCEPTION 'NB_BILIBILI_LINK_STALE'; END IF;
 SELECT * INTO b FROM social_sync.collection_bindings WHERE collection_key=target_key AND enabled AND kind='season';
 IF NOT FOUND OR outbound<>'https://space.bilibili.com/'||b.account_id||'/lists/'||b.collection_id||'?type=season' THEN RAISE EXCEPTION 'NB_BILIBILI_LINK_SCOPE'; END IF;
 PERFORM 1 FROM social_sync.bilibili_auto_bindings m JOIN social_sync.bilibili_accounts a USING(account_id)
  WHERE m.target_kind='collection' AND m.target_key=bind_bilibili_season_link.target_key AND m.account_id=b.account_id AND a.enabled FOR SHARE OF a;
 IF NOT FOUND THEN RAISE EXCEPTION 'NB_BILIBILI_LINK_SCOPE'; END IF;
 SELECT * INTO r FROM social_sync.retained_collections WHERE collection_key=target_key AND approved AND follow_public_members FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NB_BILIBILI_LINK_DENIED'; END IF;
 IF r.outbound_url IS NOT NULL THEN
  IF r.outbound_url=outbound THEN RETURN true; END IF;
  RAISE EXCEPTION 'NB_BILIBILI_LINK_ALREADY_SET';
 END IF;
 SELECT * INTO s FROM social_sync.collection_states WHERE collection_key=target_key;
 IF NOT FOUND OR s.payload_sha256<>r.source_sha256 THEN RAISE EXCEPTION 'NB_BILIBILI_LINK_SOURCE'; END IF;
 UPDATE social_sync.retained_collections SET outbound_url=outbound,link_checked_at=checked,reviewed_at=statement_timestamp(),
  approved_source_sha256=s.payload_sha256,approved_member_keys=s.member_review_keys WHERE collection_key=target_key;
 RETURN true;
END $$;
REVOKE EXECUTE ON FUNCTION social_sync.bind_bilibili_season_link(text,text,text) FROM PUBLIC,anon,authenticated,service_role,nb_social_worker,nb_social_reader;
GRANT EXECUTE ON FUNCTION social_sync.bind_bilibili_season_link(text,text,text) TO nb_social_worker;

-- A season can take in a BV that already has its own multi-P card. Fold that
-- child too; keep a user's explicit standalone override and restore it when the
-- parent is revoked. The projection shape and invoker/RLS boundary do not change.
CREATE OR REPLACE VIEW social_sync.retained_website_collections WITH(security_invoker=true,security_barrier=true) AS
 SELECT r.collection_key,r.account_id,r.kind,r.collection_id,r.card AS collection
 FROM social_sync.retained_collections r WHERE r.approved AND (r.kind<>'multi-part' OR
  EXISTS(SELECT 1 FROM social_sync.collection_standalone_overrides o WHERE o.publication_key=r.member_publication_keys->>0 AND o.keep_standalone) OR
  NOT EXISTS(SELECT 1 FROM social_sync.retained_collections parent WHERE parent.approved AND parent.kind='season' AND parent.account_id=r.account_id AND
   parent.member_publication_keys @> r.member_publication_keys));
COMMIT;
