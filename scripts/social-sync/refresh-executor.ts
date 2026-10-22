import { setTimeout as delay } from "node:timers/promises";
import { collectVideo } from "./bilibili.ts";
import { collectCollection, collectionKey, validateCollectionSnapshot } from "./collection.ts";
import type { CollectionSnapshot, CollectionTarget } from "./collection.ts";
import { hash, publicationKey, SocialSyncError, timestamp, validateObservation } from "./model.ts";
import type { Observation, Target } from "./model.ts";
import type { SocialStore, Pending } from "./store.ts";
import type { CollectionStore, CollectionPending } from "./collection-store.ts";
import { collectionReview, planRefresh, publicationReview, refreshConfig, reviewedCollectionSender, reviewedPublicationSender } from "./refresh.ts";
import type { RefreshConfig } from "./refresh.ts";
import { observeRefreshPhase } from "./refresh-activity.ts";
import type { RefreshObserver } from "./refresh-activity.ts";

export const MAX_REFRESH_TARGETS = 20;
export const MAX_REFRESH_RUN_MS = 120000;
export const MAX_REFRESH_SOURCE_BYTES = 32 * 1024 * 1024;
type Job = { type:"publication"; key:string; target:Target } | { type:"collection"; key:string; target:CollectionTarget };
export type RefreshCandidate = { type:"publication"; key:string; value:Observation } | { type:"collection"; key:string; value:CollectionSnapshot };
export interface RefreshReport {
  version:1; scopeDigest:string; startedAt:string; finishedAt:string|null; selected:number;
  collected:number; resumed:number; uploaded:number; superseded:number; reviewRequired:number; failed:number;
  waitingBrowser:number; paused:boolean; cancelled:boolean;
  entries:{key:string;type:Job["type"];status:string;code:string|null;observedAt:string|null;sha256:string|null}[];
}
export interface RefreshPorts {
  publications:SocialStore|null; collections:CollectionStore|null;
  sendPublication:(item:Pending)=>Promise<{key:string;sha256:string}>;
  sendCollection:(item:CollectionPending)=>Promise<{key:string;sha256:string}>;
  checkScope:()=>Promise<void>;
  saveReview:(candidate:RefreshCandidate,code:string)=>Promise<void>;
  progress:(report:RefreshReport)=>Promise<void>;
  afterAcknowledged?:(item:Pending|CollectionPending)=>Promise<void>;
}
const codeOf=(e:unknown)=>e instanceof SocialSyncError?e.code:"REFRESH_FAILED";
const pausing=new Set(["SOURCE_BLOCKED","SOURCE_REDIRECT","SOURCE_TEMPORARY_ERROR","RATE_LIMITED","RATE_LIMITED_LONG_COOLDOWN","PAGE_STATE_MISSING","PAGE_TYPE_INVALID","REFRESH_BYTE_BUDGET","REFRESH_REQUEST_BUDGET","REFRESH_SCOPE_CHANGED","ACK_MISMATCH","CLOUD_UPLOAD_FAILED","COLLECTION_UPLOAD_FAILED","CLOUD_UNAVAILABLE","CLOUD_HANDSHAKE_INVALID"]);
function recent(at:string,now:string) {
  const age=Date.parse(timestamp(now))-Date.parse(timestamp(at));
  if(age < -30000 || age>5*60000)throw new SocialSyncError("REFRESH_CAPTURE_EXPIRED");
}
export function reviewCandidate(scope:RefreshConfig,candidate:RefreshCandidate) {
  const key=candidate.type==="publication"?publicationKey(candidate.value):collectionKey(candidate.value.target);
  if(candidate.key!==key)throw new SocialSyncError("LOCAL_DATA_INVALID");
  return candidate.type==="publication"?publicationReview(scope,candidate.value):collectionReview(scope,candidate.value);
}
/** One shared streaming budget, in addition to the existing per-page caps. No extra source requests. */
export function refreshRequest(request:typeof fetch=fetch,budget={requests:MAX_REFRESH_TARGETS,bytes:MAX_REFRESH_SOURCE_BYTES}):typeof fetch {
  let requests=0,bytes=0;
  return async(input,init)=>{
    if(++requests>budget.requests)throw new SocialSyncError("REFRESH_REQUEST_BUDGET");
    const response=await request(input,init);
    if(!response.body)return response;
    const body=response.body.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({transform(chunk,controller){
      bytes+=chunk.byteLength;if(bytes>budget.bytes)throw new SocialSyncError("REFRESH_BYTE_BUDGET");controller.enqueue(chunk);
    }}));
    return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
  };
}
/** Source/outbox transactions are the durable checkpoint. A failed receipt never advances success. */
export async function executeRefresh(value:unknown,ports:RefreshPorts,options:{
  platform:"bilibili"|"xiaohongshu";limit:number;signal?:AbortSignal;now?:()=>string;spacingMs?:number;
  captures?:Observation[];held?:RefreshCandidate[];uploadOnly?:boolean;keys?:string[];request?:typeof fetch;observe?:RefreshObserver;
  collectPublication?:(target:Target,signal?:AbortSignal)=>Promise<Observation>;
  collectHttpNote?:(target:Target,signal?:AbortSignal)=>Promise<Observation>;
  collectCollection?:(target:CollectionTarget,signal?:AbortSignal)=>Promise<CollectionSnapshot>;
}) {
  if(!Number.isInteger(options.limit)||options.limit<1||options.limit>MAX_REFRESH_TARGETS||!["bilibili","xiaohongshu"].includes(options.platform))throw new SocialSyncError("REFRESH_LIMIT_INVALID");
  const scope=refreshConfig(value),now=options.now??(()=>new Date().toISOString()),startedAt=timestamp(now());
  const allowedKeys=new Set(options.keys);
  if(options.keys&&(allowedKeys.size!==options.keys.length||options.keys.some(k=>!scope.publications.some(p=>publicationKey(p.target)===k)&&!scope.collections.some(c=>collectionKey(c.target)===k))))throw new SocialSyncError("UNCONFIGURED_PUBLICATION");
  if(scope.publications.length&&!ports.publications || scope.collections.length&&!ports.collections)throw new SocialSyncError("REFRESH_STATE_MISSING");
  ports.publications?.checkTargets(scope.publications.map(p=>p.target));
  const plan=planRefresh(scope,{publication:t=>ports.publications?.latest(t)??null,collection:t=>ports.collections?.latest(t)?.snapshot??null},startedAt);
  const report:RefreshReport={version:1,scopeDigest:plan.scopeDigest,startedAt,finishedAt:null,selected:0,collected:0,resumed:0,uploaded:0,superseded:0,reviewRequired:0,failed:0,waitingBrowser:0,paused:false,cancelled:false,entries:[]};
  const captures=new Map<string,Observation>();
  if((options.captures?.length??0)>options.limit)throw new SocialSyncError("REFRESH_LIMIT_INVALID");
  for(const row of options.captures??[]){validateObservation(row);recent(row.observedAt,startedAt);const key=publicationKey(row);
    if(row.platform!=="xiaohongshu"||!scope.publications.some(p=>publicationKey(p.target)===key)||captures.has(key))throw new SocialSyncError("UNCONFIGURED_PUBLICATION");captures.set(key,row);}
  const held=new Map<string,RefreshCandidate>();
  for(const candidate of options.held??[]){const decision=reviewCandidate(scope,candidate);if(!decision.allowed)held.set(candidate.key,candidate);}
  const jobs:Job[]=[...scope.publications.filter(p=>p.target.platform===options.platform).map(p=>({type:"publication" as const,key:publicationKey(p.target),target:p.target})),
    ...(options.platform==="bilibili"?scope.collections.map(c=>({type:"collection" as const,key:collectionKey(c.target),target:c.target})):[])];
  const statuses=new Map(plan.entries.map(e=>[e.key,e]));
  const selected=jobs.filter(job=>{
    if(options.keys&&!allowedKeys.has(job.key))return false;
    const entry=statuses.get(job.key)!;
    if(held.has(job.key)||entry.status==="review-required")return false;
    const pending=job.type==="publication"?ports.publications!.pendingFor(job.target):ports.collections!.pendingFor(job.target);
    return options.uploadOnly?pending!==null:entry.status==="due"||pending!==null||captures.has(job.key);
  }).sort((a,b)=>{
    const rank=(j:Job)=>captures.has(j.key)?0:statuses.get(j.key)!.status==="fresh"?1:2;
    return rank(a)-rank(b)||(a.key<b.key?-1:a.key>b.key?1:0);
  }).slice(0,options.limit);
  // Recorded candidates prevent repeated collection of a known unreviewed membership/type.
  report.reviewRequired=jobs.filter(j=>held.has(j.key)||statuses.get(j.key)!.status==="review-required").length;
  report.selected=selected.length;await ports.progress(report);
  const request=refreshRequest(options.request);
  const sendPub=reviewedPublicationSender(scope,ports.sendPublication,now),sendCol=reviewedCollectionSender(scope,ports.sendCollection,now);
  let fetches=0,consecutiveFailures=0;
  for(const job of selected){
    if(options.signal?.aborted){report.cancelled=true;break;}
    let item:Pending|CollectionPending|null=null,at:string|null=null,sha:string|null=null;
    try{
      await ports.checkScope();
      const pending=job.type==="publication"?ports.publications!.pendingFor(job.target):ports.collections!.pendingFor(job.target);
      // Retry a recent completed local collection without fetching it again. Expired samples need capture.
      const reuse=pending && (options.uploadOnly||statuses.get(job.key)!.status==="fresh");
      if(reuse){item=pending;report.resumed++;}
      else {
        if(options.uploadOnly)continue;
        if(job.type==="publication"&&job.target.platform==="xiaohongshu"&&!captures.has(job.key)&&!options.collectHttpNote){
          report.waitingBrowser++;report.entries.push({key:job.key,type:job.type,status:"waiting-browser",code:"BROWSER_SNAPSHOT_REQUIRED",observedAt:null,sha256:null});continue;
        }
        const network=job.type==="collection"||job.target.platform==="bilibili"||Boolean(options.collectHttpNote&&!captures.has(job.key));
        if(network&&fetches++){await delay(options.spacingMs??1000,undefined,{signal:options.signal});}
        if(options.signal?.aborted)throw new SocialSyncError("CANCELLED");
        const candidate=await observeRefreshPhase("capture",async():Promise<RefreshCandidate>=>{
        if(job.type==="publication"){
          const row=job.target.platform==="xiaohongshu"?(captures.get(job.key)??await options.collectHttpNote!(job.target,options.signal)):await (options.collectPublication??((t,s)=>collectVideo(t,s,request)))(job.target,options.signal);
          validateObservation(row);
          if(publicationKey(row)!==job.key||row.workId!==job.target.workId)throw new SocialSyncError("IDENTITY_MISMATCH");
          return {type:"publication",key:job.key,value:row};
        }else{
          const row=validateCollectionSnapshot(await (options.collectCollection??((t,s)=>collectCollection(t,s,request)))(job.target,options.signal));
          if(collectionKey(row.target)!==job.key||row.target.representativeUrl!==job.target.representativeUrl)throw new SocialSyncError("IDENTITY_MISMATCH");
          return {type:"collection",key:job.key,value:row};
        }
        },candidate=>candidate.value.observedAt,options.observe,now);
        recent(candidate.value.observedAt,now());
        await ports.checkScope();if(options.signal?.aborted)throw new SocialSyncError("CANCELLED");
        const decision=reviewCandidate(scope,candidate);
        if(!decision.allowed){await ports.saveReview(candidate,decision.code);report.reviewRequired++;
          report.entries.push({key:job.key,type:job.type,status:"review-required",code:decision.code,observedAt:candidate.value.observedAt,sha256:hash(JSON.stringify(candidate.value))});
          await ports.progress(report);continue;
        }
        if(candidate.type==="publication")ports.publications!.ingest(candidate.value);else ports.collections!.ingest(candidate.value);
        report.collected++;
        item=job.type==="publication"?ports.publications!.pendingFor(job.target):ports.collections!.pendingFor(job.target);
        if(!item)throw new SocialSyncError("REFRESH_PENDING_MISSING");
        if(job.type==="publication")ports.publications!.recordAttempt(job.target,now(),"OK");else ports.collections!.recordAttempt(job.target,now(),"OK");
      }
      if(!item)throw new SocialSyncError("REFRESH_PENDING_MISSING");
      at="observation" in item?item.observation.observedAt:item.snapshot.observedAt;sha=item.sha256;
      await ports.checkScope();if(options.signal?.aborted)throw new SocialSyncError("CANCELLED");
      const sending=item;
      await observeRefreshPhase("upload",async()=>{
        const receipt="observation" in sending?await sendPub(sending):await sendCol(sending);
        if(options.signal?.aborted)throw new SocialSyncError("CANCELLED");
        if(receipt.key!==sending.key||receipt.sha256!==sending.sha256)throw new SocialSyncError("ACK_MISMATCH");
        return receipt;
      },()=>at,options.observe,now);
      const acked="observation" in item?ports.publications!.acknowledge(item.key,item.sha256):ports.collections!.acknowledge(item);
      if(acked)report.uploaded++;else report.superseded++;
      // Media is isolated after the exact ACK; it cannot fail/replay statistics.
      if(acked&&ports.afterAcknowledged)try{await ports.afterAcknowledged(item);}catch{};
      report.entries.push({key:job.key,type:job.type,status:acked?"uploaded":"superseded",code:null,observedAt:at,sha256:sha});consecutiveFailures=0;
    }catch(error){
      const code=options.signal?.aborted?"CANCELLED":codeOf(error);
      if(options.collectHttpNote&&item===null&&["SOURCE_NOTE_UNAVAILABLE","NOTE_BROWSER_REQUIRED"].includes(code)&&job.type==="publication"){
        ports.publications!.recordAttempt(job.target,now(),code);
        report.reviewRequired++;report.entries.push({key:job.key,type:job.type,status:"review-required",code,observedAt:null,sha256:null});
        await ports.progress(report);continue;
      }
      report.failed++;
      if(item){if("observation" in item)ports.publications!.fail(item.key,item.sha256,code==="ACK_MISMATCH"?"ACK_MISMATCH":"TRANSPORT_FAILED");else ports.collections!.fail(item,code);}
      else if(job.type==="publication")ports.publications!.recordAttempt(job.target,now(),code);else ports.collections!.recordAttempt(job.target,now(),code);
      report.entries.push({key:job.key,type:job.type,status:"failed",code,observedAt:at,sha256:sha});
      if(options.signal?.aborted)report.cancelled=true;
      if(options.collectHttpNote||pausing.has(code)||item!==null||++consecutiveFailures>=3)report.paused=true;
    }
    await ports.progress(report);if(report.paused||report.cancelled)break;
  }
  if(options.signal?.aborted)report.cancelled=true;
  report.finishedAt=now();await ports.progress(report);return report;
}
