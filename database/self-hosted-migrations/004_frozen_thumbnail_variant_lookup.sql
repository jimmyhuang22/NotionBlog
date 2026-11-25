-- Install after 003. Keep both capability digests and the publication trigger.
BEGIN;
SET LOCAL search_path = pg_catalog;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SELECT nb_freeze.lock_state();

DO $$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'nb_freeze.media(uuid,text)'::regprocedure)
       IS DISTINCT FROM '8e895bcf5f80d0276128ddb648b566ce'
     OR (SELECT count(*) = 2 AND bool_and(indisvalid AND indisready) FROM pg_index
         WHERE indexrelid IN (to_regclass('nb_thumbnails.frozen_variant_keys'),
                             to_regclass('nb_thumbnails.frozen_variant_overflow'))
           AND indrelid = 'nb_thumbnails.media'::regclass) IS DISTINCT FROM true
     OR (SELECT nb_freeze_api.check_capability(migration_digest) FROM nb_freeze.state WHERE singleton)
        IS DISTINCT FROM true
     OR (SELECT nb_freeze_payload_api.check_capability(digest)
         FROM nb_freeze_payload.migrations WHERE singleton) IS DISTINCT FROM true
  THEN RAISE EXCEPTION 'NB_FROZEN_THUMBNAIL_LOOKUP_BASE_MISMATCH';
  END IF;
END $$;

CREATE VIEW nb_freeze.thumbnail_variant_keys AS
SELECT parent_asset_id, parent_sha, descriptor,
       (CASE WHEN octet_length(descriptor::text) <= 1400
             THEN descriptor::text END) COLLATE "C" AS descriptor_key
FROM nb_thumbnails.media
WHERE version = 'v2';

-- The inner LIMITs need an ordered index seek even when a generic plan
-- greatly underestimates the number of historical copies of one thumbnail.
CREATE FUNCTION nb_freeze.thumbnail_variants(p_asset text, p_sha text)
RETURNS SETOF jsonb LANGUAGE sql STABLE
SET search_path = pg_catalog SET enable_sort = off AS $$
  WITH RECURSIVE keys(descriptor_key) AS (
    (SELECT t.descriptor_key FROM nb_freeze.thumbnail_variant_keys t
     WHERE t.parent_asset_id = p_asset AND t.parent_sha = p_sha
       AND t.descriptor_key IS NOT NULL
     ORDER BY t.descriptor_key LIMIT 1)
    UNION ALL
    SELECT successor.descriptor_key
    FROM keys k
    CROSS JOIN LATERAL (
      SELECT t.descriptor_key FROM nb_freeze.thumbnail_variant_keys t
      WHERE t.parent_asset_id = p_asset AND t.parent_sha = p_sha
        AND t.descriptor_key > k.descriptor_key
      ORDER BY t.descriptor_key LIMIT 1
    ) successor
  )
  SELECT k.descriptor_key::jsonb FROM keys k
  UNION
  SELECT t.descriptor FROM nb_freeze.thumbnail_variant_keys t
  WHERE t.parent_asset_id = p_asset AND t.parent_sha = p_sha
    AND octet_length(t.descriptor::text) > 1400
$$;

REVOKE ALL ON nb_freeze.thumbnail_variant_keys FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION nb_freeze.thumbnail_variants(text,text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION nb_freeze.media(p_run uuid, p_id text)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
DECLARE originals jsonb; variants jsonb := '[]';
BEGIN
  SELECT COALESCE(jsonb_agg(m.descriptor), '[]') INTO originals
  FROM nb_v2.media m WHERE m.run_id = p_run AND m.owner_page_id = p_id;

  IF to_regclass('nb_thumbnails.media') IS NOT NULL THEN
    SELECT COALESCE(jsonb_agg(t.descriptor), '[]') INTO variants
    FROM nb_v2.media m
    CROSS JOIN LATERAL nb_freeze.thumbnail_variants(m.asset_id, m.descriptor->>'sha256') t(descriptor)
    WHERE m.run_id = p_run AND m.owner_page_id = p_id;
  END IF;

  RETURN (SELECT COALESCE(jsonb_agg(value ORDER BY value->>'assetId'), '[]')
    FROM (SELECT value FROM jsonb_array_elements(originals)
          UNION SELECT value FROM jsonb_array_elements(variants)) unique_media);
END $$;

DO $$
BEGIN
  IF (SELECT nb_freeze_api.check_capability(migration_digest) FROM nb_freeze.state WHERE singleton)
     IS DISTINCT FROM true
     OR (SELECT nb_freeze_payload_api.check_capability(digest)
         FROM nb_freeze_payload.migrations WHERE singleton) IS DISTINCT FROM true
  THEN RAISE EXCEPTION 'NB_FROZEN_THUMBNAIL_LOOKUP_CAPABILITY_MISMATCH';
  END IF;
  IF EXISTS (
    SELECT FROM nb_publication.state p CROSS JOIN nb_freeze.members f
    WHERE p.run_id IS NOT NULL AND nb_freeze.media(p.run_id, f.page_id) IS DISTINCT FROM f.media
  ) THEN RAISE EXCEPTION 'NB_FROZEN_THUMBNAIL_LOOKUP_MEDIA_CHANGED'; END IF;
END $$;
COMMIT;
