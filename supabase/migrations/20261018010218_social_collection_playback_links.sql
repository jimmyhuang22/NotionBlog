-- Additive playback evidence; existing payloads, approvals and reader views stay unchanged.
BEGIN;
CREATE TABLE social_sync.collection_playback_sources (
 collection_key text PRIMARY KEY REFERENCES social_sync.collection_bindings(collection_key),
 source_sha256 text NOT NULL CHECK(source_sha256 ~ '^[a-f0-9]{64}$'),
 observed_at text NOT NULL,
 members jsonb NOT NULL CHECK(jsonb_typeof(members)='array' AND jsonb_array_length(members)<=1000)
);
CREATE TABLE social_sync.collection_playback_links (
 collection_key text NOT NULL REFERENCES social_sync.collection_playback_sources(collection_key) ON DELETE CASCADE,
 publication_id text NOT NULL CHECK(publication_id ~ '^BV[0-9A-Za-z]{10}$'),
 outbound_url text, link_checked_at timestamptz, failure_code text,
 PRIMARY KEY(collection_key,publication_id),
 CHECK((outbound_url IS NULL)=(link_checked_at IS NULL)),
 CHECK(outbound_url IS NULL OR outbound_url='https://www.bilibili.com/video/'||publication_id||'/'),
 CHECK(failure_code IS NULL OR failure_code ~ '^[A-Z][A-Z_]{0,63}$'),
 CHECK(outbound_url IS NULL OR failure_code IS NULL)
);

CREATE FUNCTION social_sync.sync_collection_playback_source() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF TG_TABLE_SCHEMA<>'social_sync' OR TG_TABLE_NAME<>'collection_states' OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW' OR
    session_user NOT IN ('nb_social_worker','postgres','supabase_admin') THEN RAISE EXCEPTION 'NB_PLAYBACK_TRIGGER'; END IF;
 IF TG_OP='DELETE' THEN DELETE FROM social_sync.collection_playback_sources WHERE collection_key=OLD.collection_key; RETURN NULL; END IF;
 INSERT INTO social_sync.collection_playback_sources(collection_key,source_sha256,observed_at,members)
 SELECT NEW.collection_key,NEW.payload_sha256,NEW.observed_at,coalesce(jsonb_agg(jsonb_build_object(
  'id',m->>'id','key',social_sync.publication_key('bilibili',NEW.payload->'target'->>'accountId',m->>'id'),
  'publishedAt',m->'publishedAt') ORDER BY m->>'id'),'[]'::jsonb)
 FROM jsonb_array_elements(NEW.payload->'members') m
 ON CONFLICT(collection_key) DO UPDATE SET source_sha256=excluded.source_sha256,observed_at=excluded.observed_at,members=excluded.members;
 DELETE FROM social_sync.collection_playback_links l WHERE l.collection_key=NEW.collection_key AND
  NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.payload->'members') m WHERE m->>'id'=l.publication_id);
 RETURN NULL;
END $$;
CREATE TRIGGER collection_playback_source AFTER INSERT OR UPDATE OR DELETE ON social_sync.collection_states
 FOR EACH ROW EXECUTE FUNCTION social_sync.sync_collection_playback_source();
INSERT INTO social_sync.collection_playback_sources
 SELECT s.collection_key,s.payload_sha256,s.observed_at,coalesce(jsonb_agg(jsonb_build_object(
  'id',m->>'id','key',social_sync.publication_key('bilibili',s.payload->'target'->>'accountId',m->>'id'),'publishedAt',m->'publishedAt') ORDER BY m->>'id'),'[]'::jsonb)
 FROM social_sync.collection_states s CROSS JOIN LATERAL jsonb_array_elements(s.payload->'members') m
 GROUP BY s.collection_key,s.payload_sha256,s.observed_at;

