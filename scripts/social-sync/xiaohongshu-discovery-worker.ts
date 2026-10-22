import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { acquireLock,privateDirectory,readPrivateFile } from "../notion-sync/state.ts";
import { writeJson } from "../game-sync/private.ts";
import { hash,publicationKey,SocialSyncError } from "./model.ts";
import type { Target,XiaohongshuObservation } from "./model.ts";
import { MAX_REFRESH_CONFIG_BYTES,refreshConfig } from "./refresh.ts";
import { openStore } from "./store.ts";
import { CycleCloudSession } from "./cycle-cloud.ts";
import { HttpNoteSession } from "./xiaohongshu-http-transport.ts";
import { readHttpNotePolicy } from "./xiaohongshu-http-config.ts";
import { automaticNoteTarget,readXhsAccountPolicy,readXhsDiscoveredScope,candidateNoteShareUrl } from "./xiaohongshu-account.ts";
import { readXhsDiscoveryState } from "./xiaohongshu-discovery-bridge.ts";
import { checkedNoteShareUrl } from "./xiaohongshu-http.ts";
import { holdNoteLink } from "./xiaohongshu-link-holds.ts";
import { readBrowserNoteCapture } from "./xiaohongshu-browser-notes.ts";
import { createCoverHandoff } from "../social-media/handoff.ts";

