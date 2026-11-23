-- Apply before enabling title mode. Serialize with publication and preserve registered note names.
SELECT singleton FROM nb_v2.state WHERE singleton FOR UPDATE;

-- A source can put a code at the beginning of a combined label or title.
CREATE FUNCTION nb_study_urls.course_code_prefix(value text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
  SELECT lower(substring(normalize(value, NFKC) FROM '^[[:space:]]*([A-Za-z]{2,8}[0-9]{2,7})(?:[[:space:]:]|$)'))
$$;

CREATE FUNCTION nb_study_urls.course_base(item jsonb) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
  SELECT rtrim(left(COALESCE(nb_study_urls.course_code_prefix(item->>'code'),
    NULLIF(nb_study_urls.label(item->>'code'), ''), nb_study_urls.course_code_prefix(item->>'title'),
    nb_study_urls.label(item->>'title'), ''), 80), '-')
$$;

REVOKE EXECUTE ON FUNCTION nb_study_urls.course_code_prefix(text), nb_study_urls.course_base(jsonb) FROM PUBLIC, nb_reader, nb_writer;
DO $$ DECLARE role_name text; BEGIN
  FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role') LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION nb_study_urls.course_code_prefix(text), nb_study_urls.course_base(jsonb) FROM %I', role_name);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION nb_study_urls.assign(run uuid) RETURNS void
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
      base := nb_study_urls.course_base(entry.item);
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

-- Replace only the pre-launch course names assigned from a combined label.
-- Keep existing short names in place and reserve the next available suffix on collisions.
DO $$
DECLARE
  entry record;
  candidate text;
  serial integer;
BEGIN
  FOR entry IN
    WITH snapshots AS (
      SELECT run_id AS id, 0 AS priority FROM nb_publication.state WHERE singleton
      UNION ALL
      SELECT current_run, 1 FROM nb_v2.state WHERE singleton
    ), courses AS (
      SELECT DISTINCT ON (r.id) r.id, r.item
      FROM snapshots s JOIN nb_v2.records r ON r.run_id = s.id
      WHERE r.kind = 'course' AND nb_v2.record_eligible(r.run_id, r.id)
      ORDER BY r.id, s.priority
    ), bases AS (
      SELECT id, rtrim(left(COALESCE(NULLIF(nb_study_urls.label(item->>'code'), ''),
        nb_study_urls.label(item->>'title'), ''), 80), '-') AS original, nb_study_urls.course_base(item) AS shortened
      FROM courses
    )
    SELECT b.id, b.shortened
    FROM bases b JOIN nb_study_urls.names n ON n.scope = '' AND n.id = b.id
    WHERE b.shortened <> b.original
      AND (n.name = b.original OR n.name ~ ('^' || b.original || '-[0-9]+$'))
    ORDER BY b.id
  LOOP
    candidate := entry.shortened;
    serial := 1;
    WHILE EXISTS (SELECT FROM nb_study_urls.names WHERE scope = '' AND name = candidate) LOOP
      serial := serial + 1;
      candidate := entry.shortened || '-' || serial;
    END LOOP;
    UPDATE nb_study_urls.names SET name = candidate WHERE scope = '' AND id = entry.id;
  END LOOP;
END $$;
