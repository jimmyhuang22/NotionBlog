import { join } from "node:path";
import { openSharedBudget, type BudgetBridge, type SharedBudget } from "../website-sync/shared-budget.ts";
import { privateDirectory } from "../notion-sync/state.ts";
import { privateCachePath } from "./local.ts";
import { commitCatalogDigest, classifyCommitCatalog, readCommitCatalog } from "./commit-catalog.ts";
import { COMMIT_FENCE_TABLES, readCommitRolloutFacts, runCommitRollout, type CommitRolloutPlan, type CommitRolloutAuthority, type CommitRolloutReport, type CommitRolloutConnection } from "./commit-rollout.ts";
import { createCommitRolloutJournal } from "./commit-rollout-journal.ts";
import { createHostConnector, type HostCredentials } from "./commit-host-pg.ts";
import { createHostHold, hostLock, hostNeed, hostRead, hostWrite, releaseHeld, validateHostGraph, verifyHeld, verifyHostPins, type HostGraph, type HostPin, type HeldFile } from "./commit-host-files.ts";

export interface HostSlot { kind: "execute" | "inspect"; plan: CommitRolloutPlan; authority: CommitRolloutAuthority; previousOperation?: string }
export interface CommitHostManifest { version: 1; root: string; graph: HostGraph; packagePins: HostPin[]; closure: HostPin; budget: BudgetBridge; maxConnections: number; slots: HostSlot[] }
export interface HostApproval { approved: boolean; manifestSHA256: string }
const digest = commitCatalogDigest;
const failed = (report: CommitRolloutReport) => !!report.error || report.outcome !== "committed" || !report.verified || report.journalFailed;
type BudgetState = ReturnType<SharedBudget["read"]>;
interface HostFinal { version: 1; operation: string; manifestSHA256: string; report: CommitRolloutReport | null; inspection: string | null; actorLocksReleased: boolean;
  transport: { connections: number; closed: number; tlsVerified: number; streamReceivedBytes: number; driverCalls: number; logicalBytes: number }; budget: BudgetState | null; allClosed: boolean; error: string | null }

/** A single shared ledger remains authoritative across every predeclared slot.
 * Immutable prior receipts and a per-client floor reject counter rewinds. */
