import { cleanupAll } from "../cleanup.ts";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { unlink } from "node:fs/promises";
import { acquireLock,privateDirectory,readPrivateFile } from "../notion-sync/state.ts";
import { writeJson } from "../game-sync/private.ts";
import { hash,object,publicationKey,SocialSyncError,timestamp } from "./model.ts";
import type { Target,XiaohongshuObservation } from "./model.ts";
import { readHttpNoteScope } from "./xiaohongshu-http-config.ts";
import { readXhsAccountPolicy,automaticNoteTarget,candidateNoteShareUrl } from "./xiaohongshu-account.ts";
import { MAX_REFRESH_CONFIG_BYTES,refreshConfig,publicationReview } from "./refresh.ts";
import { readXhsDiscoveryState } from "./xiaohongshu-discovery-bridge.ts";
import { readNoteLinkHolds } from "./xiaohongshu-link-holds.ts";
import { openStore } from "./store.ts";
import { snapshotBatch,snapshotObservation,MAX_SNAPSHOT_BYTES } from "./xiaohongshu.ts";
import { checkedNoteShareUrl } from "./xiaohongshu-http.ts";
import { recordExternalHttpPause } from "./xiaohongshu-http-cycle.ts";
import { readBrowserRecovery,saveBrowserRecovery,recoveryFile,browserTimeoutDiagnostic } from "./xiaohongshu-browser-recovery.ts";
import type { BrowserRecovery } from "./xiaohongshu-browser-recovery.ts";

interface BrowserState {version:1;policyDigest:string;status:"complete"|"capturing"|"paused";code:string|null;browserIds:string[];
  job:{id:string;expiresAt:string;targets:Target[];urls:string[]}|null;lastSubmission:{id:string;sha256:string;keys:string[]}|null}
