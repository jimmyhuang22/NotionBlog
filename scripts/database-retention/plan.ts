/** Owner-side planning only. No permissions, storage objects or publication pointers change. */
export const PAYLOAD_TABLES = [
  "nb_v2.records", "nb_v2.media", "nb_v2_media.sources", "nb_v2.tombstones", "nb_thumbnails.media",
] as const;
export type PayloadTable = typeof PAYLOAD_TABLES[number];
export function uuidLiteral(value: string): string {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)) throw Error("RETENTION_INVALID_RUN");
  return `'${value}'::uuid`;
}
export function runArray(values: readonly string[]): string {
  if (values.length > 200 || new Set(values).size !== values.length) throw Error("RETENTION_INVALID_RUNS");
  return `ARRAY[${values.map(uuidLiteral).join(",")}]::uuid[]`;
}
export function payloadFilter(table: PayloadTable): string {
  if (!PAYLOAD_TABLES.includes(table)) throw Error("RETENTION_INVALID_TABLE");
  return table === "nb_thumbnails.media" ? "AND x.version='v2'" : "";
}
/** Protect all live pointers, active work, a day of completions, and three successful versions.
 * Historical published-thumbnail selection is a dependency graph, not an age-based delete.
 * Its transitive closure retains complete donor snapshots, including their owners and locators.
 */
export function retentionProtectionSQL(pinnedRuns: readonly string[]): string {
  const pins = runArray(pinnedRuns);
  return `WITH RECURSIVE
roots(id) AS (
 SELECT current_run FROM nb_v2.state WHERE singleton AND current_run IS NOT NULL
 UNION SELECT lease_run FROM nb_v2.state WHERE singleton AND lease_run IS NOT NULL
 UNION SELECT run_id FROM nb_publication.state WHERE singleton AND run_id IS NOT NULL
 UNION SELECT id FROM nb_v2.runs WHERE status='staging'
 UNION SELECT id FROM nb_v2.runs WHERE valid_until>statement_timestamp()
 UNION SELECT id FROM nb_v2.runs WHERE finished_at>statement_timestamp()-interval '24 hours'
 UNION SELECT id FROM nb_v2.runs WHERE status='published' AND finished_at IS NULL
 UNION SELECT id FROM (SELECT id FROM nb_v2.runs WHERE status='published' ORDER BY finished_at DESC NULLS LAST,id DESC LIMIT 3) latest
 UNION SELECT run_id FROM nb_revalidation.bindings
 UNION SELECT previous_run FROM nb_revalidation.bindings
 UNION SELECT operation_id FROM nb_delta.operations
 UNION SELECT split_part(expected_revision,':',1)::uuid FROM nb_delta.operations
 UNION SELECT unnest(${pins})
), donors AS MATERIALIZED (
 SELECT DISTINCT ON(t.parent_asset_id,t.parent_sha,m.owner_page_id,t.width_cap)
  t.parent_asset_id,t.parent_sha,m.owner_page_id,t.width_cap,t.run_id
 FROM nb_thumbnails.media t
 JOIN nb_v2.media m ON m.run_id=t.run_id AND m.asset_id=t.parent_asset_id
 JOIN nb_v2.runs seed ON seed.id=t.run_id AND seed.status='published'
 WHERE t.version='v2' AND m.descriptor->>'sha256'=t.parent_sha
 ORDER BY t.parent_asset_id,t.parent_sha,m.owner_page_id,t.width_cap,seed.finished_at DESC,t.run_id DESC
), edges AS MATERIALIZED (
 SELECT DISTINCT m.run_id,d.run_id AS donor FROM nb_v2.media m JOIN donors d
 ON d.parent_asset_id=m.asset_id AND d.parent_sha=m.descriptor->>'sha256' AND d.owner_page_id=m.owner_page_id
), protected(id) AS (
 SELECT id FROM roots
 UNION SELECT e.donor FROM protected p JOIN edges e ON e.run_id=p.id
)`;
}
export function retentionPlanSQL(pinnedRuns: readonly string[]): string {
  return `${retentionProtectionSQL(pinnedRuns)}, inventory AS (
 SELECT r.*,to_jsonb(r)::text AS summary_json,encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex') AS summary_sha256,
  COALESCE(a.n,0) AS actual_records,COALESCE(b.n,0) AS actual_media,
  COALESCE(c.n,0) AS actual_sources,COALESCE(d.n,0) AS actual_tombstones,COALESCE(e.n,0) AS actual_thumbnails,
  EXISTS(SELECT FROM protected p WHERE p.id=r.id) AS protected
 FROM nb_v2.runs r
 LEFT JOIN (SELECT run_id,count(*) n FROM nb_v2.records GROUP BY run_id)a ON a.run_id=r.id
 LEFT JOIN (SELECT run_id,count(*) n FROM nb_v2.media GROUP BY run_id)b ON b.run_id=r.id
 LEFT JOIN (SELECT run_id,count(*) n FROM nb_v2_media.sources GROUP BY run_id)c ON c.run_id=r.id
 LEFT JOIN (SELECT run_id,count(*) n FROM nb_v2.tombstones GROUP BY run_id)d ON d.run_id=r.id
 LEFT JOIN (SELECT run_id,count(*) n FROM nb_thumbnails.media WHERE version='v2' GROUP BY run_id)e ON e.run_id=r.id
)
SELECT jsonb_build_object('state',(SELECT to_jsonb(s) FROM nb_v2.state s WHERE singleton),
 'stateSHA256',(SELECT encode(sha256(convert_to(to_jsonb(s)::text,'UTF8')),'hex') FROM nb_v2.state s WHERE singleton),
 'publication',(SELECT to_jsonb(s) FROM nb_publication.state s WHERE singleton),
 'publicationSHA256',(SELECT encode(sha256(convert_to(to_jsonb(s)::text,'UTF8')),'hex') FROM nb_publication.state s WHERE singleton),
 'protected',COALESCE((SELECT jsonb_agg(id ORDER BY id) FROM protected),'[]'),
 'candidates',COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY started_at,id) FROM inventory i
  WHERE NOT protected AND status IN ('published','failed') AND finished_at IS NOT NULL
  AND actual_records+actual_media+actual_sources+actual_tombstones+actual_thumbnails>0),'[]'),
 'summariesRetained',(SELECT count(*) FROM nb_v2.runs),
 'objectDeletion',false) AS plan`;
}
/** Owner-only metadata scan. Transaction-local hash joins avoid underestimated historical
 * JSON-key joins selecting a quadratic nested loop; website/worker sessions are unaffected.
 */
