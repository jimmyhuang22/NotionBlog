-- Install in a transaction as the website publication owner.
SELECT singleton FROM nb_v2.state WHERE singleton FOR UPDATE;

CREATE SCHEMA nb_study_urls;
CREATE SCHEMA nb_study_urls_api;
REVOKE ALL ON SCHEMA nb_study_urls, nb_study_urls_api FROM PUBLIC;

CREATE TABLE nb_study_urls.names (
  scope text NOT NULL CHECK (scope = '' OR scope ~ '^[0-9a-f]{32}$'),
  id text NOT NULL CHECK (id ~ '^[0-9a-f]{32}$'),
  name text NOT NULL CHECK (
    char_length(name) BETWEEN 1 AND 96
    AND name ~ '^[[:alnum:]]+(-[[:alnum:]]+)*$'
    AND name !~ '^[a-f0-9]{32}$|^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
    AND (scope <> '' OR name <> 'projects')
  ),
  PRIMARY KEY (scope, id),
  UNIQUE (scope, name)
);
ALTER TABLE nb_study_urls.names ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION nb_study_urls.label(title text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
  SELECT btrim(regexp_replace(lower(regexp_replace(normalize(title, NFKC),
    'https?://[^[:space:]<>"'']+', ' ', 'gi')), '[^[:alnum:]]+', '-', 'g'), '-')
$$;

CREATE FUNCTION nb_study_urls.week(label text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
  SELECT 'week-' || lpad(number::text, greatest(2, char_length(number::text)), '0')
  FROM (SELECT substring(label from '^week-([0-9]{1,3})(?:-|$)')::integer AS number) extracted
$$;

CREATE FUNCTION nb_study_urls.note_name(p_run uuid, p_course text, item jsonb) RETURNS text
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE
  title text := COALESCE(item->>'title', '');
  own text;
  course_code text;
  ancestor_id text := item->>'parentId';
  ancestor jsonb;
  context text := '';
  component text;
BEGIN
  IF item->>'noteType' IN ('assignment', 'quiz', 'test') THEN
    title := regexp_replace(title, '[[:space:]]+[-–—·][[:space:]]*[0-9]{1,3}([.][0-9]+)?%[[:space:]]*$', '');
  END IF;
  own := nb_study_urls.label(title);
  SELECT nb_study_urls.label(r.item->>'code') INTO course_code
  FROM nb_v2.records r WHERE r.run_id = p_run AND r.id = p_course AND r.kind = 'course';
  IF course_code <> '' AND starts_with(own, course_code || '-') THEN
    own := substr(own, char_length(course_code) + 2);
  END IF;

  IF ancestor_id IS NULL AND nb_study_urls.week(own) IS NOT NULL THEN
    RETURN nb_study_urls.week(own);
  END IF;

  FOR depth IN 1..32 LOOP
    EXIT WHEN ancestor_id IS NULL;
    SELECT r.item INTO ancestor FROM nb_v2.records r
    WHERE r.run_id = p_run AND r.id = ancestor_id AND r.kind = 'study-note' AND r.item->>'courseId' = p_course;
    EXIT WHEN NOT FOUND;
    component := nb_study_urls.label(COALESCE(ancestor->>'title', ''));
    IF component <> '' THEN
      context := concat_ws('-', COALESCE(nb_study_urls.week(component), rtrim(left(component, 24), '-')),
                           NULLIF(context, ''));
    END IF;
    ancestor_id := ancestor->>'parentId';
  END LOOP;

  IF own = '' THEN
    own := 'note';
  END IF;
  RETURN concat_ws('-', NULLIF(rtrim(left(context, 44), '-'), ''),
    rtrim(left(own, CASE WHEN context = '' THEN 80 ELSE 35 END), '-'));
END $$;

CREATE FUNCTION nb_study_urls.assign(run uuid) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE
  entry record;
  base text;
  candidate text;
  serial integer;
BEGIN
  FOR entry IN
    WITH unmapped AS MATERIALIZED (
      SELECT r.id, r.kind, r.item,
             CASE WHEN r.kind = 'course' THEN '' ELSE r.item->>'courseId' END AS scope
      FROM nb_v2.records r
      WHERE r.run_id = run AND r.kind IN ('course', 'study-note')
        AND NOT EXISTS (
          SELECT 1 FROM nb_study_urls.names n WHERE n.id = r.id
            AND n.scope = CASE WHEN r.kind = 'course' THEN '' ELSE r.item->>'courseId' END
        )
    )
    SELECT * FROM unmapped WHERE nb_v2.record_eligible(run, id) ORDER BY kind, id
  LOOP
    IF entry.kind = 'course' THEN
      base := COALESCE(NULLIF(nb_study_urls.label(entry.item->>'code'), ''),
                       nb_study_urls.label(entry.item->>'title'), '');
      base := rtrim(left(base, 80), '-');
    ELSE
      base := nb_study_urls.note_name(run, entry.scope, entry.item);
    END IF;
    IF base = '' OR base = 'projects' AND entry.scope = ''
       OR base ~ '^[a-f0-9]{32}$|^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
    THEN
      base := CASE WHEN entry.kind = 'course' THEN 'course' ELSE 'note' END;
    END IF;
    candidate := base;
    serial := 1;
    LOOP
      INSERT INTO nb_study_urls.names(scope, id, name)
      VALUES(entry.scope, entry.id, candidate) ON CONFLICT DO NOTHING;
      EXIT WHEN FOUND OR EXISTS (
        SELECT 1 FROM nb_study_urls.names n WHERE n.scope = entry.scope AND n.id = entry.id
      );
      serial := serial + 1;
      candidate := base || '-' || serial;
    END LOOP;
  END LOOP;
END $$;

CREATE FUNCTION nb_study_urls.assign_current() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  PERFORM nb_study_urls.assign(run_id) FROM nb_publication.state WHERE singleton AND run_id IS NOT NULL;
  PERFORM nb_study_urls.assign(current_run) FROM nb_v2.state WHERE singleton AND current_run IS NOT NULL
    AND current_run IS DISTINCT FROM (SELECT run_id FROM nb_publication.state WHERE singleton);
END $$;

CREATE FUNCTION nb_study_urls.on_publication() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM nb_study_urls.assign(NEW.id);
  RETURN NEW;
END $$;

CREATE TRIGGER study_urls_on_publication
AFTER UPDATE OF status ON nb_v2.runs
FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'published')
EXECUTE FUNCTION nb_study_urls.on_publication();

CREATE FUNCTION nb_study_urls.on_restore() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM nb_study_urls.assign_current();
  RETURN OLD;
END $$;

CREATE TRIGGER study_urls_on_restore
AFTER DELETE ON nb_v2.denied FOR EACH STATEMENT EXECUTE FUNCTION nb_study_urls.on_restore();

SELECT nb_study_urls.assign_current();

-- One read maps either the already qualified legacy paths or incoming public names.
-- Both directions recheck the current course, note ownership and publication eligibility.
CREATE FUNCTION nb_study_urls_api.read_names(p_mode text, p_paths text[], p_legacy boolean)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  snapshot nb_v2.runs;
  result jsonb;
BEGIN
  IF p_mode IS NULL OR p_mode NOT IN ('qualified', 'published') OR p_legacy IS NULL
     OR p_paths IS NULL OR cardinality(p_paths) > 20000
     OR EXISTS (SELECT FROM unnest(p_paths) path WHERE path IS NULL OR char_length(path) > 210
        OR path !~ '^/study/[^/]+(/notes/[^/]+)?$')
  THEN RAISE EXCEPTION 'NB_QUERY_INVALID'; END IF;
  IF p_mode = 'published' THEN
    snapshot := nb_publication.current_snapshot();
  ELSE
    snapshot := nb_v2.current_snapshot();
  END IF;

  WITH paths AS (
    SELECT DISTINCT split_part(path, '/', 3) AS course, NULLIF(split_part(path, '/', 5), '') AS note
    FROM unnest(p_paths) path
  ), courses AS (
    SELECT c.id, c.name, p.note FROM paths p JOIN nb_study_urls.names c ON c.scope = '' AND c.id = p.course
    WHERE p_legacy
    UNION ALL
    SELECT c.id, c.name, p.note FROM paths p JOIN nb_study_urls.names c ON c.scope = '' AND c.name = p.course
    WHERE NOT p_legacy
  ), addresses AS (
    SELECT c.id AS course_id, c.name AS course_name, NULL::text AS note_id, NULL::text AS note_name
    FROM courses c WHERE c.note IS NULL
    UNION ALL
    SELECT c.id, c.name, n.id, n.name FROM courses c JOIN nb_study_urls.names n ON n.scope = c.id AND n.id = c.note
    WHERE p_legacy
    UNION ALL
    SELECT c.id, c.name, n.id, n.name FROM courses c JOIN nb_study_urls.names n ON n.scope = c.id AND n.name = c.note
    WHERE NOT p_legacy
  )
  SELECT jsonb_agg(jsonb_build_object('courseId', a.course_id, 'courseName', a.course_name,
                                     'noteId', a.note_id, 'noteName', a.note_name))
    INTO result
  FROM addresses a
  JOIN nb_v2.records c ON c.run_id = snapshot.id AND c.id = a.course_id AND c.kind = 'course'
    AND nb_v2.record_eligible(snapshot.id, c.id)
  WHERE a.note_id IS NULL OR EXISTS (
    SELECT FROM nb_v2.records n
    WHERE n.run_id = snapshot.id AND n.id = a.note_id AND n.kind = 'study-note'
      AND n.item->>'courseId' = c.id AND nb_v2.record_eligible(snapshot.id, n.id)
  );
  RETURN COALESCE(result, '[]'::jsonb);
END $$;

REVOKE ALL ON ALL TABLES IN SCHEMA nb_study_urls FROM PUBLIC, nb_reader, nb_writer;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA nb_study_urls, nb_study_urls_api FROM PUBLIC, nb_reader, nb_writer;
DO $$ DECLARE role_name text; BEGIN
  FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role') LOOP
    EXECUTE format('REVOKE ALL ON SCHEMA nb_study_urls, nb_study_urls_api FROM %I', role_name);
    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA nb_study_urls FROM %I', role_name);
    EXECUTE format('REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA nb_study_urls, nb_study_urls_api FROM %I', role_name);
  END LOOP;
END $$;
GRANT USAGE ON SCHEMA nb_study_urls_api TO nb_reader;
GRANT EXECUTE ON FUNCTION nb_study_urls_api.read_names(text, text[], boolean) TO nb_reader;
