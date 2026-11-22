-- Install in a transaction as the owner of the existing website publication schema.
-- Publication takes this lock before changing either current snapshot.
SELECT singleton FROM nb_v2.state WHERE singleton FOR UPDATE;

CREATE SCHEMA nb_library_urls;
CREATE SCHEMA nb_library_urls_api;
REVOKE ALL ON SCHEMA nb_library_urls, nb_library_urls_api FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA nb_library_urls REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA nb_library_urls_api REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

CREATE TABLE nb_library_urls.names (
  kind text NOT NULL CHECK (kind IN ('book', 'movie', 'game')),
  id text NOT NULL CHECK (id ~ '^[0-9a-f]{32}$'),
  name text NOT NULL CHECK (
    char_length(name) BETWEEN 1 AND 96
    AND name ~ '^[[:alnum:]]+(-[[:alnum:]]+)*$'
    AND name !~ '^[a-f0-9]{32}$'
    AND name !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  ),
  PRIMARY KEY (kind, id),
  UNIQUE (kind, name)
);
ALTER TABLE nb_library_urls.names ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON nb_library_urls.names FROM PUBLIC, nb_reader, nb_writer;

CREATE FUNCTION nb_library_urls.normalize_name(label text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
  SELECT trim(both '-' from left(
    trim(both '-' from regexp_replace(lower(normalize(label, NFKC)), '[^[:alnum:]]+', '-', 'g')),
    72
  ))
$$;

CREATE FUNCTION nb_library_urls.assign(run uuid) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE
  work record;
  base text;
  qualifier text;
  candidate text;
  suffix text;
  attempt integer;
BEGIN
  FOR work IN
    SELECT r.kind, r.id, r.item
    FROM nb_v2.records r
    WHERE r.run_id = run AND r.kind IN ('book', 'movie', 'game')
      AND NOT EXISTS (
        SELECT 1 FROM nb_library_urls.names n WHERE n.kind = r.kind AND n.id = r.id
      )
      AND nb_v2.record_eligible(run, r.id)
    ORDER BY r.kind, r.id
  LOOP
    base := nb_library_urls.normalize_name(COALESCE(
      NULLIF(btrim(work.item->>'originalTitle'), ''), work.item->>'title', ''
    ));
    suffix := left(md5(work.id), 10);
    IF base = '' OR base ~ '^[a-f0-9]{32}$|^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' THEN
      base := 'work-' || suffix;
    END IF;
    qualifier := CASE WHEN work.kind = 'book'
      THEN left(nb_library_urls.normalize_name(work.item->'authors'->>0), 20)
      ELSE substring(work.item->'releaseDate'->>'start' from '^[0-9]{4}') END;
    candidate := base;
    attempt := 0;
    LOOP
      INSERT INTO nb_library_urls.names(kind, id, name) VALUES(work.kind, work.id, candidate)
        ON CONFLICT DO NOTHING;
      EXIT WHEN FOUND OR EXISTS(
        SELECT 1 FROM nb_library_urls.names n WHERE n.kind = work.kind AND n.id = work.id
      );
      attempt := attempt + 1;
      candidate := CASE
        WHEN attempt = 1 AND NULLIF(qualifier, '') IS NOT NULL THEN base || '-' || rtrim(qualifier, '-')
        WHEN attempt < 3 THEN base || '-' || suffix
        ELSE base || '-' || suffix || '-' || (attempt - 2)::text
      END;
    END LOOP;
  END LOOP;
END $$;

CREATE FUNCTION nb_library_urls.on_publication() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM nb_library_urls.assign(NEW.id);
  RETURN NEW;
END $$;

CREATE TRIGGER library_urls_on_publication
AFTER UPDATE OF status ON nb_v2.runs
FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'published')
EXECUTE FUNCTION nb_library_urls.on_publication();

-- Optional private first-release choices, for example an established English short title.
-- The operator supplies them in the installation transaction. Invalid or out-of-scope
-- rows abort the installation instead of reserving a name for an unrelated record.
DO $$
DECLARE
  overrides jsonb := COALESCE(NULLIF(current_setting('nb_library_urls.initial_names', true), ''), '[]')::jsonb;
  inserted integer;