export function retentionPlanTransactionSQL(pinnedRuns: readonly string[]): string {
  return `BEGIN READ ONLY; SET LOCAL statement_timeout='15s'; SET LOCAL enable_nestloop=off; ${retentionPlanSQL(pinnedRuns)}; COMMIT;`;
}
/** One payload copy per SHA; the index maps each historical run to these immutable bytes. */
export function archiveIndexSQL(table: PayloadTable, runs: readonly string[]): string {
  const filter = payloadFilter(table), ids = runArray(runs);
  const key = table === "nb_v2.records" || table === "nb_v2.tombstones" ? "id" : table === "nb_thumbnails.media" ? "parent_asset_id" : "asset_id";
  return `WITH rows AS MATERIALIZED (
 SELECT x.run_id,x.${key} AS key,${table === "nb_thumbnails.media" ? "x.width_cap" : "NULL::integer"} AS width,
 octet_length((to_jsonb(x)-'run_id')::text) AS bytes,
 encode(sha256(convert_to((to_jsonb(x)-'run_id')::text,'UTF8')),'hex') AS sha
 FROM ${table} x WHERE x.run_id=ANY(${ids}) ${filter}
) SELECT sha,max(bytes) AS bytes,min(run_id::text) AS sample_run,min(key) AS key,min(width) AS width,
 jsonb_agg(run_id ORDER BY run_id) AS runs FROM rows GROUP BY sha ORDER BY sha`;
}
export interface PayloadRef {sha: string; sample_run: string; key: string; width: number | null}
function literal(value: string): string { return `'${value.replaceAll("'", "''")}'`; }
/** Indexed representative lookups avoid rehashing all historical bodies for every export page. */
export function archivePayloadSQL(table: PayloadTable, refs: readonly PayloadRef[]): string {
  const filter = payloadFilter(table);
  if (refs.length < 1 || refs.length > 50 || new Set(refs.map(x => x.sha)).size !== refs.length) throw Error("RETENTION_INVALID_HASHES");
  for (const ref of refs) {
    uuidLiteral(ref.sample_run);
    if (!/^[a-f0-9]{64}$/.test(ref.sha) || typeof ref.key !== "string" || ref.key.length > 256 ||
        !(ref.width === null || [400, 800, 1600].includes(ref.width))) throw Error("RETENTION_INVALID_REF");
  }
  const key = table === "nb_v2.records" || table === "nb_v2.tombstones" ? "id" : table === "nb_thumbnails.media" ? "parent_asset_id" : "asset_id";
  return `SELECT ref.sha,(to_jsonb(x)-'run_id')::text AS data
 FROM jsonb_to_recordset(${literal(JSON.stringify(refs))}::jsonb) ref(sha text,sample_run uuid,key text,width integer)
 JOIN ${table} x ON x.run_id=ref.sample_run AND x.${key}=ref.key
 ${table === "nb_thumbnails.media" ? "AND x.width_cap=ref.width" : ""}
 WHERE encode(sha256(convert_to((to_jsonb(x)-'run_id')::text,'UTF8')),'hex')=ref.sha ${filter}
 ORDER BY ref.sha`;
}
export function tableFingerprintSQL(table: PayloadTable, runs: readonly string[]): string {
  const filter = payloadFilter(table), ids = runArray(runs);
  return `SELECT x.run_id,count(*) AS count,
 encode(sha256(convert_to(string_agg(encode(sha256(convert_to(to_jsonb(x)::text,'UTF8')),'hex'),'' ORDER BY to_jsonb(x)::text),'UTF8')),'hex') AS digest
 FROM ${table} x WHERE x.run_id=ANY(${ids}) ${filter} GROUP BY x.run_id ORDER BY x.run_id`;
}
export interface DeleteGuard {
  run: string;
  stateSHA256: string;
  publicationSHA256: string;
  summarySHA256: string;
  remainingPayloadSHA256: string;
}
/** Caller must own the maintenance/writer locks and verify a recoverable local archive first.
 * Every short transaction checks exact state, summary and remaining archived row hashes.
 * No rows, including a partially emptied table, are inferred from age or count alone.
 */
