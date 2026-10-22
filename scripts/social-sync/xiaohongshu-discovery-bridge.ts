import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { acquireLock, privateDirectory, readPrivateFile } from "../notion-sync/state.ts";
import { writeJson } from "../game-sync/private.ts";
import { hash, object, SocialSyncError, timestamp } from "./model.ts";
import { MAX_REFRESH_CONFIG_BYTES, refreshConfig } from "./refresh.ts";
import { readXhsAccountPolicy, readXhsDiscoveredScope, xhsDirectory } from "./xiaohongshu-account.ts";
import type { XhsDirectoryCard } from "./xiaohongshu-account.ts";

export interface DirectoryLink extends XhsDirectoryCard { observedAt:string }
export interface XhsDiscoveryState {
  version:1;policyDigest:string;status:"capturing"|"complete"|"paused";checkedAt:string|null;code:string|null;
  job:{id:string;accountId:string;expiresAt:string;knownIds:string[]}|null;
  links:DirectoryLink[];queue:string[];lastSubmission:{id:string;sha256:string}|null;
}
export async function readXhsDiscoveryState(root:string,digest:string):Promise<XhsDiscoveryState|null>{
  let raw:string;try{raw=await readPrivateFile(join(root,"discovery-xiaohongshu","state.json"),512*1024);}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return null;throw e;}
  const s=object(JSON.parse(raw));
  if(Object.keys(s).sort().join()!=="checkedAt,code,job,lastSubmission,links,policyDigest,queue,status,version"||s.version!==1||s.policyDigest!==digest||
    !["capturing","complete","paused"].includes(String(s.status))||!Array.isArray(s.links)||s.links.length>500||!Array.isArray(s.queue)||s.queue.length>500||
    s.queue.some(id=>typeof id!=="string"||!/^[a-f0-9]{24}$/.test(id))||new Set(s.queue).size!==s.queue.length||
    s.checkedAt!==null&&typeof s.checkedAt!=="string"||s.code!==null&&(typeof s.code!=="string"||!/^[A-Z][A-Z_]{0,63}$/.test(s.code)))throw new SocialSyncError("XHS_DISCOVERY_STATE_INVALID");
  if(s.checkedAt!==null)timestamp(s.checkedAt as string);
  const ids=new Set<string>();for(const rawLink of s.links){const l=object(rawLink);if(Object.keys(l).sort().join()!=="observedAt,publicationId,url"||typeof l.publicationId!=="string"||!/^[a-f0-9]{24}$/.test(l.publicationId)||ids.has(l.publicationId)||typeof l.url!=="string"||l.url.length>4096||typeof l.observedAt!=="string")throw new SocialSyncError("XHS_DISCOVERY_STATE_INVALID");timestamp(l.observedAt);ids.add(l.publicationId);}
  if(s.queue.some(id=>!ids.has(id as string)))throw new SocialSyncError("XHS_DISCOVERY_STATE_INVALID");
  if(s.job!==null){const j=object(s.job);if(Object.keys(j).sort().join()!=="accountId,expiresAt,id,knownIds"||typeof j.id!=="string"||!/^[-a-f0-9]{36}$/.test(j.id)||typeof j.accountId!=="string"||!/^[a-f0-9]{24}$/.test(j.accountId)||typeof j.expiresAt!=="string"||!Array.isArray(j.knownIds)||j.knownIds.length<1||j.knownIds.length>500||j.knownIds.some(id=>typeof id!=="string"||!/^[a-f0-9]{24}$/.test(id)))throw new SocialSyncError("XHS_DISCOVERY_STATE_INVALID");timestamp(j.expiresAt);}
  if(s.lastSubmission!==null){const l=object(s.lastSubmission);if(Object.keys(l).sort().join()!=="id,sha256"||typeof l.id!=="string"||!/^[-a-f0-9]{36}$/.test(l.id)||typeof l.sha256!=="string"||!/^[a-f0-9]{64}$/.test(l.sha256))throw new SocialSyncError("XHS_DISCOVERY_STATE_INVALID");}
  return s as unknown as XhsDiscoveryState;
}
const summary=(s:XhsDiscoveryState)=>({status:s.status,pending:s.queue.length,code:s.code});
export async function resumeXhsDirectory(root:string,digest:string){
  const dir=join(root,"discovery-xiaohongshu");await privateDirectory(dir);const release=await acquireLock(dir,randomUUID());
  try{const s=await readXhsDiscoveryState(root,digest);if(s?.status==="paused"){await writeJson(join(dir,`recovery-${randomUUID()}.json`),s);s.status="complete";s.code=null;s.job=null;await writeJson(join(dir,"state.json"),s);}}finally{await release();}
}
/** Positive public sightings are queued on the SSD. The Chrome message never grants SQL rights. */
export async function handleXhsDiscovery(root:string,message:unknown,now=()=>new Date().toISOString()){
  const base=refreshConfig(JSON.parse(await readPrivateFile(join(root,"refresh-config.json"),MAX_REFRESH_CONFIG_BYTES))),policy=await readXhsAccountPolicy(root,base),msg=object(message);
  const shapes:Record<string,string>={"xiaohongshu-start":"manual,op","xiaohongshu-submit":"directory,jobId,op","xiaohongshu-pause":"code,op"};
  if(typeof msg.op!=="string"||!shapes[msg.op]||Object.keys(msg).sort().join()!==shapes[msg.op]||msg.op==="xiaohongshu-start"&&typeof msg.manual!=="boolean")throw new SocialSyncError("BRIDGE_REQUEST_INVALID");
  if(msg.op==="xiaohongshu-submit"&&(typeof msg.jobId!=="string"||!/^[-a-f0-9]{36}$/.test(msg.jobId)))throw new SocialSyncError("BRIDGE_REQUEST_INVALID");
  if(!policy?.enabled)return {status:"disabled",pending:0};
  const digest=hash(JSON.stringify(policy)),dir=join(root,"discovery-xiaohongshu");await privateDirectory(dir);const release=await acquireLock(dir,randomUUID());
  const file=join(dir,"state.json");let s:XhsDiscoveryState|null=null;
  try{
    s=await readXhsDiscoveryState(root,digest);
    if(msg.op==="xiaohongshu-pause"){
      if(!s||typeof msg.code!=="string"||!/^[A-Z][A-Z_]{0,63}$/.test(msg.code))throw new SocialSyncError("BRIDGE_REQUEST_INVALID");
      s.status="paused";s.code=msg.code;await writeJson(file,s);return summary(s);
    }
    const extra=await readXhsDiscoveredScope(root,base,policy),known=[...base.publications,...extra.publications].filter(p=>p.target.platform==="xiaohongshu").map(p=>p.target.publicationId);
    if(msg.op==="xiaohongshu-start"){
      if(s?.status==="paused"&&msg.manual!==true)return summary(s);
      if(s?.checkedAt&&Date.parse(now())<Date.parse(s.checkedAt)+3600000&&msg.manual!==true)return {...summary(s),due:false};
      if(s?.status==="capturing"&&s.job&&s.job.expiresAt>now())return {...summary(s),job:s.job};
      s={version:1,policyDigest:digest,status:"capturing",checkedAt:s?.checkedAt??null,code:null,links:s?.links??[],queue:s?.queue??[],lastSubmission:s?.lastSubmission??null,
        job:{id:randomUUID(),accountId:policy.accountId,expiresAt:new Date(Date.parse(now())+2*60000).toISOString(),knownIds:known}};
      await writeJson(file,s);return {...summary(s),job:s.job};
    }
    if(!s)throw new SocialSyncError("XHS_DISCOVERY_STATE_INVALID");
    const sha=hash(JSON.stringify(msg.directory));
    const last=s.lastSubmission;if(last&&last.id===msg.jobId){if(last.sha256!==sha)throw new SocialSyncError("BRIDGE_JOB_REPLAY_CHANGED");return summary(s);}
    if(s.status!=="capturing"||!s.job||s.job.id!==msg.jobId||s.job.expiresAt<now())throw new SocialSyncError("BRIDGE_JOB_EXPIRED");
    const d=xhsDirectory(msg.directory,policy.accountId,now());
    // At least five known entries at the tail protect against a single pinned old note.
    if(d.cards.length<30||!d.cards.slice(-5).every(c=>known.includes(c.publicationId)))throw new SocialSyncError("XHS_DIRECTORY_GAP");
    const updated=new Map(s.links.map(l=>[l.publicationId,l]));for(const c of d.cards)updated.set(c.publicationId,{...c,observedAt:d.observedAt});
    if(updated.size>500)throw new SocialSyncError("XHS_DIRECTORY_CAPACITY");
    s.links=[...updated.values()];s.queue=[...new Set([...s.queue,...d.cards.filter(c=>!known.includes(c.publicationId)).map(c=>c.publicationId)])];
    s.checkedAt=d.observedAt;s.status="complete";s.code=null;s.job=null;s.lastSubmission={id:msg.jobId as string,sha256:sha};await writeJson(file,s);return summary(s);
  }finally{await release();}
}
