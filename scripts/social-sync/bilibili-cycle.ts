import { SocialSyncError, timestamp } from "./model.ts";
import { BILIBILI_CYCLE, drainCycle, newCycle } from "./refresh-cycle.ts";
import type { CycleReport } from "./refresh-cycle.ts";
import type { RefreshReport } from "./refresh-executor.ts";
import type { RefreshActivity, RefreshObserver } from "./refresh-activity.ts";
import type { inspectRefresh } from "./refresh-state.ts";
import { parseUploadCost } from "./cycle-cloud.ts";
import type { CycleUploadCost } from "./cycle-cloud.ts";

export type BilibiliInspection = Awaited<ReturnType<typeof inspectRefresh>>;
export type PreviousCycle = Partial<Pick<CycleReport, "startedAt" | "scopeDigest">> & { status: string };
const retryDelays = [15, 30, 60] as const;
const transient = new Set(["SOURCE_NETWORK_ERROR", "SOURCE_TIMEOUT", "SOURCE_TEMPORARY_ERROR", "RATE_LIMITED"]);
const states = ["idle", "complete", "review-required", "retry-wait", "manual-required", "budget", "deferred", "cancelled", "error"] as const;
type State = typeof states[number];
const cycleStates = ["running", "complete", "review-required", "paused", "budget", "cancelled", "deferred"];
export interface BilibiliCost {
  elapsedMs: number; checkMs: number; captureMs: number; uploadMs: number;
  sourceRequests: number; sourceBytes: number; cpuUserMs: number | null; cpuSystemMs: number | null; peakRssBytes: number | null;
}
export interface BilibiliHealth {
  version: 1; platform: "bilibili"; checkedAt: string; state: State; scopeDigest: string | null;
  lastCheckAt: string | null; lastCollectedAt: string | null; lastUploadedAt: string | null;
  plan: { inspectedAt: string; configured: number; due: number; fresh: number; pending: number; reviewRequired: number; nextDueAt: string | null } | null;
  cycle: { startedAt: string; status: string; selected: number; uploaded: number; failed: number; remaining: number; batches: number } | null;
  recovery: { failures: number; code: string | null; retryAt: string | null; manualRequired: boolean };
  cost: BilibiliCost;
  uploadCost?: CycleUploadCost;
}
const nullableTime = (value: unknown): string | null => value === null ? null : timestamp(value as string);
const numeric = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new SocialSyncError("BILIBILI_HEALTH_INVALID");
  return value;
};
const count = (value: unknown): number => {
  const n = numeric(value); if (!Number.isSafeInteger(n) || n > 1000000000000) throw new SocialSyncError("BILIBILI_HEALTH_INVALID"); return n;
};
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SocialSyncError("BILIBILI_HEALTH_INVALID");
  return value as Record<string, unknown>;
};
/** Pick only aggregate fields: arbitrary private file properties never reach status stdout. */
export function parseBilibiliHealth(value: unknown): BilibiliHealth {
  const h = object(value), r = object(h.recovery), c = object(h.cost);
  if (h.version !== 1 || h.platform !== "bilibili" || !states.includes(h.state as State) ||
    h.scopeDigest !== null && (typeof h.scopeDigest !== "string" || !/^[a-f0-9]{64}$/.test(h.scopeDigest)) ||
    typeof r.manualRequired !== "boolean" || count(r.failures) > 4 ||
    r.code !== null && (typeof r.code !== "string" || !/^[A-Z][A-Z_]{0,63}$/.test(r.code))) throw new SocialSyncError("BILIBILI_HEALTH_INVALID");
  let plan: BilibiliHealth["plan"] = null, cycle: BilibiliHealth["cycle"] = null;
  if (h.plan !== null) {
    const p = object(h.plan); plan = { inspectedAt: timestamp(p.inspectedAt as string), configured: count(p.configured), due: count(p.due), fresh: count(p.fresh),
      pending: count(p.pending), reviewRequired: count(p.reviewRequired), nextDueAt: nullableTime(p.nextDueAt) };
    if (plan.configured > 500 || [plan.due, plan.fresh, plan.pending, plan.reviewRequired].some(n => n > plan!.configured)) throw new SocialSyncError("BILIBILI_HEALTH_INVALID");
  }
  if (h.cycle !== null) {
    const x = object(h.cycle); if (!cycleStates.includes(x.status as string)) throw new SocialSyncError("BILIBILI_HEALTH_INVALID");
    cycle = { startedAt: timestamp(x.startedAt as string), status: x.status as string, selected: count(x.selected), uploaded: count(x.uploaded),
      failed: count(x.failed), remaining: count(x.remaining), batches: count(x.batches) };
  }
  const cost = Object.fromEntries(["elapsedMs", "checkMs", "captureMs", "uploadMs", "sourceRequests", "sourceBytes", "cpuUserMs", "cpuSystemMs", "peakRssBytes"]
    .map(k => [k, c[k] === null && ["cpuUserMs", "cpuSystemMs", "peakRssBytes"].includes(k) ? null : numeric(c[k])])) as unknown as BilibiliCost;
  return { version: 1, platform: "bilibili", checkedAt: timestamp(h.checkedAt as string), state: h.state as State, scopeDigest: h.scopeDigest as string | null,
    lastCheckAt: nullableTime(h.lastCheckAt), lastCollectedAt: nullableTime(h.lastCollectedAt), lastUploadedAt: nullableTime(h.lastUploadedAt), plan, cycle,
    recovery: { failures: r.failures as number, code: r.code as string | null, retryAt: nullableTime(r.retryAt), manualRequired: r.manualRequired as boolean }, cost,
    ...(h.uploadCost === undefined ? {} : { uploadCost: parseUploadCost(h.uploadCost) }) };
}
export function inspectBilibiliStatus(inspection: BilibiliInspection, at: string) {
  const entries = inspection.entries;
  return { inspectedAt: timestamp(at), configured: entries.length, due: entries.filter(e => !e.held && e.status === "due").length,
    fresh: entries.filter(e => !e.held && e.status === "fresh").length, pending: entries.filter(e => !e.held && e.pending).length,
    reviewRequired: inspection.reviewRequired, nextDueAt: entries.filter(e => !e.held).map(e => e.nextDueAt).filter((t): t is string => t !== null).sort()[0] ?? null };
}
const later = (a: string | null, b: string | null) => !a ? b : !b ? a : Date.parse(a) >= Date.parse(b) ? a : b;
const errorCode = (e: unknown) => {
  const code = (e as { code?: unknown })?.code;
  return typeof code === "string" && /^[A-Z][A-Z_]{0,63}$/.test(code) ? code : "BILIBILI_CYCLE_FAILED";
};
export interface BilibiliCyclePorts {
  inspect: () => Promise<BilibiliInspection>;
  execute: (keys: string[], digest: string, observe: RefreshObserver) => Promise<RefreshReport>;
  saveCycle: (cycle: CycleReport) => Promise<void>;
  saveHealth: (health: BilibiliHealth) => Promise<void>;
  measure?: () => Pick<BilibiliCost, "sourceRequests" | "sourceBytes" | "cpuUserMs" | "cpuSystemMs" | "peakRssBytes">;
  retryNotBefore?: () => string | null;
  finishUpload?: () => Promise<void>;
  uploadCost?: () => CycleUploadCost;
}
export function automaticBilibiliRecovery(old: BilibiliHealth | null, previous: PreviousCycle | null, digest: string): boolean {
  return Boolean(previous?.status === "paused" && old && old.scopeDigest === digest && previous.scopeDigest === digest &&
    old.cycle?.startedAt === previous.startedAt && !old.recovery.manualRequired && old.recovery.retryAt &&
    old.recovery.code && transient.has(old.recovery.code) && old.recovery.failures >= 1 && old.recovery.failures <= retryDelays.length);
}
/** Recovery is Bilibili-only and requires the exact paused cycle and unchanged reviewed scope. */
export async function runBilibiliCycle(command: "run" | "resume", previous: PreviousCycle | null, old: BilibiliHealth | null,
  ports: BilibiliCyclePorts, options: { now?: () => string; signal?: AbortSignal } = {}): Promise<BilibiliHealth> {
  const now = options.now ?? (() => new Date().toISOString()), start = performance.now(), checkedAt = now();
  const health: BilibiliHealth = { version: 1, platform: "bilibili", checkedAt, state: "error", scopeDigest: old?.scopeDigest ?? null,
    lastCheckAt: old?.lastCheckAt ?? null, lastCollectedAt: old?.lastCollectedAt ?? null, lastUploadedAt: old?.lastUploadedAt ?? null,
    plan: old?.plan ?? null, cycle: old?.cycle ?? null,
    recovery: { failures: old?.recovery.failures ?? 0, code: null, retryAt: null, manualRequired: false },
    cost: { elapsedMs: 0, checkMs: 0, captureMs: 0, uploadMs: 0, sourceRequests: 0, sourceBytes: 0, cpuUserMs: null, cpuSystemMs: null, peakRssBytes: null } };
  let cycle: CycleReport | null = null, failedCodes: string[] = [], inspected = false;
  const observe = (a: RefreshActivity) => {
    health.cost[a.phase === "capture" ? "captureMs" : "uploadMs"] += a.durationMs;
    if (a.success) {
      if (a.phase === "capture") health.lastCollectedAt = later(health.lastCollectedAt, a.observedAt);
      else health.lastUploadedAt = later(health.lastUploadedAt, a.completedAt);
    }
  };
  const manual = (code: string) => {
    health.state = "manual-required"; health.recovery = { failures: Math.min(health.recovery.failures, 4), code, retryAt: null, manualRequired: true };
  };
  try {
    const before = performance.now(), state = await ports.inspect(); health.cost.checkMs += performance.now() - before; inspected = true;
    health.scopeDigest = state.scopeDigest; health.lastCheckAt = checkedAt; health.plan = inspectBilibiliStatus(state, checkedAt);
    health.lastCollectedAt = state.entries.reduce((at, e) => later(at, e.observedAt), health.lastCollectedAt);
    const matches = old?.scopeDigest === state.scopeDigest && old?.cycle?.startedAt === previous?.startedAt && previous?.scopeDigest === state.scopeDigest;
    if (command === "run" && old?.recovery.manualRequired) { manual(old.recovery.code ?? "BILIBILI_MANUAL_RESUME_REQUIRED"); return health; }
    if (command === "run" && previous && ["paused", "cancelled"].includes(previous.status)) {
      if (!automaticBilibiliRecovery(old, previous, state.scopeDigest)) {
        manual(matches && old?.recovery.code ? old.recovery.code : "BILIBILI_MANUAL_RESUME_REQUIRED"); return health;
      }
      if (Date.parse(now()) < Date.parse(old!.recovery.retryAt!)) {
        health.state = "retry-wait"; health.recovery = { ...old!.recovery }; return health;
      }
    }
    if (command === "resume" || !matches) health.recovery.failures = 0;
    cycle = newCycle(state.keys, state.scopeDigest, state.reviewRequired, now());
    await drainCycle(cycle, { execute: async keys => {
      const result = await ports.execute(keys, cycle!.scopeDigest, observe);
      failedCodes.push(...result.entries.filter(e => e.status === "failed").map(e => e.code ?? "REFRESH_FAILED"));
      return result;
    }, save: ports.saveCycle }, options);
    health.cycle = { startedAt: cycle.startedAt, status: cycle.status, selected: cycle.selected, uploaded: cycle.uploaded,
      failed: cycle.failed, remaining: cycle.remaining.length, batches: cycle.batches };
    if (cycle.status === "paused") {
      const failures = health.recovery.failures + 1;
      if (failedCodes.length && failedCodes.every(code => transient.has(code)) && failures <= retryDelays.length && !options.signal?.aborted) {
        const baseRetry = new Date(Date.parse(now()) + retryDelays[failures - 1]! * 60000).toISOString();
        const sourceRetry = failedCodes.includes("RATE_LIMITED") ? ports.retryNotBefore?.() ?? null : null;
        health.state = "retry-wait"; health.recovery = { failures, code: failedCodes.at(-1)!,
          retryAt: later(baseRetry, sourceRetry), manualRequired: false };
      } else { health.recovery.failures = Math.min(failures, 4); manual(failedCodes.at(-1) ?? "BILIBILI_CYCLE_PAUSED"); }
    } else if (cycle.status === "cancelled") { health.state = "cancelled"; manual("CANCELLED"); }
    else {
      health.state = cycle.status === "complete" && !cycle.selected ? "idle" : cycle.status as State;
      health.recovery = { failures: 0, code: null, retryAt: null, manualRequired: false };
    }
    // Idle checks keep their one local inspection; only an executed batch can change the plan.
    if (!cycle.batches) return health;
    // A bounded local reread gives the actual post-run next due/pending status, not the initial plan.
    const after = performance.now();
    try { const current = await ports.inspect(); health.plan = inspectBilibiliStatus(current, now());
      if (current.scopeDigest !== health.scopeDigest) manual("REFRESH_SCOPE_CHANGED"); }
    catch (error) { if (errorCode(error) !== "BUSY") throw error; }
    finally { health.cost.checkMs += performance.now() - after; }
    return health;
  } catch (error) {
    const code = errorCode(error);
    if (cycle) health.cycle = { startedAt: cycle.startedAt, status: cycle.status, selected: cycle.selected, uploaded: cycle.uploaded,
      failed: cycle.failed, remaining: cycle.remaining.length, batches: cycle.batches };
    if (code === "BUSY") { health.state = "deferred"; health.recovery = old?.recovery ? { ...old.recovery } : health.recovery; }
    else manual(options.signal?.aborted ? "CANCELLED" : code);
    if (!inspected) health.plan = old?.plan ?? null;
    return health;
  } finally {
    try { await ports.finishUpload?.(); }
    catch { if (!health.recovery.manualRequired) manual("CLOUD_CLOSE_FAILED"); }
    health.checkedAt = now(); health.cost.elapsedMs = performance.now() - start;
    if (ports.measure) Object.assign(health.cost, ports.measure());
    if (ports.uploadCost) health.uploadCost = parseUploadCost(ports.uploadCost());
    await ports.saveHealth(health);
  }
}