async function readState(root:string,digest:string):Promise<BrowserState>{
  let raw:string;try{raw=await readPrivateFile(join(root,"xiaohongshu-browser-notes","state.json"),128*1024);}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return {version:1,policyDigest:digest,status:"complete",code:null,browserIds:[],job:null,lastSubmission:null};throw e;}
  const s=object(JSON.parse(raw));
  if(Object.keys(s).sort().join()!=="browserIds,code,job,lastSubmission,policyDigest,status,version"||s.version!==1||s.policyDigest!==digest||!["complete","capturing","paused"].includes(String(s.status))||
    !Array.isArray(s.browserIds)||s.browserIds.length>500||new Set(s.browserIds).size!==s.browserIds.length||s.browserIds.some(id=>typeof id!=="string"||!/^[a-f0-9]{24}$/.test(id))||
    s.code!==null&&(typeof s.code!=="string"||!/^[A-Z][A-Z_]{0,63}$/.test(s.code)))throw new SocialSyncError("XHS_BROWSER_NOTES_INVALID");
  if(s.job!==null){const j=object(s.job);if(Object.keys(j).sort().join()!=="expiresAt,id,targets,urls"||typeof j.id!=="string"||!/^[-a-f0-9]{36}$/.test(j.id)||typeof j.expiresAt!=="string"||!Array.isArray(j.targets)||j.targets.length<1||j.targets.length>3||!Array.isArray(j.urls)||j.urls.length!==j.targets.length)throw new SocialSyncError("XHS_BROWSER_NOTES_INVALID");timestamp(j.expiresAt);}
  if(s.lastSubmission!==null){const l=object(s.lastSubmission);if(Object.keys(l).sort().join()!=="id,keys,sha256"||typeof l.id!=="string"||!/^[-a-f0-9]{36}$/.test(l.id)||typeof l.sha256!=="string"||!/^[a-f0-9]{64}$/.test(l.sha256)||!Array.isArray(l.keys)||l.keys.length<1||l.keys.length>3||l.keys.some(k=>typeof k!=="string"||!/^[a-f0-9]{64}$/.test(k)))throw new SocialSyncError("XHS_BROWSER_NOTES_INVALID");}
  return s as unknown as BrowserState;
}
/** Both upload callers hold this lane's lock; never restore an entry snapshot. */
async function pauseBrowserState(root:string,digest:string,code:string){
  const state=await readState(root,digest);
  if(state.status==="paused"||(await readBrowserRecovery(root,digest))?.status==="accepted")return;
  state.status="paused";state.code=code;
  await writeJson(join(root,"xiaohongshu-browser-notes","state.json"),state);
}
/** Evidence was validated at receipt; delaying upload preserves the actual observation time. */
export async function readBrowserNoteCapture(root:string,target:Target,digest:string,at=new Date().toISOString()):Promise<XiaohongshuObservation|null>{
  let raw:string;try{raw=await readPrivateFile(join(root,"xiaohongshu-browser-notes",`${publicationKey(target)}.json`),MAX_SNAPSHOT_BYTES);}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return null;throw e;}
  const d=object(JSON.parse(raw));if(Object.keys(d).sort().join()!=="policyDigest,receivedAt,sha256,snapshot,targetKey,version"||d.version!==1||d.policyDigest!==digest||d.targetKey!==publicationKey(target)||typeof d.receivedAt!=="string"||d.sha256!==hash(JSON.stringify(d.snapshot)))throw new SocialSyncError("XHS_BROWSER_NOTES_INVALID");
  const age=Date.parse(timestamp(at))-Date.parse(timestamp(d.receivedAt));if(age < -30000)throw new SocialSyncError("SNAPSHOT_EXPIRED");if(age>=3600000)return null;
  return snapshotObservation(d.snapshot,target,d.receivedAt);
}
export async function readBrowserOnlyIds(root:string,digest:string){return (await readState(root,digest)).browserIds;}
export async function resumeBrowserNoteLane(root:string,digest:string){
  const dir=join(root,"xiaohongshu-browser-notes");await privateDirectory(dir);const release=await acquireLock(dir,randomUUID());
  try{const s=await readState(root,digest);if(s.status==="paused"){await writeJson(join(dir,`recovery-${randomUUID()}.json`),s);s.status="complete";s.code=null;s.job=null;await writeJson(join(dir,"state.json"),s);}}finally{await release();}
}
async function accountDigest(root:string){
  const base=refreshConfig(JSON.parse(await readPrivateFile(join(root,"refresh-config.json"),MAX_REFRESH_CONFIG_BYTES))),policy=await readXhsAccountPolicy(root,base);
  if(!policy?.enabled)throw new SocialSyncError("XHS_BROWSER_RECOVERY_INVALID");return hash(JSON.stringify(policy));
}
export async function armBrowserNoteRecovery(root:string,publicationId:string,at=new Date().toISOString()){
  const digest=await accountDigest(root),dir=join(root,"xiaohongshu-browser-notes"),release=await acquireLock(dir,randomUUID());
  try{
    if(await readBrowserRecovery(root,digest))throw new SocialSyncError("XHS_BROWSER_RECOVERY_EXISTS");
    const s=await readState(root,digest),current=await readHttpNoteScope(root);
    if(s.status!=="paused"||!["BROWSER_TIMEOUT","BROWSER_PAGE_LOAD_TIMEOUT","BROWSER_NOTE_STATE_TIMEOUT","BROWSER_LEASE_EXPIRED","BROWSER_RECOVERY_EXPIRED","BROWSER_RECOVERY_CANCELLED"].includes(s.code??"")||
      !current.scope.publications.some(p=>p.target.publicationId===publicationId)||!s.browserIds.includes(publicationId)&&!s.job?.targets.some(t=>t.publicationId===publicationId))throw new SocialSyncError("XHS_BROWSER_RECOVERY_INVALID");
    const ticket:BrowserRecovery={version:1,id:randomUUID(),policyDigest:digest,publicationId,createdAt:timestamp(at),expiresAt:new Date(Date.parse(at)+30*60000).toISOString(),status:"armed",jobId:null};
    await writeJson(join(dir,`before-recovery-${ticket.id}.json`),s);await saveBrowserRecovery(root,ticket);
    return {id:ticket.id,status:ticket.status,expiresAt:ticket.expiresAt,targetDigest:hash(publicationId),executed:false};
  }finally{await release();}
}
async function recoveryReceipt(root:string,ticket:BrowserRecovery,digest:string){
  const current=await readHttpNoteScope(root),target=current.scope.publications.find(p=>p.target.publicationId===ticket.publicationId)?.target;
  if(!target)throw new SocialSyncError("REFRESH_SCOPE_CHANGED");
  const release=await acquireLock(current.policy.stateDirectory,randomUUID());let store:Awaited<ReturnType<typeof openStore>>=null;
  try{
    const captured=await readBrowserNoteCapture(root,target,digest);store=await openStore(current.policy.stateDirectory,true);
    const latest=store?.latest(target);
    if(!captured||!latest||hash(JSON.stringify(latest))!==hash(JSON.stringify(captured))||!store!.acknowledgedFor(target,hash(JSON.stringify(latest))))throw new SocialSyncError("XHS_BROWSER_RECOVERY_NOT_ACKED");
    return {key:publicationKey(target),sha256:hash(JSON.stringify(latest)),observedAt:latest.observedAt};
  }finally{store?.close();await release();}
}
export async function finishBrowserNoteRecovery(root:string,id:string,readerSha256:string){
  const digest=await accountDigest(root),dir=join(root,"xiaohongshu-browser-notes"),release=await acquireLock(dir,randomUUID());
  try{
    const ticket=await readBrowserRecovery(root,digest);if(!ticket||ticket.id!==id||ticket.status!=="accepted")throw new SocialSyncError("XHS_BROWSER_RECOVERY_INVALID");
    const receipt=await recoveryReceipt(root,ticket,digest);if(receipt.sha256!==readerSha256)throw new SocialSyncError("ACK_MISMATCH");
    const s=await readState(root,digest);if(s.status!=="paused"||s.code!=="BROWSER_RECOVERY_ACCEPTED")throw new SocialSyncError("XHS_BROWSER_RECOVERY_INVALID");
    await writeJson(join(dir,`finished-recovery-${id}.json`),{ticket,receipt,finishedAt:new Date().toISOString()});
    s.status="complete";s.code=null;s.job=null;await writeJson(join(dir,"state.json"),s);await unlink(recoveryFile(root));return {status:"complete",executed:false};
  }finally{await release();}
}
export async function inspectBrowserNoteRecovery(root:string){
  const digest=await accountDigest(root),s=await readState(root,digest),ticket=await readBrowserRecovery(root,digest);
  let diagnostic:unknown=null;if(s.job)try{diagnostic=JSON.parse(await readPrivateFile(join(root,"xiaohongshu-browser-notes",`diagnostic-${s.job.id}.json`),4096));}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
  return {status:s.status,code:s.code,browserOnly:s.browserIds.length,diagnostic,recovery:ticket?{id:ticket.id,status:ticket.status,expiresAt:ticket.expiresAt,targetDigest:hash(ticket.publicationId)}:null,executed:false};
}
export async function cancelBrowserNoteRecovery(root:string,id:string){
  const digest=await accountDigest(root),dir=join(root,"xiaohongshu-browser-notes"),release=await acquireLock(dir,randomUUID());
  try{
    const ticket=await readBrowserRecovery(root,digest);if(!ticket||ticket.id!==id||["captured","accepted"].includes(ticket.status))throw new SocialSyncError("XHS_BROWSER_RECOVERY_INVALID");
    const s=await readState(root,digest);await writeJson(join(dir,`cancelled-recovery-${id}.json`),{ticket,state:s,cancelledAt:new Date().toISOString()});
    if(s.status!=="paused"){s.status="paused";s.code="BROWSER_RECOVERY_CANCELLED";await writeJson(join(dir,"state.json"),s);}await unlink(recoveryFile(root));return {status:"paused",executed:false};
  }finally{await release();}
}
/** Explicit retry of already captured evidence only; never opens a page or clears HTTP recovery. */
export async function retryBrowserNoteUpload(root:string,id:string){
  const digest=await accountDigest(root),dir=join(root,"xiaohongshu-browser-notes"),release=await acquireLock(dir,randomUUID());
  try{
    const ticket=await readBrowserRecovery(root,digest),s=await readState(root,digest),current=await readHttpNoteScope(root);
    const target=current.scope.publications.find(p=>p.target.publicationId===ticket?.publicationId)?.target;
    if(!ticket||ticket.id!==id||!["failed","captured"].includes(ticket.status)||!target||s.lastSubmission?.id!==ticket.jobId||s.lastSubmission.keys.length!==1||s.lastSubmission.keys[0]!==publicationKey(target)||!await readBrowserNoteCapture(root,target,digest))throw new SocialSyncError("XHS_BROWSER_RECOVERY_INVALID");
    ticket.status="captured";await saveBrowserRecovery(root,ticket);s.status="complete";s.code=null;await writeJson(join(dir,"state.json"),s);
    try{return await uploadBrowserNotes(root,s.lastSubmission.keys,digest);}catch(e){
      if((e as {code?:string}).code!=="BUSY"){
        const code=e instanceof SocialSyncError?e.code:"XHS_BROWSER_UPLOAD_FAILED";
        const results=await Promise.allSettled([
          (async()=>{
            const latest=await readBrowserRecovery(root,digest);
            if(!latest||latest.id!==id)throw new SocialSyncError("XHS_BROWSER_RECOVERY_INVALID");
            if(latest.status!=="accepted"){latest.status="failed";await saveBrowserRecovery(root,latest);}
          })(),
          pauseBrowserState(root,digest,code),
        ]);
        if(results[0].status==="rejected")console.error(JSON.stringify({code:"XHS_BROWSER_RECOVERY_WRITE_FAILED"}));
        if(results[1].status==="rejected")console.error(JSON.stringify({code:"XHS_BROWSER_PAUSE_WRITE_FAILED"}));
      }throw e;
    }
  }finally{await release();}
}
async function acceptRecoveryUpload(root:string,ticket:BrowserRecovery,digest:string){
  const receipt=await recoveryReceipt(root,ticket,digest);ticket.status="accepted";await saveBrowserRecovery(root,ticket);
  const s=await readState(root,digest);s.status="paused";s.code="BROWSER_RECOVERY_ACCEPTED";s.job=null;await writeJson(join(root,"xiaohongshu-browser-notes","state.json"),s);
  return {status:"paused",code:s.code,recovery:true,receipt};
}
/** Caller has prepared the cloud session and owns the HTTP cycle lock. No new sampling time. */
export async function ingestAcceptedBrowserNotes(root:string,keys:string[],digest:string){
  const current=await readHttpNoteScope(root),releases:(()=>Promise<void>)[]=[];let store:Awaited<ReturnType<typeof openStore>>=null;
  try{
    for(const path of [...new Set([root,current.policy.stateDirectory])].sort())releases.push(await acquireLock(path,randomUUID()));
    const after=await readHttpNoteScope(root);if(JSON.stringify(after.scope)!==JSON.stringify(current.scope))throw new SocialSyncError("REFRESH_SCOPE_CHANGED");
    const captures:XiaohongshuObservation[]=[];
    for(const p of current.scope.publications.filter(p=>keys.includes(publicationKey(p.target)))){const captured=await readBrowserNoteCapture(root,p.target,digest);if(!captured)continue;const decision=publicationReview(current.scope,captured);if(!decision.allowed)throw new SocialSyncError(decision.code);captures.push(captured);}
    store=await openStore(current.policy.stateDirectory);if(!store)throw new SocialSyncError("REFRESH_STATE_MISSING");store.checkTargets(current.scope.publications.map(p=>p.target));
    store.ingestBatch(captures);return captures;
  }finally{store?.close();for(const release of releases.reverse())await release();}
}
/** A leased exception lane visits only new notes and notes needing authenticated rendering. */
export async function handleXhsBrowserNotes(root:string,message:unknown,now=()=>new Date().toISOString()){
  const base=refreshConfig(JSON.parse(await readPrivateFile(join(root,"refresh-config.json"),MAX_REFRESH_CONFIG_BYTES))),policy=await readXhsAccountPolicy(root,base),msg=object(message);
  const shapes:Record<string,string>={"xiaohongshu-notes-start":"manual,op","xiaohongshu-notes-submit":"jobId,op,snapshots","xiaohongshu-notes-pause":"code,op","xiaohongshu-notes-upload":"op"};
  if(typeof msg.op!=="string"||!shapes[msg.op]||Object.keys(msg).sort().join()!==shapes[msg.op]&&!(msg.op==="xiaohongshu-notes-pause"&&Object.keys(msg).sort().join()==="code,diagnostic,op")||msg.op==="xiaohongshu-notes-start"&&typeof msg.manual!=="boolean")throw new SocialSyncError("BRIDGE_REQUEST_INVALID");
  if(!policy?.enabled)return {status:"disabled",pending:0};
  const digest=hash(JSON.stringify(policy)),dir=join(root,"xiaohongshu-browser-notes");await privateDirectory(dir);const release=await acquireLock(dir,randomUUID());
  let s:BrowserState|undefined;
  try{
    s=await readState(root,digest);const save=()=>writeJson(join(dir,"state.json"),s);
    const recovery=await readBrowserRecovery(root,digest);
    if(msg.op==="xiaohongshu-notes-upload"){if(s.status==="paused")return {status:s.status,code:s.code};return await uploadBrowserNotes(root,s.lastSubmission?.keys??[],digest);}
    if(msg.op==="xiaohongshu-notes-pause"){
      if(typeof msg.code!=="string"||!/^[A-Z][A-Z_]{0,63}$/.test(msg.code))throw new SocialSyncError("BRIDGE_REQUEST_INVALID");
      if(msg.diagnostic){const diagnostic=browserTimeoutDiagnostic(msg.diagnostic,msg.code,s.job);await writeJson(join(dir,`diagnostic-${s.job!.id}.json`),{...diagnostic,code:msg.code,recordedAt:now(),policyDigest:digest});}
      s.status="paused";s.code=msg.code;await save();if(recovery){recovery.status="failed";await saveBrowserRecovery(root,recovery);}return {status:s.status,code:s.code};
    }
    const current=await readHttpNoteScope(root),directory=await readXhsDiscoveryState(root,digest),holds=await readNoteLinkHolds(root),pending=directory?.queue??[];
    const byId=new Map(current.scope.publications.map(p=>[p.target.publicationId,p.target]));
    for(const id of pending)if(!byId.has(id))byId.set(id,automaticNoteTarget(policy.accountId,id));
    const urls=new Map(current.links);for(const l of directory?.links??[])if(!urls.has(l.publicationId)){const target=byId.get(l.publicationId);if(target)urls.set(l.publicationId,candidateNoteShareUrl(l.url,target));}
    if(msg.op==="xiaohongshu-notes-start"){
      if(recovery&&recovery.status!=="armed")return recovery.status==="captured"?{status:"captured",pending:0,recovery:true}:{status:"paused",code:s.code??"BROWSER_RECOVERY_SPENT",recovery:true};
      if(recovery&&recovery.expiresAt<=now()){recovery.status="failed";await saveBrowserRecovery(root,recovery);s.status="paused";s.code="BROWSER_RECOVERY_EXPIRED";await save();return {status:s.status,code:s.code};}
      if(s.status==="paused"&&msg.manual!==true&&!recovery)return {status:s.status,code:s.code};
      if(s.job&&s.job.expiresAt>now()&&!recovery){
        for(const [i,t] of s.job.targets.entries()){const actual=byId.get(t.publicationId);if(!actual||JSON.stringify(actual)!==JSON.stringify(t))throw new SocialSyncError("XHS_BROWSER_NOTES_INVALID");checkedNoteShareUrl(s.job.urls[i],actual);}
        return {status:"capturing",job:{...s.job,targets:s.job.targets.map((t,i)=>({publicationId:t.publicationId,accountId:t.accountId,url:s!.job!.urls[i],requireShareable:true}))}};
      }
      const heldIds=holds.map(h=>current.scope.publications.find(p=>publicationKey(p.target)===h.key)?.target.publicationId).filter((id):id is string=>!!id);
      const candidates=[...new Set([...pending,...s.browserIds,...heldIds])].filter(id=>byId.has(id));
      const sourceRelease=await acquireLock(current.policy.stateDirectory,randomUUID());let store:Awaited<ReturnType<typeof openStore>>=null;let ids:string[]=[];
      try{store=await openStore(current.policy.stateDirectory,true);if(!store)throw new SocialSyncError("REFRESH_STATE_MISSING");
        for(const id of candidates){const target=byId.get(id)!,latest=store.latest(target),capture=await readBrowserNoteCapture(root,target,digest,now());
          if((!latest||Date.parse(now())-Date.parse(latest.observedAt)>=3600000)&&(!capture||latest&&capture.observedAt<=latest.observedAt))ids.push(id);
        }
      }finally{store?.close();await sourceRelease();}
      if(!ids.length){s.status="complete";s.code=null;s.job=null;await save();return {status:"complete",pending:0};}
      const selected=recovery?ids.filter(id=>id===recovery.publicationId):ids.slice(0,3);
      if(recovery&&selected.length!==1)throw new SocialSyncError("XHS_BROWSER_RECOVERY_INVALID");if(selected.some(id=>!urls.has(id)))throw new SocialSyncError("XHS_HTTP_LINK_INVALID");
      s.status="capturing";s.code=null;s.job={id:randomUUID(),expiresAt:new Date(Date.parse(now())+2*60000).toISOString(),targets:selected.map(id=>byId.get(id)!),urls:selected.map(id=>urls.get(id)!)};await save();
      if(recovery){recovery.status="spent";recovery.jobId=s.job.id;await saveBrowserRecovery(root,recovery);}
      return {status:"capturing",pending:ids.length,job:{id:s.job.id,expiresAt:s.job.expiresAt,targets:s.job.targets.map((t,i)=>({publicationId:t.publicationId,accountId:t.accountId,url:s!.job!.urls[i],requireShareable:true}))}};
    }
    if(typeof msg.jobId!=="string"||!/^[-a-f0-9]{36}$/.test(msg.jobId))throw new SocialSyncError("BRIDGE_REQUEST_INVALID");
    if(!Array.isArray(msg.snapshots)||msg.snapshots.some(v=>!v||typeof v!=="object"||Array.isArray(v)))throw new SocialSyncError("BRIDGE_REQUEST_INVALID");
    const raw=JSON.stringify({version:1,snapshots:msg.snapshots}),sha=hash(raw),last=s.lastSubmission;
    if(last&&last.id===msg.jobId){if(last.sha256!==sha)throw new SocialSyncError("BRIDGE_JOB_REPLAY_CHANGED");return {status:"captured",pending:0};}
    if(s.status!=="capturing"||!s.job||s.job.id!==msg.jobId||s.job.expiresAt<now())throw new SocialSyncError("BRIDGE_JOB_EXPIRED");
    if(recovery&&(recovery.status!=="spent"||recovery.jobId!==msg.jobId||s.job.targets.length!==1||s.job.targets[0].publicationId!==recovery.publicationId))throw new SocialSyncError("XHS_BROWSER_RECOVERY_INVALID");
    const targets=s.job.targets.map(t=>{const actual=byId.get(t.publicationId);if(!actual||JSON.stringify(actual)!==JSON.stringify(t)||t.accountId!==policy.accountId)throw new SocialSyncError("REFRESH_SCOPE_CHANGED");return actual;});
    const rows=snapshotBatch(raw,targets,now());if(rows.length!==targets.length)throw new SocialSyncError("BRIDGE_JOB_INCOMPLETE");
    if(!Array.isArray(msg.snapshots))throw new SocialSyncError("BRIDGE_REQUEST_INVALID");
    for(const snapshot of msg.snapshots){const id=object(object(snapshot).note).noteId,target=targets.find(t=>t.publicationId===id)!;
      await writeJson(join(dir,`${publicationKey(target)}.json`),{version:1,policyDigest:digest,targetKey:publicationKey(target),receivedAt:now(),snapshot,sha256:hash(JSON.stringify(snapshot))});
    }
    s.browserIds=[...new Set([...s.browserIds,...rows.filter(r=>holds.some(h=>h.key===publicationKey(r))).map(r=>r.publicationId)])];s.status="complete";s.code=null;s.lastSubmission={id:msg.jobId,sha256:sha,keys:rows.map(publicationKey)};s.job=null;await save();if(recovery){recovery.status="captured";await saveBrowserRecovery(root,recovery);}return {status:"captured",captured:rows.length,pending:0};
  }catch(e){if((e as {code?:string}).code==="BUSY")return {status:s?.status??"complete",deferred:true};throw e;}finally{await release();}
}
async function uploadBrowserNotes(root:string,keys:string[],digest:string){
  const {runXhsDiscovery}=await import("./xiaohongshu-discovery-worker.ts"),{CycleCloudSession}=await import("./cycle-cloud.ts"),{executeAtRoot}=await import("./execute-cli.ts");
  await privateDirectory(join(root,"cycle-xiaohongshu-http"));const release=await acquireLock(join(root,"cycle-xiaohongshu-http"),randomUUID());
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),90000);timer.unref();let cloud:InstanceType<typeof CycleCloudSession>|undefined;
  let scopeDigest:string|undefined,failed=false;
  const pause=async(code:string,stage:"upload"|"close")=>{
    // Both callers already own the browser-state lock. Reload after child work
    // so an accepted recovery or a newer pause is never replaced by stale state.
    const results=await Promise.allSettled([
      recordExternalHttpPause(root,scopeDigest??"0".repeat(64),code,stage),
      pauseBrowserState(root,digest,code),
    ]);
    if(results[0].status==="rejected")console.error(JSON.stringify({code:"XHS_HTTP_PAUSE_WRITE_FAILED"}));
    if(results[1].status==="rejected")console.error(JSON.stringify({code:"XHS_BROWSER_PAUSE_WRITE_FAILED"}));
  };
  try{
    const recovery=await readBrowserRecovery(root,digest);if(recovery&&recovery.status!=="captured")return {status:"paused",code:"BROWSER_RECOVERY_SPENT",pending:0};
    const enrolled=recovery?{state:"complete",uploaded:0,pending:0}:await runXhsDiscovery(root,controller.signal),current=await readHttpNoteScope(root),targets=current.scope.publications.filter(p=>keys.includes(publicationKey(p.target))).map(p=>p.target),captures:XiaohongshuObservation[]=[];
    scopeDigest=hash(JSON.stringify(current.scope));
    if(recovery&&(targets.length!==1||targets[0].publicationId!==recovery.publicationId))throw new SocialSyncError("XHS_BROWSER_RECOVERY_INVALID");
    const sourceRelease=await acquireLock(current.policy.stateDirectory,randomUUID());let store:Awaited<ReturnType<typeof openStore>>=null,readFailed=false;
    try{store=await openStore(current.policy.stateDirectory,true);if(!store)throw new SocialSyncError("REFRESH_STATE_MISSING");
      for(const target of targets){const captured=await readBrowserNoteCapture(root,target,digest);if(!captured)continue;const latest=store.latest(target);if(!latest||captured.observedAt>latest.observedAt)captures.push(captured);}
    }catch(e){readFailed=true;throw e;}finally{
      const complete=await cleanupAll([()=>store?.close(),sourceRelease]);
      if(!complete&&!readFailed)throw new SocialSyncError("XHS_BROWSER_CLOSE_FAILED");
    }
    if(!captures.length)return recovery?{...await acceptRecoveryUpload(root,recovery,digest),uploaded:0,pending:0}:{status:enrolled.state,uploaded:enrolled.uploaded,pending:enrolled.pending};
    const base=refreshConfig(JSON.parse(await readPrivateFile(join(root,"refresh-config.json"),MAX_REFRESH_CONFIG_BYTES))),policy=(await readXhsAccountPolicy(root,base))!,directory=await readXhsDiscoveryState(root,digest),raw=await readPrivateFile(join(root,"cloud.env"),65536);
    cloud=new CycleCloudSession(controller.signal,undefined,{httpNotes:true,xhsAccount:{accountId:policy.accountId,link:item=>{const l=directory?.links.find(l0=>l0.publicationId===item.observation.publicationId);return l?{url:candidateNoteShareUrl(l.url,automaticNoteTarget(policy.accountId,l.publicationId)),checkedAt:item.observation.observedAt}:null;}}});
    await cloud.preparePublications(raw,scopeDigest,controller.signal);
    await ingestAcceptedBrowserNotes(root,captures.map(publicationKey),digest);
    const report=await executeAtRoot(root,{platform:"xiaohongshu",limit:3,keys:captures.map(publicationKey),uploadOnly:true,scopeDigest,scopeProvider:async()=>(await readHttpNoteScope(root)).scope,cloudSession:cloud,signal:controller.signal,collectHttpNote:async()=>{throw new SocialSyncError("BROWSER_SNAPSHOT_REQUIRED");}});
    if(!("entries" in report))throw new SocialSyncError("REFRESH_CYCLE_RECEIPT_INVALID");
    if(report.paused||report.failed||report.cancelled||report.superseded)throw new SocialSyncError(report.entries.find(e=>e.status==="failed")?.code??"XHS_BROWSER_UPLOAD_FAILED");
    if(recovery)return {...await acceptRecoveryUpload(root,recovery,digest),uploaded:report.uploaded,pending:0};
    return {status:"complete",uploaded:enrolled.uploaded+report.uploaded,pending:enrolled.pending,code:null};
  }catch(e){
    failed=true;
    const code=e instanceof SocialSyncError?e.code:"XHS_BROWSER_UPLOAD_FAILED";
    if((e as {code?:string})?.code!=="BUSY")try{await pause(code,"upload");}catch{/* Preserve the upload failure. */}
    throw e;
  }finally{
    clearTimeout(timer);
    const complete=await cleanupAll([async()=>{
      try{await cloud?.close();}catch(e){
        try{if(!failed)await pause(e instanceof SocialSyncError?e.code:"XHS_BROWSER_CLOSE_FAILED","close");}catch{/* Release the lock even if the pause receipt cannot be written. */}
        throw e;
      }
    },release]);
    if(!complete&&!failed)throw new SocialSyncError("XHS_BROWSER_CLOSE_FAILED");
  }
}
