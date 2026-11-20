-- Disposable local restore after frozen-game-publication.sql with commit_local=true.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL plan_cache_mode = force_generic_plan;
SET LOCAL statement_timeout = '90s';
CREATE FUNCTION pg_temp.require(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'failed: %', label; END IF;
END $$;

DO $$
DECLARE
  published uuid := (SELECT run_id FROM nb_publication.state);
  picked record;
  current_asset jsonb;
  history_asset jsonb;
BEGIN
  PERFORM nb_freeze_payload.assert_run(published);
  SELECT m.asset_id, m.owner_page_id, a.asset, a.recipe INTO STRICT picked
  FROM nb_v2.media m JOIN nb_display.assets a USING (run_id, asset_id)
  JOIN nb_v2_media.sources b USING (run_id, asset_id)
  WHERE m.run_id = published AND b.binding->>'sourceFingerprint' IS NOT NULL
    AND nb_v2.record_eligible(published, m.owner_page_id)
    AND NOT EXISTS (SELECT FROM nb_freeze.members f WHERE f.page_id = m.owner_page_id)
  ORDER BY m.asset_id LIMIT 1;
  current_asset := picked.asset;
  history_asset := current_asset || '{"testOrigin":"historical"}';
  DELETE FROM nb_display.assets WHERE asset_id = picked.asset_id AND run_id <> published;
  INSERT INTO nb_display.assets VALUES
    ('00000000-0000-4000-a000-000000000001',picked.asset_id,picked.recipe,current_asset),
    ('ffffffff-ffff-4fff-afff-ffffffffffff',picked.asset_id,picked.recipe,history_asset);

  PERFORM pg_temp.require(nb_display.find_asset(published,picked.asset_id) = current_asset, 'current preferred');
  UPDATE nb_display.assets SET asset = asset || '{"ownerPageId":"invalid-owner"}'
  WHERE run_id = published AND asset_id = picked.asset_id;
  PERFORM pg_temp.require(nb_display.find_asset(published,picked.asset_id) = history_asset, 'newest matching donor');

  DELETE FROM nb_display.assets WHERE run_id = published AND asset_id = picked.asset_id;
  PERFORM pg_temp.require(nb_display.find_asset(published,picked.asset_id) = history_asset, 'missing current mapping');
  INSERT INTO nb_display.assets VALUES (published,picked.asset_id,picked.recipe,current_asset || '{"sourceSha256":"different"}');

  UPDATE nb_display.assets SET asset = asset || '{"sourceSha256":"different"}'
  WHERE asset_id = picked.asset_id AND run_id <> published;
  PERFORM pg_temp.require(nb_display.find_asset(published,picked.asset_id) IS NULL, 'wrong donor hash');
  UPDATE nb_display.assets SET asset = history_asset || '{"ownerPageId":"other-owner"}'
  WHERE asset_id = picked.asset_id AND run_id <> published;
  PERFORM pg_temp.require(nb_display.find_asset(published,picked.asset_id) IS NULL, 'wrong donor owner');
  UPDATE nb_display.assets SET asset = history_asset || '{"sourceFingerprint":"different"}'
  WHERE asset_id = picked.asset_id AND run_id <> published;
  PERFORM pg_temp.require(nb_display.find_asset(published,picked.asset_id) IS NULL, 'wrong donor fingerprint');
  UPDATE nb_display.assets SET asset = history_asset WHERE asset_id = picked.asset_id AND run_id <> published;
  DELETE FROM nb_v2_media.sources WHERE run_id = published AND asset_id = picked.asset_id;
  PERFORM pg_temp.require(nb_display.find_asset(published,picked.asset_id) IS NULL, 'unbound history rejected');
  UPDATE nb_display.assets SET asset = current_asset WHERE run_id = published AND asset_id = picked.asset_id;
  PERFORM pg_temp.require(nb_display.find_asset(published,picked.asset_id) = current_asset, 'unbound current allowed');
  INSERT INTO nb_v2.denied(id) VALUES (picked.owner_page_id);
  PERFORM pg_temp.require(nb_display.find_asset(published,picked.asset_id) IS NULL, 'withdrawn owner');
END $$;
ROLLBACK;

BEGIN;
SET LOCAL plan_cache_mode = force_generic_plan;
SET LOCAL statement_timeout = '90s';
DO $$
DECLARE
  published uuid := (SELECT run_id FROM nb_publication.state);
  picked record;
BEGIN
  SELECT f.asset_id, f.group_id, f.asset INTO STRICT picked FROM nb_display.frozen f
  JOIN nb_v2.media m ON m.asset_id = f.asset_id AND m.run_id = published
  JOIN nb_freeze.members member ON member.group_id = f.group_id AND member.page_id = m.owner_page_id
  ORDER BY f.asset_id LIMIT 1;
  UPDATE nb_display.assets SET asset = asset || '{"testOrigin":"candidate"}'
  WHERE run_id = published AND asset_id = picked.asset_id;
  IF nb_display.find_asset(published,picked.asset_id) IS DISTINCT FROM picked.asset THEN
    RAISE EXCEPTION 'frozen precedence lost'; END IF;
  BEGIN
    PERFORM nb_freeze_payload.assert_run(published);
    RAISE EXCEPTION 'candidate tampering accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'NB_FREEZE_PROTECTED' THEN RAISE; END IF;
  END;
  UPDATE nb_display.frozen SET asset = asset || '{"ownerPageId":"invalid-owner"}'
  WHERE group_id = picked.group_id AND asset_id = picked.asset_id;
  IF nb_display.find_asset(published,picked.asset_id) IS NOT NULL THEN
    RAISE EXCEPTION 'invalid frozen mapping fell through to donor'; END IF;
END $$;
ROLLBACK;

-- A changed definition must still invalidate its attestation.
BEGIN;
ALTER FUNCTION nb_display.find_asset(uuid,text) COST 101;
DO $$ BEGIN
  IF (SELECT nb_display_api.check_capability(digest) FROM nb_display.migrations WHERE singleton)
     IS DISTINCT FROM false THEN RAISE EXCEPTION 'display function drift accepted'; END IF;
END $$;
ROLLBACK;

BEGIN;
ALTER FUNCTION nb_freeze_payload.assert_run(uuid) COST 101;
DO $$ BEGIN
  IF (SELECT nb_freeze_payload_api.check_capability(digest) FROM nb_freeze_payload.migrations WHERE singleton)
     IS DISTINCT FROM false THEN RAISE EXCEPTION 'freeze function drift accepted'; END IF;
END $$;
ROLLBACK;