/** B-only response classification and streamed cost counting, inside the unchanged global budget. */
export function trackedBilibiliRequest(request: typeof fetch = fetch, now = () => Date.now()) {
  const cost = { sourceRequests: 0, sourceBytes: 0 };
  let retryAt: string | null = null;
  const tracked: typeof fetch = async (input, init) => {
    cost.sourceRequests++; const response = await request(input, init);
    if (response.status >= 500 && response.status <= 599) {
      await response.body?.cancel().catch(() => {}); throw new SocialSyncError("SOURCE_TEMPORARY_ERROR");
    }
    if (response.status === 429) {
      const header = response.headers.get("retry-after")?.trim(), at = now();
      const until = header ? /^\d+$/.test(header) ? at + Number(header) * 1000 : Date.parse(header) : NaN;
      if (until === Infinity || Number.isFinite(until) && until > at + 24 * 3600000) {
        await response.body?.cancel().catch(() => {}); throw new SocialSyncError("RATE_LIMITED_LONG_COOLDOWN");
      }
      if (Number.isFinite(until) && until > at) retryAt = later(retryAt, new Date(until).toISOString());
    }
    if (!response.body) return response;
    const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) {
      cost.sourceBytes += chunk.byteLength; controller.enqueue(chunk);
    } }));
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
  return { request: tracked, cost, retryNotBefore: () => retryAt };
}
