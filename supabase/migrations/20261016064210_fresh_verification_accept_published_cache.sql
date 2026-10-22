-- Future fresh runs may verify caches from failed OR successfully published runs.
-- No run rows, expiry, privileges, or scope change.
BEGIN;
DO $repair$
DECLARE signature text := 'nb_revalidation_api.inspect_fresh_run(uuid,bigint,uuid,bigint,bigint)'; original text; repaired text;
BEGIN
 original := pg_get_functiondef(signature::regprocedure);
 IF md5(original) IS DISTINCT FROM '36686ba113b75620aefbe4be0e0642aa' OR (length(original)-length(replace(original, 'old.status IS DISTINCT FROM ''failed''', ''))) / length('old.status IS DISTINCT FROM ''failed''') <> 1
   OR position('r := nb_v2.assert_lease(p_run,p_fence)' in original)=0
   OR position('old.finished_at IS NULL' in original)=0
   OR position('old.fence IS DISTINCT FROM p_previous_fence' in original)=0
   OR position('old.config_digest IS DISTINCT FROM r.config_digest' in original)=0 THEN
   RAISE EXCEPTION 'FRESH_INSPECTION_DEFINITION_CHANGED';
 END IF;
 repaired := replace(original, 'old.status IS DISTINCT FROM ''failed''', '(old.status IS DISTINCT FROM ''failed'' AND old.status IS DISTINCT FROM ''published'')');
 EXECUTE repaired;
END $repair$;
COMMIT;
