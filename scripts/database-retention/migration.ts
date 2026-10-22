import {archiveIndexSQL, archivePayloadSQL, deleteChunkSQL, PAYLOAD_TABLES, retentionPlanSQL, tableFingerprintSQL} from "./plan.ts";

const emptyRuns = "ARRAY[]::uuid[]";
const pinRuns = "ARRAY(SELECT run_id FROM nb_retention.pins ORDER BY run_id)";
const planSQL = retentionPlanSQL([]).replace(emptyRuns, pinRuns);
const sample = "00000000-0000-0000-0000-000000000001";
const digest = "a".repeat(64);
const tables = PAYLOAD_TABLES.map(t => `'${t}'::regclass`).join(",");
const jsonRows = (sql: string) => `SELECT COALESCE(jsonb_agg(to_jsonb(q)),'[]'::jsonb) FROM (${sql}) q`;
const cases = (query: (table: typeof PAYLOAD_TABLES[number]) => string) => PAYLOAD_TABLES.map(t => `WHEN '${t}' THEN ${query(t)} INTO result;`).join("\n");

/** Separate execution-only role. No existing reader/writer grants or LOGIN credentials change.
 * Installation is disabled; an owner must review pins and record the live dependency catalog.
 * No request JWT is involved: this is a private, direct-Postgres maintenance login, not an API.
 */
