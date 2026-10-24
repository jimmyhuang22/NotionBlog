import { isAbsolute,join,resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { acquireLock,privateDirectory,readPrivateFile } from "../notion-sync/state.ts";
import { writeJson } from "../game-sync/private.ts";
import { cloudConfig,connectCloud } from "./cloud.ts";
import { connectCollectionCloud } from "./collection-cloud.ts";
import { openStore } from "./store.ts";
import { openCollectionStore } from "./collection-store.ts";
import { hash,publicationKey,SocialSyncError,timestamp } from "./model.ts";
import { collectionKey, collectCollection } from "./collection.ts";
import { createCoverHandoff } from "../social-media/handoff.ts";
import { MAX_REFRESH_CONFIG_BYTES,planRefresh,refreshConfig } from "./refresh.ts";
import { readRefreshScope } from "./refresh-scope.ts";
import { readAccountPolicy } from "./bilibili-account-scope.ts";
import { collectAccountCollection, collectAccountPublication } from "./bilibili-discovery.ts";
import { collectApiPublication, collectApiCollection } from "./bilibili-api-collect.ts";
import { readBilibiliApiPolicy } from "./bilibili-api-policy.ts";
import type { CollectionTarget } from "./collection.ts";
import type { Target } from "./model.ts";
import { refreshRequest } from "./refresh-executor.ts";
import { executeRefresh,MAX_REFRESH_RUN_MS,MAX_REFRESH_TARGETS,reviewCandidate } from "./refresh-executor.ts";
import type { Observation } from "./model.ts";
import type { RefreshCandidate,RefreshReport } from "./refresh-executor.ts";
import type { RefreshObserver } from "./refresh-activity.ts";
import type { CycleCloudSession } from "./cycle-cloud.ts";
import type { RefreshConfig } from "./refresh.ts";
import { browserCaptureScript,MAX_SNAPSHOT_BYTES,snapshotBatch } from "./xiaohongshu.ts";

export const usage="node scripts/social-sync/execute-cli.ts <run|upload> <absolute-private-directory> <bilibili|xiaohongshu> <1..20>\nnode scripts/social-sync/execute-cli.ts prepare-xhs <absolute-private-directory> <1..20>";
export function executionSummary(r:RefreshReport){return {selected:r.selected,collected:r.collected,resumed:r.resumed,uploaded:r.uploaded,superseded:r.superseded,reviewRequired:r.reviewRequired,failed:r.failed,waitingBrowser:r.waitingBrowser,paused:r.paused,cancelled:r.cancelled};}
async function optionalFile(path:string,limit:number){try{return await readPrivateFile(path,limit);}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return null;throw e;}}
export interface RootExecutionOptions {
  platform:"bilibili"|"xiaohongshu";limit:number;prepare?:boolean;uploadOnly?:boolean;
  keys?:string[];captures?:Observation[];request?:typeof fetch;signal?:AbortSignal;
  scopeDigest?:string;expectedSnapshots?:Record<string,string|null>;observe?:RefreshObserver;cloudSession?:CycleCloudSession;
  scopeProvider?:()=>Promise<RefreshConfig>;collectHttpNote?:(target:Target,signal?:AbortSignal)=>Promise<Observation>;
  bilibiliApi?:boolean;
}
export async function executeAtRoot(root:string,options:RootExecutionOptions){
  const {platform,limit,prepare}=options;
  if(!root||!isAbsolute(root)||resolve(root)!==root||!Number.isInteger(limit)||limit<1||limit>MAX_REFRESH_TARGETS)throw new SocialSyncError("USAGE");
  if(options.cloudSession&&platform!=="bilibili"&&!options.collectHttpNote)throw new SocialSyncError("USAGE");
  if(options.bilibiliApi&&platform!=="bilibili")throw new SocialSyncError("USAGE");
  if(options.collectHttpNote&&(platform!=="xiaohongshu"||!options.scopeProvider||!options.cloudSession||prepare||(options.captures?.length??0)>0))throw new SocialSyncError("USAGE");
  if(options.collectHttpNote&&!options.cloudSession!.httpNotesPrepared)throw new SocialSyncError("XHS_HTTP_PROTOCOL_REQUIRED");
  process.umask(0o077);await privateDirectory(root);
  const readScope=options.scopeProvider??(()=>readRefreshScope(root,platform));
  const scope=await readScope(),digest=hash(JSON.stringify(scope));
  const sourceDirs=[...(scope.publications.length?[scope.stateDirectories.publications]:[]),...(scope.collections.length?[scope.stateDirectories.collections]:[])];
  for(const dir of sourceDirs){await lstat(dir);await privateDirectory(dir);}
  const releases:(()=>Promise<void>)[]=[],controller=new AbortController(),runId=randomUUID(),cancel=()=>controller.abort();
  const timer=setTimeout(cancel,MAX_REFRESH_RUN_MS);timer.unref();options.signal?.addEventListener("abort",cancel,{once:true});if(options.signal?.aborted)cancel();process.once("SIGTERM",cancel);process.once("SIGINT",cancel);
  let publications:Awaited<ReturnType<typeof openStore>>=null,collections:Awaited<ReturnType<typeof openCollectionStore>>=null;
  let pubCloud:Awaited<ReturnType<typeof connectCloud>>|undefined,colCloud:Awaited<ReturnType<typeof connectCollectionCloud>>|undefined;
  try{
    for(const dir of [...new Set([root,...sourceDirs])].sort())releases.push(await acquireLock(dir,runId));
    const checkScope=async()=>{if(hash(JSON.stringify(await readScope()))!==digest)throw new SocialSyncError("REFRESH_SCOPE_CHANGED");};
    await checkScope();if(options.scopeDigest&&options.scopeDigest!==digest)throw new SocialSyncError("REFRESH_SCOPE_CHANGED");
    const base=platform==="bilibili"?refreshConfig(JSON.parse(await readPrivateFile(join(root,"refresh-config.json"),MAX_REFRESH_CONFIG_BYTES))):null;
    const accountPolicy=base?await readAccountPolicy(root,base):null;
    const apiPolicy=base?await readBilibiliApiPolicy(root,base):null,apiMode=apiPolicy?.enabled===true;
    const metadataRoot=apiMode?apiPolicy.stateDirectories.publications:root;
    if(apiMode!==Boolean(options.bilibiliApi))throw new SocialSyncError("BILIBILI_API_PROTOCOL_REQUIRED");
    if(apiMode&&(scope.stateDirectories.publications!==apiPolicy.stateDirectories.publications||scope.stateDirectories.collections!==apiPolicy.stateDirectories.collections))throw new SocialSyncError("BILIBILI_API_STATE_OVERLAP");
    const accountMode=accountPolicy?.enabled===true;
    const request=accountMode?refreshRequest(options.request):options.request;
    // Preflight existing versions read-only: execution never creates or migrates a source database.
    if(scope.publications.length){publications=await openStore(scope.stateDirectories.publications,true);if(!publications)throw new SocialSyncError("REFRESH_STATE_MISSING");}
    if(scope.collections.length){collections=await openCollectionStore(scope.stateDirectories.collections,true);if(!collections)throw new SocialSyncError("REFRESH_STATE_MISSING");if(collections.status().pending===null)throw new SocialSyncError("REFRESH_STATE_UPGRADE_REQUIRED");}
    const held:RefreshCandidate[]=[];
    for(const entry of [...scope.publications.map(p=>({key:publicationKey(p.target),type:"publication"})),...scope.collections.map(c=>({key:collectionKey(c.target),type:"collection"}))]){
      const reviewFile=`review-${entry.type}-${entry.key}.json`;
      const raw=(await optionalFile(join(metadataRoot,reviewFile),600*1024))??(metadataRoot!==root?await optionalFile(join(root,reviewFile),600*1024):null);
      if(raw!==null){const r=JSON.parse(raw);if(r.version!==1||r.candidate?.key!==entry.key||r.candidate?.type!==entry.type)throw new SocialSyncError("LOCAL_DATA_INVALID");
        reviewCandidate(scope,r.candidate);held.push(r.candidate);}
    }
    if(options.expectedSnapshots){
      const current=planRefresh(scope,{publication:t=>publications?.latest(t)??null,collection:t=>collections?.latest(t)?.snapshot??null},new Date().toISOString());
      for(const [key,sha] of Object.entries(options.expectedSnapshots))if(current.entries.find(e=>e.key===key)?.snapshotSha256!==sha)throw new SocialSyncError("REFRESH_SOURCE_CHANGED");
    }
    if(prepare){
      const plan=planRefresh(scope,{publication:t=>publications?.latest(t)??null,collection:t=>collections?.latest(t)?.snapshot??null},new Date().toISOString());
      const blocked=new Set(held.filter(c=>!reviewCandidate(scope,c).allowed).map(c=>c.key));
      const due=new Set(plan.entries.filter(e=>e.platform==="xiaohongshu"&&e.status==="due"&&!blocked.has(e.key)).map(e=>e.key));
      const targets=scope.publications.filter(p=>p.target.platform==="xiaohongshu"&&due.has(publicationKey(p.target))).map(p=>p.target).sort((a,b)=>publicationKey(a).localeCompare(publicationKey(b))).slice(0,limit);
      await checkScope();
      await writeJson(join(root,"browser-capture.json"),{version:1,preparedAt:new Date().toISOString(),scopeDigest:digest,targets,script:targets.length?browserCaptureScript(targets):null,captured:0});
      return {prepared:targets.length,captured:0,reviewRequired:blocked.size,executed:false};
    }
    const cloudRaw=await readPrivateFile(join(root,"cloud.env"),65536);cloudConfig(cloudRaw);
    if(apiMode&&!options.cloudSession?.hasPreparedBilibiliApi(cloudRaw,digest,accountMode))throw new SocialSyncError("BILIBILI_API_PROTOCOL_REQUIRED");
    const rawCaptures=platform==="xiaohongshu"&&!options.collectHttpNote&&!options.uploadOnly&&options.captures===undefined?await optionalFile(join(root,"xiaohongshu-snapshot.json"),MAX_SNAPSHOT_BYTES):null;
    const captures=options.captures??(rawCaptures===null?[]:snapshotBatch(rawCaptures,scope.publications.map(p=>p.target)));
    if(captures.length>limit)throw new SocialSyncError("REFRESH_LIMIT_INVALID");
    publications?.close();collections?.close();publications=null;collections=null;
    if(scope.publications.length)publications=await openStore(scope.stateDirectories.publications);
    if(scope.collections.length)collections=await openCollectionStore(scope.stateDirectories.collections);
    const media=createCoverHandoff(root);
    const report=await executeRefresh(scope,{publications,collections,checkScope,afterAcknowledged:media.acknowledged,
      sendPublication:async item=>{if(options.cloudSession)return options.cloudSession.sendPublication(cloudRaw,digest,item,controller.signal,checkScope,accountMode);
        pubCloud??=await connectCloud(cloudRaw,controller.signal,accountMode);await checkScope();return pubCloud.send(item);},
      sendCollection:async item=>{if(options.cloudSession)return options.cloudSession.sendCollection(cloudRaw,digest,item,controller.signal,checkScope,accountMode);
        colCloud??=await connectCollectionCloud(cloudRaw,controller.signal,accountMode);await checkScope();return colCloud.send(item);},
      saveReview:async(candidate,code)=>{await checkScope();await writeJson(join(metadataRoot,`review-${candidate.type}-${candidate.key}.json`),{version:1,scopeDigest:digest,recordedAt:new Date().toISOString(),code,candidate});},
      progress:async r=>{timestamp(r.startedAt);await writeJson(join(metadataRoot,"latest-execution.json"),{runId,...r});
        if(r.finishedAt&&!r.failed&&!r.paused&&!r.cancelled&&!r.waitingBrowser&&!r.reviewRequired&&r.selected>0)await writeJson(join(metadataRoot,"last-successful-batch.json"),{runId,...r});}
    },{platform:platform as "bilibili"|"xiaohongshu",limit,signal:controller.signal,captures,held,uploadOnly:options.uploadOnly,keys:options.keys,request,observe:options.observe,
      ...(options.collectHttpNote?{collectHttpNote:options.collectHttpNote}:{}),
      ...(apiMode?{stopOnCaptureFailure:true,
        collectPublication:(target:Target,signal?:AbortSignal)=>collectApiPublication(apiPolicy!.stateDirectories.publications,accountMode?hash(JSON.stringify(accountPolicy)):null,target,signal,request,media.stageApiCollection),
        collectCollection:(target:CollectionTarget,signal?:AbortSignal)=>collectApiCollection(apiPolicy!.stateDirectories.publications,accountMode?hash(JSON.stringify(accountPolicy)):null,target,scope.publications.map(p=>p.target),signal,request,media.stageApiCollection)}:accountMode?{collectPublication:(target:Target,signal?:AbortSignal)=>collectAccountPublication(root,hash(JSON.stringify(accountPolicy)),target,signal,request,media.stageCollection),
        collectCollection:(target:CollectionTarget,signal?:AbortSignal)=>collectAccountCollection(root,hash(JSON.stringify(accountPolicy)),target,scope.publications.map(p=>p.target),signal,request,media.stageCollection)}:
        {collectCollection:(target:CollectionTarget,signal?:AbortSignal)=>collectCollection(target,signal,request,media.stageCollection)})});
    return report;
  }finally{
    clearTimeout(timer);options.signal?.removeEventListener("abort",cancel);process.removeListener("SIGTERM",cancel);process.removeListener("SIGINT",cancel);
    const cleanup=await Promise.allSettled([pubCloud?.close(),colCloud?.close()]);
    publications?.close();collections?.close();
    for(const release of releases.reverse())await release();
    if(cleanup.some(r=>r.status==="rejected"))throw new SocialSyncError("REFRESH_CLOSE_FAILED");
  }
}
export async function runExecuteCli(args:string[]){
  if(args.length===1&&args[0]==="--help"){console.log(usage);return;}
  const [command,root,third,fourth]=args,prepare=command==="prepare-xhs",platform=prepare?"xiaohongshu":third,limit=Number(prepare?third:fourth);
  if(!["run","upload","prepare-xhs"].includes(command)||args.length!==(prepare?3:4)||!["bilibili","xiaohongshu"].includes(String(platform)))throw new SocialSyncError("USAGE");
  const result=await executeAtRoot(root,{platform:platform as "bilibili"|"xiaohongshu",limit,prepare,uploadOnly:command==="upload"});
  if("entries" in result){console.log(JSON.stringify(executionSummary(result)));if(result.failed||result.cancelled||result.waitingBrowser||result.reviewRequired||result.superseded)process.exitCode=1;}
  else console.log(JSON.stringify(result));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)runExecuteCli(process.argv.slice(2)).catch(error=>{
  console.error(JSON.stringify({code:error instanceof SocialSyncError?error.code:error?.code==="BUSY"?"BUSY":"REFRESH_EXECUTION_FAILED"}));process.exitCode=1;
});
