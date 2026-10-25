import { randomUUID } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { acquireLock, privateDirectory, readPrivateFile } from "../notion-sync/state.ts";
import { writeJson } from "../game-sync/private.ts";
import { hash, publicationKey, SocialSyncError } from "./model.ts";
import { inspectRefresh } from "./refresh-state.ts";
import { executeAtRoot } from "./execute-cli.ts";
import { CycleCloudSession } from "./cycle-cloud.ts";
import { HttpNoteSession } from "./xiaohongshu-http-transport.ts";
import { readHttpNotePolicy, readHttpNoteScope } from "./xiaohongshu-http-config.ts";
import { parseHttpHealth, runHttpNoteCycle,recordExternalHttpPause } from "./xiaohongshu-http-cycle.ts";
import { XHS_CYCLE } from "./refresh-cycle.ts";
import { readNoteLinkHolds,holdNoteLink } from "./xiaohongshu-link-holds.ts";
import { runXhsDiscovery } from "./xiaohongshu-discovery-worker.ts";
import { readXhsAccountPolicy,candidateNoteShareUrl,automaticNoteTarget } from "./xiaohongshu-account.ts";
import { readXhsDiscoveryState,resumeXhsDirectory } from "./xiaohongshu-discovery-bridge.ts";
import { MAX_REFRESH_CONFIG_BYTES,refreshConfig } from "./refresh.ts";
import { readBrowserOnlyIds,readBrowserNoteCapture,ingestAcceptedBrowserNotes,resumeBrowserNoteLane } from "./xiaohongshu-browser-notes.ts";
import { createHttpSourcePacer,XHS_HTTP_DUE_PER_CHECK } from "./xiaohongshu-http-pacing.ts";

