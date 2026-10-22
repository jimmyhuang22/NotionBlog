import { randomUUID } from "node:crypto";
import type { SqlExecutor } from "../../src/server/database/sql.ts";
import { publicCacheKey } from "../../src/server/public-cache/policy.ts";
import { validateCacheEvent, type CacheRefreshEvent } from "../../src/server/public-cache/events.ts";
import { flushCacheEvent, cacheControlOrigin, type CacheClientConfig } from "./control.ts";

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
export async function executeWithdrawal(journal: WithdrawalJournal, config: CacheClientConfig, databaseHash: string, ports: {
  db: SqlExecutor; save(value: WithdrawalJournal): Promise<void>; fetch?: typeof fetch;
}): Promise<WithdrawalJournal> {
  if (journal.version !== 1 || journal.siteKey !== config.siteKey || journal.origin !== cacheControlOrigin(config.origin) || journal.databaseHash !== databaseHash ||
      !/^[a-f0-9-]{36}$/.test(journal.id) || !["PLANNED", "DENY_OUTCOME_UNKNOWN", "DENIED_PURGE_PENDING", "PURGED_VERIFY_PENDING", "COMPLETE"].includes(journal.phase)) throw Error("WITHDRAW_ENVIRONMENT");
  validateWithdrawalPlan(journal.plan);
  if (journal.plan.sharedOwnerUrl || journal.plan.leaseActive) throw Error("WITHDRAW_REPLAN_REQUIRED");
  const save = async (phase: WithdrawalJournal["phase"]) => { journal = { ...journal, phase }; await ports.save(journal); };
  if (journal.phase === "PLANNED") {
    // Persist intent before the potentially ambiguous commit. A resume never blindly repeats it.
    await save("DENY_OUTCOME_UNKNOWN");
    const rows = await ports.db.query<{ result: unknown }>("SELECT nb_cache_api.withdraw($1,$2::jsonb) AS result", [journal.id, JSON.stringify(journal.plan)]);
    journal = { ...journal, event: validateCacheEvent({ ...(rows.rows[0]?.result as object), scope: "withdraw" }) };
    await save("DENIED_PURGE_PENDING");
  }
  // Every resume is tied to the committed database intent, never just a local phase marker.
  const proof = await ports.db.query<{ result: { event: unknown; plan: unknown; denied: boolean } }>("SELECT nb_cache_api.read_withdraw($1) AS result", [journal.id]);
  const committed = proof.rows[0]?.result;
  if (!committed || committed.denied !== true || publicCacheKey(committed.plan) !== publicCacheKey(journal.plan)) throw Error("WITHDRAW_OUTCOME_UNKNOWN");
  const actual = validateCacheEvent(committed.event);
  if (actual.scope !== "withdraw") throw Error("WITHDRAW_EVENT");
  journal = { ...journal, event: actual };
  if (journal.phase === "COMPLETE") return journal;
  if (journal.phase === "DENY_OUTCOME_UNKNOWN") await save("DENIED_PURGE_PENDING");
  if (!journal.event || journal.event.id !== journal.id || journal.event.scope !== "withdraw") throw Error("WITHDRAW_EVENT");
  if (journal.phase === "DENIED_PURGE_PENDING") {
    await flushCacheEvent(ports.db, journal.event, config, ports.fetch);
    await save("PURGED_VERIFY_PENDING");
  }
  // Only representative new website requests; SQL and broad tags cover the complete subtree/asset set.
  const pages = [journal.plan.pages.find(p => p.id === journal.plan.target)!, ...journal.plan.pages.filter(p => p.id !== journal.plan.target).slice(0, 1)];
  const paths = pages.map(page => page.kind === "page" ? "/api/pages/about" : `/api/content/${page.kind}/${encodeURIComponent(page.slug)}`);
  if (journal.plan.assets[0]) for (const width of [null, 400, 800, 1600]) paths.push(`/media/v2/${journal.plan.assets[0]}${width ? `?thumbnail=${width}` : ""}`);
  for (const path of paths) {
    const response = await (ports.fetch ?? fetch)(`${journal.origin}${path}`, { redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10_000) });
    await response.body?.cancel();
    if (![404, 410].includes(response.status)) throw Error("WITHDRAW_VERIFY_PENDING");
  }
  journal = { ...journal, checkedPaths: paths }; await save("COMPLETE"); return journal;
}
export const withdrawalDatabaseHash = (url: string) => publicCacheKey(["withdraw-database-v1", url]);
