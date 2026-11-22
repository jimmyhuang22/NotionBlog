BEGIN;

CREATE TABLE nb_game_trophies.psn_trophies (
  set_id text NOT NULL REFERENCES nb_game_trophies.psn_sets(set_id) ON DELETE CASCADE,
  id integer NOT NULL CHECK (id BETWEEN 0 AND 10000),
  name text CHECK (length(name) <= 500),
  detail text CHECK (length(detail) <= 2000),
  grade text NOT NULL CHECK (grade IN ('platinum', 'gold', 'silver', 'bronze')),
  earned boolean NOT NULL,
  earned_date date CHECK (earned_date BETWEEN DATE '1900-01-01' AND DATE '9999-12-31'),
  rarity_percent numeric(4,1) CHECK (rarity_percent BETWEEN 0 AND 100),
  hidden boolean NOT NULL,
  icon_id text UNIQUE CHECK (icon_id ~ '^psn-trophy-[0-9a-f]{64}$'),
  icon_bytes bytea CHECK (octet_length(icon_bytes) BETWEEN 1 AND 262144),
  icon_type text CHECK (icon_type IN ('image/png', 'image/jpeg', 'image/webp')),
  icon_width integer CHECK (icon_width BETWEEN 1 AND 1024),
  icon_height integer CHECK (icon_height BETWEEN 1 AND 1024),
  PRIMARY KEY (set_id, id),
  CHECK (earned OR earned_date IS NULL),
  CHECK (earned OR NOT hidden OR (name IS NULL AND detail IS NULL AND icon_id IS NULL)),
  CHECK (num_nonnulls(icon_id, icon_bytes, icon_type, icon_width, icon_height) IN (0, 5))
);
ALTER TABLE nb_game_trophies.psn_trophies ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON nb_game_trophies.psn_trophies FROM PUBLIC, nb_reader, nb_writer;

CREATE FUNCTION nb_game_trophies_api.replace_psn_details(p_observed_at timestamptz, p_sets jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE summaries jsonb;
BEGIN
  IF jsonb_typeof(p_sets) IS DISTINCT FROM 'array' OR jsonb_array_length(p_sets) > 10000
    OR octet_length(p_sets::text) > 100663296 THEN
    RAISE EXCEPTION 'NB_QUERY_INVALID';
  END IF;
  SELECT COALESCE(jsonb_agg(value - 'trophies'), '[]'::jsonb) INTO summaries FROM jsonb_array_elements(p_sets);
  IF NOT nb_game_trophies_api.replace_psn_snapshot(p_observed_at, summaries) THEN RETURN false; END IF;

  INSERT INTO nb_game_trophies.psn_trophies
  SELECT s->>'id', t.id, t.name, t.detail, t.grade, t.earned, t."earnedDate", t."rarityPercent", t.hidden,
    t.icon->>'id', decode(t.icon->>'bytes', 'base64'), t.icon->>'type',
    (t.icon->>'width')::integer, (t.icon->>'height')::integer
  FROM jsonb_array_elements(p_sets) s
  CROSS JOIN LATERAL jsonb_to_recordset(s->'trophies') t(id integer, name text, detail text, grade text,
    earned boolean, "earnedDate" date, "rarityPercent" numeric, hidden boolean, icon jsonb);

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_sets) s
    CROSS JOIN (VALUES ('platinum'), ('gold'), ('silver'), ('bronze')) AS grade(name)
    CROSS JOIN LATERAL (SELECT count(*) AS total, count(*) FILTER (WHERE earned) AS earned
      FROM nb_game_trophies.psn_trophies t WHERE t.set_id = s->>'id' AND t.grade = grade.name) actual
    WHERE s ? 'trophies' AND (actual.total IS DISTINCT FROM (s->'grades'->grade.name->>'total')::integer
      OR actual.earned IS DISTINCT FROM (s->'grades'->grade.name->>'earned')::integer)
  ) THEN RAISE EXCEPTION 'NB_QUERY_INVALID'; END IF;
  RETURN true;
END $$;

ALTER FUNCTION nb_game_trophies_api.read_game_sets(text, text, text) RENAME TO read_game_summaries;
REVOKE ALL ON FUNCTION nb_game_trophies_api.read_game_summaries(text, text, text) FROM PUBLIC, nb_reader, nb_writer;

CREATE FUNCTION nb_game_trophies_api.read_game_sets(p_game_id text, p_slug text, p_mode text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT COALESCE(jsonb_agg(CASE WHEN expanded.trophies IS NULL THEN s.value
    ELSE s.value || jsonb_build_object('trophies', expanded.trophies) END ORDER BY s.ordinal), '[]'::jsonb)
  FROM jsonb_array_elements(nb_game_trophies_api.read_game_summaries(p_game_id, p_slug, p_mode))
    WITH ORDINALITY AS s(value, ordinal)
  CROSS JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object('id', t.id::text, 'name', t.name, 'detail', t.detail,
      'grade', t.grade, 'earned', t.earned, 'earnedDate', to_char(t.earned_date, 'YYYY-MM-DD'),
      'rarityPercent', t.rarity_percent, 'hidden', t.hidden, 'icon', CASE WHEN t.icon_id IS NOT NULL THEN
      jsonb_build_object('id', t.icon_id, 'src', '/media/v2/trophy/' || t.icon_id, 'alt', '',
        'width', t.icon_width, 'height', t.icon_height) END) ORDER BY t.id) AS trophies
    FROM nb_game_trophies.psn_trophies t WHERE t.set_id = s.value->>'id'
  ) expanded
$$;

CREATE FUNCTION nb_game_trophies_api.read_trophy_icon(p_icon_id text, p_mode text)
RETURNS TABLE (bytes bytea, mime text) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE active uuid;
BEGIN
  CASE p_mode
    WHEN 'published' THEN active := (nb_publication.current_snapshot()).id;
    WHEN 'qualified' THEN active := (nb_v2.current_snapshot()).id;
    ELSE RAISE EXCEPTION 'NB_QUERY_INVALID';
  END CASE;
  RETURN QUERY SELECT t.icon_bytes, t.icon_type
    FROM nb_game_trophies.psn_trophies t
    JOIN nb_game_trophies.psn_sets s USING (set_id)
    JOIN nb_v2.records r ON r.run_id = active AND r.kind = 'game' AND r.id = s.game_id
    WHERE t.icon_id = p_icon_id AND (t.earned OR NOT t.hidden) AND nb_v2.record_eligible(active, r.id);
END $$;

REVOKE ALL ON FUNCTION nb_game_trophies_api.replace_psn_details(timestamptz, jsonb) FROM PUBLIC, nb_reader, nb_writer;
REVOKE ALL ON FUNCTION nb_game_trophies_api.read_game_sets(text, text, text) FROM PUBLIC, nb_reader, nb_writer;
REVOKE ALL ON FUNCTION nb_game_trophies_api.read_trophy_icon(text, text) FROM PUBLIC, nb_reader, nb_writer;
GRANT EXECUTE ON FUNCTION nb_game_trophies_api.replace_psn_details(timestamptz, jsonb) TO nb_writer;
GRANT EXECUTE ON FUNCTION nb_game_trophies_api.read_game_sets(text, text, text) TO nb_reader;
GRANT EXECUTE ON FUNCTION nb_game_trophies_api.read_trophy_icon(text, text) TO nb_reader;

COMMIT;
