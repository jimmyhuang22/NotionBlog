-- Keep an independently verified publication cover until its replacement is ready.
-- Candidate qualification remains exact; reader continuity never grants publication scope.
BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM social_sync.cover_meta WHERE singleton AND version=1) THEN
  RAISE EXCEPTION 'NB_SOCIAL_COVER_PROTOCOL';
 END IF;
END $$;

-- Never infer continuity for an already-hidden binding. Keep its object metadata
-- available to the media worker for encoding reuse and independent verification.
ALTER TABLE social_sync.cover_bindings ADD COLUMN continuity_ready boolean NOT NULL DEFAULT false;
UPDATE social_sync.cover_bindings b SET continuity_ready=true WHERE b.owner_kind='publication' AND
 social_sync.cover_owner_visible(b.display_mode,b.owner_kind,b.owner_key) AND
 social_sync.cover_source_matches(b.display_mode,b.owner_kind,b.owner_key,b.source_sha256);

CREATE OR REPLACE FUNCTION social_sync.sync_cover_source() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF session_user NOT IN ('nb_social_worker','postgres','supabase_admin') OR TG_TABLE_SCHEMA<>'social_sync' OR
  TG_TABLE_NAME<>'publications' OR TG_LEVEL<>'ROW' OR TG_WHEN<>'AFTER' THEN RAISE EXCEPTION 'NB_SOCIAL_COVER_ACTOR'; END IF;
 IF TG_OP='DELETE' THEN DELETE FROM social_sync.cover_sources WHERE owner_kind='publication' AND owner_key=OLD.publication_key;
 ELSE
  INSERT INTO social_sync.cover_sources(display_mode,owner_kind,owner_key,source_sha256,observed_at,publication_kind)
  SELECT mode,'publication',NEW.publication_key,CASE WHEN NEW.payload->>'coverUrl' IS NULL THEN NULL ELSE
   encode(sha256(convert_to(NEW.payload->>'coverUrl','UTF8')),'hex') END,NEW.observed_at,NEW.payload->>'kind' FROM (VALUES('trial'),('retained')) modes(mode)
  ON CONFLICT(display_mode,owner_kind,owner_key) DO UPDATE SET source_sha256=EXCLUDED.source_sha256,observed_at=EXCLUDED.observed_at,publication_kind=EXCLUDED.publication_kind;
  -- Lock/update the source first. Registration takes the same source lock and cannot
  -- publish an older candidate after a completed removal. A destructive transition
  -- also discards the binding, so adding a cover/type back cannot resurrect it.
  IF NEW.payload->>'coverUrl' IS NULL OR (TG_OP='UPDATE' AND OLD.payload->>'kind' IS DISTINCT FROM NEW.payload->>'kind') THEN
   DELETE FROM social_sync.cover_bindings WHERE owner_kind='publication' AND owner_key=NEW.publication_key;
  END IF;
 END IF;
 RETURN NULL;
END $$;

CREATE FUNCTION social_sync.guard_cover_binding() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE expected text;
BEGIN
 IF session_user NOT IN ('nb_social_media_worker','postgres','supabase_admin') OR TG_TABLE_SCHEMA<>'social_sync' OR
  TG_TABLE_NAME<>'cover_bindings' OR TG_LEVEL<>'ROW' OR TG_WHEN<>'BEFORE' OR TG_OP NOT IN ('INSERT','UPDATE') THEN
  RAISE EXCEPTION 'NB_SOCIAL_COVER_ACTOR';
 END IF;
 SELECT s.source_sha256 INTO expected FROM social_sync.cover_sources s
  WHERE s.display_mode=NEW.display_mode AND s.owner_kind=NEW.owner_kind AND s.owner_key=NEW.owner_key FOR UPDATE;
 IF NOT FOUND OR expected IS NULL OR expected IS DISTINCT FROM NEW.source_sha256 OR
  NOT social_sync.cover_owner_visible(NEW.display_mode,NEW.owner_kind,NEW.owner_key) OR
  NOT social_sync.cover_source_matches(NEW.display_mode,NEW.owner_kind,NEW.owner_key,NEW.source_sha256) THEN
  RAISE EXCEPTION 'NB_SOCIAL_COVER_SOURCE_CHANGED';
 END IF;
 NEW.continuity_ready := true;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_cover_binding BEFORE INSERT OR UPDATE ON social_sync.cover_bindings
 FOR EACH ROW EXECUTE FUNCTION social_sync.guard_cover_binding();

CREATE FUNCTION social_sync.cover_binding_readable(mode text,kind text,key text,source text) RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT CASE WHEN kind='publication' THEN EXISTS(
  SELECT 1 FROM social_sync.cover_sources s WHERE s.display_mode=mode AND s.owner_kind=kind AND s.owner_key=key
   AND s.source_sha256 IS NOT NULL AND social_sync.cover_source_matches(mode,kind,key,s.source_sha256))
 ELSE social_sync.cover_source_matches(mode,kind,key,source) END
$$;
ALTER POLICY cover_bindings_reader ON social_sync.cover_bindings USING(
 social_sync.cover_owner_visible(display_mode,owner_kind,owner_key) AND
 (social_sync.cover_source_matches(display_mode,owner_kind,owner_key,source_sha256) OR
  (owner_kind='publication' AND continuity_ready AND social_sync.cover_binding_readable(display_mode,owner_kind,owner_key,source_sha256))));

-- The statistics worker still cannot approve/read/write media. Registration still
-- checks the exact current digest with the original INSERT/UPDATE WITH CHECK.
REVOKE EXECUTE ON FUNCTION social_sync.guard_cover_binding(),social_sync.cover_binding_readable(text,text,text,text)
 FROM PUBLIC,anon,authenticated,service_role,nb_reader,nb_social_worker,nb_social_reader,nb_social_media_worker;
GRANT EXECUTE ON FUNCTION social_sync.cover_binding_readable(text,text,text,text) TO nb_social_reader;
COMMIT;
