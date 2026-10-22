-- Opt-in page-level publication. No source calls, scheduler or automatic activation.
BEGIN;
CREATE SCHEMA nb_delta;
CREATE SCHEMA nb_delta_api;
REVOKE ALL ON SCHEMA nb_delta,nb_delta_api FROM PUBLIC;
GRANT USAGE ON SCHEMA nb_delta_api TO nb_reader,nb_writer;
ALTER DEFAULT PRIVILEGES IN SCHEMA nb_delta REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA nb_delta_api REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
CREATE TABLE nb_delta.state(singleton boolean PRIMARY KEY CHECK(singleton),version integer NOT NULL CHECK(version=1),migration_digest text);
INSERT INTO nb_delta.state VALUES(true,1,NULL);
CREATE TABLE nb_delta.operations(
 operation_id uuid PRIMARY KEY,payload_digest text NOT NULL,expected_revision text NOT NULL,config_digest text NOT NULL,
 records jsonb NOT NULL,media jsonb NOT NULL,withdrawals jsonb NOT NULL,receipt jsonb NOT NULL,
 committed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE nb_delta.state ENABLE ROW LEVEL SECURITY;
ALTER TABLE nb_delta.operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA nb_delta FROM PUBLIC,nb_reader,nb_writer;

CREATE FUNCTION nb_delta_api.check_capability(p_digest text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM nb_delta.state WHERE singleton AND version=1 AND migration_digest=p_digest AND p_digest ~ '^[a-f0-9]{64}$')
$$;
CREATE FUNCTION nb_delta_api.read_state() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r nb_v2.runs; s nb_v2.state;
BEGIN
 r:=nb_publication.current_snapshot(); SELECT * INTO s FROM nb_v2.state WHERE singleton;
 RETURN jsonb_build_object('publicationRevision',r.id::text||':'||s.revision::text,'configDigest',s.config_digest,
  'schemaDigest',s.schema_digest,'policyEpoch',s.epoch::text);
END $$;
CREATE FUNCTION nb_delta_api.read_operation(p_operation uuid,p_digest text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE old nb_delta.operations;
BEGIN
 SELECT * INTO old FROM nb_delta.operations WHERE operation_id=p_operation;
 IF old.operation_id IS NULL THEN RETURN NULL; END IF;
 IF old.payload_digest IS DISTINCT FROM p_digest THEN RAISE EXCEPTION 'NB_DELTA_OPERATION_CONFLICT'; END IF;
 RETURN old.receipt;
END $$;

-- Network reads and file preparation finish before this short database transaction.
CREATE FUNCTION nb_delta_api.apply_delta(p_operation uuid,p_digest text,p_expected text,p_config text,
 p_records jsonb,p_media jsonb,p_withdrawals jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s nb_v2.state; publication_state nb_publication.state; r nb_v2.runs; old nb_delta.operations; lease jsonb; fence bigint;
 removed text[]; removed_count integer; records_count integer; media_count integer; absent_count integer; result jsonb;
BEGIN
 IF p_operation IS NULL OR p_digest IS NULL OR p_digest !~ '^[a-f0-9]{64}$' OR p_config IS NULL OR p_config !~ '^[a-f0-9]{64}$'
  OR p_expected IS NULL OR p_expected !~ '^[a-f0-9-]{36}:[0-9]+$'
  OR jsonb_typeof(p_records) IS DISTINCT FROM 'array' OR jsonb_typeof(p_media) IS DISTINCT FROM 'array'
  OR jsonb_typeof(p_withdrawals) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'NB_DELTA_INPUT_INVALID'; END IF;
 IF jsonb_array_length(p_records)>100 OR jsonb_array_length(p_media)>100 OR jsonb_array_length(p_withdrawals)>100
  OR jsonb_array_length(p_records)+jsonb_array_length(p_withdrawals)=0
  OR octet_length(p_records::text)+octet_length(p_media::text)+octet_length(p_withdrawals::text)>16777216 THEN
  RAISE EXCEPTION 'NB_DELTA_INPUT_INVALID'; END IF;
 -- Lock in the same order as full publications and policy/withdrawal edits.
 SELECT * INTO s FROM nb_v2.state WHERE singleton FOR UPDATE;
 SELECT * INTO publication_state FROM nb_publication.state WHERE singleton FOR UPDATE;
 IF NOT EXISTS(SELECT 1 FROM nb_delta.state WHERE singleton AND version=1 AND migration_digest IS NOT NULL) THEN
  RAISE EXCEPTION 'NB_DELTA_UNAVAILABLE'; END IF;
 SELECT * INTO old FROM nb_delta.operations WHERE operation_id=p_operation;
 IF old.operation_id IS NOT NULL THEN
  IF old.payload_digest IS DISTINCT FROM p_digest OR old.expected_revision IS DISTINCT FROM p_expected
   OR old.config_digest IS DISTINCT FROM p_config OR old.records IS DISTINCT FROM p_records
   OR old.media IS DISTINCT FROM p_media OR old.withdrawals IS DISTINCT FROM p_withdrawals THEN
   RAISE EXCEPTION 'NB_DELTA_OPERATION_CONFLICT'; END IF;
  RETURN old.receipt;
 END IF;
 -- Use the locked state after any concurrent publisher/withdrawal has finished.
 SELECT * INTO r FROM nb_v2.runs WHERE id=publication_state.run_id;
 IF publication_state.version IS DISTINCT FROM 1 OR publication_state.migration_digest IS NULL OR r.id IS NULL OR r.status IS DISTINCT FROM 'published'
  OR r.epoch IS DISTINCT FROM s.epoch OR r.config_digest IS DISTINCT FROM s.config_digest THEN RAISE EXCEPTION 'NB_DELTA_UNAVAILABLE'; END IF;
 IF p_expected IS DISTINCT FROM r.id::text||':'||s.revision::text THEN RAISE EXCEPTION 'NB_DELTA_VERSION_CHANGED'; END IF;
 IF p_config IS DISTINCT FROM s.config_digest THEN RAISE EXCEPTION 'NB_DELTA_POLICY_CHANGED'; END IF;
 IF (SELECT count(*) FROM nb_v2.records WHERE run_id=r.id)>20000 THEN RAISE EXCEPTION 'NB_DELTA_INPUT_INVALID'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_records) x GROUP BY x->'detail'->'item'->>'id' HAVING count(*)>1)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_withdrawals) x GROUP BY x->>'id' HAVING count(*)>1)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_records) x JOIN jsonb_array_elements(p_withdrawals) w
   ON x->'detail'->'item'->>'id'=w->>'id') THEN RAISE EXCEPTION 'NB_DELTA_INPUT_INVALID'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_withdrawals) w WHERE w->>'id' IS NULL OR w->>'sourceKey' IS NULL
  OR w->>'reason' IS NULL OR w->>'reason' NOT IN ('archived','deleted','out-of-scope')
  OR NOT EXISTS(SELECT 1 FROM nb_v2.records x WHERE x.run_id=r.id AND x.id=w->>'id' AND x.source_key=w->>'sourceKey')) THEN
  RAISE EXCEPTION 'NB_DELTA_WITHDRAWAL_INVALID'; END IF;
 -- A confirmed ancestor withdrawal removes all old descendants; explicit moved
 -- descendants may be reintroduced only by validated upserts with a new parent.
 WITH RECURSIVE descendants AS (
  SELECT x.id FROM nb_v2.records x JOIN jsonb_array_elements(p_withdrawals) w ON x.id=w->>'id' WHERE x.run_id=r.id
  UNION SELECT x.id FROM nb_v2.records x JOIN descendants d ON x.parent_id=d.id WHERE x.run_id=r.id
 ) SELECT COALESCE(array_agg(id),ARRAY[]::text[]) INTO removed FROM descendants;
 lease:=nb_v2_api.begin_run(p_operation,s.protocol,s.schema_digest,p_config,300); fence:=(lease->>'fence')::bigint;
 -- Reuse the accepted database version. The host sends no unchanged bodies or files.
 INSERT INTO nb_v2.records SELECT p_operation,id,kind,source_key,course_id,parent_id,ordinal,item,document
  FROM nb_v2.records WHERE run_id=r.id AND NOT id=ANY(removed) AND nb_v2.record_eligible(r.id,id);
 INSERT INTO nb_v2.media SELECT p_operation,m.asset_id,m.owner_page_id,m.descriptor FROM nb_v2.media m
  JOIN nb_v2.records x ON x.run_id=p_operation AND x.id=m.owner_page_id WHERE m.run_id=r.id;
 INSERT INTO nb_v2.tombstones SELECT p_operation,id,reason FROM nb_v2.tombstones WHERE run_id=r.id;
 INSERT INTO nb_v2.tombstones SELECT p_operation,p.id,'out-of-scope' FROM nb_v2.permits p WHERE p.id=ANY(removed)
  ON CONFLICT(run_id,id) DO UPDATE SET reason=EXCLUDED.reason;
 DELETE FROM nb_v2.tombstones t WHERE run_id=p_operation AND EXISTS(
  SELECT 1 FROM jsonb_array_elements(p_records) x WHERE x->'detail'->'item'->>'id'=t.id);
 PERFORM nb_v2_api.stage_batch(p_operation,fence,p_records,p_media,'[]');
 -- A moved parent cannot leave unchanged children attached to another course.
 IF EXISTS(SELECT 1 FROM nb_v2.records x
  LEFT JOIN nb_v2.records parent ON parent.run_id=p_operation AND parent.id=x.parent_id
  LEFT JOIN nb_v2.records root ON root.run_id=p_operation AND root.id=x.course_id
  WHERE x.run_id=p_operation AND x.kind='study-note' AND (
   root.id IS NULL OR root.kind<>'course' OR parent.id IS NULL
   OR (parent.id<>root.id AND (parent.kind<>'study-note' OR parent.course_id IS DISTINCT FROM root.id OR parent.source_key<>x.source_key))
   OR x.item->>'courseId' IS DISTINCT FROM x.course_id
   OR x.item->>'parentId' IS DISTINCT FROM CASE WHEN x.parent_id=x.course_id THEN NULL ELSE x.parent_id END)) THEN
  RAISE EXCEPTION 'NB_DELTA_DEPENDENCY_MISSING'; END IF;
 -- Removed image references must stop being addressable, including on edited owners.
 DELETE FROM nb_v2.media m WHERE m.run_id=p_operation AND NOT EXISTS(
  SELECT 1 FROM nb_v2.records x CROSS JOIN LATERAL jsonb_path_query(jsonb_build_array(x.item,x.document),'$.** ? (@.src != null && @.id != null)') img
   WHERE x.run_id=p_operation AND x.id=m.owner_page_id AND img->>'id'=m.asset_id AND img->>'src'='/media/v2/'||m.asset_id);
 SELECT count(*) INTO records_count FROM nb_v2.records WHERE run_id=p_operation;
 SELECT count(*) INTO media_count FROM nb_v2.media WHERE run_id=p_operation;
 SELECT count(*) INTO absent_count FROM nb_v2.tombstones WHERE run_id=p_operation;
 IF records_count>20000 OR media_count>20000 THEN RAISE EXCEPTION 'NB_DELTA_INPUT_INVALID'; END IF;
 SELECT count(*) INTO removed_count FROM unnest(removed) AS lost(id)
  WHERE NOT EXISTS(SELECT 1 FROM nb_v2.records x WHERE x.run_id=p_operation AND x.id=lost.id);
 PERFORM nb_publication_api.promote_run(p_operation,fence,records_count,media_count,true,absent_count);
 -- This delta has not requalified every source. Only the independent pointer
 -- advances; the qualified reader keeps its last genuinely full publication.
 UPDATE nb_v2.state SET current_run=s.current_run WHERE singleton;
 UPDATE nb_v2.runs SET valid_until=LEAST(r.valid_until,clock_timestamp()) WHERE id=p_operation;
 result:=jsonb_build_object('operationId',p_operation,'payloadDigest',p_digest,
  'publicationRevision',p_operation::text||':'||s.revision::text,'upserts',jsonb_array_length(p_records),
  'withdrawals',jsonb_array_length(p_withdrawals),'removedRecords',removed_count,
  'records',records_count,'media',media_count,'committed',true);
 INSERT INTO nb_delta.operations(operation_id,payload_digest,expected_revision,config_digest,records,media,withdrawals,receipt)
  VALUES(p_operation,p_digest,p_expected,p_config,p_records,p_media,p_withdrawals,result);
 RETURN result;
END $$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA nb_delta_api FROM PUBLIC,nb_reader,nb_writer;
DO $$ DECLARE role_name text; BEGIN
 FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role') LOOP
  EXECUTE format('REVOKE ALL ON SCHEMA nb_delta,nb_delta_api FROM %I',role_name);
  EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA nb_delta FROM %I',role_name);
  EXECUTE format('REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA nb_delta_api FROM %I',role_name);
 END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION nb_delta_api.check_capability(text),nb_delta_api.read_state() TO nb_reader,nb_writer;
GRANT EXECUTE ON FUNCTION nb_delta_api.read_operation(uuid,text),nb_delta_api.apply_delta(uuid,text,text,text,jsonb,jsonb,jsonb) TO nb_writer;
COMMIT;