/** At most five new public notes per local tick. Known cards cause zero detail requests. */
export async function runXhsDiscovery(root:string,signal?:AbortSignal,ports:{cloud?:CycleCloudSession;collect?:(target:Target,url:string,signal?:AbortSignal)=>Promise<XiaohongshuObservation>}={}){
  const base=refreshConfig(JSON.parse(await readPrivateFile(join(root,"refresh-config.json"),MAX_REFRESH_CONFIG_BYTES))),policy=await readXhsAccountPolicy(root,base);
  if(!policy?.enabled)return {state:"disabled",uploaded:0,pending:0};
  const digest=hash(JSON.stringify(policy)),dir=join(root,"discovery-xiaohongshu"),initial=await readXhsDiscoveryState(root,digest);
  if(!initial?.queue.length)return {state:"idle",uploaded:0,pending:0};
  if(initial.status==="paused")return {state:"paused",uploaded:0,pending:initial.queue.length};
  if(!ports.collect&&!await readBrowserNoteCapture(root,automaticNoteTarget(policy.accountId,initial.queue[0]!),digest))return {state:"waiting-browser",uploaded:0,pending:initial.queue.length};
  const httpPolicy=await readHttpNotePolicy(root);if(!httpPolicy?.enabled)throw new SocialSyncError("XHS_HTTP_DISABLED");
  const releases:(()=>Promise<void>)[]=[];let store:Awaited<ReturnType<typeof openStore>>=null,uploaded=0;
  const http=new HttpNoteSession(httpPolicy.pythonExecutable);let cloud:CycleCloudSession|undefined;
  try{
    for(const path of [...new Set([root,dir,httpPolicy.stateDirectory])].sort()){await privateDirectory(path);releases.push(await acquireLock(path,randomUUID()));}
    const state=await readXhsDiscoveryState(root,digest);if(!state?.queue.length||state.status==="paused")return {state:"deferred",uploaded:0,pending:state?.queue.length??0};
    const extra=await readXhsDiscoveredScope(root,base,policy),raw=await readPrivateFile(join(root,"cloud.env"),65536);
    const check=async()=>{const current=refreshConfig(JSON.parse(await readPrivateFile(join(root,"refresh-config.json"),MAX_REFRESH_CONFIG_BYTES)));if(hash(JSON.stringify(current))!==policy.baseScopeDigest||hash(JSON.stringify(await readXhsAccountPolicy(root,current)))!==digest||hash(JSON.stringify(await readHttpNotePolicy(root)))!==hash(JSON.stringify(httpPolicy)))throw new SocialSyncError("REFRESH_SCOPE_CHANGED");};
    cloud=ports.cloud??new CycleCloudSession(signal,undefined,{httpNotes:true,xhsAccount:{accountId:policy.accountId,link:item=>{const l=state.links.find(l0=>l0.publicationId===item.observation.publicationId);return l?{url:candidateNoteShareUrl(l.url,automaticNoteTarget(policy.accountId,l.publicationId)),checkedAt:item.observation.observedAt}:null;}}});
    await check();await cloud.preparePublications(raw,digest,signal); // Capability/account verified before any GET.
    store=await openStore(httpPolicy.stateDirectory);if(!store)throw new SocialSyncError("REFRESH_STATE_MISSING");
    for(const id of state.queue.slice(0,5)){
      if(signal?.aborted)throw new SocialSyncError("CANCELLED");
      const target=automaticNoteTarget(policy.accountId,id),link=state.links.find(l=>l.publicationId===id);if(!link)throw new SocialSyncError("XHS_DIRECTORY_INVALID");
      const url=candidateNoteShareUrl(link.url,target),age=Date.now()-Date.parse(link.observedAt);if(age < -30000||age>=3600000)throw new SocialSyncError("XHS_DIRECTORY_EXPIRED");
      const known=[...base.publications,...extra.publications].find(p=>p.target.platform==="xiaohongshu"&&p.target.publicationId===id);
      if(known&&known.target.workId!==target.workId)throw new SocialSyncError("WORK_BINDING_REVIEW_REQUIRED");
      const latest=store.latest(target),pending=store.pendingFor(target);
      if(known&&latest&&!pending){state.queue=state.queue.filter(i=>i!==id);await writeJson(join(dir,"state.json"),state);continue;}
      if(!pending||Date.now()-Date.parse(pending.observation.observedAt)>=3600000){
        let row:XiaohongshuObservation;
        try{row=ports.collect?await ports.collect(target,url,signal):(await readBrowserNoteCapture(root,target,digest))!;if(!row)break;}catch(e){if(e instanceof SocialSyncError&&e.code==="SOURCE_NOTE_UNAVAILABLE")await holdNoteLink(root,publicationKey(target),url);throw e;}
        if(row.accountId!==policy.accountId||row.publicationId!==id||row.workId!==target.workId||!["public-note-page-ssr","browser-note-state"].includes(row.source))throw new SocialSyncError("IDENTITY_MISMATCH");
        if(known&&known.kind!==row.kind)throw new SocialSyncError("KIND_REVIEW_REQUIRED");
        await check();
        if(!known){extra.publications.push({target,kind:row.kind});refreshConfig({...base,publications:[...base.publications,...extra.publications]});await writeJson(join(root,"xiaohongshu-discovered.json"),extra);}
        store.ingest(row);
      }
      const sending=store.pendingFor(target);if(!sending)throw new SocialSyncError("REFRESH_PENDING_MISSING");
      await check();const receipt=await cloud.sendPublication(raw,digest,sending,signal,check);
      if(receipt.key!==sending.key||receipt.sha256!==sending.sha256||!store.acknowledge(sending.key,sending.sha256))throw new SocialSyncError("ACK_MISMATCH");
      uploaded++;await createCoverHandoff(root).acknowledged(sending);
      state.queue=state.queue.filter(i=>i!==id);await writeJson(join(dir,"state.json"),state);
    }
    return {state:"complete",uploaded,pending:state.queue.length};
  }catch(e){
    if((e as {code?:string}).code!=="BUSY"&&releases.length===3){const state=await readXhsDiscoveryState(root,digest);if(state){state.status="paused";state.code=e instanceof SocialSyncError?e.code:"XHS_DISCOVERY_FAILED";await writeJson(join(dir,"state.json"),state);}}
    throw e;
  }finally{try{store?.close();const closed=await Promise.allSettled([http.close(),cloud?.close()]),failed=closed.find(r=>r.status==="rejected");if(failed?.status==="rejected")throw failed.reason;}finally{for(const release of releases.reverse())await release();}}
}
