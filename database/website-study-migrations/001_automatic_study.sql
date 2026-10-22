-- Independent opt-in study extension. Does not activate or change a policy.
BEGIN;
CREATE SCHEMA nb_study;
CREATE SCHEMA nb_study_api;
REVOKE ALL ON SCHEMA nb_study, nb_study_api FROM PUBLIC;
GRANT USAGE ON SCHEMA nb_study_api TO nb_writer;
ALTER DEFAULT PRIVILEGES IN SCHEMA nb_study REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA nb_study_api REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

ALTER TABLE nb_v2.sources DROP CONSTRAINT sources_check;
ALTER TABLE nb_v2.sources DROP CONSTRAINT sources_check2;
ALTER TABLE nb_v2.sources ADD CONSTRAINT sources_study_mode CHECK (
  (mode IN ('all','allowlist') AND (mode<>'all' OR kind NOT IN ('study-note','page'))) OR
  (mode='course-descendants' AND kind='study-note'));
ALTER TABLE nb_v2.sources ADD CONSTRAINT sources_study_parent CHECK (
  kind<>'study-note' OR (mode='allowlist' AND database_parent_id IS NOT NULL) OR
  (mode='course-descendants' AND database_parent_id IS NULL));

-- Preserve the frozen implementation for every legacy policy and batch.
ALTER FUNCTION nb_v2_api.configure_policy(text,integer,jsonb,jsonb) SET SCHEMA nb_study;
ALTER FUNCTION nb_study.configure_policy(text,integer,jsonb,jsonb) RENAME TO configure_legacy;
CREATE FUNCTION nb_v2_api.configure_policy(p_digest text,p_freshness integer,p_sources jsonb,p_permits jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,nb_v2,nb_study,pg_temp AS $$
BEGIN
  PERFORM nb_study.configure_legacy(p_digest,p_freshness,p_sources,p_permits);
  IF EXISTS(SELECT FROM nb_v2.sources n WHERE n.mode='course-descendants' AND
      NOT EXISTS(SELECT FROM nb_v2.sources c WHERE c.kind='course' AND c.mode='all' AND c.data_source_id=n.data_source_id)) OR
    EXISTS(SELECT data_source_id FROM nb_v2.sources WHERE mode='course-descendants' GROUP BY data_source_id HAVING count(*)>1) THEN
    RAISE EXCEPTION 'NB_STUDY_POLICY_INVALID';
  END IF;
END $$;

ALTER FUNCTION nb_v2_api.stage_batch(uuid,bigint,jsonb,jsonb,jsonb) SET SCHEMA nb_study;
ALTER FUNCTION nb_study.stage_batch(uuid,bigint,jsonb,jsonb,jsonb) RENAME TO stage_legacy;
REVOKE EXECUTE ON FUNCTION nb_study.stage_legacy(uuid,bigint,jsonb,jsonb,jsonb) FROM nb_writer, nb_reader, PUBLIC;
CREATE FUNCTION nb_v2_api.stage_batch(p_run uuid,p_fence bigint,p_records jsonb,p_media jsonb,p_absences jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,nb_v2,nb_study,pg_temp AS $$
DECLARE x jsonb; i jsonb; e jsonb; s nb_v2.sources; root nb_v2.records; parent nb_v2.records; legacy jsonb:='[]';
BEGIN
  PERFORM nb_v2.assert_lease(p_run,p_fence);
  IF jsonb_typeof(p_records) IS DISTINCT FROM 'array' OR jsonb_typeof(p_media) IS DISTINCT FROM 'array' OR jsonb_typeof(p_absences) IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_records)>100 OR jsonb_array_length(p_media)>100 OR jsonb_array_length(p_absences)>100 THEN RAISE EXCEPTION 'NB_BATCH_TOO_LARGE'; END IF;
  FOR x IN SELECT value FROM jsonb_array_elements(p_records) LOOP
    i:=x->'detail'->'item'; e:=x->'evidence';
    SELECT * INTO s FROM nb_v2.sources WHERE key=e->>'sourceKey';
    IF s.mode IS DISTINCT FROM 'course-descendants' THEN legacy:=legacy||jsonb_build_array(x); CONTINUE; END IF;
    IF jsonb_array_length(legacy)>0 THEN PERFORM nb_study.stage_legacy(p_run,p_fence,legacy,'[]','[]'); legacy:='[]'; END IF;
    SELECT * INTO root FROM nb_v2.records WHERE run_id=p_run AND id=e->>'courseId';
    SELECT * INTO parent FROM nb_v2.records WHERE run_id=p_run AND id=e->>'parentId';
    IF s.kind<>'study-note' OR i->>'kind' IS DISTINCT FROM 'study-note' OR
      e->>'dataSourceId' IS DISTINCT FROM s.data_source_id OR e->>'databaseParentId' IS NOT NULL OR
      e->>'courseId' IS NULL OR e->>'parentId' IS NULL OR
      i->>'courseId' IS DISTINCT FROM e->>'courseId' OR i->>'parentId' IS DISTINCT FROM
        (CASE WHEN e->>'parentId'=e->>'courseId' THEN NULL ELSE e->>'parentId' END) OR
      root.id IS NULL OR root.kind<>'course' OR parent.id IS NULL OR
      NOT EXISTS(SELECT FROM nb_v2.sources c WHERE c.key=root.source_key AND c.kind='course' AND c.mode='all' AND c.data_source_id=s.data_source_id) OR
      (parent.id<>root.id AND (parent.kind<>'study-note' OR parent.source_key<>s.key OR parent.course_id IS DISTINCT FROM root.id)) OR
      parent.id=i->>'id' OR root.id=i->>'id' THEN RAISE EXCEPTION 'NB_STUDY_SCOPE_INVALID'; END IF;
    IF EXISTS(SELECT FROM nb_v2.denied WHERE id=i->>'id') OR NOT nb_v2.record_eligible(p_run,parent.id) THEN RAISE EXCEPTION 'NB_SCOPE_DENIED'; END IF;
    IF EXISTS(SELECT FROM nb_v2.records r WHERE r.run_id=p_run AND r.id=i->>'id' AND
        (r.kind<>'study-note' OR r.source_key<>s.key)) OR
      (WITH RECURSIVE ancestors AS (
        SELECT r.id,r.parent_id,ARRAY[r.id] AS path FROM nb_v2.records r WHERE r.run_id=p_run AND r.id=parent.id
        UNION ALL SELECT r.id,r.parent_id,a.path||r.id FROM nb_v2.records r JOIN ancestors a ON r.id=a.parent_id
          WHERE r.run_id=p_run AND NOT r.id=ANY(a.path) AND cardinality(a.path)<=24
      ) SELECT count(*)>24 OR COALESCE(bool_or(id=i->>'id'),false) FROM ancestors) THEN
      RAISE EXCEPTION 'NB_STUDY_ANCESTRY_INVALID'; END IF;
    INSERT INTO nb_v2.records VALUES(p_run,i->>'id','study-note',s.key,root.id,parent.id,(e->>'ordinal')::integer,i,
      NULLIF(x->'detail'->'document','null'::jsonb))
    ON CONFLICT(run_id,id) DO UPDATE SET kind=EXCLUDED.kind,source_key=EXCLUDED.source_key,
      course_id=EXCLUDED.course_id,parent_id=EXCLUDED.parent_id,ordinal=EXCLUDED.ordinal,item=EXCLUDED.item,document=EXCLUDED.document;
  END LOOP;
  PERFORM nb_study.stage_legacy(p_run,p_fence,legacy,p_media,p_absences);
END $$;
GRANT EXECUTE ON FUNCTION nb_v2_api.stage_batch(uuid,bigint,jsonb,jsonb,jsonb) TO nb_writer;
REVOKE EXECUTE ON FUNCTION nb_v2_api.configure_policy(text,integer,jsonb,jsonb), nb_v2_api.stage_batch(uuid,bigint,jsonb,jsonb,jsonb) FROM PUBLIC;

CREATE FUNCTION nb_study_api.check_capability(p_digest text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,nb_v2,pg_temp AS $$
  SELECT p_digest IS NOT NULL AND p_digest=(SELECT digest FROM nb_v2.migrations WHERE version='001-automatic-study')
$$;
REVOKE ALL ON FUNCTION nb_study_api.check_capability(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nb_study_api.check_capability(text) TO nb_writer;
INSERT INTO nb_v2.migrations(version) VALUES('001-automatic-study');
-- Installation owner sets this row's digest from the checked file manifest.
COMMIT;