-- Only a boolean denial check escapes these private tables. No approval is granted.
CREATE FUNCTION social_sync.collection_playback_member_allowed(pub_key text,display_mode text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF session_user NOT IN ('nb_social_reader','nb_social_worker','postgres','supabase_admin') OR pub_key IS NULL OR
    pub_key !~ '^[a-f0-9]{64}$' OR display_mode NOT IN ('trial','retained') OR display_mode IS NULL THEN RAISE EXCEPTION 'NB_PLAYBACK_SCOPE'; END IF;
 RETURN NOT EXISTS(SELECT 1 FROM social_sync.bindings b WHERE b.publication_key=pub_key AND NOT b.enabled) AND
  NOT EXISTS(SELECT 1 FROM social_sync.bindings b JOIN social_sync.works w USING(work_id) WHERE b.publication_key=pub_key AND NOT w.approved) AND
  CASE WHEN display_mode='retained' THEN NOT EXISTS(SELECT 1 FROM social_sync.retained_publications r WHERE r.publication_key=pub_key AND NOT r.approved)
   ELSE NOT EXISTS(SELECT 1 FROM social_sync.website_visibility v WHERE v.publication_key=pub_key AND NOT v.approved) END;
END $$;

ALTER TABLE social_sync.collection_playback_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_sync.collection_playback_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY playback_source_reader ON social_sync.collection_playback_sources FOR SELECT TO nb_social_reader USING(
 EXISTS(SELECT 1 FROM social_sync.website_collections c WHERE c.collection_key=collection_playback_sources.collection_key AND c.collection->>'observedAt'=observed_at) OR
 EXISTS(SELECT 1 FROM social_sync.retained_website_collections c WHERE c.collection_key=collection_playback_sources.collection_key AND c.collection->>'observedAt'=observed_at));
CREATE POLICY playback_links_reader ON social_sync.collection_playback_links FOR SELECT TO nb_social_reader USING(
 EXISTS(SELECT 1 FROM social_sync.collection_playback_sources s WHERE s.collection_key=collection_playback_links.collection_key AND
  EXISTS(SELECT 1 FROM jsonb_array_elements(s.members) m WHERE m->>'id'=publication_id)));
CREATE VIEW social_sync.website_collection_playbacks WITH(security_invoker=true,security_barrier=true) AS
 SELECT c.collection_key,m.value->>'key' AS publication_key,m.value->>'id' AS publication_id,m.value->>'publishedAt' AS published_at,
  l.outbound_url,to_char(l.link_checked_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS link_verified_at
 FROM social_sync.website_collections c JOIN social_sync.collection_playback_sources s USING(collection_key)
 CROSS JOIN LATERAL(SELECT value FROM jsonb_array_elements(s.members) WHERE value->>'publishedAt' IS NOT NULL AND
  social_sync.collection_playback_member_allowed(value->>'key','trial') ORDER BY value->>'publishedAt' DESC,value->>'key' LIMIT 1) m
 LEFT JOIN social_sync.collection_playback_links l ON l.collection_key=c.collection_key AND l.publication_id=m.value->>'id'
 WHERE s.observed_at=c.collection->>'observedAt' AND c.kind='season';
CREATE VIEW social_sync.retained_website_collection_playbacks WITH(security_invoker=true,security_barrier=true) AS
 SELECT c.collection_key,m.value->>'key' AS publication_key,m.value->>'id' AS publication_id,m.value->>'publishedAt' AS published_at,
  l.outbound_url,to_char(l.link_checked_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS link_verified_at
 FROM social_sync.retained_website_collections c JOIN social_sync.collection_playback_sources s USING(collection_key)
 CROSS JOIN LATERAL(SELECT value FROM jsonb_array_elements(s.members) WHERE value->>'publishedAt' IS NOT NULL AND
  social_sync.collection_playback_member_allowed(value->>'key','retained') ORDER BY value->>'publishedAt' DESC,value->>'key' LIMIT 1) m
 LEFT JOIN social_sync.collection_playback_links l ON l.collection_key=c.collection_key AND l.publication_id=m.value->>'id'
 WHERE s.observed_at=c.collection->>'observedAt' AND c.kind='season';

-- Used only by the restricted verifier. Explicitly repeat the parent policy under definer rights.
CREATE FUNCTION social_sync.collection_playback_parent_allowed(key text,sha text,display_mode text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM social_sync.collection_bindings b JOIN social_sync.collection_states s USING(collection_key)
  WHERE b.collection_key=key AND b.enabled AND b.kind='season' AND s.payload_sha256=sha AND
   CASE WHEN display_mode='retained' THEN EXISTS(SELECT 1 FROM social_sync.retained_collections r WHERE r.collection_key=key AND r.approved AND
    r.source_sha256=sha AND r.reviewed_at<=statement_timestamp()+interval '30 seconds' AND r.observed_at<=to_char((statement_timestamp()+interval '30 seconds') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
   WHEN display_mode='trial' THEN s.observed_at>=to_char((statement_timestamp()-interval '24 hours') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AND
    s.observed_at<=to_char((statement_timestamp()+interval '30 seconds') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AND
    EXISTS(SELECT 1 FROM social_sync.collection_visibility v WHERE v.collection_key=key AND v.approved AND v.checked_at<=statement_timestamp()+interval '30 seconds' AND v.valid_until>statement_timestamp()) AND
    social_sync.collection_members_approved(key,s.member_review_keys) ELSE false END)
$$;
CREATE FUNCTION social_sync.pending_collection_playbacks(keys jsonb,display_mode text) RETURNS SETOF jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF session_user<>'nb_social_worker' OR display_mode IS NULL OR display_mode NOT IN ('trial','retained') OR jsonb_typeof(keys) IS DISTINCT FROM 'array' OR
  jsonb_array_length(keys)>20 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(keys) k WHERE k IS NULL OR k !~ '^[a-f0-9]{64}$') THEN RAISE EXCEPTION 'NB_PLAYBACK_SCOPE'; END IF;
 RETURN QUERY SELECT jsonb_build_object('key',s.collection_key,'sourceSha256',s.source_sha256,'accountId',b.account_id,'collectionId',b.collection_id,
  'publicationId',m.value->>'id','publishedAt',m.value->>'publishedAt','members',s.members,'failureCode',l.failure_code)
 FROM social_sync.collection_playback_sources s JOIN social_sync.collection_bindings b USING(collection_key)
 CROSS JOIN LATERAL(SELECT value FROM jsonb_array_elements(s.members) WHERE value->>'publishedAt' IS NOT NULL AND
  social_sync.collection_playback_member_allowed(value->>'key',display_mode) ORDER BY value->>'publishedAt' DESC,value->>'key' LIMIT 1) m
 LEFT JOIN social_sync.collection_playback_links l ON l.collection_key=s.collection_key AND l.publication_id=m.value->>'id'
 WHERE keys ? s.collection_key AND social_sync.collection_playback_parent_allowed(s.collection_key,s.source_sha256,display_mode) AND
  l.outbound_url IS NULL ORDER BY s.collection_key;
END $$;
CREATE FUNCTION social_sync.complete_collection_playback(key text,sha text,bvid text,display_mode text,checked_text text,failure text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE chosen text; checked timestamptz; BEGIN
 IF session_user<>'nb_social_worker' OR key IS NULL OR key !~ '^[a-f0-9]{64}$' OR sha IS NULL OR sha !~ '^[a-f0-9]{64}$' OR
  bvid IS NULL OR bvid !~ '^BV[0-9A-Za-z]{10}$' OR display_mode IS NULL OR display_mode NOT IN ('trial','retained') OR
  (failure IS NOT NULL AND failure !~ '^[A-Z][A-Z_]{0,63}$') THEN RAISE EXCEPTION 'NB_PLAYBACK_SCOPE'; END IF;
 PERFORM 1 FROM social_sync.collection_states s WHERE s.collection_key=key AND s.payload_sha256=sha FOR SHARE;
 IF NOT FOUND OR NOT social_sync.collection_playback_parent_allowed(key,sha,display_mode) THEN RAISE EXCEPTION 'NB_PLAYBACK_STALE'; END IF;
 SELECT value->>'id' INTO chosen FROM social_sync.collection_playback_sources s CROSS JOIN LATERAL jsonb_array_elements(s.members)
 WHERE s.collection_key=key AND s.source_sha256=sha AND value->>'publishedAt' IS NOT NULL AND
 social_sync.collection_playback_member_allowed(value->>'key',display_mode) ORDER BY value->>'publishedAt' DESC,value->>'key' LIMIT 1;
 IF chosen IS DISTINCT FROM bvid THEN RAISE EXCEPTION 'NB_PLAYBACK_STALE'; END IF;
 IF failure IS NULL THEN
  IF checked_text IS NULL OR NOT social_sync.valid_time(to_jsonb(checked_text)) THEN RAISE EXCEPTION 'NB_PLAYBACK_TIME'; END IF;
  checked:=checked_text::timestamptz;
  IF checked>statement_timestamp()+interval '30 seconds' OR checked<statement_timestamp()-interval '5 minutes' THEN RAISE EXCEPTION 'NB_PLAYBACK_TIME'; END IF;
 END IF;
 INSERT INTO social_sync.collection_playback_links VALUES(key,bvid,CASE WHEN failure IS NULL THEN 'https://www.bilibili.com/video/'||bvid||'/' ELSE NULL END,checked,failure)
 ON CONFLICT(collection_key,publication_id) DO UPDATE SET outbound_url=excluded.outbound_url,link_checked_at=excluded.link_checked_at,failure_code=excluded.failure_code
 WHERE collection_playback_links.outbound_url IS NULL;
 RETURN true;
END $$;

REVOKE ALL ON social_sync.collection_playback_sources,social_sync.collection_playback_links,social_sync.website_collection_playbacks,social_sync.retained_website_collection_playbacks
 FROM PUBLIC,anon,authenticated,service_role,nb_social_worker,nb_social_reader;
GRANT SELECT ON social_sync.collection_playback_sources,social_sync.collection_playback_links,social_sync.website_collection_playbacks,social_sync.retained_website_collection_playbacks TO nb_social_reader;
REVOKE EXECUTE ON FUNCTION social_sync.sync_collection_playback_source(),social_sync.collection_playback_member_allowed(text,text),
 social_sync.collection_playback_parent_allowed(text,text,text),social_sync.pending_collection_playbacks(jsonb,text),social_sync.complete_collection_playback(text,text,text,text,text,text)
 FROM PUBLIC,anon,authenticated,service_role,nb_social_worker,nb_social_reader;
GRANT EXECUTE ON FUNCTION social_sync.collection_playback_member_allowed(text,text) TO nb_social_reader;
GRANT EXECUTE ON FUNCTION social_sync.pending_collection_playbacks(jsonb,text),social_sync.complete_collection_playback(text,text,text,text,text,text) TO nb_social_worker;
COMMIT;