export function deleteChunkSQL(table: PayloadTable, guard: DeleteGuard, limit = 250): string {
  const filter = payloadFilter(table), run = uuidLiteral(guard.run);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500 ||
      [guard.stateSHA256,guard.publicationSHA256,guard.summarySHA256,guard.remainingPayloadSHA256].some(x=>!/^[a-f0-9]{64}$/.test(x)))
    throw Error("RETENTION_INVALID_GUARD");
  return `WITH state_lock AS MATERIALIZED (
 SELECT s.* FROM nb_v2.state s WHERE singleton FOR UPDATE NOWAIT
), publication_lock AS MATERIALIZED (
 SELECT p.* FROM nb_publication.state p CROSS JOIN state_lock s WHERE p.singleton FOR UPDATE OF p NOWAIT
), admitted AS MATERIALIZED (
 SELECT 1 FROM state_lock s CROSS JOIN publication_lock p JOIN nb_v2.runs r ON r.id=${run}
 WHERE encode(sha256(convert_to(to_jsonb(s)::text,'UTF8')),'hex')='${guard.stateSHA256}'
 AND encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')='${guard.publicationSHA256}'
 AND encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex')='${guard.summarySHA256}'
 AND s.lease_run IS NULL AND s.lease_until IS NULL AND s.current_run IS DISTINCT FROM r.id AND p.run_id IS DISTINCT FROM r.id
 AND r.status IN ('published','failed') AND r.finished_at<statement_timestamp()-interval '24 hours'
 AND r.valid_until<statement_timestamp()
), hashes AS MATERIALIZED (
 SELECT encode(sha256(convert_to((to_jsonb(x)-'run_id')::text,'UTF8')),'hex') AS sha
 FROM ${table} x WHERE x.run_id=${run} ${filter}
), gate AS MATERIALIZED (
 SELECT EXISTS(SELECT FROM admitted) AND encode(sha256(convert_to(
 COALESCE((SELECT string_agg(sha,'' ORDER BY sha) FROM hashes),''),'UTF8')),'hex')='${guard.remainingPayloadSHA256}' AS accepted
), victims AS MATERIALIZED (
 SELECT x.ctid FROM ${table} x CROSS JOIN gate g WHERE g.accepted AND x.run_id=${run} ${filter}
 ORDER BY x.ctid LIMIT ${limit} FOR UPDATE OF x NOWAIT
), deleted AS (
 DELETE FROM ${table} x USING victims v WHERE x.ctid=v.ctid
 RETURNING encode(sha256(convert_to((to_jsonb(x)-'run_id')::text,'UTF8')),'hex') AS sha
)
SELECT jsonb_build_object('guardAccepted',(SELECT accepted FROM gate),'runId',${run},
 'deleted',COALESCE((SELECT jsonb_agg(sha ORDER BY sha) FROM deleted),'[]')) AS result`;
}
