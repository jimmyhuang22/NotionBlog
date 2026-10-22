-- Default-off own-account discovery. Install separately after the operator reviews scope.
BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM social_sync.meta WHERE singleton AND http_note_version=1) OR
    (SELECT md5(prosrc) FROM pg_proc WHERE oid='social_sync.guard_retained_publication()'::regprocedure)<>'fd4c9ca4f523e78ac49c30844038f178' THEN
  RAISE EXCEPTION 'NB_XHS_ACCOUNT_BASE_CHANGED';
 END IF;
END $$;
ALTER TABLE social_sync.meta ADD COLUMN xhs_account_version integer NOT NULL DEFAULT 1 CHECK(xhs_account_version=1);
CREATE TABLE social_sync.xiaohongshu_accounts(
 account_id text PRIMARY KEY CHECK(account_id ~ '^[a-f0-9]{24}$'),
 enabled boolean NOT NULL DEFAULT false,authorized_at timestamptz NOT NULL DEFAULT statement_timestamp()
);
CREATE TABLE social_sync.xiaohongshu_auto_bindings(
 publication_key text PRIMARY KEY CHECK(publication_key ~ '^[a-f0-9]{64}$'),
 account_id text NOT NULL REFERENCES social_sync.xiaohongshu_accounts(account_id),
 registered_at timestamptz NOT NULL DEFAULT statement_timestamp()
);
ALTER TABLE social_sync.xiaohongshu_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_sync.xiaohongshu_auto_bindings ENABLE ROW LEVEL SECURITY;
CREATE POLICY xhs_account_private ON social_sync.xiaohongshu_accounts FOR ALL TO PUBLIC USING(false) WITH CHECK(false);
CREATE POLICY xhs_auto_private ON social_sync.xiaohongshu_auto_bindings FOR ALL TO PUBLIC USING(false) WITH CHECK(false);
REVOKE ALL ON social_sync.xiaohongshu_accounts,social_sync.xiaohongshu_auto_bindings FROM PUBLIC,anon,authenticated,service_role,nb_social_worker,nb_social_reader;

