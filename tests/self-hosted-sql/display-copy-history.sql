-- Fixture included by frozen-game-publication.sql with -v test_copy_history=true.
-- Choose unchanged, eligible assets with a binding so history is a valid fallback.
CREATE TEMP TABLE copy_cases AS
WITH candidates AS (
  SELECT a.*, row_number() OVER (ORDER BY a.asset_id) AS n
  FROM nb_publication.state s JOIN nb_display.assets a USING (run_id)
  JOIN nb_v2.media m USING (run_id, asset_id)
  JOIN nb_v2_media.sources b USING (run_id, asset_id)
  WHERE m.owner_page_id <> (SELECT id FROM game_edit)
    AND nb_v2.record_eligible(a.run_id, m.owner_page_id)
    AND NOT EXISTS (SELECT FROM nb_freeze.members f WHERE f.page_id = m.owner_page_id)
    AND b.binding->>'sourceFingerprint' = a.asset->>'sourceFingerprint'
    AND a.asset = nb_display.find_asset(a.run_id, a.asset_id)
  ORDER BY a.asset_id LIMIT 3
)
SELECT *, CASE WHEN n = 1 THEN recipe ELSE 'qa-newest-equal' END AS expected FROM candidates;

DELETE FROM nb_display.assets x USING copy_cases c
WHERE x.asset_id = c.asset_id AND x.run_id <> c.run_id;
INSERT INTO nb_display.assets
SELECT v.run_id, c.asset_id, v.recipe, c.asset
FROM copy_cases c CROSS JOIN (VALUES
  ('00000000-0000-4000-a000-000000000001'::uuid, 'qa-older-equal'),
  ('ffffffff-ffff-4fff-afff-fffffffffff0'::uuid, 'qa-newest-equal')
) AS v(run_id, recipe);
-- A still newer row with different content must never supply the recipe.
INSERT INTO nb_display.assets
SELECT 'ffffffff-ffff-4fff-afff-ffffffffffff'::uuid, asset_id, 'qa-mismatch',
       asset || '{"sourceSha256":"different"}'::jsonb FROM copy_cases;
-- Exercise previous-row hit, absent previous row, and nonmatching previous row.
DELETE FROM nb_display.assets x USING copy_cases c
WHERE c.n = 2 AND x.run_id = c.run_id AND x.asset_id = c.asset_id;
UPDATE nb_display.assets x SET asset = x.asset || '{"sourceSha256":"different"}'::jsonb
FROM copy_cases c WHERE c.n = 3 AND x.run_id = c.run_id AND x.asset_id = c.asset_id;
