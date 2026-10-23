-- Opt-in metadata for a returned search page. Existing search functions stay frozen.
BEGIN;
CREATE SCHEMA nb_search_context;
CREATE SCHEMA nb_search_context_api;
REVOKE ALL ON SCHEMA nb_search_context,nb_search_context_api FROM PUBLIC,nb_reader,nb_writer;
CREATE TABLE nb_search_context.state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  migration_digest text CHECK(migration_digest IS NULL OR migration_digest ~ '^[a-f0-9]{64}$')
);
ALTER TABLE nb_search_context.state ENABLE ROW LEVEL SECURITY;
INSERT INTO nb_search_context.state VALUES(true,NULL);

CREATE FUNCTION nb_search_context_api.read_context(p_mode text,p_ids text[],p_run uuid,p_revision bigint,p_digest text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r nb_v2.runs; note nb_v2.records; course nb_v2.records; parent nb_v2.records;
  next_parent text; seen text[]; labels text[]; course_label text; valid boolean; contexts jsonb[]:=ARRAY[]::jsonb[]; entry jsonb;
BEGIN
  IF NOT EXISTS(SELECT FROM nb_search_context.state WHERE singleton AND migration_digest=p_digest AND p_digest ~ '^[a-f0-9]{64}$') THEN
    RAISE EXCEPTION 'NB_UNAVAILABLE';
  END IF;
  IF p_run IS NULL OR p_revision IS NULL OR p_ids IS NULL OR cardinality(p_ids) NOT BETWEEN 1 AND 50
    OR array_position(p_ids,NULL) IS NOT NULL OR EXISTS(SELECT FROM unnest(p_ids) id WHERE length(id) NOT BETWEEN 1 AND 256)
    OR (SELECT count(DISTINCT id) FROM unnest(p_ids) id)<>cardinality(p_ids) THEN RAISE EXCEPTION 'NB_QUERY_INVALID'; END IF;
  r:=nb_read.assert_pin(p_mode,p_run,p_revision);
  FOR note IN SELECT * FROM nb_v2.records x WHERE x.run_id=r.id AND x.id=ANY(p_ids) AND x.kind='study-note'
      AND nb_v2.record_eligible(r.id,x.id) ORDER BY x.id LOOP
    labels:=ARRAY[]::text[]; seen:=ARRAY[note.id]; next_parent:=note.parent_id; valid:=true;
    SELECT * INTO course FROM nb_v2.records x WHERE x.run_id=r.id AND x.id=note.course_id AND x.kind='course'
      AND nb_v2.record_eligible(r.id,x.id);
    IF NOT FOUND THEN valid:=false; END IF;
    IF valid THEN
      course_label:=COALESCE(NULLIF(btrim(course.item->>'code'),''),course.item->>'title');
      IF lower(replace(course_label,'-',''))=lower(replace(course.id,'-','')) THEN course_label:=course.item->>'title'; END IF;
      IF course_label IS NULL OR btrim(course_label)='' OR length(course_label)>256 THEN valid:=false; END IF;
    END IF;
    WHILE valid AND next_parent IS DISTINCT FROM note.course_id LOOP
      IF next_parent IS NULL OR next_parent=ANY(seen) OR cardinality(labels)>=32 THEN valid:=false; EXIT; END IF;
      SELECT * INTO parent FROM nb_v2.records x WHERE x.run_id=r.id AND x.id=next_parent AND x.kind='study-note'
        AND x.course_id=note.course_id AND x.source_key=note.source_key AND nb_v2.record_eligible(r.id,x.id);
      IF NOT FOUND OR parent.item->>'title' IS NULL OR btrim(parent.item->>'title')='' OR length(parent.item->>'title')>256 THEN valid:=false; EXIT; END IF;
      seen:=array_append(seen,next_parent); labels:=array_prepend(parent.item->>'title',labels); next_parent:=parent.parent_id;
    END LOOP;
    IF valid AND length(course_label)+COALESCE((SELECT sum(length(label)) FROM unnest(labels) label),0)>4096 THEN valid:=false; END IF;
    entry:=jsonb_build_object('id',note.id,'context',CASE WHEN valid THEN jsonb_build_object('courseLabel',course_label,'parentLabels',to_jsonb(labels)) ELSE NULL END);
    contexts:=array_append(contexts,entry);
  END LOOP;
  entry:=jsonb_build_object('runId',r.id,'revision',(SELECT revision::text FROM nb_v2.state WHERE singleton),
    'schemaDigest',(SELECT schema_digest FROM nb_v2.state WHERE singleton),'contexts',to_jsonb(contexts));
  IF octet_length(entry::text)>262144 THEN RAISE EXCEPTION 'NB_UNAVAILABLE'; END IF;
  RETURN entry;
END $$;

REVOKE ALL ON ALL TABLES IN SCHEMA nb_search_context FROM PUBLIC,nb_reader,nb_writer;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA nb_search_context_api FROM PUBLIC,nb_reader,nb_writer;
GRANT USAGE ON SCHEMA nb_search_context_api TO nb_reader;
GRANT EXECUTE ON FUNCTION nb_search_context_api.read_context(text,text[],uuid,bigint,text) TO nb_reader;
DO $$ DECLARE role_name text; BEGIN
  FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE ALL ON SCHEMA nb_search_context,nb_search_context_api FROM %I',role_name);
    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA nb_search_context FROM %I',role_name);
    EXECUTE format('REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA nb_search_context_api FROM %I',role_name);
  END LOOP;
END $$;
-- The installation owner registers this reviewed file SHA before explicit activation.
COMMIT;
