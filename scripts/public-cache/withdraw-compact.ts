import { createHash } from "node:crypto";
import { validateCacheEvent, uuid, type CacheRefreshEvent } from "../../src/server/public-cache/events.ts";
import { cacheControlOrigin } from "./control.ts";

export interface CompactWithdrawalPlan {
  version: 2; target: string; runId: string; revision: string; epoch: string;
  pages: { id: string; href: string; kind: string; slug: string }[];
  assetSummary: { algorithm: "nb-withdraw-assets-sha256-v1"; count: number; digest: string; sample: string | null };
  sharedOwnerUrl: boolean; leaseActive: boolean;
}
export interface CompactWithdrawalJournal {
  version: 2; id: string; siteKey: string; origin: string; databaseHash: string; plan: CompactWithdrawalPlan;
  phase: "PLANNED" | "DENY_OUTCOME_UNKNOWN" | "DENIED_PURGE_PENDING" | "PURGED_VERIFY_PENDING" | "COMPLETE";
  event?: CacheRefreshEvent; checkedPaths?: string[];
}
function fail(code: string): never { throw Error(code); }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function keys(value: Record<string, unknown>, required: string[], optional: string[] = []) {
  return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}
/** Withdrawal-only canonical JSON bound; general cache keys keep their 16 KiB limit. */
function boundedJsonIdentity(value: unknown, maximumBytes: number): string {
  const hash = createHash("sha256"), ancestors = new Set<object>(); let bytes = 0, nodes = 0;
  const append = (text: string) => { bytes += Buffer.byteLength(text); if (bytes > maximumBytes) fail("WITHDRAW_PLAN_LIMIT"); hash.update(text); };
  const quoted = (text: string) => { if (text.length > maximumBytes) fail("WITHDRAW_PLAN_LIMIT"); append(JSON.stringify(text)); };
  const visit = (item: unknown, depth: number): void => {
    if (depth > 12 || ++nodes > 250000) fail("WITHDRAW_PLAN_LIMIT");
    if (item === null) { append("null"); return; }
    if (typeof item === "string") { quoted(item); return; }
    if (typeof item === "boolean" || typeof item === "number" && Number.isFinite(item)) { append(JSON.stringify(item)); return; }
    if (!item || typeof item !== "object" || !Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype || ancestors.has(item)) fail("WITHDRAW_PLAN_LIMIT");
    if (Object.getOwnPropertySymbols(item).length) fail("WITHDRAW_PLAN_LIMIT");
    ancestors.add(item);
    if (Array.isArray(item)) {
      if (item.length > 250000 || Object.keys(item).length !== item.length || Object.getOwnPropertyNames(item).length !== item.length + 1) fail("WITHDRAW_PLAN_LIMIT"); append("[");
      for (let i = 0; i < item.length; i++) { if (i) append(","); const entry = Object.getOwnPropertyDescriptor(item, i); if (!entry || !("value" in entry)) fail("WITHDRAW_PLAN_LIMIT"); visit(entry.value, depth + 1); }
      append("]");
    } else {
      const names = Object.keys(item); if (names.length > 250000 || Object.getOwnPropertyNames(item).length !== names.length) fail("WITHDRAW_PLAN_LIMIT"); names.sort(); append("{");
      names.forEach((name, index) => { if (index) append(","); quoted(name); append(":"); const entry = Object.getOwnPropertyDescriptor(item, name); if (!entry || !("value" in entry)) fail("WITHDRAW_PLAN_LIMIT"); visit(entry.value, depth + 1); }); append("}");
    }
    ancestors.delete(item);
  };
  visit(value, 0); return hash.digest("hex");
}
export const withdrawalPlanIdentity = (value: unknown) => boundedJsonIdentity(value, 8 * 1024 * 1024);
function bounded(value: unknown, maximumBytes = 8 * 1024 * 1024) { try { boundedJsonIdentity(value, maximumBytes); return true; } catch { return false; } }
export const sameWithdrawalPlan = (left: unknown, right: unknown) => withdrawalPlanIdentity(left) === withdrawalPlanIdentity(right);
const kinds = ["status", "course", "study-note", "post", "album", "book", "movie", "game", "project", "page"];
/** Structural admission only. The server recomputes the complete ordered set and
 * compares the entire plan; this validator cannot prove digest or sample truth. */
