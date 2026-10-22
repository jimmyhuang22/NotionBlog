import { createHash } from "node:crypto";
import { WEBSITE_CONTENT_SQL, WEBSITE_SNAPSHOT_SQL } from "../../src/server/database/website-projection.ts";
import type { SqlExecutor } from "../../src/server/database/sql.ts";
import { createOperatorSql, type ProjectionQuery } from "./projection.ts";
import { createOperatorSqlBudget, type OperatorSqlPlan } from "./budget.ts";
import { createProjectionCache, type ProjectionCacheLimits } from "./cache.ts";

// These are the fixed statements used by the separate maintenance operators.
// Exact allowlisting catches unnoticed changes. SELECT alone does not mean read-only.
export const MAINTENANCE_CURRENT_SQL = "SELECT nb_v2_api.read_snapshot(ARRAY[]::text[],false)-'records'-'links'-'mediaIds' AS result";
export const MAINTENANCE_CURRENT_SPACED_SQL = "SELECT nb_v2_api.read_snapshot(ARRAY[]::text[],false) - 'records' - 'links' - 'mediaIds' AS result";
export const MAINTENANCE_ROLE_SQL = "SELECT current_user AS role";
export const MAINTENANCE_THUMBNAIL_SQL = "SELECT nb_thumbnail_api.read_media($1,$2,$3) AS result";
export const MAINTENANCE_THUMBNAILS_SQL = "SELECT x.ordinal,nb_thumbnail_api.read_media('v2',x.asset,x.width) AS result FROM jsonb_to_recordset($1::jsonb) AS x(ordinal integer,asset text,width integer) ORDER BY x.ordinal";
export const MAINTENANCE_REGISTER_SQL = "SELECT x.ordinal,nb_thumbnail_api.register_media('v2',$1::uuid,x.asset,x.sha,x.fingerprint,x.width,x.descriptor) AS result FROM jsonb_to_recordset($2::jsonb) AS x(ordinal integer,asset text,sha text,fingerprint text,width integer,descriptor jsonb) ORDER BY x.ordinal";

const readerQueries = new Map<string, ProjectionQuery>([
  [MAINTENANCE_ROLE_SQL, { shape: "rows", cache: false }],
  [MAINTENANCE_CURRENT_SQL, { shape: "result", cache: false }],
  [MAINTENANCE_CURRENT_SPACED_SQL, { shape: "result", cache: false }],
  [WEBSITE_SNAPSHOT_SQL, { shape: "result", cache: true, canonicalReferenceSets: true }],
  // Run/revision pins are still sent unchanged to read_content. A cache hit
  // requires freshly qualified content, links and mediaIds to match byte for byte.
  [WEBSITE_CONTENT_SQL, { shape: "result", cache: true, generationParameters: [3, 4], canonicalReferenceSets: true }],
  [MAINTENANCE_THUMBNAIL_SQL, { shape: "result", cache: true, freshThumbnail: true }],
  [MAINTENANCE_THUMBNAILS_SQL, { shape: "ordinal-result", cache: true, freshThumbnail: true }],
]);
const writerQueries = new Map<string, ProjectionQuery>([
  [MAINTENANCE_ROLE_SQL, { shape: "rows", cache: false }],
  [MAINTENANCE_REGISTER_SQL, { shape: "ordinal-result", cache: false }],
]);

/** Explicit opt-in for operator programs. This does not change website reads,
 * install a task, create connections, or supply credentials. Use the same fixed
 * plan/budgetDirectory for every stage of a cycle, including process restarts.
 * Namespace must bind the reviewed database/role/schema/config identity.
 * Keep existing deadlines, query timeouts, TLS and write-outcome journals. */
export async function createWebsiteMaintenanceSession(input: {
  cacheDirectory: string; budgetDirectory: string; namespace: string;
  plan: OperatorSqlPlan; cacheLimits: ProjectionCacheLimits;
}) {
  if (!/^[a-f0-9]{64}$/.test(input.namespace)) throw Error("OPERATOR_NAMESPACE_INVALID");
  const cache = await createProjectionCache(input.cacheDirectory, input.cacheLimits);
  const budget = await createOperatorSqlBudget(input.budgetDirectory, input.plan);
  const wrap = (db: SqlExecutor, role: "reader" | "writer", queries: ReadonlyMap<string, ProjectionQuery>) =>
    createOperatorSql({ db, queries, cache, budget,
      namespace: createHash("sha256").update(JSON.stringify(["website-maintenance-v2", input.namespace, role])).digest("hex") });
  return {
    reader: (db: SqlExecutor) => wrap(db, "reader", readerQueries),
    writer: (db: SqlExecutor) => wrap(db, "writer", writerQueries),
    statistics: () => budget.statistics(),
  };
}
