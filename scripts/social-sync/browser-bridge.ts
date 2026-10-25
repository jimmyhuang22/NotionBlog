import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { acquireLock,privateDirectory,readPrivateFile } from "../notion-sync/state.ts";
import { writeJson } from "../game-sync/private.ts";
import { hash,publicationKey,SocialSyncError } from "./model.ts";
import { snapshotBatch,MAX_SNAPSHOT_BYTES } from "./xiaohongshu.ts";
import { inspectRefresh } from "./refresh-state.ts";
import { MAX_REFRESH_CONFIG_BYTES,refreshConfig } from "./refresh.ts";
import { executeAtRoot } from "./execute-cli.ts";
import { applyBatch,newCycle,XHS_CYCLE } from "./refresh-cycle.ts";
import type { CycleReport } from "./refresh-cycle.ts";
import type { RootExecutionOptions } from "./execute-cli.ts";
import type { RefreshReport } from "./refresh-executor.ts";
import { handleBilibiliDiscovery } from "./bilibili-discovery-bridge.ts";
import { readHttpNotePolicy } from "./xiaohongshu-http-config.ts";
import { handleXhsDiscovery } from "./xiaohongshu-discovery-bridge.ts";
import { readXhsAccountPolicy } from "./xiaohongshu-account.ts";
import { handleXhsBrowserNotes } from "./xiaohongshu-browser-notes.ts";

