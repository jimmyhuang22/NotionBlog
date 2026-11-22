BEGIN;

CREATE TABLE nb_game_trophies.steam_snapshot (
  singleton boolean PRIMARY KEY CHECK (singleton),
  observed_at timestamptz NOT NULL,
  set_id text CHECK (set_id ~ '^steam:[0-9a-f]{32}$'),
  game_id text CHECK (game_id ~ '^[0-9a-f]{32}$'),
  CHECK (num_nonnulls(set_id, game_id) IN (0, 2))
);
INSERT INTO nb_game_trophies.steam_snapshot VALUES (true, '-infinity');
CREATE TABLE nb_game_trophies.steam_achievements (
  id text PRIMARY KEY CHECK (id ~ '^[0-9a-f]{32}$'),
  ordinal integer NOT NULL UNIQUE CHECK (ordinal BETWEEN 1 AND 10000),
  name text CHECK (length(name) BETWEEN 1 AND 500),
  detail text CHECK (length(detail) <= 2000),
  earned boolean NOT NULL,
  earned_date date CHECK (earned_date BETWEEN DATE '1900-01-01' AND DATE '9999-12-31'),
  rarity_percent numeric(4,1) CHECK (rarity_percent BETWEEN 0 AND 100),
  hidden boolean NOT NULL,
  icon_id text UNIQUE CHECK (icon_id ~ '^steam-trophy-[0-9a-f]{64}$'),
  icon_bytes bytea CHECK (octet_length(icon_bytes) BETWEEN 1 AND 262144),
  icon_type text CHECK (icon_type IN ('image/png', 'image/jpeg', 'image/webp')),
  icon_width integer CHECK (icon_width BETWEEN 1 AND 1024),
  icon_height integer CHECK (icon_height BETWEEN 1 AND 1024),
  CHECK (earned OR earned_date IS NULL),
  CHECK (CASE WHEN hidden AND NOT earned THEN num_nonnulls(name, detail, icon_id, rarity_percent) = 0 ELSE name IS NOT NULL END),
  CHECK (num_nonnulls(icon_id, icon_bytes, icon_type, icon_width, icon_height) IN (0, 5))
);
ALTER TABLE nb_game_trophies.steam_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE nb_game_trophies.steam_achievements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON nb_game_trophies.steam_snapshot, nb_game_trophies.steam_achievements FROM PUBLIC, nb_reader, nb_writer;

