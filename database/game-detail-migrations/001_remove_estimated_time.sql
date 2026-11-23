-- Run as the website owner in a transaction for each backed-up run, under the publication lock.
-- Set notionblog.estimate_run, notionblog.estimate_backup_rows and notionblog.estimate_backup_sha.
-- Hash the exported JSONL rows for this run in id order, joined by a newline with no trailing newline.
SELECT singleton FROM nb_v2.state WHERE singleton FOR UPDATE;

DO $$
DECLARE
  target uuid := current_setting('notionblog.estimate_run')::uuid;
  backed_up bigint := current_setting('notionblog.estimate_backup_rows')::bigint;
  backup_sha text := current_setting('notionblog.estimate_backup_sha');
  remaining bigint;
  current_sha text;
BEGIN
  IF backed_up < 0 OR backup_sha !~ '^[a-f0-9]{64}$' OR EXISTS (
    SELECT 1 FROM nb_v2.state WHERE singleton AND lease_run IS NOT NULL AND lease_until > now()
  ) THEN
    RAISE EXCEPTION 'NB_GAME_ESTIMATE_CLEANUP_NOT_READY';
  END IF;

  SELECT count(*), encode(sha256(convert_to(string_agg(jsonb_build_object(
    'run', run_id, 'id', id, 'value', item->'estimatedTime')::text, chr(10) ORDER BY id), 'UTF8')), 'hex')
  INTO remaining, current_sha FROM nb_v2.records
  WHERE run_id = target AND kind = 'game' AND item ? 'estimatedTime';
  IF remaining = 0 THEN RETURN; END IF;
  IF remaining <> backed_up OR current_sha IS DISTINCT FROM backup_sha THEN
    RAISE EXCEPTION 'NB_GAME_ESTIMATE_BACKUP_CHANGED';
  END IF;

  UPDATE nb_v2.records SET item = item - 'estimatedTime'
  WHERE run_id = target AND kind = 'game' AND item ? 'estimatedTime';
END $$;
