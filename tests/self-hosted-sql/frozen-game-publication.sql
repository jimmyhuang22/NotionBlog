-- psql -X -v ON_ERROR_STOP=1, using a disposable local restore with game data.
-- Default is rollback. Set commit_local=true on a disposable copy to check the
-- result from a new reader connection and leave a validated run for the guard tests.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL plan_cache_mode = force_generic_plan;
SET LOCAL statement_timeout = '90s';
CREATE TEMP TABLE game_edit AS
WITH game AS (
  SELECT r.* FROM nb_publication.state p JOIN nb_v2.records r ON r.run_id = p.run_id
  WHERE r.kind = 'game' AND nb_v2.record_eligible(r.run_id, r.id)
    AND NOT EXISTS (SELECT FROM nb_freeze.members f WHERE f.page_id = r.id)
    AND EXISTS (SELECT FROM nb_v2.media m WHERE m.run_id = r.run_id AND m.owner_page_id = r.id)
  ORDER BY r.id LIMIT 1
), media AS (
  SELECT m.* FROM game g JOIN nb_v2.media m ON m.run_id = g.run_id AND m.owner_page_id = g.id
)
SELECT gen_random_uuid() AS op, encode(sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 'hex') AS digest,
       (nb_delta_api.read_state()->>'publicationRevision') AS expected, s.config_digest AS config,
       g.id, g.item->>'title' || ' (offline QA)' AS edited_title,
       jsonb_build_array(jsonb_build_object(
         'detail', jsonb_build_object('item', jsonb_set(g.item, '{title}', to_jsonb(g.item->>'title' || ' (offline QA)')),
                                      'document', g.document),
         'evidence', jsonb_build_object('sourceKey', g.source_key, 'dataSourceId', src.data_source_id,
                         'databaseParentId', src.database_parent_id, 'parentId', g.parent_id,
                         'courseId', g.course_id, 'ordinal', g.ordinal)
       )) AS records,
       (SELECT jsonb_agg(m.descriptor ORDER BY m.asset_id) FROM media m) AS media,
       (SELECT min(a.recipe) FROM media m JOIN nb_display.assets a USING (run_id, asset_id)) AS recipe,
       (SELECT jsonb_agg(a.asset ORDER BY m.asset_id) FROM media m JOIN nb_display.assets a USING (run_id, asset_id)) AS assets,
       COALESCE((SELECT jsonb_agg(b.binding ORDER BY m.asset_id) FROM media m
                 JOIN nb_v2_media.sources b USING (run_id, asset_id)), '[]') AS bindings
FROM game g JOIN nb_v2.sources src ON src.key = g.source_key CROSS JOIN nb_v2.state s;
DO $$ BEGIN
  IF (SELECT count(*) FROM game_edit WHERE edited_title IS NOT NULL AND recipe IS NOT NULL) <> 1
  THEN RAISE EXCEPTION 'game with media required'; END IF;
END $$;
-- The copy-path regression seeds different historical recipes inside this transaction.
\if :{?test_copy_history}
  \ir display-copy-history.sql
\endif
GRANT SELECT ON game_edit TO nb_writer;
SET LOCAL ROLE nb_writer;
\timing on
SELECT (nb_freeze_payload_api.apply_delta(op, digest, expected, config, records, media,
        '[]', recipe, assets, NULL, NULL, bindings)->>'committed')::boolean AS committed FROM game_edit;
\timing off
RESET ROLE;
\if :{?test_copy_history}
  DO $$ BEGIN
    IF (SELECT count(*) FROM copy_cases) <> 3 OR EXISTS (
      SELECT FROM copy_cases c LEFT JOIN nb_display.assets a
      ON a.asset_id = c.asset_id AND a.run_id = (SELECT op FROM game_edit)
      WHERE a.recipe IS DISTINCT FROM c.expected OR a.asset IS DISTINCT FROM c.asset
    ) THEN RAISE EXCEPTION 'copied recipe or full asset differs from expected donor'; END IF;
  END $$;
\endif
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM game_edit g JOIN nb_publication.state s ON s.run_id = g.op
                 JOIN nb_v2.records r ON r.run_id = s.run_id AND r.id = g.id
                 WHERE r.item->>'title' = g.edited_title AND nb_v2.record_eligible(r.run_id,r.id)
                   AND nb_freeze_payload_api.read_operation(g.op,g.digest)->>'operationId' = g.op::text)
  THEN RAISE EXCEPTION 'published edit or receipt missing'; END IF;
END $$;
\if :{?commit_local}
\else
  \set commit_local false
\endif
\if :commit_local
  SELECT op, digest, nb_freeze_payload_api.read_operation(op,digest)->>'publicationRevision' AS revision
  FROM game_edit \gset
  COMMIT;
  \connect -
  BEGIN READ ONLY;
  SET LOCAL ROLE nb_delta_reader;
  SELECT (nb_delta_api.verify_operation(:'op', :'digest', :'revision')->>'readerVerified')
         IS NOT DISTINCT FROM 'true' AS verified \gset
  \if :verified
    \echo Independent reader verified the committed game edit.
  \else
    DO $$ BEGIN RAISE EXCEPTION 'independent verification failed'; END $$;
  \endif
  COMMIT;
\else
  ROLLBACK;
\endif
