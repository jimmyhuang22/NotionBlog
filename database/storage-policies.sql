-- Optional Supabase adapter only; do not apply to standard PostgreSQL.
-- Use a NEW private bucket and audit existing global Storage policies before enabling.
BEGIN;
INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
VALUES('notionblog-media','notionblog-media',false,20971520,
  ARRAY['image/jpeg','image/png','image/webp','image/gif','image/avif']) ON CONFLICT(id) DO NOTHING;
DO $$ BEGIN
  IF NOT EXISTS(SELECT FROM storage.buckets WHERE id='notionblog-media' AND public=false
    AND file_size_limit=20971520 AND allowed_mime_types @> ARRAY['image/jpeg','image/png','image/webp','image/gif','image/avif']
    AND allowed_mime_types <@ ARRAY['image/jpeg','image/png','image/webp','image/gif','image/avif']) THEN
    RAISE EXCEPTION 'NB_BUCKET_CONFIGURATION_INVALID'; END IF;
END $$;
CREATE POLICY nb_media_read ON storage.objects FOR SELECT TO authenticated
USING(bucket_id='notionblog-media' AND name ~ '^sha256/[a-f0-9]{64}$' AND
  (auth.jwt()->'app_metadata'->>'notionblog_storage_role') IN ('reader','writer'));
CREATE POLICY nb_media_insert ON storage.objects FOR INSERT TO authenticated
WITH CHECK(bucket_id='notionblog-media' AND name ~ '^sha256/[a-f0-9]{64}$' AND
  (auth.jwt()->'app_metadata'->>'notionblog_storage_role')='writer');
-- No UPDATE/DELETE policy: immutable uploads, separate owner-controlled garbage collection.
COMMIT;