export const usage = "node scripts/social-sync/http-cycle-cli.ts <plan|status|run|resume> <absolute-private-runtime>";
async function optional(path: string) { try { return JSON.parse(await readPrivateFile(path, 128 * 1024)); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; } }
export async function runHttpCycleCli(args: string[]) {
  if (args.length === 1 && args[0] === "--help") { console.log(usage); return; }
  const [command, root] = args;
  if (args.length !== 2 || !["plan", "status", "run", "resume"].includes(command) || !isAbsolute(root) || resolve(root) !== root) throw new SocialSyncError("USAGE");
  process.umask(0o077); await privateDirectory(root);
  const policy = await readHttpNotePolicy(root);
  if (!policy?.enabled) { console.log(JSON.stringify({ state: "disabled", executed: false })); return; }
  const policyDigest = hash(JSON.stringify(policy));
  let lastScopeDigest: string | undefined;
  const checked = async () => {
    const current = await readHttpNoteScope(root);
    if (hash(JSON.stringify(current.policy)) !== policyDigest) throw new SocialSyncError("REFRESH_SCOPE_CHANGED");
    lastScopeDigest = hash(JSON.stringify(current.scope));
    return current;
  };
  const scopeProvider = async () => (await checked()).scope, inspect = async () => {
    const current=await inspectRefresh(root,"xiaohongshu",new Date().toISOString(),scopeProvider),links=(await checked()).links,holds=await readNoteLinkHolds(root);
    const base=refreshConfig(JSON.parse(await readPrivateFile(join(root,"refresh-config.json"),MAX_REFRESH_CONFIG_BYTES))),account=await readXhsAccountPolicy(root,base),accountDigest=account?.enabled?hash(JSON.stringify(account)):null;
    const browserIds=new Set(accountDigest?await readBrowserOnlyIds(root,accountDigest):[]),held=new Set<string>();
    for(const e of current.entries){const target=current.scope.publications.find(p=>publicationKey(p.target)===e.key)!.target,hold=holds.find(h=>h.key===e.key&&h.linkSha256===hash(links.get(target.publicationId)!));
      const captured=accountDigest?await readBrowserNoteCapture(root,target,accountDigest):null;
      if(e.status==="due"&&(hold||browserIds.has(target.publicationId))&&(!captured||e.observedAt&&captured.observedAt<=e.observedAt))held.add(e.key);
    }
    const eligible=current.keys.filter(k=>!held.has(k)).sort((a,b)=>{const ea=current.entries.find(e=>e.key===a)!,eb=current.entries.find(e=>e.key===b)!;return (ea.observedAt??"").localeCompare(eb.observedAt??"")||a.localeCompare(b);});
    return {...current,entries:current.entries.map(e=>({...e,held:e.held||held.has(e.key)})),keys:eligible.slice(0,XHS_HTTP_DUE_PER_CHECK),reviewRequired:new Set([...current.entries.filter(e=>e.held).map(e=>e.key),...held]).size};
  };
  const dir = join(root, "cycle-xiaohongshu-http"), healthFile = join(dir, "health.json");
  const readPrevious = async () => {
    const raw = await optional(healthFile), old = raw === null ? null : parseHttpHealth(raw);
    const previous = await optional(join(dir, "latest-cycle.json")), legacy = previous === null ? await optional(join(root, "cycle-xiaohongshu", "latest-cycle.json")) : null;
    const interrupted = previous !== null && ["paused", "cancelled", "running", "budget"].includes(previous.status) || legacy !== null && ["paused", "cancelled", "running", "budget"].includes(legacy.cycle?.status);
    return {old,interrupted};
  };
  if (command === "plan" || command === "status") {
    const {old,interrupted}=await readPrevious();
    const current = await inspect();
    console.log(JSON.stringify({ state: old?.recovery.manualRequired || interrupted ? "manual-required" : current.keys.length ? "due" : "idle", configured: current.entries.length,
      due: current.entries.filter(e => e.status === "due" && !e.held).length, pending: current.entries.filter(e => e.pending).length, remaining: current.keys.length,
      recovery: old?.recovery ?? { manualRequired: interrupted, code: interrupted ? "XHS_MANUAL_RESUME_REQUIRED" : null, stage: interrupted ? "check" : null },
      lastCheckAt: old?.lastCheckAt ?? null, lastCollectedAt: old?.lastCollectedAt ?? null, lastUploadedAt: old?.lastUploadedAt ?? null,
      lastCycle: old?.cycle ?? null, lastCost: old?.cost ?? null, lastUploadCost: old?.uploadCost ?? null, executed: false })); return;
  }
  const controller = new AbortController(), cancel = () => controller.abort();
  let release: (() => Promise<void>) | undefined;
  const timer = setTimeout(cancel, XHS_CYCLE.durationMs); timer.unref(); process.on("SIGTERM", cancel); process.on("SIGINT", cancel);
  let cloud: CycleCloudSession | undefined, http: HttpNoteSession | undefined;
  try {
    release = await acquireLock(dir, randomUUID());
    controller.signal.throwIfAborted();
    const base=refreshConfig(JSON.parse(await readPrivateFile(join(root,"refresh-config.json"),MAX_REFRESH_CONFIG_BYTES))),account=await readXhsAccountPolicy(root,base),directory=account?.enabled?await readXhsDiscoveryState(root,hash(JSON.stringify(account))):null;
    cloud = new CycleCloudSession(controller.signal, undefined, { httpNotes: true,...(account?.enabled?{xhsAccount:{accountId:account.accountId,link:(item:import("./store.ts").Pending)=>{const l=directory?.links.find(l0=>l0.publicationId===item.observation.publicationId);return l?{url:candidateNoteShareUrl(l.url,automaticNoteTarget(account.accountId,l.publicationId)),checkedAt:item.observation.observedAt}:null;}}}:{}) }); http = new HttpNoteSession(policy.pythonExecutable);
    const pace=createHttpSourcePacer();
    const activeCloud = cloud, activeHttp = http;
    const {old,interrupted}=await readPrevious();
    if(command==="resume"&&account?.enabled){const digest=hash(JSON.stringify(account));await resumeXhsDirectory(root,digest);await resumeBrowserNoteLane(root,digest);}
    if(command==="resume"||!old?.recovery.manualRequired&&!interrupted){try{await runXhsDiscovery(root,controller.signal);}catch(e){
      if((e as {code?:string}).code!=="BUSY")try{await recordExternalHttpPause(root,lastScopeDigest??"0".repeat(64),e instanceof SocialSyncError?e.code:"XHS_DISCOVERY_FAILED","upload");}
      catch{console.error(JSON.stringify({code:"XHS_HTTP_PAUSE_WRITE_FAILED"}));}
      throw e;
    }}
    const report = await runHttpNoteCycle(command as "run" | "resume", old, interrupted, {
      inspect,
      prepare: async digest => { await checked(); await activeCloud.preparePublications(await readPrivateFile(join(root, "cloud.env"), 65536), digest, controller.signal); },
      execute: async (keys, digest, observe) => {
        if(account?.enabled){const started=performance.now(),accepted=await ingestAcceptedBrowserNotes(root,keys,hash(JSON.stringify(account)));for(const row of accepted)observe({phase:"capture",success:true,observedAt:row.observedAt,completedAt:new Date().toISOString(),durationMs:performance.now()-started,code:null});}
        const result = await executeAtRoot(root, { platform: "xiaohongshu", limit: 5, keys, scopeDigest: digest, scopeProvider, cloudSession: activeCloud, signal: controller.signal, observe,
          collectHttpNote: async (target, signal) => { const current = await checked(),url=current.links.get(target.publicationId)!;
            const captured=account?.enabled?await readBrowserNoteCapture(root,target,hash(JSON.stringify(account))):null;if(captured)return captured;
            try{await pace(signal);return await activeHttp.collect(target,url,signal);}catch(e){if(e instanceof SocialSyncError&&(e.code==="SOURCE_NOTE_UNAVAILABLE"||e.code==="NOTE_BROWSER_REQUIRED"))await holdNoteLink(root,publicationKey(target),url,new Date().toISOString(),e.code);throw e;} } });
        if (!("entries" in result)) throw new SocialSyncError("REFRESH_CYCLE_RECEIPT_INVALID"); return result;
      },
      saveCycle: async cycle => { await writeJson(join(dir, "latest-cycle.json"), cycle); if (cycle.status === "complete") await writeJson(join(dir, "last-successful-cycle.json"), cycle); },
      saveHealth: health => writeJson(healthFile, health),
      finish: async () => { const closed = await Promise.allSettled([activeHttp.close(), activeCloud.close()]); const failed = closed.find(r => r.status === "rejected"); if (failed?.status === "rejected") throw failed.reason; },
      cost: () => ({ ...activeHttp.cost }), uploadCost: () => ({ ...activeCloud.cost }),
    }, controller.signal);
    console.log(JSON.stringify({ state: report.state, recovery: report.recovery, cycle: report.cycle, cost: report.cost, uploadCost: report.uploadCost }));
    if (report.recovery.manualRequired || ["budget", "review-required", "cancelled"].includes(report.state)) process.exitCode = 1;
  } finally {
    clearTimeout(timer); process.removeListener("SIGTERM", cancel); process.removeListener("SIGINT", cancel);
    try { await Promise.allSettled([http?.close(), cloud?.close()]); } finally { await release?.(); }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) runHttpCycleCli(process.argv.slice(2)).catch(e => {
  console.error(JSON.stringify({ code: e instanceof SocialSyncError ? e.code : e?.code === "BUSY" ? "BUSY" : "XHS_HTTP_REFRESH_FAILED" })); process.exitCode = 1;
});