export const retentionMigrationSQL = `BEGIN;
CREATE SCHEMA nb_retention;
CREATE SCHEMA nb_retention_api;
REVOKE ALL ON SCHEMA nb_retention,nb_retention_api FROM PUBLIC;
CREATE ROLE nb_retention_executor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA nb_retention_api TO nb_retention_executor;
CREATE TABLE nb_retention.config(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 enabled boolean NOT NULL DEFAULT false,catalog_sha text CHECK(catalog_sha ~ '^[a-f0-9]{64}$'));
INSERT INTO nb_retention.config(singleton) VALUES(true);
CREATE TABLE nb_retention.pins(run_id uuid PRIMARY KEY REFERENCES nb_v2.runs(id),reason text NOT NULL CHECK(length(reason)>0));
CREATE TABLE nb_retention.chunks(operation_id uuid PRIMARY KEY,run_id uuid NOT NULL REFERENCES nb_v2.runs(id),
 payload_table text NOT NULL,archive_sha text NOT NULL,before_sha text NOT NULL,deleted_count integer NOT NULL,
 deleted_sha text NOT NULL,finished_at timestamptz NOT NULL DEFAULT clock_timestamp());
ALTER TABLE nb_retention.config ENABLE ROW LEVEL SECURITY;
ALTER TABLE nb_retention.pins ENABLE ROW LEVEL SECURITY;
ALTER TABLE nb_retention.chunks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA nb_retention FROM PUBLIC,nb_reader,nb_writer,nb_retention_executor;

CREATE FUNCTION nb_retention.catalog_sha() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT encode(sha256(convert_to(COALESCE(string_agg(line,'|' ORDER BY line),''),'UTF8')),'hex') FROM (
 SELECT 'constraint:'||conrelid::regclass::text||':'||conname||':'||pg_get_constraintdef(oid) AS line
 FROM pg_catalog.pg_constraint WHERE conrelid=ANY(ARRAY[${tables}]) OR confrelid=ANY(ARRAY[${tables}])
 UNION ALL SELECT 'trigger:'||tgrelid::regclass::text||':'||pg_get_triggerdef(oid)||':'||tgenabled::text||':'||pg_get_functiondef(tgfoid)
 FROM pg_catalog.pg_trigger WHERE NOT tgisinternal AND tgrelid=ANY(ARRAY[${tables}])
 UNION ALL SELECT 'column:'||attrelid::regclass::text||':'||attnum||':'||attname||':'||atttypid||':'||attnotnull||':'||attisdropped
 FROM pg_catalog.pg_attribute WHERE attnum>0 AND attrelid=ANY(ARRAY[${tables}])
 ) q
$$;
CREATE FUNCTION nb_retention.assert_enabled() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NOT EXISTS(SELECT FROM nb_retention.config WHERE singleton AND enabled AND catalog_sha=nb_retention.catalog_sha()) THEN
  RAISE EXCEPTION 'RETENTION_DISABLED_OR_CATALOG_CHANGED'; END IF;
END $$;
CREATE FUNCTION nb_retention_api.plan() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET enable_nestloop=off AS $$
DECLARE result jsonb;
BEGIN PERFORM nb_retention.assert_enabled(); ${planSQL} INTO result; RETURN result; END $$;
CREATE FUNCTION nb_retention_api.archive_schema() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb;
BEGIN
 PERFORM nb_retention.assert_enabled();
 SELECT jsonb_build_object('catalogSHA256',nb_retention.catalog_sha(),'tables',jsonb_agg(jsonb_build_object(
  'name',c.oid::regclass::text,'createSQL',format('CREATE TABLE %I.%I (%s)',n.nspname,c.relname,
   (SELECT string_agg(format('%I %s%s%s',a.attname,format_type(a.atttypid,a.atttypmod),
    CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END,
    CASE WHEN d.adbin IS NOT NULL THEN ' DEFAULT '||pg_get_expr(d.adbin,d.adrelid) ELSE '' END),',' ORDER BY a.attnum)
    FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped)),
  'constraints',COALESCE((SELECT jsonb_agg(format('ALTER TABLE %I.%I ADD CONSTRAINT %I %s',n.nspname,c.relname,k.conname,pg_get_constraintdef(k.oid)) ORDER BY k.conname)
   FROM pg_catalog.pg_constraint k WHERE k.conrelid=c.oid),'[]'),
  'indexes',COALESCE((SELECT jsonb_agg(pg_get_indexdef(i.indexrelid) ORDER BY i.indexrelid)
   FROM pg_catalog.pg_index i WHERE i.indrelid=c.oid AND NOT EXISTS(SELECT FROM pg_catalog.pg_constraint k WHERE k.conindid=i.indexrelid)),'[]')
 ) ORDER BY c.oid::regclass::text)) INTO result
 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 WHERE c.oid=ANY(ARRAY[${tables},'nb_v2.runs'::regclass]);
 RETURN result;
END $$;

CREATE FUNCTION nb_retention_api.archive_index(p_table text,p_run uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb;
BEGIN
 PERFORM nb_retention.assert_enabled();
 IF NOT EXISTS(SELECT FROM nb_v2.runs WHERE id=p_run AND status IN ('published','failed')
  AND finished_at<statement_timestamp()-interval '24 hours' AND valid_until<statement_timestamp()) THEN
  RAISE EXCEPTION 'RETENTION_NOT_HISTORICAL'; END IF;
 CASE p_table
 ${cases(t => jsonRows(archiveIndexSQL(t,[]).replace(emptyRuns,"ARRAY[p_run]::uuid[]")))}
 ELSE RAISE EXCEPTION 'RETENTION_INVALID_TABLE'; END CASE; RETURN result;
END $$;
CREATE FUNCTION nb_retention_api.archive_payload(p_table text,p_refs jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb;
BEGIN
 PERFORM nb_retention.assert_enabled();
 IF jsonb_typeof(p_refs) IS DISTINCT FROM 'array' OR jsonb_array_length(p_refs) NOT BETWEEN 1 AND 50 THEN
  RAISE EXCEPTION 'RETENTION_INVALID_REFS'; END IF;
 CASE p_table
 ${cases(t => {
   const refs=[{sha:digest,sample_run:sample,key:"placeholder",width:null}];
   return jsonRows(archivePayloadSQL(t,refs).replace(`'${JSON.stringify(refs)}'::jsonb`, "p_refs"));
 })}
 ELSE RAISE EXCEPTION 'RETENTION_INVALID_TABLE'; END CASE; RETURN result;
END $$;
CREATE FUNCTION nb_retention_api.fingerprint(p_table text,p_runs uuid[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET work_mem='16MB' AS $$
DECLARE result jsonb;
BEGIN
 PERFORM nb_retention.assert_enabled();
 IF cardinality(p_runs)>200 OR p_runs IS NULL THEN RAISE EXCEPTION 'RETENTION_INVALID_RUNS'; END IF;
 CASE p_table
 ${cases(t => jsonRows(tableFingerprintSQL(t,[]).replace(emptyRuns,"p_runs")))}
 ELSE RAISE EXCEPTION 'RETENTION_INVALID_TABLE'; END CASE; RETURN result;
END $$;

CREATE FUNCTION nb_retention_api.delete_chunk(p_table text,p_guard jsonb,p_limit integer,p_operation uuid,p_archive_sha text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET enable_nestloop=off SET lock_timeout='2s' AS $$
DECLARE result jsonb; fresh jsonb;
BEGIN
 PERFORM nb_retention.assert_enabled();
 IF p_operation IS NULL OR p_archive_sha IS NULL OR p_archive_sha !~ '^[a-f0-9]{64}$' OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 OR
  NOT COALESCE((p_guard->>'run') ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$',false) OR
  EXISTS(SELECT FROM unnest(ARRAY['stateSHA256','publicationSHA256','summarySHA256','remainingPayloadSHA256']) k
   WHERE NOT COALESCE((p_guard->>k) ~ '^[a-f0-9]{64}$',false)) THEN RAISE EXCEPTION 'RETENTION_INVALID_GUARD'; END IF;
 IF EXISTS(SELECT FROM nb_retention.chunks WHERE operation_id=p_operation) THEN RAISE EXCEPTION 'RETENTION_RECONCILE_REQUIRED'; END IF;
 -- No table writes can add a donor, revalidation or delta dependency between this plan and deletion.
 -- State locks reject a live writer immediately. A bounded table-lock wait lets routine
 -- autovacuum finish instead of treating a brief background lock as a failed cleanup.
 PERFORM 1 FROM nb_v2.state WHERE singleton FOR UPDATE NOWAIT;
 PERFORM 1 FROM nb_publication.state WHERE singleton FOR UPDATE NOWAIT;
 LOCK TABLE nb_v2.runs,nb_v2.records,nb_v2.media,nb_v2_media.sources,nb_v2.tombstones,nb_thumbnails.media,
  nb_revalidation.bindings,nb_delta.operations,nb_retention.config,nb_retention.pins IN SHARE ROW EXCLUSIVE MODE;
 PERFORM nb_retention.assert_enabled();
 fresh:=nb_retention_api.plan();
 IF NOT EXISTS(SELECT FROM jsonb_array_elements(fresh->'candidates') c WHERE c->>'id'=p_guard->>'run') THEN
  RAISE EXCEPTION 'RETENTION_PROTECTED_RUN'; END IF;
 CASE p_table
 ${cases(t => {
   const query=deleteChunkSQL(t,{run:sample,stateSHA256:"b".repeat(64),publicationSHA256:"c".repeat(64),summarySHA256:"d".repeat(64),remainingPayloadSHA256:"e".repeat(64)},500);
   return query.replaceAll(`'${sample}'::uuid`,"(p_guard->>'run')::uuid")
    .replaceAll(`'${"b".repeat(64)}'`,"(p_guard->>'stateSHA256')").replaceAll(`'${"c".repeat(64)}'`,"(p_guard->>'publicationSHA256')")
    .replaceAll(`'${"d".repeat(64)}'`,"(p_guard->>'summarySHA256')").replaceAll(`'${"e".repeat(64)}'`,"(p_guard->>'remainingPayloadSHA256')")
    .replace("LIMIT 500","LIMIT p_limit");
 })}
 ELSE RAISE EXCEPTION 'RETENTION_INVALID_TABLE'; END CASE;
 IF NOT COALESCE((result->>'guardAccepted')::boolean,false) THEN RAISE EXCEPTION 'RETENTION_GUARD_CHANGED'; END IF;
 INSERT INTO nb_retention.chunks(operation_id,run_id,payload_table,archive_sha,before_sha,deleted_count,deleted_sha)
 SELECT p_operation,(p_guard->>'run')::uuid,p_table,p_archive_sha,p_guard->>'remainingPayloadSHA256',jsonb_array_length(result->'deleted'),
 encode(sha256(convert_to(COALESCE(string_agg(sha,'' ORDER BY sha),''),'UTF8')),'hex') FROM jsonb_array_elements_text(result->'deleted') sha;
 RETURN result;
END $$;
CREATE FUNCTION nb_retention_api.receipt(p_operation uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT to_jsonb(c) FROM nb_retention.chunks c WHERE operation_id=p_operation
$$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA nb_retention,nb_retention_api FROM PUBLIC,nb_reader,nb_writer;
DO $$ DECLARE r text; BEGIN
 FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname IN ('anon','authenticated','service_role') LOOP
  EXECUTE format('REVOKE ALL ON SCHEMA nb_retention,nb_retention_api FROM %I',r);
  EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA nb_retention FROM %I',r);
  EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA nb_retention,nb_retention_api FROM %I',r);
 END LOOP;
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA nb_retention_api TO nb_retention_executor;
COMMIT;`;
