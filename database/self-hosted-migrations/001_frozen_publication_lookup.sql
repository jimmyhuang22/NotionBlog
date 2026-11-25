-- Optional self-hosted display/freeze extensions. Install as their migration owner.
BEGIN;
SET LOCAL search_path = pg_catalog;
SET LOCAL lock_timeout = '5s';

SELECT nb_display.lock_state();
SELECT singleton FROM nb_freeze_payload.migrations WHERE singleton FOR UPDATE;
DO $$
BEGIN
  IF (SELECT nb_freeze_payload_api.check_capability(digest)
      FROM nb_freeze_payload.migrations WHERE singleton) IS DISTINCT FROM true
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'nb_display.find_asset(uuid,text)'::regprocedure)
        IS DISTINCT FROM '166507adc92eba89d88d6a5e08981633'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'nb_freeze_payload.assert_run(uuid)'::regprocedure)
        IS DISTINCT FROM 'b2a17928f9f3e55888a938379cee3f8d'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'nb_freeze_payload.page(uuid,text)'::regprocedure)
        IS DISTINCT FROM '0bf4ba5f9ddb0ddebee6fd61439c802c'
  THEN RAISE EXCEPTION 'NB_FROZEN_OPTIMIZATION_BASE_MISMATCH';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION nb_display.find_asset(p_run uuid, p_asset text)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
DECLARE
  media nb_v2.media;
  fingerprint text;
  candidate jsonb;
BEGIN
  SELECT * INTO media FROM nb_v2.media WHERE run_id = p_run AND asset_id = p_asset;
  IF media.asset_id IS NULL OR NOT nb_v2.record_eligible(p_run, media.owner_page_id) THEN
    RETURN NULL;
  END IF;
  IF to_regclass('nb_v2_media.sources') IS NOT NULL THEN
    SELECT binding->>'sourceFingerprint' INTO fingerprint
    FROM nb_v2_media.sources WHERE run_id = p_run AND asset_id = p_asset;
  END IF;

  SELECT f.asset INTO candidate
  FROM nb_display.frozen f JOIN nb_freeze.members m ON m.group_id = f.group_id
  WHERE m.page_id = media.owner_page_id AND f.asset_id = p_asset;
  IF candidate IS NOT NULL THEN
    IF candidate->>'ownerPageId' = media.owner_page_id
       AND candidate->>'sourceSha256' = media.descriptor->>'sha256'
       AND (fingerprint IS NULL OR candidate->>'sourceFingerprint' = fingerprint) THEN
      RETURN candidate;
    END IF;
    RETURN NULL;
  END IF;

  -- Keep identity tests outside the primary-key probe. Under a generic plan
  -- combining them can make PostgreSQL visit every historical copy first.
  SELECT asset INTO candidate FROM nb_display.assets
  WHERE run_id = p_run AND asset_id = p_asset;
  IF candidate->>'ownerPageId' = media.owner_page_id
     AND candidate->>'sourceSha256' = media.descriptor->>'sha256'
     AND (fingerprint IS NULL OR candidate->>'sourceFingerprint' = fingerprint) THEN
    RETURN candidate;
  END IF;

  IF fingerprint IS NULL THEN RETURN NULL; END IF;
  SELECT x.asset INTO candidate FROM nb_display.assets x
  WHERE x.asset_id = p_asset AND x.asset->>'ownerPageId' = media.owner_page_id
    AND x.asset->>'sourceSha256' = media.descriptor->>'sha256'
    AND x.asset->>'sourceFingerprint' = fingerprint
  ORDER BY x.run_id DESC LIMIT 1;
  RETURN candidate;
END $$;

CREATE OR REPLACE FUNCTION nb_freeze_payload.assert_run(p_run uuid)
RETURNS void LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
DECLARE
  frozen record;
  actual jsonb;
