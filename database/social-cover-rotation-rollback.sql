-- Operator-only rollback after stopping the social media consumer.
-- Keep current bindings/objects; never restore bindings removed by a real withdrawal.
BEGIN;
ALTER POLICY cover_bindings_reader ON social_sync.cover_bindings USING(
 social_sync.cover_owner_visible(display_mode,owner_kind,owner_key) AND
 social_sync.cover_source_matches(display_mode,owner_kind,owner_key,source_sha256));
DROP TRIGGER guard_cover_binding ON social_sync.cover_bindings;
DROP FUNCTION social_sync.guard_cover_binding();
DROP FUNCTION social_sync.cover_binding_readable(text,text,text,text);
ALTER TABLE social_sync.cover_bindings DROP COLUMN continuity_ready;
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
 END IF;
 RETURN NULL;
END $$;
COMMIT;
