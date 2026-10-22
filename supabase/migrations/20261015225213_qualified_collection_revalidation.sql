-- Optional qualified recovery; frozen v2 functions and original runs are unchanged.
BEGIN;
CREATE SCHEMA nb_revalidation;
CREATE SCHEMA nb_revalidation_api;
REVOKE ALL ON SCHEMA nb_revalidation, nb_revalidation_api FROM PUBLIC;
GRANT USAGE ON SCHEMA nb_revalidation_api TO nb_writer;
CREATE TABLE nb_revalidation.bindings (
 run_id uuid PRIMARY KEY REFERENCES nb_v2.runs(id),
 previous_run uuid NOT NULL REFERENCES nb_v2.runs(id),
 valid_until timestamptz NOT NULL,
 CHECK (run_id <> previous_run)
);
ALTER TABLE nb_revalidation.bindings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON nb_revalidation.bindings FROM PUBLIC, nb_writer, nb_reader;

-- No client-supplied dates. assert_lease locks the singleton and enforces the
-- current policy, fence, lease and qualification before we narrow the deadline.
CREATE FUNCTION nb_revalidation_api.bind_run(
 p_run uuid, p_fence bigint, p_previous uuid, p_previous_fence bigint, p_previous_revision bigint
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,nb_v2,pg_temp AS $$
DECLARE r nb_v2.runs; old nb_v2.runs; binding nb_revalidation.bindings; deadline timestamptz;
BEGIN
 r := nb_v2.assert_lease(p_run,p_fence);
 SELECT * INTO old FROM nb_v2.runs WHERE id=p_previous;
 IF old.id IS NULL OR old.id=r.id OR old.status IS DISTINCT FROM 'failed' OR old.finished_at IS NULL
   OR old.fence IS DISTINCT FROM p_previous_fence OR old.revision IS DISTINCT FROM p_previous_revision
   OR old.config_digest IS DISTINCT FROM r.config_digest OR old.epoch IS DISTINCT FROM r.epoch
   OR old.revision IS DISTINCT FROM r.revision OR old.started_at > r.started_at
   OR old.valid_until <= clock_timestamp() THEN RAISE EXCEPTION 'NB_RECOVERY_INVALID'; END IF;
 SELECT * INTO binding FROM nb_revalidation.bindings WHERE run_id=r.id;
 IF binding.run_id IS NOT NULL THEN
   IF binding.previous_run IS DISTINCT FROM old.id THEN RAISE EXCEPTION 'NB_RECOVERY_INVALID'; END IF;
   deadline := least(r.valid_until,old.valid_until,binding.valid_until);
 ELSE
   IF EXISTS(SELECT 1 FROM nb_v2.records WHERE run_id=r.id)
     OR EXISTS(SELECT 1 FROM nb_v2.media WHERE run_id=r.id)
     OR EXISTS(SELECT 1 FROM nb_v2.tombstones WHERE run_id=r.id)
     THEN RAISE EXCEPTION 'NB_RECOVERY_INVALID'; END IF;
   deadline := least(r.valid_until,old.valid_until);
   INSERT INTO nb_revalidation.bindings VALUES(r.id,old.id,deadline);
 END IF;
 UPDATE nb_v2.runs SET valid_until=deadline WHERE id=r.id;
 UPDATE nb_revalidation.bindings SET valid_until=deadline WHERE run_id=r.id;
 RETURN jsonb_build_object('runId',r.id,'previousRunId',old.id,'configDigest',r.config_digest,
   'fence',r.fence::text,'revision',r.revision::text,'validUntil',deadline,
   'previousValidUntil',old.valid_until,'serverNow',clock_timestamp());
END $$;
REVOKE ALL ON FUNCTION nb_revalidation_api.bind_run(uuid,bigint,uuid,bigint,bigint) FROM PUBLIC,nb_reader;
GRANT EXECUTE ON FUNCTION nb_revalidation_api.bind_run(uuid,bigint,uuid,bigint,bigint) TO nb_writer;
COMMIT;