CREATE FUNCTION social_sync.xiaohongshu_account_enabled(account text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF session_user<>'nb_social_worker' OR account IS NULL OR account !~ '^[a-f0-9]{24}$' THEN RAISE EXCEPTION 'NB_XHS_ACCOUNT_ACTOR';END IF;
 RETURN EXISTS(SELECT 1 FROM social_sync.xiaohongshu_accounts a WHERE a.account_id=account AND a.enabled);
END $$;
REVOKE EXECUTE ON FUNCTION social_sync.xiaohongshu_account_enabled(text) FROM PUBLIC,anon,authenticated,service_role,nb_social_reader,nb_social_worker;
GRANT EXECUTE ON FUNCTION social_sync.xiaohongshu_account_enabled(text) TO nb_social_worker;

-- A fixed, account-bound operation; no table grants, arbitrary approvals or resurrection.
CREATE FUNCTION social_sync.ingest_xiaohongshu_account(target_key text,payload_sha256 text,payload_text text,outbound text,checked_text text)
RETURNS TABLE(key text,sha256 text) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p jsonb;b social_sync.bindings;old_exists boolean;account text;work text;checked timestamptz;BEGIN
 IF session_user<>'nb_social_worker' THEN RAISE EXCEPTION 'NB_XHS_ACCOUNT_ACTOR'; END IF;
 IF target_key IS NULL OR target_key !~ '^[a-f0-9]{64}$' OR payload_sha256 IS NULL OR payload_sha256 !~ '^[a-f0-9]{64}$' OR
    payload_text IS NULL OR octet_length(payload_text)>196608 OR encode(sha256(convert_to(payload_text,'UTF8')),'hex')<>payload_sha256 THEN
  RAISE EXCEPTION 'NB_XHS_ACCOUNT_DIGEST';
 END IF;
 BEGIN p:=payload_text::jsonb;EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'NB_XHS_ACCOUNT_PAYLOAD';END;
 IF NOT social_sync.valid_observation(p) OR p->>'platform'<>'xiaohongshu' OR p->>'source' NOT IN ('public-note-page-ssr','browser-note-state') OR
    social_sync.publication_key('xiaohongshu',p->>'accountId',p->>'publicationId')<>target_key THEN RAISE EXCEPTION 'NB_XHS_ACCOUNT_PAYLOAD';END IF;
 account:=p->>'accountId';work:=p->>'workId';
 -- Same lock as Bilibili enrollment: both share the 500-card retained capacity.
 PERFORM pg_advisory_xact_lock(hashtextextended('bilibili-account-enrollment',0));
 PERFORM 1 FROM social_sync.xiaohongshu_accounts a WHERE a.account_id=account AND a.enabled FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NB_XHS_ACCOUNT_UNAUTHORIZED';END IF;
 SELECT * INTO b FROM social_sync.bindings WHERE publication_key=target_key;old_exists:=FOUND;
 IF old_exists AND (NOT b.enabled OR b.work_id<>work OR b.platform<>'xiaohongshu' OR b.account_id<>account OR b.publication_id<>p->>'publicationId') THEN
  RAISE EXCEPTION 'NB_XHS_ACCOUNT_BINDING';END IF;
 IF NOT old_exists THEN
  IF work<>'xa_'||left(target_key,40) OR p->>'publishedAt' IS NULL OR (p->>'publishedAt')::timestamptz>(p->>'observedAt')::timestamptz+interval '30 seconds' OR
     (p->>'observedAt')::timestamptz>statement_timestamp()+interval '30 seconds' OR (p->>'observedAt')::timestamptz<statement_timestamp()-interval '1 hour' THEN
   RAISE EXCEPTION 'NB_XHS_ACCOUNT_WORK';END IF;
  IF outbound IS NULL OR outbound !~ ('^https://www\.xiaohongshu\.com/discovery/item/'||(p->>'publicationId')||'\?source=webshare&xhsshare=pc_web&xsec_token=[A-Za-z0-9_=-]{16,255}&xsec_source=pc_share$') OR checked_text IS NULL OR NOT social_sync.valid_time(to_jsonb(checked_text)) THEN
   RAISE EXCEPTION 'NB_XHS_ACCOUNT_LINK';END IF;
  checked:=checked_text::timestamptz;
  IF checked>statement_timestamp()+interval '30 seconds' OR checked<statement_timestamp()-interval '1 hour' THEN RAISE EXCEPTION 'NB_XHS_ACCOUNT_LINK_STALE';END IF;
  IF (SELECT count(*) FROM social_sync.retained_publications WHERE approved)+(SELECT count(*) FROM social_sync.retained_collections WHERE approved)>=500 THEN RAISE EXCEPTION 'NB_XHS_ACCOUNT_CAPACITY';END IF;
  INSERT INTO social_sync.works(work_id,title,occurred_at,approved) VALUES(work,p->>'title',p->>'publishedAt',true);
  INSERT INTO social_sync.bindings(platform,account_id,publication_id,work_id,enabled) VALUES('xiaohongshu',account,p->>'publicationId',work,true);
  INSERT INTO social_sync.xiaohongshu_auto_bindings(publication_key,account_id) VALUES(target_key,account);
 END IF;
 RETURN QUERY SELECT r.key,r.sha256 FROM social_sync.ingest(target_key,payload_sha256,payload_text) r;
 IF NOT old_exists THEN
  INSERT INTO social_sync.retained_publications(publication_key,work_id,approved,reviewed_at,reviewed_kind,approved_source_sha256,source_sha256,outbound_url,link_checked_at)
   VALUES(target_key,work,true,statement_timestamp(),p->>'kind',payload_sha256,payload_sha256,outbound,checked);
 END IF;
 RETURN;
END $$;
REVOKE EXECUTE ON FUNCTION social_sync.ingest_xiaohongshu_account(text,text,text,text,text) FROM PUBLIC,anon,authenticated,service_role,nb_social_reader,nb_social_worker;
GRANT EXECUTE ON FUNCTION social_sync.ingest_xiaohongshu_account(text,text,text,text,text) TO nb_social_worker;
COMMIT;
