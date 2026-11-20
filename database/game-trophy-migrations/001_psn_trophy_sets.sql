CREATE SCHEMA nb_game_trophies;
CREATE SCHEMA nb_game_trophies_api;
REVOKE ALL ON SCHEMA nb_game_trophies, nb_game_trophies_api FROM PUBLIC;
GRANT USAGE ON SCHEMA nb_game_trophies_api TO nb_reader, nb_writer;

CREATE TABLE nb_game_trophies.state (
  singleton boolean PRIMARY KEY CHECK (singleton),
  observed_at timestamptz NOT NULL
);
INSERT INTO nb_game_trophies.state VALUES (true, '-infinity');

CREATE TABLE nb_game_trophies.psn_sets (
  set_id text PRIMARY KEY CHECK (set_id ~ '^psn:[0-9a-f]{32}$'),
  game_id text NOT NULL CHECK (game_id ~ '^[0-9a-f]{32}$'),
  platform text NOT NULL CHECK (platform IN ('PS4', 'PS5', 'PS4 / PS5')),
  progress_percent integer CHECK (progress_percent BETWEEN 0 AND 100),
  platinum_earned integer NOT NULL,
  platinum_total integer NOT NULL,
  gold_earned integer NOT NULL,
  gold_total integer NOT NULL,
  silver_earned integer NOT NULL,
  silver_total integer NOT NULL,
  bronze_earned integer NOT NULL,
  bronze_total integer NOT NULL,
  CHECK (platinum_earned BETWEEN 0 AND platinum_total AND platinum_total <= 10000),
  CHECK (gold_earned BETWEEN 0 AND gold_total AND gold_total <= 10000),
  CHECK (silver_earned BETWEEN 0 AND silver_total AND silver_total <= 10000),
  CHECK (bronze_earned BETWEEN 0 AND bronze_total AND bronze_total <= 10000),
  CHECK (platinum_total + gold_total + silver_total + bronze_total BETWEEN 1 AND 10000)
);
CREATE INDEX psn_sets_game ON nb_game_trophies.psn_sets (game_id, platform, set_id);
ALTER TABLE nb_game_trophies.state ENABLE ROW LEVEL SECURITY;
ALTER TABLE nb_game_trophies.psn_sets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA nb_game_trophies FROM PUBLIC, nb_reader, nb_writer;

-- One complete, privacy-filtered observation of the site's one PSN account.
-- A newer observation replaces the scope atomically, including withdrawals.
CREATE FUNCTION nb_game_trophies_api.replace_psn_snapshot(p_observed_at timestamptz, p_sets jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE previous timestamptz;
BEGIN
  IF p_observed_at IS NULL OR NOT isfinite(p_observed_at) OR p_observed_at > clock_timestamp() + interval '1 minute'
     OR p_observed_at < clock_timestamp() - interval '1 hour'
     OR jsonb_typeof(p_sets) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'NB_QUERY_INVALID';
  END IF;
  IF jsonb_array_length(p_sets) > 10000 OR octet_length(p_sets::text) > 8388608 THEN
    RAISE EXCEPTION 'NB_QUERY_INVALID';
  END IF;
  SELECT observed_at INTO STRICT previous FROM nb_game_trophies.state WHERE singleton FOR UPDATE;
  IF p_observed_at <= previous THEN RETURN false; END IF;
  DELETE FROM nb_game_trophies.psn_sets;
  INSERT INTO nb_game_trophies.psn_sets
  SELECT s.id, s."gameId", s.platform, s."progressPercent",
    (s.grades #>> '{platinum,earned}')::integer, (s.grades #>> '{platinum,total}')::integer,
    (s.grades #>> '{gold,earned}')::integer, (s.grades #>> '{gold,total}')::integer,
    (s.grades #>> '{silver,earned}')::integer, (s.grades #>> '{silver,total}')::integer,
    (s.grades #>> '{bronze,earned}')::integer, (s.grades #>> '{bronze,total}')::integer
  FROM jsonb_to_recordset(p_sets) s(id text, "gameId" text, platform text, "progressPercent" integer, grades jsonb);
  UPDATE nb_game_trophies.state SET observed_at = p_observed_at WHERE singleton;
  RETURN true;
END $$;

CREATE FUNCTION nb_game_trophies_api.read_game_sets(p_game_id text, p_slug text, p_mode text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE active uuid;
BEGIN
  CASE p_mode
    WHEN 'published' THEN active := (nb_publication.current_snapshot()).id;
    WHEN 'qualified' THEN active := (nb_v2.current_snapshot()).id;
    ELSE RAISE EXCEPTION 'NB_QUERY_INVALID';
  END CASE;
  IF NOT EXISTS (SELECT 1 FROM nb_v2.records r
    WHERE r.run_id = active AND r.kind = 'game' AND r.id = p_game_id AND r.item->>'slug' = p_slug
      AND nb_v2.record_eligible(active, r.id)) THEN
    RETURN '[]'::jsonb;
  END IF;
  RETURN (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', s.set_id, 'platform', s.platform, 'progressPercent', s.progress_percent,
      'earned', s.platinum_earned + s.gold_earned + s.silver_earned + s.bronze_earned,
      'total', s.platinum_total + s.gold_total + s.silver_total + s.bronze_total,
      'grades', jsonb_build_object(
        'platinum', jsonb_build_object('earned', s.platinum_earned, 'total', s.platinum_total),
        'gold', jsonb_build_object('earned', s.gold_earned, 'total', s.gold_total),
        'silver', jsonb_build_object('earned', s.silver_earned, 'total', s.silver_total),
        'bronze', jsonb_build_object('earned', s.bronze_earned, 'total', s.bronze_total)
      )
    ) ORDER BY s.platform COLLATE "C", s.set_id), '[]'::jsonb)
    FROM nb_game_trophies.psn_sets s WHERE s.game_id = p_game_id
  );
END $$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA nb_game_trophies_api FROM PUBLIC, nb_reader, nb_writer;
GRANT EXECUTE ON FUNCTION nb_game_trophies_api.replace_psn_snapshot(timestamptz, jsonb) TO nb_writer;
GRANT EXECUTE ON FUNCTION nb_game_trophies_api.read_game_sets(text, text, text) TO nb_reader;
