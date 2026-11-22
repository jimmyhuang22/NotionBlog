BEGIN;

CREATE TABLE nb_game_trophies.steam_sets (
  set_id text PRIMARY KEY CHECK (set_id ~ '^steam:[0-9a-f]{32}$'),
  game_id text UNIQUE CHECK (game_id ~ '^[0-9a-f]{32}$'),
  observed_at timestamptz NOT NULL
);
ALTER TABLE nb_game_trophies.steam_sets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON nb_game_trophies.steam_sets FROM PUBLIC, nb_reader, nb_writer;

-- Keep the pilot set and its media identifiers when installing the multi-game reader.
INSERT INTO nb_game_trophies.steam_sets
  SELECT set_id, game_id, observed_at FROM nb_game_trophies.steam_snapshot WHERE set_id IS NOT NULL;
ALTER TABLE nb_game_trophies.steam_achievements ADD COLUMN set_id text;
UPDATE nb_game_trophies.steam_achievements t SET set_id = s.set_id
  FROM nb_game_trophies.steam_snapshot s WHERE s.singleton;
ALTER TABLE nb_game_trophies.steam_achievements
  ALTER COLUMN set_id SET NOT NULL,
  ADD FOREIGN KEY (set_id) REFERENCES nb_game_trophies.steam_sets(set_id) ON DELETE CASCADE,
  DROP CONSTRAINT steam_achievements_ordinal_key,
  ADD UNIQUE (set_id, ordinal);

ALTER TABLE nb_game_trophies.steam_snapshot RENAME TO steam_import_lock;
ALTER TABLE nb_game_trophies.steam_import_lock DROP COLUMN set_id, DROP COLUMN game_id, DROP COLUMN observed_at;

CREATE FUNCTION nb_game_trophies_api.steam_game_eligible(p_game_id text, p_slug text, p_mode text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE active uuid;
BEGIN
  CASE p_mode
    WHEN 'published' THEN active := (nb_publication.current_snapshot()).id;
    WHEN 'qualified' THEN active := (nb_v2.current_snapshot()).id;
    ELSE RAISE EXCEPTION 'NB_QUERY_INVALID';
  END CASE;
  RETURN EXISTS (SELECT 1 FROM nb_v2.records r
    WHERE r.run_id = active AND r.kind = 'game' AND r.id = p_game_id
      AND (p_slug IS NULL OR r.item->>'slug' = p_slug) AND nb_v2.record_eligible(active, r.id));
END $$;

-- Only the listed sets are changed. A withdrawn set retains its timestamp so stale retries cannot republish it.
CREATE FUNCTION nb_game_trophies_api.apply_steam_achievement_batch(p_observed_at timestamptz, p_changes jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF p_observed_at IS NULL OR NOT isfinite(p_observed_at) OR p_observed_at > clock_timestamp() + interval '1 minute'
      OR p_observed_at < clock_timestamp() - interval '1 hour'
      OR jsonb_typeof(p_changes) IS DISTINCT FROM 'array' OR octet_length(p_changes::text) > 25165824 THEN
    RAISE EXCEPTION 'NB_QUERY_INVALID';
  END IF;
  IF jsonb_array_length(p_changes) NOT BETWEEN 1 AND 10000 THEN RAISE EXCEPTION 'NB_QUERY_INVALID'; END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_changes) c
    WHERE jsonb_typeof(c) IS DISTINCT FROM 'object' OR c->>'id' IS NULL OR c->>'id' !~ '^steam:[0-9a-f]{32}$'
      OR CASE WHEN c->'gameId' = 'null'::jsonb THEN c ? 'trophies'
        WHEN c->>'gameId' ~ '^[0-9a-f]{32}$' AND jsonb_typeof(c->'trophies') = 'array'
          THEN jsonb_array_length(c->'trophies') NOT BETWEEN 1 AND 10000
        ELSE true END
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_changes) c GROUP BY c->>'id' HAVING count(*) > 1
  ) THEN RAISE EXCEPTION 'NB_QUERY_INVALID'; END IF;

  PERFORM singleton FROM nb_game_trophies.steam_import_lock WHERE singleton FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_changes) c
    JOIN nb_game_trophies.steam_sets s ON s.set_id = c->>'id' WHERE p_observed_at <= s.observed_at
  ) THEN RETURN false; END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_changes) c WHERE c->>'gameId' IS NOT NULL
      AND NOT nb_game_trophies_api.steam_game_eligible(c->>'gameId', NULL, 'published')
  ) THEN RAISE EXCEPTION 'NB_QUERY_INVALID'; END IF;

  DELETE FROM nb_game_trophies.steam_achievements t USING jsonb_array_elements(p_changes) c
  WHERE t.set_id = c->>'id';

  INSERT INTO nb_game_trophies.steam_sets
  SELECT c->>'id', c->>'gameId', p_observed_at FROM jsonb_array_elements(p_changes) c
  ON CONFLICT (set_id) DO UPDATE SET game_id = EXCLUDED.game_id, observed_at = EXCLUDED.observed_at;

  INSERT INTO nb_game_trophies.steam_achievements
  (id, ordinal, name, detail, earned, earned_date, rarity_percent, hidden, icon_id, icon_bytes, icon_type, icon_width, icon_height, set_id)
  SELECT t.id, r.ordinal, t.name, t.detail, t.earned, t."earnedDate", t."rarityPercent", t.hidden,
    t.icon->>'id', decode(t.icon->>'bytes', 'base64'), t.icon->>'type',
    (t.icon->>'width')::integer, (t.icon->>'height')::integer, c->>'id'
  FROM jsonb_array_elements(p_changes) c
  CROSS JOIN LATERAL jsonb_array_elements(c->'trophies') WITH ORDINALITY r(value, ordinal)
  CROSS JOIN LATERAL jsonb_to_record(r.value) t(id text, name text, detail text, earned boolean,
    "earnedDate" date, "rarityPercent" numeric, hidden boolean, icon jsonb);
  RETURN true;