export function validateCompactWithdrawalPlan(value: unknown): CompactWithdrawalPlan {
  if (!record(value) || !keys(value, ["version", "target", "runId", "revision", "epoch", "pages", "assetSummary", "sharedOwnerUrl", "leaseActive"]) || value.version !== 2 ||
      typeof value.target !== "string" || value.target.length < 1 || value.target.length > 256 || !uuid(value.runId) ||
      typeof value.revision !== "string" || !/^\d{1,19}$/.test(value.revision) || typeof value.epoch !== "string" || !/^\d{1,19}$/.test(value.epoch) ||
      !Array.isArray(value.pages) || value.pages.length < 1 || value.pages.length > 20000 || typeof value.sharedOwnerUrl !== "boolean" || typeof value.leaseActive !== "boolean") fail("WITHDRAW_COMPACT_PLAN");
  const p = value as unknown as CompactWithdrawalPlan;
  if (p.pages.some(page => !record(page) || !keys(page, ["id", "href", "kind", "slug"]) || typeof page.id !== "string" || page.id.length < 1 || page.id.length > 256 ||
      typeof page.href !== "string" || !/^\/[a-zA-Z0-9/_#%.-]+$/.test(page.href) || typeof page.kind !== "string" || !kinds.includes(page.kind) || typeof page.slug !== "string" || page.slug.length > 256) ||
      !p.pages.some(page => page.id === p.target) || new Set(p.pages.map(page => page.id)).size !== p.pages.length) fail("WITHDRAW_COMPACT_PLAN");
  const s = p.assetSummary;
  if (!record(s) || !keys(s, ["algorithm", "count", "digest", "sample"]) || s.algorithm !== "nb-withdraw-assets-sha256-v1" ||
      !Number.isSafeInteger(s.count) || s.count < 0 || s.count > 400000 || typeof s.digest !== "string" || !/^[a-f0-9]{64}$/.test(s.digest) ||
      (s.count === 0 ? s.sample !== null : typeof s.sample !== "string" || !/^a1\.[a-f0-9]{64}$/.test(s.sample)) || !bounded(p)) fail("WITHDRAW_COMPACT_PLAN");
  return p;
}
export function validateCompactWithdrawalEvent(value: unknown, id: string): CacheRefreshEvent {
  if (!record(value) || !keys(value, ["id", "scope", "generation", "status"])) fail("WITHDRAW_EVENT");
  if (typeof value.generation !== "string") fail("WITHDRAW_EVENT");
  const event = validateCacheEvent(value);
  if (event.id !== id || event.scope !== "withdraw") fail("WITHDRAW_EVENT");
  return event;
}
export function compactWithdrawalCheckPaths(plan: CompactWithdrawalPlan): string[] {
  const pages = [plan.pages.find(page => page.id === plan.target)!, ...plan.pages.filter(page => page.id !== plan.target).slice(0, 1)];
  const paths = pages.map(page => page.kind === "page" ? "/api/pages/about" : `/api/content/${page.kind}/${encodeURIComponent(page.slug)}`);
  if (plan.assetSummary.sample) for (const width of [null, 400, 800, 1600]) paths.push(`/media/v2/${plan.assetSummary.sample}${width ? `?thumbnail=${width}` : ""}`);
  return paths;
}
export function validateCompactWithdrawalJournal(value: unknown): CompactWithdrawalJournal {
  if (!record(value) || !keys(value, ["version", "id", "siteKey", "origin", "databaseHash", "plan", "phase"], ["event", "checkedPaths"]) || value.version !== 2 ||
      !uuid(value.id) || typeof value.siteKey !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.siteKey) ||
      typeof value.origin !== "string" || value.origin.length > 2048 || typeof value.databaseHash !== "string" || !/^[a-f0-9]{64}$/.test(value.databaseHash) ||
      typeof value.phase !== "string" || !["PLANNED", "DENY_OUTCOME_UNKNOWN", "DENIED_PURGE_PENDING", "PURGED_VERIFY_PENDING", "COMPLETE"].includes(value.phase)) fail("WITHDRAW_COMPACT_JOURNAL");
  try { if (cacheControlOrigin(value.origin as string) !== value.origin) fail("WITHDRAW_COMPACT_JOURNAL"); } catch { fail("WITHDRAW_COMPACT_JOURNAL"); }
  const j = value as unknown as CompactWithdrawalJournal; validateCompactWithdrawalPlan(j.plan);
  const needsEvent = ["DENIED_PURGE_PENDING", "PURGED_VERIFY_PENDING", "COMPLETE"].includes(j.phase);
  if (needsEvent !== Object.hasOwn(j, "event") || (j.phase === "COMPLETE") !== Object.hasOwn(j, "checkedPaths")) fail("WITHDRAW_COMPACT_JOURNAL");
  if (needsEvent) {
    try { validateCompactWithdrawalEvent(j.event, j.id); } catch { fail("WITHDRAW_COMPACT_JOURNAL"); }
  }
  if (j.phase === "COMPLETE") {
    const expected = compactWithdrawalCheckPaths(j.plan);
    if (!Array.isArray(j.checkedPaths) || j.checkedPaths.length !== expected.length || j.checkedPaths.some((path, index) => path !== expected[index])) fail("WITHDRAW_COMPACT_JOURNAL");
  }
  if (!bounded(j, 10 * 1024 * 1024)) fail("WITHDRAW_COMPACT_JOURNAL");
  return j;
}