export const NATIVE_HOST="com.notionblog.social_refresh";
export const validOrigin=(value:unknown):value is string=>typeof value==="string"&&/^chrome-extension:\/\/[a-p]{32}\/$/.test(value);
type Job={id:string;expiresAt:string;keys:string[];expected:Record<string,string|null>;captureRaw?:string};
type BridgeState={version:1;cycleId:string;cycle:CycleReport;job:Job|null;lastJob:{id:string;sha:string;response:unknown}|null};
const summary=(s:BridgeState)=>({cycleId:s.cycleId,status:s.cycle.status,batches:s.cycle.batches,uploaded:s.cycle.uploaded,remaining:s.cycle.remaining.length,reviewRequired:s.cycle.reviewRequired});
function exact(value:unknown,keys:string[]):Record<string,unknown>{
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).sort().join()!==keys.sort().join())throw new SocialSyncError("BRIDGE_REQUEST_INVALID");return value as Record<string,unknown>;
}
async function optional(path:string){try{return JSON.parse(await readPrivateFile(path,MAX_SNAPSHOT_BYTES*2));}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return null;throw e;}}
export function browserLinks(value:unknown,targets:{publicationId:string}[]):Map<string,string>{
  const row=exact(value,["version","links"]);if(row.version!==1||!Array.isArray(row.links)||row.links.length!==targets.length)throw new SocialSyncError("BRIDGE_LINKS_INVALID");
  const result=new Map<string,string>();
  for(const input of row.links){const r=exact(input,["publicationId","url"]);if(typeof r.url!=="string"||typeof r.publicationId!=="string")throw new SocialSyncError("BRIDGE_LINKS_INVALID");
    const url=new URL(r.url),match=/^\/(?:explore|discovery\/item)\/([a-f0-9]{24})\/?$/.exec(url.pathname);
    if(r.url.length>4096||url.protocol!=="https:"||url.hostname!=="www.xiaohongshu.com"||url.port||url.username||url.password||url.hash||!match||match[1]!==r.publicationId||!targets.some(t=>t.publicationId===r.publicationId)||result.has(r.publicationId))throw new SocialSyncError("BRIDGE_LINKS_INVALID");
    result.set(r.publicationId,r.url);
  }return result;
}
/** Only the pinned extension can start a fixed-scope job. No paths, scripts or credentials in messages. */
export async function handleBrowserMessage(root:string,origin:string,message:unknown,ports:{signal?:AbortSignal;now?:()=>string;execute?:(options:RootExecutionOptions)=>Promise<RefreshReport>}={}){
  ports.signal?.throwIfAborted();
  await privateDirectory(root);
  const config=exact(JSON.parse(await readPrivateFile(join(root,"bridge-config.json"),4096)),["version","origin","enabled"]);
  if(config.version!==1||!validOrigin(config.origin)||config.origin!==origin||typeof config.enabled!=="boolean")throw new SocialSyncError("BRIDGE_ORIGIN_REJECTED");
  const msg=message as Record<string,unknown>,op=msg?.op;
  if(op==="settings"){
    exact(message,["op"]);
    // A broken XHS sidecar cannot disable Bilibili, and cannot silently restart browser capture.
    let xiaohongshuEnabled=false;
    try{xiaohongshuEnabled=!(await readHttpNotePolicy(root))?.enabled;}catch{}
    let xiaohongshuDiscovery=false;
    try{const base=refreshConfig(JSON.parse(await readPrivateFile(join(root,"refresh-config.json"),MAX_REFRESH_CONFIG_BYTES)));xiaohongshuDiscovery=(await readXhsAccountPolicy(root,base))?.enabled===true;}catch{}
    return {enabled:config.enabled,periodMinutes:15,cadenceHours:24,...(!xiaohongshuEnabled?{xiaohongshuEnabled:false}:{}),...(xiaohongshuDiscovery?{xiaohongshuDiscovery:true}:{})};
  }
  if(!config.enabled)throw new SocialSyncError("BRIDGE_DISABLED");
  if(typeof op==="string"&&op.startsWith("bilibili-"))return handleBilibiliDiscovery(root,message);
  if(typeof op==="string"&&op.startsWith("xiaohongshu-notes-"))return handleXhsBrowserNotes(root,message,ports.now);
  if(typeof op==="string"&&op.startsWith("xiaohongshu-"))return handleXhsDiscovery(root,message,ports.now);
  if((await readHttpNotePolicy(root))?.enabled){
    if(!["start","next","submit","pause"].includes(String(op)))throw new SocialSyncError("BRIDGE_REQUEST_INVALID");
    return {status:"http-managed",cycleId:null,batches:0,uploaded:0,remaining:0,reviewRequired:0};
  }
  const dir=join(root,"cycle-xiaohongshu"),release=await acquireLock(dir,randomUUID()),now=ports.now??(()=>new Date().toISOString());
  const file=join(dir,"latest-cycle.json");
  let state:BridgeState|null=null;
  const save=async()=>{await writeJson(file,state);if(state?.cycle.status==="complete"&&state.cycle.finishedAt)await writeJson(join(dir,"last-successful-cycle.json"),state);};
  try{
    ports.signal?.throwIfAborted();
    state=await optional(file);
    if(op==="start"){
      exact(message,Object.hasOwn(msg,"manual")?["op","manual"]:["op"]);
      if(Object.hasOwn(msg,"manual")&&typeof msg.manual!=="boolean")throw new SocialSyncError("BRIDGE_REQUEST_INVALID");
      if(state&&["paused","cancelled"].includes(state.cycle.status)&&msg.manual!==true)return summary(state);
      if(state?.cycle.status==="running"&&Date.parse(now())-Date.parse(state.cycle.startedAt)<XHS_CYCLE.durationMs)return summary(state);
      const current=await inspectRefresh(root,"xiaohongshu",now());
      state={version:1,cycleId:randomUUID(),cycle:newCycle(current.keys,current.scopeDigest,current.reviewRequired,now()),job:null,lastJob:null};await save();return summary(state);
    }
    if(!state||state.version!==1)throw new SocialSyncError("BRIDGE_CYCLE_MISSING");
    if(op==="pause"){
      const r=exact(message,["op","cycleId","code"]);if(r.cycleId!==state.cycleId||!(["BROWSER_REQUIRED","SOURCE_BLOCKED","IDENTITY_MISMATCH","BROWSER_TIMEOUT","BRIDGE_DISCONNECTED"] as unknown[]).includes(r.code))throw new SocialSyncError("BRIDGE_REQUEST_INVALID");
      state.cycle.status="paused";state.cycle.finishedAt=now();state.job=null;await save();return summary(state);
    }
    if(op!=="next"&&op!=="submit")throw new SocialSyncError("BRIDGE_REQUEST_INVALID");
    exact(message,op==="next"?["op","cycleId"]:["op","cycleId","jobId","snapshots"]);
    if(msg.cycleId!==state.cycleId)throw new SocialSyncError("BRIDGE_CYCLE_MISMATCH");
    // Cache a confirmed job's exact response: loss of the native reply cannot recapture/re-ingest it.
    const payload=op==="submit"?JSON.stringify({version:1,snapshots:msg.snapshots}):null;
    if(payload&&Buffer.byteLength(payload)>MAX_SNAPSHOT_BYTES)throw new SocialSyncError("SNAPSHOT_TOO_LARGE");
    const last=state.lastJob;
    if(op==="submit"&&last&&last.id===msg.jobId){if(hash(payload!)!==last.sha)throw new SocialSyncError("BRIDGE_JOB_REPLAY_CHANGED");return last.response;}
    if(state.cycle.status!=="running")return summary(state);
    if(Date.parse(now())-Date.parse(state.cycle.startedAt)>=XHS_CYCLE.durationMs||state.cycle.batches>=XHS_CYCLE.batches){state.cycle.status="budget";state.cycle.finishedAt=now();state.job=null;await save();return summary(state);}
    // Persist only a fully validated, leased projection before competing for the shared source lock.
    // Chrome stores no snapshot: next can submit this same SSD packet without reopening a page.
    if(op==="submit"){
      const job=state.job;
      if(!job||msg.jobId!==job.id||Date.parse(job.expiresAt)<Date.parse(now()))throw new SocialSyncError("BRIDGE_JOB_EXPIRED");
      const scope=refreshConfig(JSON.parse(await readPrivateFile(join(root,"refresh-config.json"),MAX_REFRESH_CONFIG_BYTES)));
      if(hash(JSON.stringify(scope))!==state.cycle.scopeDigest)throw new SocialSyncError("REFRESH_SCOPE_CHANGED");
      const targets=scope.publications.filter(p=>job.keys.includes(publicationKey(p.target))).map(p=>p.target);
      if(snapshotBatch(payload!,targets,now()).length!==job.keys.length)throw new SocialSyncError("BRIDGE_JOB_INCOMPLETE");
      if(job.captureRaw&&hash(job.captureRaw)!==hash(payload!))throw new SocialSyncError("BRIDGE_JOB_REPLAY_CHANGED");
      job.captureRaw=payload!;await save();
    }
    const current=await inspectRefresh(root,"xiaohongshu",now());
    if(current.scopeDigest!==state.cycle.scopeDigest)throw new SocialSyncError("REFRESH_SCOPE_CHANGED");
    const active=state;
    const submitSaved=async(job:Job,raw:string)=>{
      const targets=current.scope.publications.filter(p=>job.keys.includes(publicationKey(p.target))).map(p=>p.target),captures=snapshotBatch(raw,targets,now());
      if(captures.length!==job.keys.length)throw new SocialSyncError("BRIDGE_JOB_INCOMPLETE");
      for(const k of job.keys)if(current.entries.find(e=>e.key===k)?.snapshotSha256!==job.expected[k])throw new SocialSyncError("REFRESH_SOURCE_CHANGED");
      const result=await (ports.execute??(async o=>await executeAtRoot(root,o) as RefreshReport))({signal:ports.signal,platform:"xiaohongshu",limit:5,keys:job.keys,captures,scopeDigest:current.scopeDigest,expectedSnapshots:job.expected});
      applyBatch(active.cycle,result,job.keys);active.job=null;
      if(!active.cycle.remaining.length&&active.cycle.status==="running"){active.cycle.status=active.cycle.reviewRequired?"review-required":"complete";active.cycle.finishedAt=now();}
      const response=summary(active);active.lastJob={id:job.id,sha:hash(raw),response};await save();return response;
    };
    if(state.job?.captureRaw&&Date.parse(state.job.expiresAt)>=Date.parse(now()))return await submitSaved(state.job,state.job.captureRaw);
    if(op==="next"){
      const held=new Set(current.entries.filter(e=>e.held).map(e=>e.key));
      const skipped=state.cycle.remaining.filter(k=>held.has(k));state.cycle.reviewRequired+=skipped.length;
      state.cycle.remaining=state.cycle.remaining.filter(k=>!held.has(k)&&current.keys.includes(k));
      if(!state.cycle.remaining.length){state.cycle.status=state.cycle.reviewRequired?"review-required":"complete";state.cycle.finishedAt=now();state.job=null;await save();return summary(state);}
      // Already persisted, recent pending samples are sent without reopening their pages.
      const pending=state.cycle.remaining.filter(k=>{const e=current.entries.find(e=>e.key===k)!;return e.pending&&e.status==="fresh";}).slice(0,XHS_CYCLE.batchSize);
      if(pending.length){const result=await (ports.execute??(async o=>await executeAtRoot(root,o) as RefreshReport))({signal:ports.signal,platform:"xiaohongshu",limit:5,keys:pending,captures:[],uploadOnly:true,scopeDigest:current.scopeDigest});applyBatch(state.cycle,result,pending);await save();return {...summary(state),resumed:result.resumed};}
      if(!state.job||Date.parse(state.job.expiresAt)<Date.parse(now())){
        const keys=state.cycle.remaining.slice(0,XHS_CYCLE.batchSize),expected=Object.fromEntries(keys.map(k=>[k,current.entries.find(e=>e.key===k)!.snapshotSha256]));
        state.job={id:randomUUID(),expiresAt:new Date(Date.parse(now())+5*60000).toISOString(),keys,expected};await save();
      }
      const targets=state.job.keys.map(k=>current.scope.publications.find(p=>publicationKey(p.target)===k)!.target);
      const links=browserLinks(JSON.parse(await readPrivateFile(join(root,"browser-links.json"),128*1024)),current.scope.publications.filter(p=>p.target.platform==="xiaohongshu").map(p=>p.target));
      return {...summary(state),job:{id:state.job.id,expiresAt:state.job.expiresAt,targets:targets.map(t=>({publicationId:t.publicationId,accountId:t.accountId,url:links.get(t.publicationId)!}))}};
    }
    throw new SocialSyncError("BRIDGE_JOB_EXPIRED");
  }catch(error){
    if((error as {code?:string})?.code==="BUSY"&&state?.cycle.status==="running")return {...summary(state),deferred:true};
    if(state&&error instanceof SocialSyncError&&["REFRESH_SCOPE_CHANGED","REFRESH_SOURCE_CHANGED","BRIDGE_JOB_EXPIRED"].includes(error.code)){state.cycle.status="paused";state.cycle.finishedAt=now();await save();}throw error;
  }finally{await release();}
}
