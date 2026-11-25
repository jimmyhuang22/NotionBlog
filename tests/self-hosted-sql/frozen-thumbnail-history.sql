-- Run in a disposable self-hosted database after migrations 003 and 004.
BEGIN;
SET LOCAL plan_cache_mode = force_generic_plan;
SET LOCAL statement_timeout = '15s';

DO $$
DECLARE
  asset text := 'a1.' || repeat('f', 64);
  parent_sha text := repeat('e', 64);
  first_variant jsonb := '{"assetId":"small","byteSize":1}';
  same_id_variant jsonb := '{"assetId":"small","byteSize":2}';
  oversized jsonb := jsonb_build_object('assetId', 'large', 'legacyValue', repeat('汉', 500));
  actual jsonb;
  expected jsonb;
BEGIN
  INSERT INTO nb_thumbnails.media
    (version, run_id, parent_asset_id, parent_sha, source_fingerprint, width_cap, descriptor)
  SELECT 'v2', md5(n::text)::uuid, asset, parent_sha, repeat('d', 64), 400, first_variant
  FROM generate_series(1, 4000) n;

  INSERT INTO nb_thumbnails.media VALUES
    ('v2', md5('variant')::uuid, asset, parent_sha, repeat('d', 64), 400, same_id_variant),
    ('v2', md5('large-a')::uuid, asset, parent_sha, repeat('d', 64), 800, oversized),
    ('v2', md5('large-b')::uuid, asset, parent_sha, repeat('d', 64), 800, oversized),
    ('v1', md5('version')::uuid, asset, parent_sha, repeat('d', 64), 400, '{"assetId":"v1"}'),
    ('v2', md5('other-sha')::uuid, asset, repeat('0', 64), repeat('d', 64), 400, '{"assetId":"other-sha"}');

  SELECT jsonb_agg(value ORDER BY value) INTO actual FROM nb_freeze.thumbnail_variants(asset, parent_sha) value;
  SELECT jsonb_agg(value ORDER BY value) INTO expected FROM (VALUES (first_variant), (same_id_variant), (oversized)) t(value);
  IF actual IS DISTINCT FROM expected OR EXISTS (SELECT FROM nb_freeze.thumbnail_variants(asset, repeat('7', 64)))
  THEN RAISE EXCEPTION 'FROZEN_THUMBNAIL_SET_CHANGED'; END IF;

  IF has_function_privilege('nb_website_reader', 'nb_freeze.thumbnail_variants(text,text)', 'EXECUTE')
     OR has_table_privilege('nb_website_reader', 'nb_freeze.thumbnail_variant_keys', 'SELECT')
  THEN RAISE EXCEPTION 'FROZEN_THUMBNAIL_PRIVILEGE_CHANGED'; END IF;
END $$;
ROLLBACK;
