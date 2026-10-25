import { createHash } from "node:crypto";
import type { SqlExecutor } from "../../src/server/database/sql.ts";
import protocol from "../../database/public-cache-commit-protocol.json" with { type: "json" };
import { classifyCommitCatalog, commitCatalogDigest, readCommitCatalog } from "./commit-catalog.ts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const digest = (value: unknown) => commitCatalogDigest(value);
const hashPattern = /^[a-f0-9]{64}$/;
const idPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const requireValue = (ok: unknown, code: string): void => { if (!ok) throw Error(code); };

/** Fixed identifiers only; no caller-supplied identifier is interpolated into SQL. */
export const COMMIT_FENCE_TABLES: readonly string[] = Object.freeze([
  "nb_cache.state", "nb_cache.events", "nb_cache.commit_config", "nb_cache.commit_intents",
  "nb_v2.state", "nb_v2.runs", "nb_v2.records", "nb_v2.media", "nb_v2.tombstones",
  "nb_v2_media.sources", "nb_publication.state", "nb_retention.config", "nb_thumbnails.media",
  "social_sync.bindings", "social_sync.publications", "social_sync.works", "social_sync.website_visibility",
  "social_sync.collection_bindings", "social_sync.collection_states", "social_sync.collection_visibility",
  "social_sync.collection_member_reviews", "social_sync.collection_standalone_overrides",
  "social_sync.retained_publications", "social_sync.retained_collections", "social_sync.collection_playback_links",
  "social_sync.bilibili_accounts", "social_sync.xiaohongshu_accounts", "social_sync.bilibili_auto_bindings",
  "social_sync.xiaohongshu_auto_bindings", "social_sync.cover_bindings",
].sort());

