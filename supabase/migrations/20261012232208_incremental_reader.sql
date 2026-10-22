-- Private single-page preparation and independent acknowledgement. No publication.
BEGIN;
ALTER TABLE nb_delta.state ADD COLUMN reader_digest text;
CREATE FUNCTION nb_delta_api.check_reader(p_digest text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM nb_delta.state WHERE singleton AND version=1 AND reader_digest=p_digest AND p_digest ~ '^[a-f0-9]{64}$')
$$;

CREATE FUNCTION nb_delta_api.read_page(p_page text,p_source text,p_expected text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE current_run nb_v2.runs; policy_state nb_v2.state; selected_record nb_v2.records; source_policy nb_v2.sources; result jsonb;
BEGIN
 IF p_page IS NULL OR p_page !~ '^[A-Za-z0-9_-]{1,128}$' OR p_source IS NULL OR length(p_source) NOT BETWEEN 1 AND 128 THEN
  RAISE EXCEPTION 'NB_DELTA_INPUT_INVALID'; END IF;
 current_run:=nb_publication.current_snapshot(); SELECT * INTO policy_state FROM nb_v2.state WHERE singleton;
 IF p_expected IS DISTINCT FROM current_run.id::text||':'||policy_state.revision::text THEN RAISE EXCEPTION 'NB_DELTA_VERSION_CHANGED'; END IF;
 SELECT * INTO selected_record FROM nb_v2.records WHERE run_id=current_run.id AND id=p_page AND source_key=p_source;
 IF selected_record.id IS NULL OR NOT nb_v2.record_eligible(current_run.id,selected_record.id) THEN RETURN NULL; END IF;
 SELECT * INTO source_policy FROM nb_v2.sources WHERE key=selected_record.source_key;
 IF source_policy.key IS NULL OR source_policy.kind IS DISTINCT FROM selected_record.kind OR selected_record.document IS NULL THEN
  RAISE EXCEPTION 'NB_DELTA_READER_UNAVAILABLE'; END IF;
 result:=jsonb_build_object('record',jsonb_build_object(
  'detail',jsonb_build_object('item',selected_record.item,'document',selected_record.document),
  'evidence',jsonb_build_object('sourceKey',selected_record.source_key,'dataSourceId',source_policy.data_source_id,
   'databaseParentId',source_policy.database_parent_id,'courseId',selected_record.course_id,'parentId',selected_record.parent_id,'ordinal',selected_record.ordinal)),
  'media',(SELECT COALESCE(jsonb_agg(m.descriptor ORDER BY m.asset_id),'[]') FROM nb_v2.media m WHERE m.run_id=current_run.id AND m.owner_page_id=p_page),
  'publicationRevision',current_run.id::text||':'||policy_state.revision::text,'configDigest',policy_state.config_digest,
  'schemaDigest',policy_state.schema_digest,'readerVerified',true);
 IF octet_length(result::text)>16777216 THEN RAISE EXCEPTION 'NB_DELTA_READER_UNAVAILABLE'; END IF;
 RETURN result;
END $$;

CREATE FUNCTION nb_delta_api.verify_operation(p_operation uuid,p_digest text,p_revision text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE operation_row nb_delta.operations; current_run nb_v2.runs; policy_state nb_v2.state;
BEGIN
 SELECT * INTO operation_row FROM nb_delta.operations WHERE operation_id=p_operation;
 IF operation_row.operation_id IS NULL OR operation_row.payload_digest IS DISTINCT FROM p_digest
  OR operation_row.receipt->>'publicationRevision' IS DISTINCT FROM p_revision THEN RETURN NULL; END IF;
 current_run:=nb_publication.current_snapshot(); SELECT * INTO policy_state FROM nb_v2.state WHERE singleton;
 IF p_revision IS DISTINCT FROM current_run.id::text||':'||policy_state.revision::text
  OR current_run.id IS DISTINCT FROM p_operation OR operation_row.config_digest IS DISTINCT FROM policy_state.config_digest THEN RETURN NULL; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(operation_row.records) changed
  LEFT JOIN nb_v2.records actual ON actual.run_id=current_run.id AND actual.id=changed->'detail'->'item'->>'id'
  WHERE actual.id IS NULL OR NOT nb_v2.record_eligible(current_run.id,actual.id)
   OR actual.item IS DISTINCT FROM changed->'detail'->'item' OR actual.document IS DISTINCT FROM NULLIF(changed->'detail'->'document','null'::jsonb)
   OR actual.source_key IS DISTINCT FROM changed->'evidence'->>'sourceKey'
   OR actual.course_id IS DISTINCT FROM changed->'evidence'->>'courseId'
   OR actual.parent_id IS DISTINCT FROM changed->'evidence'->>'parentId'
   OR actual.ordinal IS DISTINCT FROM (changed->'evidence'->>'ordinal')::integer) THEN RETURN NULL; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(operation_row.withdrawals) removed
  JOIN nb_v2.records actual ON actual.run_id=current_run.id AND actual.id=removed->>'id') THEN RETURN NULL; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(operation_row.media) prepared
  LEFT JOIN nb_v2.media actual ON actual.run_id=current_run.id AND actual.asset_id=prepared->>'assetId'
  WHERE actual.asset_id IS NULL OR actual.descriptor IS DISTINCT FROM prepared
   OR NOT nb_v2.record_eligible(current_run.id,actual.owner_page_id)) THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('operationId',p_operation,'payloadDigest',p_digest,'publicationRevision',p_revision,
  'schemaDigest',policy_state.schema_digest,'readerVerified',true);
END $$;

REVOKE EXECUTE ON FUNCTION nb_delta_api.check_reader(text),nb_delta_api.read_page(text,text,text),nb_delta_api.verify_operation(uuid,text,text)
 FROM PUBLIC,nb_reader,nb_writer;
DO $$ DECLARE role_name text; BEGIN
 FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role') LOOP
  EXECUTE format('REVOKE EXECUTE ON FUNCTION nb_delta_api.check_reader(text),nb_delta_api.read_page(text,text,text),nb_delta_api.verify_operation(uuid,text,text) FROM %I',role_name);
 END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION nb_delta_api.check_reader(text),nb_delta_api.read_page(text,text,text),nb_delta_api.verify_operation(uuid,text,text) TO nb_reader;
COMMIT;
