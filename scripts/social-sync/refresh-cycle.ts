import type { RefreshReport } from "./refresh-executor.ts";
import { SocialSyncError } from "./model.ts";

export const BILIBILI_CYCLE={batches:8,batchSize:20,durationMs:16*60000,requests:160,bytes:128*1024*1024};
export const XHS_CYCLE={batches:32,batchSize:5,durationMs:30*60000};
export interface CycleReport {
  version:1;startedAt:string;finishedAt:string|null;scopeDigest:string;configured:number;
  selected:number;remaining:string[];batches:number;uploaded:number;reviewRequired:number;
  failed:number;superseded:number;waitingBrowser:number;status:"running"|"complete"|"review-required"|"paused"|"budget"|"cancelled"|"deferred";
}
export function newCycle(keys:string[],scopeDigest:string,reviewRequired:number,at=new Date().toISOString()):CycleReport {
  if(new Set(keys).size!==keys.length||keys.length>500)throw new SocialSyncError("REFRESH_LIMIT_INVALID");
  return {version:1,startedAt:at,finishedAt:null,scopeDigest,configured:keys.length,selected:0,remaining:[...keys],batches:0,uploaded:0,reviewRequired,failed:0,superseded:0,waitingBrowser:0,status:"running"};
}
export function applyBatch(cycle:CycleReport,batch:RefreshReport,requested:string[]){
  if(batch.scopeDigest!==cycle.scopeDigest||batch.selected>requested.length||batch.entries.some(e=>!requested.includes(e.key))||new Set(batch.entries.map(e=>e.key)).size!==batch.entries.length)throw new SocialSyncError("REFRESH_CYCLE_RECEIPT_INVALID");
  cycle.batches++;cycle.selected+=batch.selected;cycle.uploaded+=batch.uploaded;cycle.failed+=batch.failed;cycle.superseded+=batch.superseded;cycle.waitingBrowser+=batch.waitingBrowser;
  const completed=batch.entries.filter(e=>e.status==="uploaded"||e.status==="review-required").map(e=>e.key);
  cycle.reviewRequired=Math.max(cycle.reviewRequired+batch.entries.filter(e=>e.status==="review-required").length,batch.reviewRequired);
  // Unselected keys became fresh/held while this cycle was between batches. Never revisit them.
  if(!batch.selected)completed.push(...requested);
  cycle.remaining=cycle.remaining.filter(k=>!completed.includes(k));
  if(batch.cancelled)cycle.status="cancelled";
  else if(batch.paused||batch.failed||batch.superseded||batch.waitingBrowser)cycle.status="paused";
  else if(cycle.remaining.length&&!completed.length)cycle.status="paused";
}
/** Freeze eligible keys at start; no new due work can prolong a cycle. */
export async function drainCycle(cycle:CycleReport,ports:{execute:(keys:string[])=>Promise<RefreshReport>;save:(report:CycleReport)=>Promise<void>},options:{budget?:typeof BILIBILI_CYCLE;signal?:AbortSignal;now?:()=>string}={}){
  const budget=options.budget??BILIBILI_CYCLE,now=options.now??(()=>new Date().toISOString());await ports.save(cycle);
  try{
    while(cycle.remaining.length&&cycle.status==="running"){
      if(options.signal?.aborted){cycle.status="cancelled";break;}
      if(cycle.batches>=budget.batches||Date.parse(now())-Date.parse(cycle.startedAt)>=budget.durationMs){cycle.status="budget";break;}
      const keys=cycle.remaining.slice(0,budget.batchSize);applyBatch(cycle,await ports.execute(keys),keys);await ports.save(cycle);
    }
    if(cycle.status==="running")cycle.status=cycle.reviewRequired?"review-required":"complete";
  }catch(error){
    if(!options.signal?.aborted&&(error as {code?:string})?.code==="BUSY")cycle.status="deferred";
    else {cycle.status=options.signal?.aborted?"cancelled":"paused";cycle.failed++;}
    throw error;
  }
  finally{cycle.finishedAt=now();await ports.save(cycle);}
  return cycle;
}
