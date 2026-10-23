-- Advisory cached inputs under a narrowly checked mapping-only transition.
-- Only the NEW lease grants qualification; no old deadline or run is changed.
BEGIN;
CREATE FUNCTION nb_revalidation_api.inspect_mapped_fresh_run(
 p_run uuid,p_fence bigint,p_previous uuid,p_previous_fence bigint,p_previous_revision bigint,p_previous_digest text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,nb_v2,pg_temp AS $$
DECLARE r nb_v2.runs; old nb_v2.runs;
BEGIN
 r := nb_v2.assert_lease(p_run,p_fence);
 SELECT * INTO old FROM nb_v2.runs WHERE id=p_previous;
 IF old.id IS NULL OR old.id=r.id OR old.status NOT IN ('failed','published') OR old.finished_at IS NULL
   OR old.fence IS DISTINCT FROM p_previous_fence OR old.revision IS DISTINCT FROM p_previous_revision
   OR p_previous_digest IS NULL OR p_previous_digest !~ '^[a-f0-9]{64}$'
   OR old.config_digest IS DISTINCT FROM p_previous_digest
   OR old.config_digest IS NOT DISTINCT FROM r.config_digest OR old.started_at>r.started_at
   OR EXISTS(SELECT 1 FROM nb_revalidation.bindings WHERE run_id=r.id)
   OR EXISTS(SELECT 1 FROM nb_v2.records WHERE run_id=r.id)
   OR EXISTS(SELECT 1 FROM nb_v2.media WHERE run_id=r.id)
   OR EXISTS(SELECT 1 FROM nb_v2.tombstones WHERE run_id=r.id)
   THEN RAISE EXCEPTION 'NB_MAPPED_FRESH_VERIFICATION_INVALID'; END IF;
 RETURN jsonb_build_object('qualification','fresh','runId',r.id,'previousRunId',old.id,
   'configDigest',r.config_digest,'previousConfigDigest',old.config_digest,'fence',r.fence::text,'revision',r.revision::text,
   'validUntil',r.valid_until,'previousValidUntil',old.valid_until,'serverNow',clock_timestamp());
END $$;
REVOKE ALL ON FUNCTION nb_revalidation_api.inspect_mapped_fresh_run(uuid,bigint,uuid,bigint,bigint,text) FROM PUBLIC,nb_reader;
GRANT EXECUTE ON FUNCTION nb_revalidation_api.inspect_mapped_fresh_run(uuid,bigint,uuid,bigint,bigint,text) TO nb_writer;
INSERT INTO nb_v2.migrations(version) VALUES('001-mapped-collection-revalidation-v2');
COMMIT;
