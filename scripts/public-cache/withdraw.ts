import { randomUUID } from "node:crypto";
import type { SqlExecutor } from "../../src/server/database/sql.ts";
import { publicCacheKey } from "../../src/server/public-cache/policy.ts";
import { validateCacheEvent, type CacheRefreshEvent } from "../../src/server/public-cache/events.ts";
import { flushCacheEvent, cacheControlOrigin, type CacheClientConfig } from "./control.ts";
import { validateCompactWithdrawalPlan, validateCompactWithdrawalJournal, validateCompactWithdrawalEvent, sameWithdrawalPlan, withdrawalPlanIdentity, compactWithdrawalCheckPaths, type CompactWithdrawalPlan, type CompactWithdrawalJournal } from "./withdraw-compact.ts";
import { verifyCompactWithdrawalCapability } from "./compact-withdrawal-capability.ts";

export interface WithdrawalPlan {
  version: 1; target: string; runId: string; revision: string; epoch: string;
  pages: { id: string; href: string; kind: string; slug: string }[];
  assets: string[]; sharedOwnerUrl: boolean; leaseActive: boolean;
}
export interface WithdrawalJournal {
  version: 1; id: string; siteKey: string; origin: string; databaseHash: string; plan: WithdrawalPlan;
  phase: "PLANNED" | "DENY_OUTCOME_UNKNOWN" | "DENIED_PURGE_PENDING" | "PURGED_VERIFY_PENDING" | "COMPLETE";
  event?: CacheRefreshEvent; checkedPaths?: string[];
}
export function withdrawalTarget(input: string, origin: string): string {
  const url = new URL(input);
  if (url.username || url.password || url.protocol !== "https:" || input.length > 2048) throw Error("WITHDRAW_TARGET");
  if (url.origin === cacheControlOrigin(origin)) {
    if (/[\u0000-\u001f\\]/.test(url.pathname + url.hash)) throw Error("WITHDRAW_TARGET");
    if (url.pathname === "/status" && url.searchParams.size === 1 && url.searchParams.getAll("focus").length === 1 && /^[a-zA-Z0-9_-]{1,256}$/.test(url.searchParams.get("focus")!))
      return `/status#${url.searchParams.get("focus")}`;
    if (url.search) throw Error("WITHDRAW_TARGET");
    return url.pathname + (url.pathname === "/status" ? url.hash : "");
  }
  if (url.hostname !== "notion.so" && url.hostname !== "www.notion.so" && !url.hostname.endsWith(".notion.site")) throw Error("WITHDRAW_TARGET");
  const id = /([a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\/?$/i.exec(url.pathname)?.[1];
  if (!id || url.hash) throw Error("WITHDRAW_TARGET");
  return id.replaceAll("-", "").toLowerCase();
}
export function validateWithdrawalPlan(value: unknown): WithdrawalPlan {
  const p = value as WithdrawalPlan;
  if (!p || p.version !== 1 || typeof p.target !== "string" || p.target.length > 256 ||
      !/^[a-f0-9-]{36}$/.test(p.runId) || !/^\d{1,19}$/.test(p.revision) || !/^\d{1,19}$/.test(p.epoch) ||
      !Array.isArray(p.pages) || !p.pages.length || p.pages.length > 20000 || !p.pages.some(v => v.id === p.target) ||
      p.pages.some(v => !v || typeof v.id !== "string" || !/^\/[a-zA-Z0-9/_#%.-]+$/.test(v.href) ||
        !["status", "course", "study-note", "post", "album", "book", "movie", "game", "project", "page"].includes(v.kind) || typeof v.slug !== "string" || v.slug.length > 256) ||
      !Array.isArray(p.assets) || p.assets.length > 40000 || p.assets.some(v => !/^a1\.[a-f0-9]{64}$/.test(v)) ||
      typeof p.sharedOwnerUrl !== "boolean" || typeof p.leaseActive !== "boolean") throw Error("WITHDRAW_PLAN");
  return p;
}
export async function planWithdrawal(db: SqlExecutor, target: string, config: CacheClientConfig, databaseHash: string): Promise<WithdrawalJournal> {
  const result = await db.query<{ result: unknown }>("SELECT nb_cache_api.plan_withdraw($1) AS result", [withdrawalTarget(target, config.origin)]);
  return { version: 1, id: randomUUID(), siteKey: config.siteKey, origin: cacheControlOrigin(config.origin), databaseHash,
    phase: "PLANNED", plan: validateWithdrawalPlan(result.rows[0]?.result) };
}
export type AnyWithdrawalJournal = WithdrawalJournal | CompactWithdrawalJournal;
/** Local version dispatch never turns a v2 payload into a legacy assets array. */
export function validateWithdrawalJournalVersion(value: unknown): AnyWithdrawalJournal {
  if (value && typeof value === "object" && "version" in value && value.version === 2) return validateCompactWithdrawalJournal(value);
  const j = value as WithdrawalJournal;
  if (!j || typeof j !== "object" || Array.isArray(j) || j.version !== 1 || typeof j.id !== "string" || !/^[a-f0-9-]{36}$/.test(j.id) ||
      typeof j.siteKey !== "string" || typeof j.origin !== "string" || typeof j.databaseHash !== "string" ||
      !["PLANNED", "DENY_OUTCOME_UNKNOWN", "DENIED_PURGE_PENDING", "PURGED_VERIFY_PENDING", "COMPLETE"].includes(j.phase)) throw Error("WITHDRAW_ENVIRONMENT");
  validateWithdrawalPlan(j.plan);
  if (Object.hasOwn(j.plan, "assetSummary")) throw Error("WITHDRAW_ENVIRONMENT");
  return j;
}
export async function planCompactWithdrawal(db: SqlExecutor, target: string, config: CacheClientConfig, databaseHash: string): Promise<CompactWithdrawalJournal> {
  const normalized = withdrawalTarget(target, config.origin), origin = cacheControlOrigin(config.origin);
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(config.siteKey) || !/^[a-f0-9]{64}$/.test(config.secret) || !/^[a-f0-9]{64}$/.test(databaseHash)) throw Error("WITHDRAW_ENVIRONMENT");
  await verifyCompactWithdrawalCapability(db);
  const rows = await db.query<{ result: unknown }>("SELECT nb_cache_api.plan_withdraw_compact($1) AS result", [normalized]);
  if (rows.rows.length !== 1) throw Error("WITHDRAW_COMPACT_PLAN");
  return validateCompactWithdrawalJournal({ version: 2, id: randomUUID(), siteKey: config.siteKey, origin, databaseHash,
    phase: "PLANNED", plan: validateCompactWithdrawalPlan(rows.rows[0]?.result) });
}
interface WithdrawalPorts<J> { db: SqlExecutor; save(value: J): Promise<void>; fetch?: typeof fetch }
export async function executeWithdrawal(journal: WithdrawalJournal, config: CacheClientConfig, databaseHash: string, ports: WithdrawalPorts<WithdrawalJournal>): Promise<WithdrawalJournal> {
  return executeWithdrawalVariant(journal, config, databaseHash, ports, "legacy-v1");
}
export async function executeCompactWithdrawal(journal: CompactWithdrawalJournal, config: CacheClientConfig, databaseHash: string, ports: WithdrawalPorts<CompactWithdrawalJournal>): Promise<CompactWithdrawalJournal> {
  return executeWithdrawalVariant(journal, config, databaseHash, ports, "compact-v2");
}
async function executeWithdrawalVariant<J extends AnyWithdrawalJournal>(journal: J, config: CacheClientConfig, databaseHash: string,
  ports: WithdrawalPorts<J>, variant: "legacy-v1" | "compact-v2"): Promise<J> {
  if (variant === "compact-v2") { validateCompactWithdrawalJournal(journal); if (!/^[a-f0-9]{64}$/.test(config.secret)) throw Error("WITHDRAW_ENVIRONMENT"); }
  if (journal.version !== (variant === "compact-v2" ? 2 : 1) || journal.siteKey !== config.siteKey || journal.origin !== cacheControlOrigin(config.origin) || journal.databaseHash !== databaseHash ||
      !/^[a-f0-9-]{36}$/.test(journal.id) || !["PLANNED", "DENY_OUTCOME_UNKNOWN", "DENIED_PURGE_PENDING", "PURGED_VERIFY_PENDING", "COMPLETE"].includes(journal.phase)) throw Error("WITHDRAW_ENVIRONMENT");
  if (variant === "legacy-v1") validateWithdrawalPlan(journal.plan);
  withdrawalPlanIdentity(journal.plan);
  if (journal.plan.sharedOwnerUrl || journal.plan.leaseActive) throw Error("WITHDRAW_REPLAN_REQUIRED");
  if (variant === "compact-v2") await verifyCompactWithdrawalCapability(ports.db);
  const save = async (phase: WithdrawalJournal["phase"]) => { journal = { ...journal, phase }; if (variant === "compact-v2") validateCompactWithdrawalJournal(journal); await ports.save(journal); };
  if (journal.phase === "PLANNED") {
    // Persist intent before the potentially ambiguous commit. A resume never blindly repeats it.
    await save("DENY_OUTCOME_UNKNOWN");
    const rows = await ports.db.query<{ result: unknown }>(variant === "compact-v2" ? "SELECT nb_cache_api.withdraw_compact($1,$2::jsonb) AS result" : "SELECT nb_cache_api.withdraw($1,$2::jsonb) AS result", [journal.id, JSON.stringify(journal.plan)]);
    if (variant === "compact-v2" && rows.rows.length !== 1) throw Error("WITHDRAW_EVENT");
    journal = { ...journal, event: validateCacheEvent({ ...(rows.rows[0]?.result as object), scope: "withdraw" }) };
    await save("DENIED_PURGE_PENDING");
  }
  // Every resume is tied to the committed database intent, never just a local phase marker.
  const proof = await ports.db.query<{ result: { event: unknown; plan: unknown; denied: boolean } }>("SELECT nb_cache_api.read_withdraw($1) AS result", [journal.id]);
  const committed = proof.rows[0]?.result;
  if (!committed || committed.denied !== true || variant === "compact-v2" && proof.rows.length !== 1) throw Error("WITHDRAW_OUTCOME_UNKNOWN");
  if (variant === "compact-v2") validateCompactWithdrawalPlan(committed.plan);
  if (!sameWithdrawalPlan(committed.plan, journal.plan)) throw Error("WITHDRAW_OUTCOME_UNKNOWN");
  const actual = variant === "compact-v2" ? validateCompactWithdrawalEvent(committed.event, journal.id) : validateCacheEvent(committed.event);
  if (actual.scope !== "withdraw" || variant === "compact-v2" && actual.id !== journal.id) throw Error("WITHDRAW_EVENT");
  if (variant === "compact-v2" && ["PURGED_VERIFY_PENDING", "COMPLETE"].includes(journal.phase) && actual.status !== "complete") throw Error("WITHDRAW_OUTCOME_UNKNOWN");
  journal = { ...journal, event: actual };
  if (journal.phase === "COMPLETE") return journal;
  if (journal.phase === "DENY_OUTCOME_UNKNOWN") await save("DENIED_PURGE_PENDING");
  if (!journal.event || journal.event.id !== journal.id || journal.event.scope !== "withdraw") throw Error("WITHDRAW_EVENT");
  if (journal.phase === "DENIED_PURGE_PENDING") {
    await flushCacheEvent(ports.db, journal.event, config, ports.fetch);
    await save("PURGED_VERIFY_PENDING");
  }
  // Only representative new website requests; SQL and broad tags cover the complete subtree/asset set.
  let paths: string[];
  if (variant === "compact-v2") paths = compactWithdrawalCheckPaths(journal.plan as CompactWithdrawalPlan);
  else {
    const legacy = journal as WithdrawalJournal;
    const pages = [journal.plan.pages.find(p => p.id === journal.plan.target)!, ...journal.plan.pages.filter(p => p.id !== journal.plan.target).slice(0, 1)];
    paths = pages.map(page => page.kind === "page" ? "/api/pages/about" : `/api/content/${page.kind}/${encodeURIComponent(page.slug)}`);
    if (legacy.plan.assets[0]) for (const width of [null, 400, 800, 1600]) paths.push(`/media/v2/${legacy.plan.assets[0]}${width ? `?thumbnail=${width}` : ""}`);
  }
  for (const path of paths) {
    const response = await (ports.fetch ?? fetch)(`${journal.origin}${path}`, { redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10_000) });
    await response.body?.cancel();
    if (![404, 410].includes(response.status)) throw Error("WITHDRAW_VERIFY_PENDING");
  }
  journal = { ...journal, checkedPaths: paths }; await save("COMPLETE"); return journal;
}
export const withdrawalDatabaseHash = (url: string) => publicCacheKey(["withdraw-database-v1", url]);
