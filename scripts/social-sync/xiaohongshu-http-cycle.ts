import { SocialSyncError, timestamp } from "./model.ts";
import { drainCycle, newCycle, XHS_CYCLE } from "./refresh-cycle.ts";
import type { CycleReport } from "./refresh-cycle.ts";
import type { RefreshReport } from "./refresh-executor.ts";
import type { RefreshObserver } from "./refresh-activity.ts";
import type { inspectRefresh } from "./refresh-state.ts";
import type { HttpProcessCost } from "./xiaohongshu-http-transport.ts";
import { XHS_HTTP_LIMITS } from "./xiaohongshu-http-transport.ts";
import type { CycleUploadCost } from "./cycle-cloud.ts";
import { parseUploadCost } from "./cycle-cloud.ts";
import { join } from "node:path";
import { readPrivateFile,privateDirectory } from "../notion-sync/state.ts";
import { writeJson } from "../game-sync/private.ts";

export type HttpStage = "check" | "preflight" | "capture" | "upload" | "close";
export interface HttpHealth {
  version: 1; platform: "xiaohongshu"; scopeDigest: string; state: string; lastCheckAt: string;
  lastCollectedAt: string | null; lastUploadedAt: string | null;
  recovery: { manualRequired: boolean; code: string | null; stage: HttpStage | null; since: string | null };
  cycle: { startedAt: string; finishedAt: string | null; uploaded: number; remaining: number } | null;
  cost: HttpProcessCost | null; uploadCost: CycleUploadCost | null;
}
const codeOf = (e: unknown) => {
  const code = (e as { code?: unknown })?.code;
  return typeof code === "string" && /^[A-Z][A-Z_]{0,63}$/.test(code) ? code : "XHS_HTTP_REFRESH_FAILED";
};
export function parseHttpHealth(value: unknown): HttpHealth {
  if (!value || typeof value !== "object") throw new SocialSyncError("XHS_HTTP_HEALTH_INVALID");
  const h = value as HttpHealth;
  if (h.version !== 1 || h.platform !== "xiaohongshu" || !/^[a-f0-9]{64}$/.test(h.scopeDigest) ||
    !["idle", "complete", "review-required", "paused", "cancelled", "budget", "deferred"].includes(h.state) ||
    !h.recovery || typeof h.recovery.manualRequired !== "boolean" ||
    h.recovery.code !== null && !/^[A-Z][A-Z_]{0,63}$/.test(h.recovery.code) ||
    h.recovery.stage !== null && !["check", "preflight", "capture", "upload", "close"].includes(h.recovery.stage)) throw new SocialSyncError("XHS_HTTP_HEALTH_INVALID");
  if (typeof h.recovery.code !== "string" && h.recovery.code !== null || typeof h.recovery.since !== "string" && h.recovery.since !== null) throw new SocialSyncError("XHS_HTTP_HEALTH_INVALID");
  try { for (const at of [h.lastCheckAt, h.lastCollectedAt, h.lastUploadedAt, h.recovery.since]) if (at !== null) timestamp(at); }
  catch { throw new SocialSyncError("XHS_HTTP_HEALTH_INVALID"); }
  let cycle: HttpHealth["cycle"] = null, cost: HttpProcessCost | null = null, uploadCost: CycleUploadCost | null = null;
  try {
    if (h.cycle !== null) {
      const c = h.cycle!;timestamp(c.startedAt);if(c.finishedAt!==null)timestamp(c.finishedAt);
      if (![c.uploaded,c.remaining].every(n=>Number.isSafeInteger(n)&&n>=0&&n<=500)) throw Error();
      cycle={startedAt:c.startedAt,finishedAt:c.finishedAt,uploaded:c.uploaded,remaining:c.remaining};
    }
    if(h.cost!==null){
      const c=h.cost!;
      if(![c.starts,c.requests,c.bytes,c.cpuMs,c.peakRssBytes].every(n=>typeof n==="number"&&Number.isFinite(n)&&n>=0&&n<=1e12)||
        ![c.starts,c.requests,c.bytes,c.peakRssBytes].every(Number.isSafeInteger)||c.starts>1||c.requests>160)throw Error();
      cost={starts:c.starts,requests:c.requests,bytes:c.bytes,cpuMs:c.cpuMs,peakRssBytes:c.peakRssBytes};
    }
    if(h.uploadCost!==null)uploadCost=parseUploadCost(h.uploadCost);
  }catch{throw new SocialSyncError("XHS_HTTP_HEALTH_INVALID");}
  // The status CLI never echoes arbitrary fields from a private receipt.
  return {version:1,platform:"xiaohongshu",scopeDigest:h.scopeDigest,state:h.state,lastCheckAt:h.lastCheckAt,
    lastCollectedAt:h.lastCollectedAt,lastUploadedAt:h.lastUploadedAt,
    recovery:{manualRequired:h.recovery.manualRequired,code:h.recovery.code,stage:h.recovery.stage,since:h.recovery.since},cycle,cost,uploadCost};
}
/** An exceptional native upload uses the same durable operator-resume latch as HTTP. */
export async function recordExternalHttpPause(root:string,scopeDigest:string,code:string,stage:HttpStage){
  await privateDirectory(join(root,"cycle-xiaohongshu-http"));
  const file=join(root,"cycle-xiaohongshu-http","health.json"),at=new Date().toISOString();let old:HttpHealth|null=null;
  try{old=parseHttpHealth(JSON.parse(await readPrivateFile(file,128*1024)));}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
  const h:HttpHealth=old??{version:1,platform:"xiaohongshu",scopeDigest,state:"paused",lastCheckAt:at,lastCollectedAt:null,lastUploadedAt:null,recovery:{manualRequired:false,code:null,stage:null,since:null},cycle:null,cost:null,uploadCost:null};
  h.state="paused";h.recovery={manualRequired:true,code,stage,since:at};await writeJson(file,parseHttpHealth(h));
}
export interface HttpCyclePorts {
  inspect: () => Promise<Awaited<ReturnType<typeof inspectRefresh>>>;
  prepare: (scopeDigest: string) => Promise<void>;
  execute: (keys: string[], digest: string, observe: RefreshObserver) => Promise<RefreshReport>;
  saveCycle: (cycle: CycleReport) => Promise<void>;
  saveHealth: (health: HttpHealth) => Promise<void>;
  finish: () => Promise<void>;
  cost: () => HttpProcessCost; uploadCost: () => CycleUploadCost; now?: () => string;
}
/** No source/network auto-retries. Resume is a deliberate operator command; pending ACKs survive. */
export async function runHttpNoteCycle(command: "run" | "resume", old: HttpHealth | null, interrupted: boolean,
  ports: HttpCyclePorts, signal?: AbortSignal): Promise<HttpHealth> {
  const now = ports.now ?? (() => new Date().toISOString());
  let health: HttpHealth | null = null, cycle: CycleReport | null = null, stage: HttpStage = "check", failure: string | null = null;
  const observe: RefreshObserver = event => {
    if (!health) return;
    stage = event.phase;
    if (event.success) {
      if (event.phase === "capture") {if(!health.lastCollectedAt||event.observedAt&&event.observedAt>health.lastCollectedAt)health.lastCollectedAt = event.observedAt;}
      else health.lastUploadedAt = event.completedAt;
    } else failure = event.code;
  };
  try {
    const current = await ports.inspect();
    health = { version: 1, platform: "xiaohongshu", scopeDigest: current.scopeDigest, state: "idle", lastCheckAt: now(),
      lastCollectedAt: old?.lastCollectedAt ?? null, lastUploadedAt: old?.lastUploadedAt ?? null,
      recovery: { manualRequired: false, code: null, stage: null, since: null }, cycle: old?.cycle ?? null, cost: old?.cost ?? null, uploadCost: old?.uploadCost ?? null };
    if (command === "run" && (old?.recovery.manualRequired || interrupted)) {
      health.state = "paused"; health.recovery = old?.recovery.manualRequired ? old.recovery :
        { manualRequired: true, code: "XHS_MANUAL_RESUME_REQUIRED", stage: "check", since: now() };
      // Keep the actual failed cycle/cost while only updating the local check time.
      health.cost = old?.cost ?? null; health.uploadCost = old?.uploadCost ?? null;
    } else if (!current.keys.length) {
      health.state = current.reviewRequired ? "review-required" : "idle";
    } else {
      cycle = newCycle(current.keys, current.scopeDigest, current.reviewRequired, now());
      await ports.saveCycle(cycle);
      stage = "preflight";
      if (signal?.aborted) throw new SocialSyncError("CANCELLED");
      await ports.prepare(current.scopeDigest); // Must pass before any source GET or ingestion.
      stage = "capture";
      await drainCycle(cycle, { execute: async keys => {
        const batch = await ports.execute(keys, current.scopeDigest, observe);
        failure ??= batch.entries.find(e => e.status === "failed")?.code ?? (batch.superseded ? "REFRESH_SOURCE_CHANGED" : null);
        return batch;
      }, save: ports.saveCycle },
        { budget: { ...XHS_CYCLE, ...XHS_HTTP_LIMITS }, signal, now });
      health.state = cycle.status;
      if (["paused", "cancelled", "budget"].includes(cycle.status)) {
        health.recovery = { manualRequired: true, code: failure ?? (cycle.status === "budget" ? "REFRESH_CYCLE_BUDGET" : cycle.status === "cancelled" ? "CANCELLED" : "XHS_HTTP_REFRESH_FAILED"), stage, since: now() };
      }
    }
  } catch (e) {
    const code = codeOf(e);
    health ??= { version: 1, platform: "xiaohongshu", scopeDigest: old?.scopeDigest ?? "0".repeat(64), state: "paused", lastCheckAt: now(),
      lastCollectedAt: old?.lastCollectedAt ?? null, lastUploadedAt: old?.lastUploadedAt ?? null,
      recovery: { manualRequired: false, code: null, stage: null, since: null }, cycle: old?.cycle ?? null, cost: old?.cost ?? null, uploadCost: old?.uploadCost ?? null };
    health.state = code === "BUSY" ? "deferred" : signal?.aborted ? "cancelled" : "paused";
    health.recovery = code === "BUSY" ? old?.recovery ?? { manualRequired: interrupted, code: interrupted ? "XHS_MANUAL_RESUME_REQUIRED" : "BUSY", stage: "check", since: now() } :
      { manualRequired: true, code, stage, since: now() };
    if (cycle && cycle.status === "running") { cycle.status = health.state === "deferred" ? "deferred" : "paused"; cycle.finishedAt = now(); await ports.saveCycle(cycle); }
  } finally {
    try { await ports.finish(); }
    catch (e) { if (health) { health.state = "paused"; health.recovery = { manualRequired: true, code: codeOf(e), stage: "close", since: now() }; } }
    if (health) {
      if (cycle) { health.cycle = { startedAt: cycle.startedAt, finishedAt: cycle.finishedAt, uploaded: cycle.uploaded, remaining: cycle.remaining.length }; health.cost = ports.cost(); health.uploadCost = ports.uploadCost(); }
      await ports.saveHealth(health);
    }
  }
  return health!;
}
