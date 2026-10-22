import { join } from "node:path";
import { readPrivateFile } from "../notion-sync/state.ts";
import { writeJson } from "../game-sync/private.ts";
import { hash, object, SocialSyncError, timestamp } from "./model.ts";

export interface BrowserRecovery {version:1;id:string;policyDigest:string;publicationId:string;createdAt:string;expiresAt:string;status:"armed"|"spent"|"captured"|"accepted"|"failed";jobId:string|null}
export const recoveryFile=(root:string)=>join(root,"xiaohongshu-browser-notes","recovery.json");
export async function readBrowserRecovery(root:string,digest:string):Promise<BrowserRecovery|null>{
  let raw:string;try{raw=await readPrivateFile(recoveryFile(root),4096);}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return null;throw e;}
  const v=object(JSON.parse(raw));
  if(Object.keys(v).sort().join()!=="createdAt,expiresAt,id,jobId,policyDigest,publicationId,status,version"||v.version!==1||v.policyDigest!==digest||typeof v.id!=="string"||!/^[-a-f0-9]{36}$/.test(v.id)||typeof v.publicationId!=="string"||!/^[a-f0-9]{24}$/.test(v.publicationId)||
    !["armed","spent","captured","accepted","failed"].includes(String(v.status))||v.jobId!==null&&(typeof v.jobId!=="string"||!/^[-a-f0-9]{36}$/.test(v.jobId))||typeof v.createdAt!=="string"||typeof v.expiresAt!=="string")throw new SocialSyncError("XHS_BROWSER_RECOVERY_INVALID");
  const duration=Date.parse(timestamp(v.expiresAt))-Date.parse(timestamp(v.createdAt));if(duration<=0||duration>30*60000)throw new SocialSyncError("XHS_BROWSER_RECOVERY_INVALID");
  return v as unknown as BrowserRecovery;
}
export const saveBrowserRecovery=(root:string,value:BrowserRecovery)=>writeJson(recoveryFile(root),value);
/** Only bounded facts about the currently leased target; no URLs, text or raw browser state. */
export function browserTimeoutDiagnostic(raw:unknown,code:string,job:{id:string;targets:{publicationId:string}[]}|null){
  const d=object(raw),codes:Record<string,string>={"page-load":"BROWSER_PAGE_LOAD_TIMEOUT","note-state":"BROWSER_NOTE_STATE_TIMEOUT",lease:"BROWSER_LEASE_EXPIRED"};
  if(Object.keys(d).sort().join()!=="discarded,frozen,jobId,lastState,lastTabStatus,phase,polls,targetDigest,version,waitMs"||d.version!==1||!job||d.jobId!==job.id||typeof d.targetDigest!=="string"||!job.targets.some(t=>hash(t.publicationId)===d.targetDigest)||typeof d.phase!=="string"||codes[d.phase]!==code||
    !Number.isInteger(d.waitMs)||Number(d.waitMs)<0||Number(d.waitMs)>120000||!Number.isInteger(d.polls)||Number(d.polls)<0||Number(d.polls)>120||!["loading","complete","unknown"].includes(String(d.lastTabStatus))||d.lastState!==null&&d.lastState!=="NOTE_STATE_MISSING"||
    [d.frozen,d.discarded].some(v=>v!==null&&typeof v!=="boolean"))throw new SocialSyncError("XHS_BROWSER_DIAGNOSTIC_INVALID");
  return d;
}
