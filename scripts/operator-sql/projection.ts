import { createHash } from "node:crypto";
import type { SqlExecutor } from "../../src/server/database/sql.ts";

export type ProjectionShape = "result" | "ordinal-result" | "rows";
export interface ProjectionQuery {
  shape: ProjectionShape;
  /** Only fixed, reviewed read functions may opt in. A SELECT can mutate data. */
  cache: boolean;
  /** Only links/mediaIds consumed as Sets by the reviewed DTO projector. */
  canonicalReferenceSets?: boolean;
  /** Thumbnail state is returned fresh, alongside run/revision, on every call. */
  freshThumbnail?: boolean;
  /** Zero-based positions affect the lookup key only, never the actual SQL. */
  generationParameters?: readonly number[];
}
export interface CachedProjection { digest: string; payload: string }
export interface ProjectionCache {
  get(key: string): Promise<CachedProjection | null>;
  put(key: string, value: CachedProjection): Promise<void>;
}
export interface SqlReservation { id: string; bytes: number }
export interface SqlResponseBudget {
  reserve(): Promise<SqlReservation>;
  settle(reservation: SqlReservation, bytes: number): Promise<void>;
  fail(reservation: SqlReservation, reason: string): Promise<void>;
}
interface Envelope {
  status: "HIT" | "MISS" | "OVER_LIMIT" | "INVALID_ROWS";
  payload: string | null;
  generations: string | null;
  digest: string | null;
  response_bytes: number;
  content_bytes: number;
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function failure(code: string): never { throw new Error(code); }

/** The extra allowance bounds the single PostgreSQL DataRow's fixed fields and
 * framing. TLS, startup/auth and other connections still need the wire relay. */
export const RESPONSE_ENVELOPE_BYTES = 512;

function referenceSets(result: string): { valid: string; value: string } {
  let value = result;
  const checks: string[] = [];
  for (const field of ["links", "mediaIds"]) {
    const array = `CASE WHEN jsonb_typeof(${result}->'${field}')='array' THEN ${result}->'${field}' ELSE '[]'::jsonb END`;
    checks.push(`jsonb_typeof(${result}->'${field}') IS NOT DISTINCT FROM 'array' AND NOT EXISTS
      (SELECT FROM jsonb_array_elements(${array}) AS refs(ref) WHERE jsonb_typeof(ref)<>'string')`);
    value = `jsonb_set(${value},'{${field}}',(SELECT COALESCE(jsonb_agg(ref ORDER BY ref::text COLLATE "C"),'[]'::jsonb)
      FROM jsonb_array_elements(${array}) AS refs(ref)))`;
  }
  return { valid: checks.join(" AND "), value };
}

/** One materialized evaluation, under the existing role and existing qualified
 * functions. Only the transfer changes; no cached eligibility or SQL is skipped.
 * Cache misses/oversize responses are decided before a large body leaves PG. */
export function projectionSql(text: string, parameters: number, spec: ProjectionQuery): string {
  if (!/^(?:SELECT|WITH)\b/.test(text.trim()) || text.includes(";") ||
      !Number.isSafeInteger(parameters) || parameters < 0 || parameters > 128 ||
      !["result", "ordinal-result", "rows"].includes(spec.shape) || typeof spec.cache !== "boolean" ||
      spec.shape === "rows" && spec.cache ||
      spec.canonicalReferenceSets !== undefined && typeof spec.canonicalReferenceSets !== "boolean" ||
      spec.freshThumbnail !== undefined && typeof spec.freshThumbnail !== "boolean" ||
      (spec.canonicalReferenceSets || spec.freshThumbnail) && (!spec.cache || spec.shape === "rows") ||
      spec.canonicalReferenceSets && (spec.shape !== "result" || spec.freshThumbnail)) failure("OPERATOR_SQL_SPEC_INVALID");
  const result = "(data->'result')";
  const fields = ["runId", "revision", ...(spec.freshThumbnail ? ["thumbnail"] : [])];
  const strip = spec.cache ? `CASE WHEN jsonb_typeof(${result})='object' THEN ${result}-ARRAY[${fields.map(k => `'${k}'`).join(",")}] ELSE ${result} END` : result;
  const references = spec.canonicalReferenceSets ? referenceSets(strip) : null;
  const generation = spec.cache ? `CASE WHEN jsonb_typeof(${result})='object' THEN
    (CASE WHEN ${result} ? 'runId' THEN jsonb_build_object('runId',${result}->'runId') ELSE '{}'::jsonb END)||
    (CASE WHEN ${result} ? 'revision' THEN jsonb_build_object('revision',${result}->'revision') ELSE '{}'::jsonb END)${spec.freshThumbnail ? `||jsonb_build_object('thumbnail',${result}->'thumbnail')` : ""}
    ELSE '{}'::jsonb END` : "'{}'::jsonb";
  const projected = spec.shape === "rows" ? "data" : `jsonb_set(data,'{result}',${references?.value ?? strip})`;
  const valid = spec.shape === "rows" ? "true" : `data ? 'result' AND data-ARRAY['result'${spec.shape === "ordinal-result" ? ",'ordinal'" : ""}]='{}'::jsonb
    ${references ? `AND jsonb_typeof(${result})='object' AND ${references.valid}` : ""}
    ${spec.freshThumbnail ? `AND (${result}='null'::jsonb OR jsonb_typeof(${result})='object' AND ${result} ? 'thumbnail')` : ""}`;
  const order = spec.shape === "ordinal-result" ? "(data->>'ordinal')::integer" : "position";
  const ordinalCheck = spec.shape === "ordinal-result" ?
    "AND COALESCE(min((data->>'ordinal')::integer),0)=0 AND COALESCE(max((data->>'ordinal')::integer),-1)=count(*)-1 AND count(DISTINCT data->'ordinal')=count(*)" : "AND count(*)<=1";
  const known = `$${parameters + 1}::text`, cap = `$${parameters + 2}::integer`;
  return `WITH operator_source AS MATERIALIZED (${text}),
    operator_rows AS MATERIALIZED (SELECT to_jsonb(q) AS data,row_number() OVER () AS position FROM operator_source q),
    operator_serialized AS MATERIALIZED (SELECT
      COALESCE(jsonb_agg(${projected} ORDER BY ${order}),'[]'::jsonb)::text AS payload,
      COALESCE(jsonb_agg(${generation} ORDER BY ${order}),'[]'::jsonb)::text AS generations,
      COALESCE(bool_and(${valid}),true) AND count(*)<=1024 ${ordinalCheck} AS valid FROM operator_rows),
    operator_digest AS MATERIALIZED (SELECT *,encode(sha256(convert_to(payload,'UTF8')),'hex') AS digest,
      octet_length(payload) AS content_bytes,octet_length(generations) AS generation_bytes FROM operator_serialized),
    operator_size AS MATERIALIZED (SELECT *,${spec.cache ? `digest=${known}` : `${known} IS NOT NULL AND false`} AS matched FROM operator_digest),
    operator_checked AS MATERIALIZED (SELECT *,${RESPONSE_ENVELOPE_BYTES}+generation_bytes+
      CASE WHEN COALESCE(matched,false) THEN 0 ELSE content_bytes END AS response_bytes FROM operator_size)
    SELECT CASE WHEN NOT valid THEN 'INVALID_ROWS' WHEN response_bytes>${cap} THEN 'OVER_LIMIT'
        WHEN COALESCE(matched,false) THEN 'HIT' ELSE 'MISS' END AS status,
      CASE WHEN valid AND response_bytes<=${cap} AND NOT COALESCE(matched,false) THEN payload END AS payload,
      CASE WHEN valid AND response_bytes<=${cap} THEN generations END AS generations,
      CASE WHEN valid AND response_bytes<=${cap} THEN digest END AS digest,
      CASE WHEN valid AND response_bytes<=${cap} THEN response_bytes ELSE ${RESPONSE_ENVELOPE_BYTES} END AS response_bytes,
      content_bytes FROM operator_checked`;
}

export function validateCachedProjection(value: CachedProjection): void {
  if (!value || typeof value.payload !== "string" || !/^[a-f0-9]{64}$/.test(value.digest) || hash(value.payload) !== value.digest)
    failure("OPERATOR_CACHE_CORRUPT");
  try { if (!Array.isArray(JSON.parse(value.payload))) failure("OPERATOR_CACHE_CORRUPT"); }
  catch { failure("OPERATOR_CACHE_CORRUPT"); }
}

/** Explicit allowlist; unknown SQL is rejected, including unnoticed new calls.
 * All processes/stages can share the same durable response-budget instance. */
export function createOperatorSql(input: {
  db: SqlExecutor; queries: ReadonlyMap<string, ProjectionQuery>; cache: ProjectionCache;
  budget: SqlResponseBudget; namespace: string;
}): SqlExecutor & { statistics(): { hits: number; misses: number; contentBytes: number; responseBytes: number } } {
  if (!/^[a-f0-9]{64}$/.test(input.namespace)) failure("OPERATOR_NAMESPACE_INVALID");
  const statistics = { hits: 0, misses: 0, contentBytes: 0, responseBytes: 0 };
  // Copy descriptors so another caller cannot change an in-flight allowlist.
  const queries = new Map([...input.queries].map(([sql, spec]) => [sql, { ...spec, generationParameters: [...(spec.generationParameters ?? [])] }]));
  return {
    statistics: () => ({ ...statistics }),
    async query<T>(text: string, values: unknown[] = []) {
      const spec = queries.get(text);
      if (!spec) failure("OPERATOR_SQL_NOT_ALLOWED");
      if (spec.generationParameters.some(index => !Number.isSafeInteger(index) || index < 0 || index >= values.length))
        failure("OPERATOR_GENERATION_PARAMETER_INVALID");
      const sql = projectionSql(text, values.length, spec);
      const ignored = new Set(spec.generationParameters);
      const key = hash(JSON.stringify([input.namespace, "projection-v2", text, spec.shape,
        spec.canonicalReferenceSets === true, spec.freshThumbnail === true,
        values.map((v, index) => ignored.has(index) ? null : v)]));
      const cached = spec.cache ? await input.cache.get(key) : null;
      if (cached) validateCachedProjection(cached); // No network fallback for corrupt local evidence.
      const reservation = await input.budget.reserve();
      let settled = false;
      try {
        const wire = await input.db.query<Envelope>(sql, [...values, cached?.digest ?? null, reservation.bytes]);
        if (wire.rows.length !== 1) failure("OPERATOR_ENVELOPE_INVALID");
        const row = wire.rows[0];
        if (!Number.isSafeInteger(row.response_bytes) || row.response_bytes < RESPONSE_ENVELOPE_BYTES ||
            row.response_bytes > reservation.bytes || !Number.isSafeInteger(row.content_bytes) || row.content_bytes < 2)
          failure("OPERATOR_ENVELOPE_INVALID");
        await input.budget.settle(reservation, row.response_bytes); settled = true;
        statistics.responseBytes += row.response_bytes;
        if (row.status === "OVER_LIMIT") failure("OPERATOR_SQL_RESPONSE_LIMIT");
        if (row.status === "INVALID_ROWS") failure("OPERATOR_SQL_ROWS_INVALID");
        if (!["HIT", "MISS"].includes(row.status) || typeof row.generations !== "string" || !/^[a-f0-9]{64}$/.test(row.digest ?? ""))
          failure("OPERATOR_ENVELOPE_INVALID");
        if (row.response_bytes !== RESPONSE_ENVELOPE_BYTES + Buffer.byteLength(row.generations) +
            (row.status === "HIT" ? 0 : typeof row.payload === "string" ? Buffer.byteLength(row.payload) : -1))
          failure("OPERATOR_ENVELOPE_INVALID");
        const value = row.status === "HIT" ? cached : { digest: row.digest!, payload: row.payload! };
        if (!value || row.status === "HIT" && (!spec.cache || row.payload !== null || value.digest !== row.digest))
          failure("OPERATOR_CACHE_PROOF_MISMATCH");
        validateCachedProjection(value);
        if (Buffer.byteLength(value.payload) !== row.content_bytes) failure("OPERATOR_CACHE_PROOF_MISMATCH");
        const rows: unknown[] = JSON.parse(value.payload), generations: unknown = JSON.parse(row.generations);
        if (!Array.isArray(generations) || generations.length !== rows.length || rows.length > 1024 ||
            rows.some((v, index) => !object(v) || !object(generations[index]) ||
              Object.keys(generations[index]).some(k => !["runId", "revision", ...(spec.freshThumbnail ? ["thumbnail"] : [])].includes(k)))) failure("OPERATOR_ENVELOPE_INVALID");
        const hydrated = rows.map((v, index) => {
          const record = v as Record<string, unknown>, generation = generations[index] as Record<string, unknown>;
          if (Object.keys(generation).length && (!spec.cache || !object(record.result))) failure("OPERATOR_ENVELOPE_INVALID");
          if (spec.freshThumbnail && object(record.result) &&
              (!Object.hasOwn(generation, "thumbnail") || Object.hasOwn(record.result, "thumbnail"))) failure("OPERATOR_ENVELOPE_INVALID");
          return { ...record, ...(Object.keys(generation).length ? { result: { ...(record.result as object), ...generation } } : {}) } as T;
        });
        if (row.status === "MISS" && spec.cache) await input.cache.put(key, value);
        statistics[row.status === "HIT" ? "hits" : "misses"]++;
        statistics.contentBytes += row.content_bytes;
        return { rows: hydrated };
      } catch (error) {
        // Transport failure may already have incurred the whole reservation.
        // Every error closes the shared budget; no automatic retry/new allowance.
        await input.budget.fail(reservation, settled ? "INVALID_OR_REJECTED_RESPONSE" : "SQL_OUTCOME_UNKNOWN");
        throw error;
      }
    },
  };
}
