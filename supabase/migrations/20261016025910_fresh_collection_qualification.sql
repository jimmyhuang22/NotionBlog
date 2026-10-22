-- Explicit fresh verification, separate from original-deadline recovery.
-- No run or deadline is updated. The worker must freshly discover membership,
-- match complete source proofs and revalidate owners before staging any cache.
BEGIN;
CREATE FUNCTION nb_revalidation_api.inspect_fresh_run(
 p_run uuid, p_fence bigint, p_previous uuid, p_previous_fence bigint, p_previous_revision bigint
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,nb_v2,pg_temp AS $$
DECLARE r nb_v2.runs; old nb_v2.runs;
BEGIN
 r := nb_v2.assert_lease(p_run,p_fence);
 SELECT * INTO old FROM nb_v2.runs WHERE id=p_previous;
 IF old.id IS NULL OR old.id=r.id OR old.status IS DISTINCT FROM 'failed' OR old.finished_at IS NULL
   OR old.fence IS DISTINCT FROM p_previous_fence OR old.revision IS DISTINCT FROM p_previous_revision
   OR old.config_digest IS DISTINCT FROM r.config_digest OR old.started_at > r.started_at
   OR EXISTS(SELECT 1 FROM nb_revalidation.bindings WHERE run_id=r.id)
   OR EXISTS(SELECT 1 FROM nb_v2.records WHERE run_id=r.id)
   OR EXISTS(SELECT 1 FROM nb_v2.media WHERE run_id=r.id)
   OR EXISTS(SELECT 1 FROM nb_v2.tombstones WHERE run_id=r.id)
   THEN RAISE EXCEPTION 'NB_FRESH_VERIFICATION_INVALID'; END IF;
 -- Old expiry/epoch/revision are historical. All permission comes from the new
 -- lease and CURRENT source discovery, not the failed run or its stored DTOs.
 RETURN jsonb_build_object('qualification','fresh','runId',r.id,'previousRunId',old.id,
   'configDigest',r.config_digest,'fence',r.fence::text,'revision',r.revision::text,
   'validUntil',r.valid_until,'previousValidUntil',old.valid_until,'serverNow',clock_timestamp());
END $$;
REVOKE ALL ON FUNCTION nb_revalidation_api.inspect_fresh_run(uuid,bigint,uuid,bigint,bigint) FROM PUBLIC,nb_reader;
GRANT EXECUTE ON FUNCTION nb_revalidation_api.inspect_fresh_run(uuid,bigint,uuid,bigint,bigint) TO nb_writer;
COMMIT;