/** No content bodies, media locators, passwords, SQL text or live-learned expectation. */
export const COMMIT_ROLLOUT_FACTS_SQL = `WITH fence AS (
 SELECT name,to_regclass(name) AS oid FROM unnest($1::text[]) names(name)
), lines AS (
 SELECT 'function:'||p.oid::regprocedure::text||':'||pg_get_userbyid(p.proowner)||':'||coalesce(p.proacl::text,'null')||':'||pg_get_functiondef(p.oid) AS line
 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('nb_cache','nb_cache_api','nb_retention','nb_retention_api')
 UNION ALL SELECT 'relation:'||n.nspname||'.'||c.relname||':'||pg_get_userbyid(c.relowner)||':'||coalesce(c.relacl::text,'null')||':'||c.relkind::text||':'||c.relrowsecurity::text
 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('nb_cache','nb_cache_api') OR c.oid IN (SELECT oid FROM fence)
 UNION ALL SELECT 'trigger:'||t.tgrelid::regclass::text||':'||pg_get_triggerdef(t.oid)||':'||t.tgenabled::text||':'||pg_get_functiondef(t.tgfoid)
 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
 WHERE NOT t.tgisinternal AND (n.nspname='nb_cache' OR t.tgrelid IN (SELECT oid FROM fence))
 UNION ALL SELECT 'column:'||a.attrelid::regclass::text||':'||a.attnum||':'||a.attname||':'||format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull::text||':'||a.attisdropped::text||':'||coalesce(a.attacl::text,'null')
 FROM pg_catalog.pg_attribute a WHERE a.attnum>0 AND a.attrelid IN (SELECT oid FROM fence)
 UNION ALL SELECT 'constraint:'||c.conrelid::regclass::text||':'||c.conname||':'||pg_get_constraintdef(c.oid)||':'||c.convalidated::text
 FROM pg_catalog.pg_constraint c WHERE c.contype<>'n' AND (c.conrelid IN (SELECT oid FROM fence) OR c.confrelid IN (SELECT oid FROM fence))
 UNION ALL SELECT 'schema:'||nspname||':'||pg_get_userbyid(nspowner)||':'||coalesce(nspacl::text,'null') FROM pg_catalog.pg_namespace WHERE nspname IN ('nb_cache','nb_cache_api','nb_retention','nb_retention_api') OR oid IN (SELECT c.relnamespace FROM pg_catalog.pg_class c WHERE c.oid IN (SELECT oid FROM fence))
 UNION ALL SELECT 'index:'||pg_get_indexdef(indexrelid) FROM pg_catalog.pg_index WHERE indrelid IN (SELECT oid FROM fence)
 UNION ALL SELECT 'policy:'||polrelid::regclass::text||':'||polname||':'||polcmd::text||':'||polpermissive::text||':'||coalesce(pg_get_expr(polqual,polrelid),'null')||':'||coalesce(pg_get_expr(polwithcheck,polrelid),'null')||':'||
  (SELECT string_agg(CASE WHEN r=0 THEN 'PUBLIC' ELSE pg_get_userbyid(r) END,',' ORDER BY (CASE WHEN r=0 THEN 'PUBLIC' ELSE pg_get_userbyid(r) END) COLLATE "C") FROM unnest(polroles) r)
 FROM pg_catalog.pg_policy WHERE polrelid IN (SELECT c.oid FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('nb_cache','nb_cache_api'))
), roles AS (
 SELECT jsonb_agg(jsonb_build_array(rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls,rolconnlimit,rolvaliduntil,rolconfig) ORDER BY rolname COLLATE "C") AS value FROM pg_catalog.pg_roles
), members AS (
 SELECT jsonb_agg(jsonb_build_array(r.rolname,m.rolname,g.rolname,a.admin_option,a.inherit_option,a.set_option) ORDER BY r.rolname COLLATE "C",m.rolname COLLATE "C",g.rolname COLLATE "C") AS value
 FROM pg_catalog.pg_auth_members a JOIN pg_catalog.pg_roles r ON r.oid=a.roleid JOIN pg_catalog.pg_roles m ON m.oid=a.member JOIN pg_catalog.pg_roles g ON g.oid=a.grantor
) SELECT jsonb_build_object(
 'database',current_database(),'login',session_user,'role',current_user,'serverMajor',current_setting('server_version_num')::integer/10000,
 'ownerMatches',(SELECT relowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user) FROM pg_catalog.pg_class WHERE oid='nb_cache.state'::regclass),
 'tables',(SELECT jsonb_agg(name ORDER BY name COLLATE "C") FROM fence WHERE oid IS NOT NULL),
 'catalogSHA256',(SELECT encode(sha256(convert_to(coalesce(string_agg(line,'|' ORDER BY line COLLATE "C"),''),'UTF8')),'hex') FROM lines),
 'rolesSHA256',encode(sha256(convert_to(jsonb_build_array((SELECT value FROM roles),(SELECT value FROM members))::text,'UTF8')),'hex'),
 'sourceSHA256',(SELECT encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(s))::text,'null'),'UTF8')),'hex') FROM nb_v2.state s),
 'cacheSHA256',(SELECT encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(s))::text,'null'),'UTF8')),'hex') FROM nb_cache.state s),
 'sourceIdle',NOT EXISTS(SELECT FROM nb_v2.state WHERE lease_run IS NOT NULL OR lease_until IS NOT NULL) AND NOT EXISTS(SELECT FROM nb_v2.runs WHERE status='staging'),
 'writersIdle',NOT EXISTS(SELECT FROM pg_catalog.pg_stat_activity a WHERE a.datname=current_database() AND a.pid<>pg_backend_pid() AND (a.state IS NULL OR a.state IN ('active','idle in transaction','idle in transaction (aborted)')) AND EXISTS(
  SELECT FROM pg_catalog.pg_roles r WHERE (r.rolname IN ('nb_writer','nb_social_worker','nb_cache_operator','nb_cache_publisher','nb_retention_executor') OR r.oid=(SELECT relowner FROM pg_catalog.pg_class WHERE oid='nb_cache.state'::regclass)) AND pg_has_role(a.usesysid,r.oid,'MEMBER')))
) AS result`;

export interface CommitRolloutFacts { database: string; login: string; role: string; serverMajor: number; ownerMatches: boolean;
  tables: string[]; catalogSHA256: string; rolesSHA256: string; sourceSHA256: string; cacheSHA256: string; sourceIdle: boolean; writersIdle: boolean; retention?: unknown }