-- The Steam pilot can replace or explicitly withdraw one complete set. PSN has its own writer and state.
CREATE FUNCTION nb_game_trophies_api.replace_steam_achievements(p_observed_at timestamptz, p_set jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE previous timestamptz;
BEGIN
  IF p_observed_at IS NULL OR NOT isfinite(p_observed_at) OR p_observed_at > clock_timestamp() + interval '1 minute'
      OR p_observed_at < clock_timestamp() - interval '1 hour' THEN
    RAISE EXCEPTION 'NB_QUERY_INVALID';
  END IF;
  IF p_set IS NOT NULL THEN
    IF jsonb_typeof(p_set) IS DISTINCT FROM 'object' OR p_set->>'id' IS NULL OR p_set->>'gameId' IS NULL
        OR jsonb_typeof(p_set->'trophies') IS DISTINCT FROM 'array' OR octet_length(p_set::text) > 25165824 THEN
      RAISE EXCEPTION 'NB_QUERY_INVALID';
    END IF;
    IF jsonb_array_length(p_set->'trophies') NOT BETWEEN 1 AND 10000 THEN RAISE EXCEPTION 'NB_QUERY_INVALID'; END IF;
  END IF;
  SELECT observed_at INTO STRICT previous FROM nb_game_trophies.steam_snapshot WHERE singleton FOR UPDATE;
  IF p_observed_at <= previous THEN RETURN false; END IF;
  DELETE FROM nb_game_trophies.steam_achievements;
  IF p_set IS NOT NULL THEN
    INSERT INTO nb_game_trophies.steam_achievements
    SELECT t.id, r.ordinal, t.name, t.detail, t.earned, t."earnedDate", t."rarityPercent", t.hidden,
      t.icon->>'id', decode(t.icon->>'bytes', 'base64'), t.icon->>'type',
      (t.icon->>'width')::integer, (t.icon->>'height')::integer
    FROM jsonb_array_elements(p_set->'trophies') WITH ORDINALITY r(value, ordinal)
    CROSS JOIN LATERAL jsonb_to_record(r.value) t(id text, name text, detail text, earned boolean,
      "earnedDate" date, "rarityPercent" numeric, hidden boolean, icon jsonb);
  END IF;
  UPDATE nb_game_trophies.steam_snapshot
    SET observed_at = p_observed_at, set_id = p_set->>'id', game_id = p_set->>'gameId' WHERE singleton;
  RETURN true;
END $$;

CREATE FUNCTION nb_game_trophies_api.eligible_steam_set(p_mode text)
RETURNS TABLE (set_id text, game_id text, slug text) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE active uuid;
BEGIN
  CASE p_mode
    WHEN 'published' THEN active := (nb_publication.current_snapshot()).id;
    WHEN 'qualified' THEN active := (nb_v2.current_snapshot()).id;
    ELSE RAISE EXCEPTION 'NB_QUERY_INVALID';
  END CASE;
  RETURN QUERY SELECT s.set_id, s.game_id, r.item->>'slug'
    FROM nb_game_trophies.steam_snapshot s
    JOIN nb_v2.records r ON r.run_id = active AND r.kind = 'game' AND r.id = s.game_id
    WHERE s.singleton AND nb_v2.record_eligible(active, r.id);
END $$;

CREATE FUNCTION nb_game_trophies_api.read_steam_game_sets(p_game_id text, p_slug text, p_mode text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT COALESCE((SELECT jsonb_build_array(jsonb_build_object('id', s.set_id, 'platform', 'Steam',
    'earned', count(*) FILTER (WHERE t.earned), 'total', count(*),
    'progressPercent', round(100.0 * count(*) FILTER (WHERE t.earned) / count(*)),
    'trophies', jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'detail', t.detail,
      'grade', NULL, 'earned', t.earned, 'earnedDate', to_char(t.earned_date, 'YYYY-MM-DD'),
      'rarityPercent', t.rarity_percent, 'hidden', t.hidden, 'icon', CASE WHEN t.icon_id IS NOT NULL THEN
      jsonb_build_object('id', t.icon_id, 'src', '/media/v2/trophy/' || t.icon_id, 'alt', '',
        'width', t.icon_width, 'height', t.icon_height) END) ORDER BY t.ordinal)))
    FROM nb_game_trophies_api.eligible_steam_set(p_mode) s CROSS JOIN nb_game_trophies.steam_achievements t
    WHERE s.game_id = p_game_id AND s.slug = p_slug GROUP BY s.set_id), '[]'::jsonb)
$$;

CREATE FUNCTION nb_game_trophies_api.read_steam_icon(p_icon_id text, p_mode text)
RETURNS TABLE (bytes bytea, mime text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT t.icon_bytes, t.icon_type FROM nb_game_trophies.steam_achievements t
  WHERE t.icon_id = p_icon_id AND (t.earned OR NOT t.hidden)
    AND EXISTS (SELECT 1 FROM nb_game_trophies_api.eligible_steam_set(p_mode))
$$;

REVOKE ALL ON FUNCTION nb_game_trophies_api.replace_steam_achievements(timestamptz, jsonb),
  nb_game_trophies_api.eligible_steam_set(text), nb_game_trophies_api.read_steam_game_sets(text, text, text),
  nb_game_trophies_api.read_steam_icon(text, text) FROM PUBLIC, nb_reader, nb_writer;
GRANT EXECUTE ON FUNCTION nb_game_trophies_api.replace_steam_achievements(timestamptz, jsonb) TO nb_writer;
GRANT EXECUTE ON FUNCTION nb_game_trophies_api.read_steam_game_sets(text, text, text),
  nb_game_trophies_api.read_steam_icon(text, text) TO nb_reader;

COMMIT;
