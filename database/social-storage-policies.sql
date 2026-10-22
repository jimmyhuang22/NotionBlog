-- Optional Supabase adapter: audit existing global policies before installing.
-- Dedicated Auth accounts use ONLY app_metadata.notionblog_social_storage_role.
-- Existing Notion bucket and policies remain independent.
BEGIN;
INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
VALUES('notionblog-social-media','notionblog-social-media',false,20971520,
  ARRAY['image/jpeg','image/png','image/webp','image/gif','image/avif']) ON CONFLICT(id) DO NOTHING;
DO $$ BEGIN
  IF NOT EXISTS(SELECT FROM storage.buckets WHERE id='notionblog-social-media' AND public=false
    AND file_size_limit=20971520 AND allowed_mime_types @> ARRAY['image/jpeg','image/png','image/webp','image/gif','image/avif']
    AND allowed_mime_types <@ ARRAY['image/jpeg','image/png','image/webp','image/gif','image/avif']) THEN
    RAISE EXCEPTION 'NB_SOCIAL_BUCKET_CONFIGURATION_INVALID'; END IF;
END $$;
CREATE POLICY nb_social_media_read ON storage.objects FOR SELECT TO authenticated
USING(bucket_id='notionblog-social-media' AND name ~ '^sha256/[a-f0-9]{64}$' AND
  (auth.jwt()->'app_metadata'->>'notionblog_social_storage_role') IN ('reader','writer') AND
  NOT ((auth.jwt()->'app_metadata') ? 'notionblog_storage_role'));
CREATE POLICY nb_social_media_insert ON storage.objects FOR INSERT TO authenticated
WITH CHECK(bucket_id='notionblog-social-media' AND name ~ '^sha256/[a-f0-9]{64}$' AND
  (auth.jwt()->'app_metadata'->>'notionblog_social_storage_role')='writer' AND
  NOT ((auth.jwt()->'app_metadata') ? 'notionblog_storage_role'));
-- No UPDATE/DELETE policy; uploads remain immutable.
COMMIT;