BEGIN
  PERFORM nb_freeze_payload.assert_complete();
  FOR frozen IN SELECT page_id, payload FROM nb_freeze_payload.pages LOOP
    -- Capture may select historical donors. Validation compares the candidate
    -- run's own rows with the stored snapshot, including a missing/extra row.
    WITH media AS MATERIALIZED (
      SELECT m.* FROM nb_v2.media m
      WHERE m.run_id = p_run AND m.owner_page_id = frozen.page_id
    )
    SELECT jsonb_build_object(
      'record', nb_freeze.record(p_run, frozen.page_id),
      'source', (SELECT to_jsonb(s) FROM nb_v2.sources s
                 JOIN nb_v2.records r ON r.source_key = s.key
                 WHERE r.run_id = p_run AND r.id = frozen.page_id),
      'media', COALESCE((SELECT jsonb_agg(to_jsonb(m) - 'run_id' ORDER BY m.asset_id)
                         FROM media m), '[]'),
      'sources', COALESCE((SELECT jsonb_agg(to_jsonb(b) - 'run_id' ORDER BY b.asset_id)
                           FROM media m JOIN nb_v2_media.sources b USING (run_id, asset_id)), '[]'),
      'thumbnails', COALESCE((SELECT jsonb_agg(to_jsonb(t) - 'run_id' ORDER BY (to_jsonb(t) - 'run_id')::text)
                              FROM media m JOIN nb_thumbnails.media t
                                ON t.run_id = m.run_id AND t.parent_asset_id = m.asset_id
                              WHERE t.version = 'v2'), '[]'),
      'display', COALESCE((SELECT jsonb_agg(to_jsonb(a) - 'run_id' ORDER BY a.asset_id)
                           FROM media m JOIN nb_display.assets a USING (run_id, asset_id)), '[]')
    ) INTO actual;
    IF actual IS DISTINCT FROM frozen.payload THEN RAISE EXCEPTION 'NB_FREEZE_PROTECTED'; END IF;
  END LOOP;
  IF EXISTS (SELECT FROM nb_v2.records r JOIN nb_freeze.members m ON m.page_id = r.parent_id
             WHERE r.run_id = p_run AND NOT EXISTS (
               SELECT FROM nb_freeze.members c WHERE c.page_id = r.id AND c.group_id = m.group_id
             )) THEN RAISE EXCEPTION 'NB_FREEZE_PROTECTED'; END IF;
  IF EXISTS (SELECT FROM nb_v2.media m WHERE m.run_id = p_run AND nb_v2.record_eligible(p_run, m.owner_page_id)
             AND nb_display.find_asset(p_run, m.asset_id) IS NULL)
  THEN RAISE EXCEPTION 'NB_DISPLAY_MEDIA_NOT_READY'; END IF;
END $$;

-- Update only the two reviewed definitions. Both capability protocols verify
-- all their other fingerprints, grants and guards again before committing.
UPDATE nb_display.migrations SET definitions = jsonb_set(definitions, ARRAY[p.oid::regprocedure::text],
  to_jsonb(md5(pg_get_functiondef(p.oid))), false)
FROM pg_proc p WHERE singleton AND p.oid = 'nb_display.find_asset(uuid,text)'::regprocedure;
UPDATE nb_freeze_payload.migrations SET definitions = jsonb_set(definitions, ARRAY[p.oid::regprocedure::text],
  to_jsonb(md5(pg_get_functiondef(p.oid) || COALESCE(p.proacl::text, '') || pg_get_userbyid(p.proowner))), false)
FROM pg_proc p WHERE singleton AND p.oid = 'nb_freeze_payload.assert_run(uuid)'::regprocedure;
DO $$
BEGIN
  IF (SELECT nb_display_api.check_capability(digest) FROM nb_display.migrations WHERE singleton) IS DISTINCT FROM true
     OR (SELECT nb_freeze_payload_api.check_capability(digest)
         FROM nb_freeze_payload.migrations WHERE singleton) IS DISTINCT FROM true
  THEN RAISE EXCEPTION 'NB_FROZEN_OPTIMIZATION_CAPABILITY_MISMATCH'; END IF;
END $$;
COMMIT;