BEGIN
  IF jsonb_typeof(overrides) <> 'array' OR jsonb_array_length(overrides) > 20000 THEN
    RAISE EXCEPTION 'NB_LIBRARY_NAMES_INVALID';
  END IF;
  INSERT INTO nb_library_urls.names(kind, id, name)
    SELECT o.kind, o.id, o.name FROM jsonb_to_recordset(overrides) o(kind text, id text, name text)
    WHERE o.name = nb_library_urls.normalize_name(o.name)
      AND EXISTS(
        SELECT 1 FROM nb_v2.records r
        WHERE r.run_id = COALESCE(
          (SELECT run_id FROM nb_publication.state WHERE singleton),
          (SELECT current_run FROM nb_v2.state WHERE singleton)
        ) AND r.kind = o.kind AND r.id = o.id AND nb_v2.record_eligible(r.run_id, r.id)
      );
  GET DIAGNOSTICS inserted = ROW_COUNT;
  IF inserted <> jsonb_array_length(overrides) THEN RAISE EXCEPTION 'NB_LIBRARY_NAMES_INVALID'; END IF;
END $$;

-- Backfill the displayed snapshot first. Qualified readers can have a different active run.
SELECT nb_library_urls.assign(run_id) FROM nb_publication.state WHERE singleton AND run_id IS NOT NULL;
SELECT nb_library_urls.assign(current_run) FROM nb_v2.state WHERE singleton AND current_run IS NOT NULL
  AND current_run IS DISTINCT FROM (SELECT run_id FROM nb_publication.state WHERE singleton);

-- A previously denied row can be restored on the very same snapshot.
CREATE FUNCTION nb_library_urls.on_restore() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM nb_library_urls.assign(run_id) FROM nb_publication.state WHERE singleton AND run_id IS NOT NULL;
  PERFORM nb_library_urls.assign(current_run) FROM nb_v2.state WHERE singleton AND current_run IS NOT NULL
    AND current_run IS DISTINCT FROM (SELECT run_id FROM nb_publication.state WHERE singleton);
  RETURN OLD;
END $$;
CREATE TRIGGER library_urls_on_restore
AFTER DELETE ON nb_v2.denied FOR EACH ROW EXECUTE FUNCTION nb_library_urls.on_restore();

-- Use the same snapshot and eligibility predicate as public content readers.
-- A retained name is never sufficient to resolve withdrawn content.
CREATE FUNCTION nb_library_urls_api.read_names(p_mode text, p_keys text[], p_kind text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  snapshot nb_v2.runs;
  result jsonb;
BEGIN
  IF p_mode IS NULL OR p_mode NOT IN ('qualified', 'published')
     OR p_keys IS NULL OR cardinality(p_keys) > 20000
     OR (p_kind IS NOT NULL AND p_kind NOT IN ('game', 'book', 'movie'))
     OR EXISTS(SELECT 1 FROM unnest(p_keys) k WHERE k IS NULL OR char_length(k) > 128)
  THEN RAISE EXCEPTION 'NB_QUERY_INVALID'; END IF;
  IF p_mode = 'published' THEN
    snapshot := nb_publication.current_snapshot();
  ELSE
    snapshot := nb_v2.current_snapshot();
  END IF;
  IF p_kind IS NULL THEN
    SELECT jsonb_agg(jsonb_build_object('oldHref', r.item->>'href', 'storageSlug', r.item->>'slug', 'slug', n.name))
      INTO result
    FROM nb_v2.records r
    JOIN nb_library_urls.names n USING (kind, id)
    WHERE r.run_id = snapshot.id AND r.kind IN ('game', 'book', 'movie')
      AND r.item->>'href' = ANY(p_keys) AND nb_v2.record_eligible(snapshot.id, r.id);
  ELSE
    SELECT jsonb_agg(jsonb_build_object('oldHref', r.item->>'href', 'storageSlug', r.item->>'slug', 'slug', n.name))
      INTO result
    FROM nb_library_urls.names n
    JOIN nb_v2.records r USING (kind, id)
    WHERE r.run_id = snapshot.id AND n.kind = p_kind AND n.name = ANY(p_keys)
      AND nb_v2.record_eligible(snapshot.id, r.id);
  END IF;
  RETURN COALESCE(result, '[]'::jsonb);
END $$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA nb_library_urls, nb_library_urls_api FROM PUBLIC, nb_reader, nb_writer;
DO $$ DECLARE role_name text; BEGIN
  FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role') LOOP
    EXECUTE format('REVOKE ALL ON SCHEMA nb_library_urls, nb_library_urls_api FROM %I', role_name);
    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA nb_library_urls FROM %I', role_name);
    EXECUTE format('REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA nb_library_urls, nb_library_urls_api FROM %I', role_name);
  END LOOP;
END $$;
GRANT USAGE ON SCHEMA nb_library_urls_api TO nb_reader;
GRANT EXECUTE ON FUNCTION nb_library_urls_api.read_names(text, text[], text) TO nb_reader;