END $$;

CREATE FUNCTION nb_game_trophies_api.list_active_steam_sets()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT COALESCE(jsonb_agg(set_id ORDER BY set_id), '[]'::jsonb)
  FROM nb_game_trophies.steam_sets WHERE game_id IS NOT NULL
$$;

CREATE OR REPLACE FUNCTION nb_game_trophies_api.replace_steam_achievements(p_observed_at timestamptz, p_set jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE active jsonb;
BEGIN
  IF p_set IS NOT NULL THEN
    RETURN nb_game_trophies_api.apply_steam_achievement_batch(p_observed_at, jsonb_build_array(p_set));
  END IF;
  PERFORM singleton FROM nb_game_trophies.steam_import_lock WHERE singleton FOR UPDATE;
  active := nb_game_trophies_api.list_active_steam_sets();
  IF jsonb_array_length(active) = 0 THEN RETURN false; END IF;
  IF jsonb_array_length(active) > 1 THEN RAISE EXCEPTION 'NB_QUERY_INVALID'; END IF;
  RETURN nb_game_trophies_api.apply_steam_achievement_batch(p_observed_at,
    jsonb_build_array(jsonb_build_object('id', active->>0, 'gameId', NULL)));
END $$;

CREATE OR REPLACE FUNCTION nb_game_trophies_api.read_steam_game_sets(p_game_id text, p_slug text, p_mode text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT COALESCE((SELECT jsonb_build_array(jsonb_build_object('id', s.set_id, 'platform', 'Steam',
    'earned', count(*) FILTER (WHERE t.earned), 'total', count(*),
    'progressPercent', round(100.0 * count(*) FILTER (WHERE t.earned) / count(*)),
    'trophies', jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'detail', t.detail,
      'grade', NULL, 'earned', t.earned, 'earnedDate', to_char(t.earned_date, 'YYYY-MM-DD'),
      'rarityPercent', t.rarity_percent, 'hidden', t.hidden, 'icon', CASE WHEN t.icon_id IS NOT NULL THEN
      jsonb_build_object('id', t.icon_id, 'src', '/media/v2/trophy/' || t.icon_id, 'alt', '',
        'width', t.icon_width, 'height', t.icon_height) END) ORDER BY t.ordinal)))
    FROM nb_game_trophies.steam_sets s JOIN nb_game_trophies.steam_achievements t USING (set_id)
    WHERE s.game_id = p_game_id AND p_slug IS NOT NULL
      AND nb_game_trophies_api.steam_game_eligible(s.game_id, p_slug, p_mode)
    GROUP BY s.set_id), '[]'::jsonb)
$$;

CREATE OR REPLACE FUNCTION nb_game_trophies_api.read_steam_icon(p_icon_id text, p_mode text)
RETURNS TABLE (bytes bytea, mime text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT t.icon_bytes, t.icon_type
  FROM nb_game_trophies.steam_achievements t JOIN nb_game_trophies.steam_sets s USING (set_id)
  WHERE t.icon_id = p_icon_id AND s.game_id IS NOT NULL AND (t.earned OR NOT t.hidden)
    AND nb_game_trophies_api.steam_game_eligible(s.game_id, NULL, p_mode)
$$;

DROP FUNCTION nb_game_trophies_api.eligible_steam_set(text);
REVOKE ALL ON FUNCTION nb_game_trophies_api.steam_game_eligible(text, text, text),
  nb_game_trophies_api.apply_steam_achievement_batch(timestamptz, jsonb), nb_game_trophies_api.list_active_steam_sets()
  FROM PUBLIC, nb_reader, nb_writer;
GRANT EXECUTE ON FUNCTION nb_game_trophies_api.apply_steam_achievement_batch(timestamptz, jsonb),
  nb_game_trophies_api.list_active_steam_sets() TO nb_writer;

COMMIT;
