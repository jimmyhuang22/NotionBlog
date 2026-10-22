-- Per-collection opt-in: existing and newly approved rows remain fixed by default.
BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM social_sync.retained_meta WHERE singleton AND version=1) THEN
  RAISE EXCEPTION 'NB_SOCIAL_RETAINED_PROTOCOL';
 END IF;
END $$;
ALTER TABLE social_sync.retained_collections ADD COLUMN follow_public_members boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION social_sync.guard_retained_collection() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE s social_sync.collection_states; b social_sync.collection_bindings; review_changed boolean; expected_url text; BEGIN
 IF TG_OP='UPDATE' AND NEW.collection_key<>OLD.collection_key THEN RAISE EXCEPTION 'NB_SOCIAL_RETAINED_IDENTITY'; END IF;
 IF NEW.reviewed_at>statement_timestamp()+interval '30 seconds' THEN RAISE EXCEPTION 'NB_SOCIAL_RETAINED_FUTURE'; END IF;
 -- Revocation cannot leave a latent automatic-publication grant behind.
 IF NOT NEW.approved THEN NEW.follow_public_members:=false; RETURN NEW; END IF;
 SELECT * INTO b FROM social_sync.collection_bindings WHERE collection_key=NEW.collection_key AND enabled;
 IF NOT FOUND THEN RAISE EXCEPTION 'NB_SOCIAL_RETAINED_BINDING'; END IF;
 SELECT * INTO s FROM social_sync.collection_states WHERE collection_key=NEW.collection_key;
 IF NOT FOUND OR NEW.source_sha256 IS DISTINCT FROM s.payload_sha256 THEN RAISE EXCEPTION 'NB_SOCIAL_RETAINED_SOURCE'; END IF;
 review_changed:=TG_OP='INSERT' OR NOT OLD.approved OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at OR
    NEW.approved_member_keys IS DISTINCT FROM OLD.approved_member_keys OR NEW.approved_source_sha256 IS DISTINCT FROM OLD.approved_source_sha256 OR
    NEW.follow_public_members IS DISTINCT FROM OLD.follow_public_members;
 -- Enabling/disabling follows requires an operator-bound current baseline. Automatic
 -- source updates retain that baseline and the original review/link evidence.
 IF NOT NEW.follow_public_members OR review_changed THEN
  IF social_sync.retained_members_equal(NEW.approved_member_keys,s.member_review_keys) IS DISTINCT FROM true THEN
   RAISE EXCEPTION 'NB_SOCIAL_RETAINED_SOURCE';
  END IF;
 END IF;
 IF review_changed AND NEW.approved_source_sha256 IS DISTINCT FROM s.payload_sha256 THEN RAISE EXCEPTION 'NB_SOCIAL_RETAINED_REVIEW'; END IF;
 expected_url:=CASE WHEN b.kind='season'
  THEN 'https://space.bilibili.com/'||b.account_id||'/lists/'||b.collection_id||'?type=season'
  ELSE 'https://www.bilibili.com/video/'||b.collection_id||'/' END;
 IF NEW.outbound_url IS NOT NULL AND NEW.outbound_url IS DISTINCT FROM expected_url THEN RAISE EXCEPTION 'NB_SOCIAL_RETAINED_LINK'; END IF;
 NEW.account_id:=b.account_id;NEW.kind:=b.kind;NEW.collection_id:=b.collection_id;
 NEW.observed_at:=s.observed_at;NEW.member_publication_keys:=s.member_publication_keys;
 NEW.card:=s.card||jsonb_build_object('title',NEW.title,'originalUrl',NEW.outbound_url,
  'linkVerifiedAt',to_char(NEW.link_checked_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
 IF (NOT review_changed AND NOT NEW.follow_public_members) OR
    (TG_OP='UPDATE' AND OLD.approved AND NEW.follow_public_members IS DISTINCT FROM OLD.follow_public_members AND OLD.source_sha256=s.payload_sha256) THEN
  NEW.card:=NEW.card||jsonb_build_object('activity',OLD.card->'activity','latestAddition',OLD.card->'latestAddition');
 END IF;
 RETURN NEW;
END $$;

-- This is the existing trigger-only bridge, with the collection condition extended.
-- Worker/reader still cannot call it or write approval rows or the opt-in column.
CREATE OR REPLACE FUNCTION social_sync.sync_retained_source() RETURNS trigger
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
     AND (r.follow_public_members OR social_sync.retained_members_equal(r.approved_member_keys,NEW.member_review_keys))
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

REVOKE ALL (follow_public_members) ON social_sync.retained_collections FROM PUBLIC,anon,authenticated,service_role,nb_social_worker,nb_social_reader;
REVOKE EXECUTE ON FUNCTION social_sync.guard_retained_collection(),social_sync.sync_retained_source() FROM PUBLIC,anon,authenticated,service_role,nb_social_worker,nb_social_reader;
COMMIT;