export async function readCommitRolloutFacts(db: SqlExecutor): Promise<CommitRolloutFacts> {
  const rows = (await db.query<{ result: CommitRolloutFacts }>(COMMIT_ROLLOUT_FACTS_SQL, [COMMIT_FENCE_TABLES])).rows;
  requireValue(rows.length === 1 && rows[0]?.result && Buffer.byteLength(JSON.stringify(rows[0].result)) <= 16384, "CACHE_ROLLOUT_FACTS");
  const facts = rows[0].result;
  if (facts.tables.includes("nb_retention.config")) facts.retention = (await db.query<{ result: unknown }>(
    "SELECT jsonb_agg(jsonb_build_object('singleton',singleton,'enabled',enabled,'catalogSHA256',catalog_sha) ORDER BY singleton) AS result FROM nb_retention.config")).rows[0]?.result;
  return facts;
}

export function prepareCommitMigration(sql: string) {
  requireValue(sha(sql) === protocol.migration.sha256 && (sql.match(/^BEGIN;$/gm) ?? []).length === 1 && (sql.match(/^COMMIT;$/gm) ?? []).length === 1 && sql.endsWith("COMMIT;\n"), "CACHE_ROLLOUT_MIGRATION");
  const body = sql.replace(/^BEGIN;\n/m, "").slice(0, -"COMMIT;\n".length);
  return { body, bodySHA256: sha(body) };
}

export interface CommitRolloutPlan {
  version: 1; operation: string; action: "install" | "enable" | "disable"; environment: "project" | "isolated";
  targetSHA256: string; packageSHA256: string; runtimeSHA256: string; migrationBodySHA256: string;
  beforeFactsSHA256: string; afterFactsSHA256: string; beforeTables: string[]; afterTables: string[];
}
export interface CommitRolloutAuthority {
  approved: boolean; nonce: string; planSHA256: string; issuedAt: number; startBefore: number; businessEnd: number; cleanupEnd: number;
  maxConnections: number; maxDriverCalls: number; maxLogicalBytes: number;
}
export interface CommitRolloutConnection extends SqlExecutor {
  targetSHA256: string; transport: "verified-tls" | "private-unix-fixture";
  command(sql: string, values?: unknown[]): Promise<string>;
  script(sql: string): Promise<void>;
  close(): Promise<void>;
}
export interface CommitRolloutPorts {
  now(): number;
  /** Durable exclusive nonce claim; existing or uncertain claim must reject, never overwrite. */
  claim(nonce: string, planSHA256: string): Promise<void>;
  /** Fixed local graph, locks and holds only. Must not read credentials or access the project. */
  hold(runtimeSHA256: string, packageSHA256: string): Promise<{ verify(): Promise<void>; release(): Promise<void> }>;
  /** Only invoked after authority, claim and the local hold have succeeded. */
  connect(): Promise<CommitRolloutConnection>;
  /** Append durable sanitized state; a failed write must throw. */
  save(report: CommitRolloutReport): Promise<void>;
}
export interface CommitRolloutReport {
  operation: string; action: string; outcome: "not-started" | "rolled-back" | "unknown" | "committed";
  stage: string; verified: boolean; connectionClosed: boolean; holdReleased: boolean; journalFailed: boolean;
  connections: number; driverCalls: number; logicalBytes: number; error: string | null;
}
const stateSQL = "SELECT jsonb_build_object('config',(SELECT jsonb_agg(to_jsonb(c)) FROM nb_cache.commit_config c),'intentPresent',EXISTS(SELECT FROM nb_cache.commit_intents)) AS result";
function tablesValid(tables: string[], installed: boolean) {
  return Array.isArray(tables) && tables.length > 3 && tables.length <= COMMIT_FENCE_TABLES.length &&
    JSON.stringify(tables) === JSON.stringify([...new Set(tables)].sort()) && tables.every(t => COMMIT_FENCE_TABLES.includes(t)) &&
    ["nb_cache.events", "nb_cache.state", "nb_v2.runs", "nb_v2.state", ...(installed ? ["nb_cache.commit_config", "nb_cache.commit_intents"] : [])].every(t => tables.includes(t)) &&
    (installed || !tables.some(t => t === "nb_cache.commit_config" || t === "nb_cache.commit_intents"));
}

