import {join, resolve} from "node:path";

export const ROLLING_LIMITS = Object.freeze({attempts:8,runs:16,returnedBytes:64*1024*1024,deleteCalls:750,deletedRows:250_000});
export const ROLLING_PERIOD = 24*60*60*1000;
export interface Usage {runs:number;returnedBytes:number;deleteCalls:number;deletedRows:number}
export interface Reservation {id:string;sourceRunId:string;at:number;reserved:Usage;status:"RUNNING"|"PASS";finishedAt?:number;usage?:Usage}
export interface RollingLedger {
 format:"retention-rolling-ledger-v1";stateDirectory:string;archiveDirectory:string;updatedAt:number;
 seenSourceRuns:string[];entries:Reservation[];
}
const keys = ["runs","returnedBytes","deleteCalls","deletedRows"] as const;
const uuid = (x:unknown):x is string => typeof x==="string"&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x);
const integer = (n:unknown):n is number => typeof n==="number"&&Number.isSafeInteger(n)&&n>=0;
const reject = ():never => {throw Error("RETENTION_ROLLING_LEDGER_INVALID");};
export const rollingLedgerPath = (archive:string) => join(archive,"ROLLING_LEDGER_PRIVATE.json");
/** Pure construction only. Installation must explicitly reconcile and create this file;
 * neither the scheduler nor the child creates a missing ledger or resets STOPPED. */
export function initialRollingLedger(stateDirectory:string,archiveDirectory:string,at:number):RollingLedger {
 return {format:"retention-rolling-ledger-v1",stateDirectory,archiveDirectory,updatedAt:at,seenSourceRuns:[],entries:[]};
}
export function validateRollingLedger(value:RollingLedger,state:string,archive:string,at:number) {
 if(!value||value.format!=="retention-rolling-ledger-v1"||!integer(at)||!integer(value.updatedAt)||at<value.updatedAt||
  value.stateDirectory!==state||value.archiveDirectory!==archive||![state,archive].every(p=>p.startsWith("/")&&resolve(p)===p)||
  !Array.isArray(value.seenSourceRuns)||value.seenSourceRuns.length>20_000||!value.seenSourceRuns.every(uuid)||
  new Set(value.seenSourceRuns).size!==value.seenSourceRuns.length||!Array.isArray(value.entries)||value.entries.length>8)reject();
 const ids=new Set<string>(),sources=new Set<string>();
 for(const e of value.entries){
  if(!e||!uuid(e.id)||!uuid(e.sourceRunId)||ids.has(e.id)||sources.has(e.sourceRunId)||!value.seenSourceRuns.includes(e.sourceRunId)||
   !integer(e.at)||e.at>value.updatedAt||!["RUNNING","PASS"].includes(e.status)||!e.reserved)reject();
  ids.add(e.id);sources.add(e.sourceRunId);
  for(const k of keys)if(!integer(e.reserved[k])||e.reserved[k]<1||e.reserved[k]>ROLLING_LIMITS[k])reject();
  if(e.reserved.runs>2||e.reserved.returnedBytes>32*1024*1024)reject();
  if(e.status==="PASS"){
   if(!integer(e.finishedAt)||e.finishedAt<e.at||e.finishedAt>value.updatedAt||!e.usage)reject();
   for(const k of keys)if(!integer(e.usage![k])||e.usage![k]>e.reserved[k])reject();
  }else if(e.finishedAt!==undefined||e.usage!==undefined)reject();
 }
 return value;
}
function activeEntries(ledger:RollingLedger,at:number){
 return ledger.entries.filter(e=>e.status!=="PASS"||e.finishedAt!>at-ROLLING_PERIOD);
}
export function rollingAdmission(ledger:RollingLedger,sourceRunId:string,at:number,maximumRuns:number){
 validateRollingLedger(ledger,ledger.stateDirectory,ledger.archiveDirectory,at);
 if(!uuid(sourceRunId)||![1,2].includes(maximumRuns))reject();
 if(ledger.entries.some(e=>e.status!=="PASS"))return {status:"REQUIRES_REVIEW"} as const;
 if(ledger.seenSourceRuns.includes(sourceRunId))return {status:"SOURCE_ALREADY_PROCESSED"} as const;
 if(ledger.seenSourceRuns.length>=20_000)return {status:"REQUIRES_REVIEW"} as const;
 const entries=activeEntries(ledger,at),remaining:Usage={runs:16,returnedBytes:64*1024*1024,deleteCalls:750,deletedRows:250_000};
 for(const e of entries)for(const k of keys)remaining[k]-=e.usage![k];
 if(entries.length>=8||remaining.returnedBytes<4096||keys.some(k=>remaining[k]<1))return {status:"ROLLING_BUDGET_EXHAUSTED"} as const;
 return {status:"READY",reserved:{runs:Math.min(maximumRuns,remaining.runs),returnedBytes:Math.min(32*1024*1024,remaining.returnedBytes),
  deleteCalls:remaining.deleteCalls,deletedRows:remaining.deletedRows}} as const;
}
export function reserveRolling(ledger:RollingLedger,sourceRunId:string,id:string,at:number,maximumRuns:number):RollingLedger {
 const admission=rollingAdmission(ledger,sourceRunId,at,maximumRuns);
 if(admission.status!=="READY"||!uuid(id)||ledger.entries.some(e=>e.id===id))throw Error("RETENTION_ROLLING_NOT_ADMITTED");
 return {...ledger,updatedAt:at,seenSourceRuns:[...ledger.seenSourceRuns,sourceRunId],
  entries:[...activeEntries(ledger,at),{id,sourceRunId,at,status:"RUNNING",reserved:admission.reserved}]};
}
/** Only a verified, closed child and released owned locks may call settlement.
 * An absent/unknown receipt leaves the RUNNING reservation charged indefinitely. */
export function settleRolling(ledger:RollingLedger,id:string,usage:Usage,at:number):RollingLedger {
 validateRollingLedger(ledger,ledger.stateDirectory,ledger.archiveDirectory,at);
 const entry=ledger.entries.find(e=>e.id===id&&e.status==="RUNNING");
 if(!entry||keys.some(k=>!integer(usage[k])||usage[k]>entry.reserved[k]))throw Error("RETENTION_ROLLING_USAGE_INVALID");
 return {...ledger,updatedAt:at,entries:ledger.entries.map(e=>e===entry?{...e,status:"PASS",finishedAt:at,usage:{...usage}}:e)};
}
