import { isAbsolute,join,resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { acquireLock,privateDirectory,readPrivateFile } from "../notion-sync/state.ts";
import { writeJson } from "../game-sync/private.ts";
import { executeAtRoot } from "./execute-cli.ts";
import { inspectRefresh } from "./refresh-state.ts";
import { refreshRequest } from "./refresh-executor.ts";
import { BILIBILI_CYCLE,newCycle } from "./refresh-cycle.ts";
import { automaticBilibiliRecovery,inspectBilibiliStatus,parseBilibiliHealth,runBilibiliCycle,trackedBilibiliRequest } from "./bilibili-cycle.ts";
import type { PreviousCycle } from "./bilibili-cycle.ts";
import { SocialSyncError } from "./model.ts";
import { CycleCloudSession } from "./cycle-cloud.ts";
import { readBilibiliMetadataRoot, requireApiMetadataTransfer } from "./bilibili-api-policy.ts";
import { MAX_REFRESH_CONFIG_BYTES, refreshConfig } from "./refresh.ts";
import { readAccountPolicy } from "./bilibili-account-scope.ts";

export const usage="node scripts/social-sync/cycle-cli.ts <plan|status|run|resume> <absolute-private-directory> bilibili";
async function optional(path:string){
  try{return JSON.parse(await readPrivateFile(path,128*1024));}
  catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return null;throw error;}
}
function previousCycle(value:unknown):PreviousCycle|null{
  if(value===null)return null;
  if(!value||typeof value!=="object"||typeof (value as PreviousCycle).status!=="string")throw new SocialSyncError("REFRESH_CYCLE_RECEIPT_INVALID");
  const {status,startedAt,scopeDigest}=value as PreviousCycle;return {status,startedAt,scopeDigest};
}
export async function runCycleCli(args:string[]){
  if(args.length===1&&args[0]==="--help"){console.log(usage);return;}
  const [command,root,platform]=args;
  if(args.length!==3||!["plan","status","run","resume"].includes(command)||platform!=="bilibili"||!isAbsolute(root)||resolve(root)!==root)throw new SocialSyncError("USAGE");
  process.umask(0o077);if(command==="status")await lstat(root);await privateDirectory(root);
  const metadataRoot=await readBilibiliMetadataRoot(root),apiMode=metadataRoot!==root,dir=join(metadataRoot,"cycle-bilibili");
  await requireApiMetadataTransfer(root,metadataRoot,"cycle-bilibili","health.json");
  await requireApiMetadataTransfer(root,metadataRoot,"cycle-bilibili","latest-cycle.json");
  if(command==="status"){
    const raw=await optional(join(dir,"health.json")),health=raw===null?null:parseBilibiliHealth(raw),previous=previousCycle(await optional(join(dir,"latest-cycle.json")));
    const state=await inspectRefresh(root,"bilibili"),inspectedAt=new Date().toISOString(),scopeMatches=health===null?null:health.scopeDigest===state.scopeDigest;
    const paused=previous&&["paused","cancelled"].includes(previous.status);
    const recoveryMatches=automaticBilibiliRecovery(health,previous,state.scopeDigest);
    const manualRequired=Boolean(health?.recovery.manualRequired||paused&&!recoveryMatches);
    console.log(JSON.stringify({platform:"bilibili",inspectedAt,state:manualRequired?"manual-required":paused&&recoveryMatches?"retry-wait":state.keys.length?"due":state.reviewRequired?"review-required":"idle",lastRunState:health?.state??null,
      lastCheckAt:health?.lastCheckAt??null,lastCollectedAt:state.entries.map(e=>e.observedAt).filter(Boolean).sort().at(-1)??null,lastUploadedAt:health?.lastUploadedAt??null,
      plan:inspectBilibiliStatus(state,inspectedAt),recovery:recoveryMatches||health?.recovery.manualRequired?health!.recovery:{failures:0,code:paused?"BILIBILI_MANUAL_RESUME_REQUIRED":null,retryAt:null,manualRequired},
      lastCycle:health?.cycle??null,lastCost:health?.cost??null,lastUploadCost:health?.uploadCost??null,scopeMatches,executed:false}));return;
  }
  const release=await acquireLock(dir,randomUUID());
  const controller=new AbortController(),cancel=()=>controller.abort(),timer=setTimeout(cancel,BILIBILI_CYCLE.durationMs);timer.unref();process.once("SIGTERM",cancel);process.once("SIGINT",cancel);
  const cloudSession=new CycleCloudSession(controller.signal,undefined,{bilibiliApi:apiMode});
  try{
    const previous=previousCycle(await optional(join(dir,"latest-cycle.json"))),rawHealth=await optional(join(dir,"health.json")),old=rawHealth===null?null:parseBilibiliHealth(rawHealth);
    if(command==="plan"){
      const state=await inspectRefresh(root,"bilibili"),cycle=newCycle(state.keys,state.scopeDigest,state.reviewRequired);
      await writeJson(join(dir,"plan.json"),{...cycle,budget:BILIBILI_CYCLE,executed:false});console.log(JSON.stringify({targets:state.keys.length,batches:Math.ceil(state.keys.length/20),reviewRequired:state.reviewRequired,withinBudget:state.keys.length<=160,executed:false}));return;
    }
    const tracked=trackedBilibiliRequest(),request=refreshRequest(tracked.request,{requests:BILIBILI_CYCLE.requests,bytes:BILIBILI_CYCLE.bytes}),cpuStart=process.cpuUsage();
    const report=await runBilibiliCycle(command as "run"|"resume",previous,old,{
      inspect:()=>inspectRefresh(root,"bilibili"),
      execute:async(keys,scopeDigest,observe)=>{
        if(apiMode){const base=refreshConfig(JSON.parse(await readPrivateFile(join(root,"refresh-config.json"),MAX_REFRESH_CONFIG_BYTES))),accountMode=(await readAccountPolicy(root,base))?.enabled===true;
          await cloudSession.prepareBilibiliApi(await readPrivateFile(join(root,"cloud.env"),65536),scopeDigest,accountMode,controller.signal);}
        const result=await executeAtRoot(root,{platform:"bilibili",limit:20,keys,scopeDigest,request,signal:controller.signal,observe,cloudSession,bilibiliApi:apiMode});
        if(!("entries" in result))throw new SocialSyncError("REFRESH_CYCLE_RECEIPT_INVALID");return result;
      },
      saveCycle:async cycle=>{await writeJson(join(dir,"latest-cycle.json"),cycle);if(cycle.finishedAt&&cycle.status==="complete")await writeJson(join(dir,"last-successful-cycle.json"),cycle);},
      saveHealth:health=>writeJson(join(dir,"health.json"),health),
      retryNotBefore:tracked.retryNotBefore,
      finishUpload:()=>cloudSession.close(),
      uploadCost:()=>({...cloudSession.cost}),
      measure:()=>{const cpu=process.cpuUsage(cpuStart);return {...tracked.cost,cpuUserMs:cpu.user/1000,cpuSystemMs:cpu.system/1000,peakRssBytes:process.resourceUsage().maxRSS*1024};}
    },{signal:controller.signal,manualOnFailure:apiMode});
    console.log(JSON.stringify({status:report.state,uploaded:report.cycle?.uploaded??0,remaining:report.cycle?.remaining??0,reviewRequired:report.plan?.reviewRequired??0,
      nextDueAt:report.plan?.nextDueAt??null,retryAt:report.recovery.retryAt,resumeRequired:report.recovery.manualRequired,cost:report.cost,uploadCost:report.uploadCost??null}));
    if(report.recovery.manualRequired||report.state==="error"||report.state==="budget"||report.state==="review-required"||
      report.state==="retry-wait"&&report.cycle?.startedAt!==old?.cycle?.startedAt)process.exitCode=1;
  }finally{clearTimeout(timer);process.removeListener("SIGTERM",cancel);process.removeListener("SIGINT",cancel);
    try{if(!cloudSession.closed)await cloudSession.close();}finally{await release();}}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)runCycleCli(process.argv.slice(2)).catch(e=>{console.error(JSON.stringify({code:e instanceof SocialSyncError?e.code:e?.code==="BUSY"?"BUSY":"REFRESH_CYCLE_FAILED"}));process.exitCode=1;});