/** One action per exclusive authority. No CLI, env loading, retries, scheduling or implicit activation. */
export async function runCommitRollout(inputPlan: CommitRolloutPlan, inputAuthority: CommitRolloutAuthority, migration: string, ports: CommitRolloutPorts): Promise<CommitRolloutReport> {
  const plan = structuredClone(inputPlan), authority = structuredClone(inputAuthority);
  const prepared = prepareCommitMigration(migration), now = ports.now(), planSHA = digest(plan), installing = plan.action === "install";
  requireValue(plan.version === 1 && idPattern.test(plan.operation) && ["install", "enable", "disable"].includes(plan.action) &&
    ["project", "isolated"].includes(plan.environment) && [plan.targetSHA256, plan.packageSHA256, plan.runtimeSHA256, plan.beforeFactsSHA256, plan.afterFactsSHA256].every(v => hashPattern.test(v)) &&
    plan.migrationBodySHA256 === prepared.bodySHA256 && tablesValid(plan.beforeTables, !installing) && tablesValid(plan.afterTables, true), "CACHE_ROLLOUT_PLAN");
  requireValue(authority.approved === true && idPattern.test(authority.nonce) && authority.planSHA256 === planSHA &&
    [now, authority.issuedAt, authority.startBefore, authority.businessEnd, authority.cleanupEnd].every(Number.isSafeInteger) &&
    authority.issuedAt <= now && now <= authority.startBefore && authority.startBefore < authority.businessEnd &&
    authority.startBefore - authority.issuedAt <= 30 * 60_000 && authority.businessEnd - authority.issuedAt <= 120 * 60_000 &&
    authority.cleanupEnd > authority.businessEnd && authority.cleanupEnd - authority.businessEnd <= 15 * 60_000 &&
    Number.isSafeInteger(authority.maxConnections) && authority.maxConnections >= 2 && authority.maxConnections <= 3 &&
    Number.isSafeInteger(authority.maxDriverCalls) && authority.maxDriverCalls >= 32 && authority.maxDriverCalls <= 80 &&
    Number.isSafeInteger(authority.maxLogicalBytes) && authority.maxLogicalBytes >= 65536 && authority.maxLogicalBytes <= 262144, "CACHE_ROLLOUT_AUTHORITY");
  const report: CommitRolloutReport = { operation: plan.operation, action: plan.action, outcome: "not-started", stage: "claim", verified: false,
    connectionClosed: true, holdReleased: false, journalFailed: false, connections: 0, driverCalls: 0, logicalBytes: 0, error: null };
  await ports.claim(authority.nonce, planSHA);
  let connection: CommitRolloutConnection | undefined, hold: Awaited<ReturnType<CommitRolloutPorts["hold"]>> | undefined;
  let begun = false, commitSent = false, closeAttempted = false;
  const save = async () => { try { await ports.save(structuredClone(report)); } catch { report.journalFailed = true; report.error = "CACHE_ROLLOUT_JOURNAL"; throw Error("CACHE_ROLLOUT_JOURNAL"); } };
  const charge = (cleanup = false) => { requireValue(ports.now() < (cleanup ? authority.cleanupEnd : authority.businessEnd) && report.driverCalls < authority.maxDriverCalls - (cleanup ? 0 : 4), "CACHE_ROLLOUT_LIMIT"); report.driverCalls++; };
  const db: SqlExecutor = { query: async <T>(text: string, values?: unknown[]) => { charge(); const result = await connection!.query<T>(text, values);
    report.logicalBytes += Buffer.byteLength(JSON.stringify(result.rows)); requireValue(report.logicalBytes <= authority.maxLogicalBytes && Buffer.byteLength(JSON.stringify(result.rows)) <= 32768, "CACHE_ROLLOUT_BYTES"); return result; } };
  const command = async (text: string, values?: unknown[], cleanup = false) => { charge(cleanup); return connection!.command(text, values); };
  const open = async () => {
    requireValue(ports.now() < authority.businessEnd && report.connections < authority.maxConnections, "CACHE_ROLLOUT_LIMIT");
    report.connections++; report.connectionClosed = false; closeAttempted = false; connection = await ports.connect();
    requireValue(connection.targetSHA256 === plan.targetSHA256 && (connection.transport === "verified-tls" || (plan.environment === "isolated" && connection.transport === "private-unix-fixture")), "CACHE_ROLLOUT_TARGET");
  };
  const close = async () => { const current = connection; if (current) { requireValue(!closeAttempted, "CACHE_ROLLOUT_CLOSE"); closeAttempted = true; await current.close(); connection = undefined; report.connectionClosed = true; } };
  const inspect = async (after: boolean) => {
    const catalog = classifyCommitCatalog(await readCommitCatalog(db));
    requireValue(catalog === (after || !installing ? "installed" : "legacy"), "CACHE_ROLLOUT_CATALOG");
    const facts = await readCommitRolloutFacts(db);
    requireValue(facts.ownerMatches === true && facts.role === facts.login && facts.sourceIdle === true && facts.writersIdle === true &&
      JSON.stringify(facts.tables) === JSON.stringify(after ? plan.afterTables : plan.beforeTables) && digest(facts) === (after ? plan.afterFactsSHA256 : plan.beforeFactsSHA256), "CACHE_ROLLOUT_BASELINE");
    if (catalog === "installed") {
      const state = (await db.query<{ result: { config: unknown; intentPresent: boolean } }>(stateSQL)).rows[0]?.result;
      const enabled = after ? plan.action === "enable" : plan.action === "disable";
      requireValue(state && state.intentPresent === false && digest(state.config) === digest([{ singleton: true, version: 1, enabled }]), "CACHE_ROLLOUT_STATE");
    }
  };
  try {
    await save(); hold = await ports.hold(plan.runtimeSHA256, plan.packageSHA256); await hold.verify(); await open();
    report.stage = "fence"; await save();
    requireValue(await command("BEGIN") === "BEGIN", "CACHE_ROLLOUT_BEGIN"); begun = true;
    await command("SET LOCAL search_path='pg_catalog'"); await command("SET LOCAL lock_timeout='2s'"); await command("SET LOCAL statement_timeout='15s'");
    await command("SET LOCAL idle_in_transaction_session_timeout='20s'");
    await command(`LOCK TABLE ${plan.beforeTables.join(",")} IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
    await hold.verify(); await inspect(false);
    report.stage = "mutation-intent"; await save();
    if (installing) { charge(); await connection!.script(prepared.body); }
    else {
      requireValue(await command("UPDATE nb_cache.commit_config SET enabled=$1 WHERE singleton AND version=1 AND enabled=$2 RETURNING singleton", [plan.action === "enable", plan.action === "disable"]) === "UPDATE 1", "CACHE_ROLLOUT_CAS");
    }
    await inspect(true); await hold.verify();
    report.stage = "commit-intent"; await save(); commitSent = true;
    requireValue(await command("COMMIT") === "COMMIT", "CACHE_ROLLOUT_COMMIT_ACK");
    begun = false; report.outcome = "committed"; report.stage = "committed"; await save();
    await close(); await hold.verify(); await open();
    requireValue(await command("BEGIN READ ONLY") === "BEGIN", "CACHE_ROLLOUT_BEGIN"); begun = true;
    await command("SET LOCAL search_path='pg_catalog'"); await command("SET LOCAL statement_timeout='3s'"); await command("SET LOCAL lock_timeout='250ms'");
    await inspect(true);
    requireValue(await command("ROLLBACK", [], true) === "ROLLBACK", "CACHE_ROLLOUT_ROLLBACK_ACK"); begun = false;
    await close(); await hold.verify(); report.verified = true; report.stage = "verified"; await save();
    await hold.release(); report.holdReleased = true;
  } catch (cause) {
    report.error = cause instanceof Error && /^CACHE_ROLLOUT_[A-Z_]+$/.test(cause.message) ? cause.message : "CACHE_ROLLOUT_FAILED";
    if (commitSent && report.outcome !== "committed") report.outcome = "unknown";
    if (begun && connection && !commitSent) {
      try { requireValue(await command("ROLLBACK", [], true) === "ROLLBACK", "CACHE_ROLLOUT_ROLLBACK_ACK"); begun = false; report.outcome = "rolled-back"; }
      catch { report.outcome = "unknown"; }
    }
    // A post-COMMIT verification transaction can be rolled back, without making
    // any claim that the already acknowledged mutation was rolled back.
    if (begun && connection && report.outcome === "committed") { try { await command("ROLLBACK", [], true); } catch { /* retain hold */ } }
    try { await close(); } catch { report.error = "CACHE_ROLLOUT_CLOSE"; }
    if (hold && report.connectionClosed && report.outcome !== "unknown" && report.outcome !== "committed" && !report.journalFailed) {
      try { await hold.verify(); await hold.release(); report.holdReleased = true; } catch { report.error = "CACHE_ROLLOUT_HOLD"; }
    }
  }
  try { await save(); } catch { /* return the observed outcome; never hide an acknowledged commit */ }
  return report;
}