function monotonicBudget(budget: SharedBudget, prior: BudgetState[]) {
  let floor = budget.read();
  const compare = (current: BudgetState, previous: BudgetState) => hostNeed(current.revision >= previous.revision && Object.entries(previous.counters).every(([k,v]) => current.counters[k as keyof typeof current.counters] >= v), "CACHE_HOST_LEDGER_REWIND");
  prior.forEach(p => compare(floor, p));
  const read = () => { const current = budget.read(); compare(current, floor); floor = current; return current; };
  return { ...budget, read,
    guard: () => { read(); budget.guard(); read(); },
    charge: (...args: Parameters<SharedBudget["charge"]>) => { read(); try { budget.charge(...args); } finally { read(); } },
    observe: (...args: Parameters<SharedBudget["observe"]>) => { read(); try { budget.observe(...args); } finally { read(); } },
  } satisfies SharedBudget;
}
async function optionalJSON<T>(path: string): Promise<T | undefined> {
  try { return JSON.parse((await hostRead(path)).bytes.toString()) as T; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
}
function validateSlot(slot: HostSlot, manifest: CommitHostManifest, now: number) {
  const p = slot.plan, a = slot.authority;
  hostNeed(["execute","inspect"].includes(slot.kind) && p.environment === "project" && /^[a-f0-9-]{36}$/.test(p.operation) && a.approved === true && /^[a-f0-9-]{36}$/.test(a.nonce) && a.planSHA256 === digest(p), "CACHE_HOST_AUTHORITY");
  hostNeed(p.runtimeSHA256 === digest(manifest.graph) && p.packageSHA256 === digest(manifest.packagePins) && p.targetSHA256 === manifest.slots[0].plan.targetSHA256 &&
    [p.beforeTables,p.afterTables].every(t => Array.isArray(t) && t.length > 0 && new Set(t).size === t.length && t.every(name => COMMIT_FENCE_TABLES.includes(name))), "CACHE_HOST_PLAN");
  hostNeed([a.issuedAt,a.startBefore,a.businessEnd,a.cleanupEnd].every(Number.isSafeInteger) && a.issuedAt <= now && now <= a.startBefore && a.startBefore < a.businessEnd &&
    a.startBefore-a.issuedAt <= 30*60_000 && a.businessEnd-a.issuedAt <= 120*60_000 && a.cleanupEnd>a.businessEnd && a.cleanupEnd-a.businessEnd<=20_000 &&
    Number.isSafeInteger(a.maxConnections) && a.maxConnections>=2 && a.maxConnections<=3 && Number.isSafeInteger(a.maxDriverCalls) && a.maxDriverCalls>=32 && a.maxDriverCalls<=80 &&
    Number.isSafeInteger(a.maxLogicalBytes) && a.maxLogicalBytes>=65536 && a.maxLogicalBytes<=262144, "CACHE_HOST_AUTHORITY");
  if (slot.kind === "inspect") {
    const previous = manifest.slots.find(s => s.kind === "execute" && s.plan.operation === slot.previousOperation);
    hostNeed(previous && digest({ ...p, operation: previous.plan.operation }) === digest(previous.plan), "CACHE_HOST_INSPECTION_SCOPE");
  } else hostNeed(slot.previousOperation === undefined, "CACHE_HOST_PLAN");
}

/** Concrete filesystem / shared-budget / pg adapter. No CLI, env loading or
 * permission inference: approval must describe this exact complete manifest. */
export async function runHostedCommitRollout(input: CommitHostManifest, approval: HostApproval, operation: string, migration: string, loadCredentials: () => Promise<HostCredentials>) {
  const manifest = structuredClone(input), manifestSHA256 = digest(manifest);
  hostNeed(approval.approved === true && approval.manifestSHA256 === manifestSHA256 && manifest.version === 1, "CACHE_HOST_AUTHORITY");
  validateHostGraph(manifest.graph, manifest.packagePins); privateCachePath(manifest.root);
  hostNeed(manifest.slots.length>0 && manifest.slots.length<=4 && new Set(manifest.slots.map(s => s.plan.operation)).size===manifest.slots.length && new Set(manifest.slots.map(s => s.authority.nonce)).size===manifest.slots.length &&
    Number.isSafeInteger(manifest.maxConnections) && manifest.maxConnections<=12 && manifest.slots.reduce((n,s)=>n+s.authority.maxConnections,0)<=manifest.maxConnections, "CACHE_HOST_SLOT_LIMIT");
  const slot = manifest.slots.find(s => s.plan.operation===operation); hostNeed(slot, "CACHE_HOST_SLOT");
  validateSlot(slot!, manifest, Date.now());
  // Immutable shape checks for future slots; their start windows are evaluated
  // when selected, so a long parent window does not authorize a late start.
  for (const s of manifest.slots) { validateSlot(s,manifest,s.authority.issuedAt); hostNeed(s.authority.issuedAt<=Date.now() && s.plan.runtimeSHA256===slot!.plan.runtimeSHA256 && s.plan.packageSHA256===slot!.plan.packageSHA256 && s.plan.targetSHA256===slot!.plan.targetSHA256, "CACHE_HOST_PLAN"); }
  const rawBudget = openSharedBudget(manifest.budget);
  hostNeed(rawBudget.plan.runtimeSha256===slot!.plan.runtimeSHA256 && slot!.authority.businessEnd<=rawBudget.plan.deadline && slot!.authority.cleanupEnd<=rawBudget.plan.deadline+rawBudget.plan.cleanupMs &&
    manifest.slots.reduce((n,s)=>n+s.authority.maxDriverCalls,0)<=rawBudget.plan.limits.sqlRequests && manifest.slots.reduce((n,s)=>n+s.authority.maxLogicalBytes+8192,0)<=rawBudget.plan.limits.sqlResponseBytes, "CACHE_HOST_BUDGET");
  await privateDirectory(manifest.root);
  const serial = await hostLock(join(manifest.root,"host-session.lock"), operation);
  let connector: ReturnType<typeof createHostConnector> | undefined;
  let final: HostFinal | undefined, canReleaseSerial = true;
  let observedReport: CommitRolloutReport|null=null, observedInspection:string|null=null, actorLocksReleased=false;
  const output = (id: string, name: string) => join(manifest.root,`operation-${id}`,name);
  const stopPath = join(manifest.root,"business-stop.json");
  try {
    const prior: BudgetState[]=[];
    for (const s of manifest.slots) {
      const result=await optionalJSON<HostFinal>(output(s.plan.operation,"host-final.json"));
      if (result) { hostNeed(result.version===1 && result.operation===s.plan.operation && result.manifestSHA256===manifestSHA256 && result.budget, "CACHE_HOST_PRIOR_RECEIPT"); prior.push(result.budget!); }
      else if (s.plan.operation!==operation && await optionalJSON(output(s.plan.operation,"host-start.json"))) hostNeed(false,"CACHE_HOST_PRIOR_UNSETTLED");
    }
    const budget=monotonicBudget(rawBudget,prior); budget.guard();
    if (slot!.kind==="execute") hostNeed(!await optionalJSON(stopPath),"CACHE_HOST_BUSINESS_STOPPED");
    const journal=await createCommitRolloutJournal(manifest.root,operation);
    connector=createHostConnector(slot!.plan.targetSHA256,loadCredentials,budget,slot!.authority.maxConnections,slot!.authority);
    const save=async(report:CommitRolloutReport)=>{budget.read(); await journal.save(report);};
    if (slot!.kind==="execute") {
      const report=await runCommitRollout(slot!.plan,slot!.authority,migration,{
        now:Date.now, claim:async(nonce,planSHA)=>{await journal.claim(nonce,planSHA); await hostWrite(output(operation,"host-start.json"),{version:1,operation,manifestSHA256});},
        hold:async(runtime,pkg)=>{hostNeed(runtime===digest(manifest.graph)&&pkg===digest(manifest.packagePins),"CACHE_HOST_PLAN"); return createHostHold(manifest.graph,manifest.packagePins,manifest.closure,manifest.budget.nonce,operation,output(operation,"host-hold.json"));},
        connect:connector.connect, save,
      });
      observedReport=report; actorLocksReleased=report.holdReleased;
      final={version:1,operation,manifestSHA256,report,inspection:null,actorLocksReleased,transport:{...connector.metrics},budget:budget.read(),allClosed:connector.allClosed(),error:report.error};
      if (failed(report)) {
        if (!await optionalJSON(stopPath)) await hostWrite(stopPath,{version:1,operation,manifestSHA256});
      }
    } else {
      const previous=await optionalJSON<HostFinal>(output(slot!.previousOperation!,"host-final.json"));
      hostNeed(previous?.report && previous.manifestSHA256===manifestSHA256 && failed(previous.report) && !previous.report.holdReleased && previous.allClosed && previous.report.connectionClosed && await optionalJSON(stopPath),"CACHE_HOST_INSPECTION_PREREQUISITE");
      await journal.claim(slot!.authority.nonce,slot!.authority.planSHA256);
      await hostWrite(output(operation,"host-start.json"),{version:1,operation,manifestSHA256});
      const held=await optionalJSON<{version:number;operation:string;scopeNonce:string;runtimeSHA256:string;files:HeldFile[]}>(output(slot!.previousOperation!,"host-hold.json"));
      hostNeed(held?.version===1 && held.operation===slot!.previousOperation && held.scopeNonce===manifest.budget.nonce && held.runtimeSHA256===digest(manifest.graph) &&
        digest(held.files.map(f=>f.path))===digest(manifest.graph.lockOrder),"CACHE_HOST_HOLD_RECEIPT");
      const verifyPins=await verifyHostPins([...manifest.packagePins,...manifest.graph.statePins]);
      await verifyHeld(held!.files);
      let connection:CommitRolloutConnection|undefined,begun=false,status="unavailable";
      try {
        connection=await connector.connect();
        hostNeed(await connection.command("BEGIN")==="BEGIN"); begun=true;
        await connection.command("SET LOCAL search_path='pg_catalog'"); await connection.command("SET LOCAL lock_timeout='250ms'"); await connection.command("SET LOCAL statement_timeout='3s'");
        const initial=classifyCommitCatalog(await readCommitCatalog(connection)); hostNeed(initial!=="mismatch","CACHE_HOST_INSPECTION_CATALOG");
        const tables=initial==="legacy"?slot!.plan.beforeTables:slot!.plan.afterTables;
        await connection.command(`LOCK TABLE ${[...tables].sort().join(",")} IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
        const catalog=classifyCommitCatalog(await readCommitCatalog(connection)); hostNeed(catalog===initial,"CACHE_HOST_INSPECTION_CATALOG");
        const facts=await readCommitRolloutFacts(connection); hostNeed(facts.sourceIdle&&facts.writersIdle&&facts.ownerMatches&&facts.login===facts.role,"CACHE_HOST_INSPECTION_BUSY");
        let flag:boolean|undefined;
        if(catalog==="installed") { const state=(await connection.query<{enabled:boolean;version:number;singleton:boolean;intent:boolean}>("SELECT enabled,version,singleton,EXISTS(SELECT FROM nb_cache.commit_intents) AS intent FROM nb_cache.commit_config")).rows; hostNeed(state.length===1&&state[0].version===1&&state[0].singleton===true&&state[0].intent===false,"CACHE_HOST_INSPECTION_STATE"); flag=state[0].enabled; }
        const beforeCatalog=slot!.plan.action==="install"?"legacy":"installed";
        const beforeFlag=slot!.plan.action==="install"?undefined:slot!.plan.action==="disable";
        if(catalog===beforeCatalog&&digest(facts)===slot!.plan.beforeFactsSHA256&&flag===beforeFlag)status="matches-before";
        else if(catalog==="installed"&&digest(facts)===slot!.plan.afterFactsSHA256&&flag===(slot!.plan.action==="enable"))status="matches-after";
        else status="mismatch";
        hostNeed(await connection.command("ROLLBACK")==="ROLLBACK");begun=false;await connection.close();connection=undefined;
        await verifyPins();await verifyHeld(held!.files);
        observedInspection=status;
        await hostWrite(output(operation,"inspection-state.json"),{version:1,operation,previousOperation:slot!.previousOperation,status,originalOutcomeUnchanged:true});
        if(status!=="mismatch"){await releaseHeld(held!.files);actorLocksReleased=true;}
      } finally { if(connection){if(begun)try{await connection.command("ROLLBACK");}catch{}await connection.close();} }
      final={version:1,operation,manifestSHA256,report:null,inspection:status,actorLocksReleased,transport:{...connector.metrics},budget:budget.read(),allClosed:connector.allClosed(),error:status==="mismatch"?"CACHE_HOST_INSPECTION_MISMATCH":null};
    }
    await hostWrite(output(operation,"host-final.json"),final);
    return final;
  } catch {
    canReleaseSerial=connector?.allClosed()??true;
    try { if(!await optionalJSON(stopPath))await hostWrite(stopPath,{version:1,operation,manifestSHA256}); }catch{canReleaseSerial=false;}
    if(observedReport||observedInspection){final={version:1,operation,manifestSHA256,report:observedReport,inspection:observedInspection,actorLocksReleased,
      transport:{...connector!.metrics},budget:null,allClosed:connector!.allClosed(),error:"CACHE_HOST_STOPPED"};return final;}
    throw Error("CACHE_HOST_STOPPED");
  } finally {
    connector?.clearCredentials();
    if(canReleaseSerial&&(connector?.allClosed()??true)){
      try{await releaseHeld([serial]);}catch{
        if(final){final.error="CACHE_HOST_SESSION";try{if(!await optionalJSON(stopPath))await hostWrite(stopPath,{version:1,operation,manifestSHA256});await hostWrite(output(operation,"session-release-error.json"),{version:1,error:"CACHE_HOST_SESSION"});}catch{}}
        else throw Error("CACHE_HOST_SESSION");
      }
    }
  }
}
