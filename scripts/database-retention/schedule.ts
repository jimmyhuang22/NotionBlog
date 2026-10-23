import {constants} from "node:fs";
import {lstat, mkdir, open, rename, unlink, readFile} from "node:fs/promises";
import {dirname, join, resolve} from "node:path";
import {randomUUID} from "node:crypto";
import {spawn} from "node:child_process";
import {sha256} from "./daily.ts";
import {retentionRunLimit} from "./limits.ts";
import {rollingLedgerPath,validateRollingLedger,rollingAdmission,reserveRolling,settleRolling,type RollingLedger,type Usage} from "./rolling-ledger.ts";

export interface ScheduledConfig {
 format:"retention-daily-config-v2"|"retention-after-sync-config-v3";maximumRuns:number;directory:string;archiveDirectory:string;syncState:string;websitePause:string;
 lockFiles:string[];absentLocks:string[];envFile:string;healthURL:string;cli:string;
 tailCatalog:string;tailRunsDirectory:string;programFiles:{path:string;sha256:string}[];
}
interface LastAttempt {status:"PASS"|"STOPPED"|"RUNNING";finishedAt?:number;startedAt?:number;operation?:string;runId?:string}
export function dailyDecision(last:LastAttempt|null,sync:{status:string},at:number){
 if(last&&last.status!=="PASS")return "REQUIRES_REVIEW";
 if(last?.finishedAt!==undefined&&at<last.finishedAt+24*60*60*1000)return "NOT_DUE";
 return sync.status==="PASS"?"READY":"WAITING_FOR_SYNC";
}
async function privateText(path:string){
 const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const s=await file.stat();if(!s.isFile()||s.uid!==process.getuid?.()||(s.mode&0o077)||s.nlink!==1||s.size>2*1024*1024)throw Error("RETENTION_PRIVATE_FILE_INVALID");
  const text=await file.readFile("utf8"),after=await lstat(path);if(s.dev!==after.dev||s.ino!==after.ino||s.mtimeMs!==after.mtimeMs)throw Error("RETENTION_PRIVATE_FILE_CHANGED");return text;
 }finally{await file.close();}
}
async function exists(path:string){try{await lstat(path);return true;}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return false;throw e;}}
async function readRolling(config:ScheduledConfig,at:number){
 for(const path of [config.directory,config.archiveDirectory]){const s=await lstat(path);if(!s.isDirectory()||s.isSymbolicLink()||(s.mode&0o077))throw Error("RETENTION_DIRECTORY_INVALID");}
 const path=rollingLedgerPath(config.archiveDirectory);
 if(!await exists(path))throw Error("RETENTION_ROLLING_LEDGER_REQUIRED");
 const raw=await privateText(path),ledger=validateRollingLedger(JSON.parse(raw),config.directory,config.archiveDirectory,at);
 return {raw,ledger};
}
async function admission(config:ScheduledConfig,last:LastAttempt|null,sync:{status:string;runId?:string},at:number){
 if(config.format==="retention-daily-config-v2")return dailyDecision(last,sync,at);
 if(!last||last.status!=="PASS")return "REQUIRES_REVIEW";
 if(sync.status!=="PASS")return "WAITING_FOR_SYNC";
 const {ledger}=await readRolling(config,at);
 return rollingAdmission(ledger,sync.runId!,at,config.maximumRuns).status;
}
/** A successful pipeline may explicitly preserve a cache-header failure and bind its
 * same-plan continuation. Both immutable receipts remain window proofs. */
export async function verifyVisitorAcceptance(operation:string,runId:string,pipeline:Record<string,unknown>,proof:(path:string)=>Promise<Record<string,unknown>>){
 const reject=()=>{throw Error("RETENTION_VISITOR_NOT_VERIFIED");};
 if(!operation.startsWith("/")||resolve(operation)!==operation)reject();
 const originalPath=join(operation,"acceptance-operation-private/PRODUCTION_VISITOR_RECEIPT_PRIVATE.json");
 const original=await proof(originalPath);
 if(original.runId!==runId||pipeline.status!=="PASS"||pipeline.runId!==runId)reject();
 if(!Object.hasOwn(pipeline,"visitorContinuationReceipt")){
  if(original.status!=="PASS")reject();return {continued:false,receipt:originalPath};
 }
 const path=join(operation,"acceptance-operation-private/PRODUCTION_VISITOR_CONTINUATION_RECEIPT_PRIVATE.json");
 if(pipeline.visitorContinuationReceipt!==path||pipeline.firstAttemptStatus!=="FAIL"||pipeline.firstAttemptReason!=="PRODUCTION-VISITOR_FAILED"||
  original.status!=="FAIL"||original.errorCode!=="VISITOR_CACHE_HEADERS"||typeof original.planSHA256!=="string"||!/^[a-f0-9]{64}$/.test(original.planSHA256))reject();
 let canonicalOrigin=false;
 try{const url=new URL(original.origin as string);canonicalOrigin=url.protocol==="https:"&&url.origin===original.origin;}catch{}
 if(!canonicalOrigin)reject();
 const continuation=await proof(path);
 const first=Date.parse(original.finishedAtUTC as string),last=Date.parse(continuation.finishedAtUTC as string),finished=Date.parse(pipeline.finishedAtUTC as string);
 if(continuation.status!=="PASS"||continuation.runId!==runId||continuation.planSHA256!==original.planSHA256||continuation.origin!==original.origin||
  continuation.priorFailure!==original.errorCode||continuation.continuationPolicy!=="nb-public-cache-v1"||continuation.failure!==null||
  ![first,last,finished].every(Number.isFinite)||last<first||last>finished)reject();
 return {continued:true,receipt:path};
}
/** Read-only operator inspection. No locks, credential access, child process or database calls. */
export async function inspectScheduledReadiness(config:ScheduledConfig){
 if(!["retention-daily-config-v2","retention-after-sync-config-v3"].includes(config.format))throw Error("RETENTION_CONFIG_INVALID");
 retentionRunLimit(config.maximumRuns);
 for(const p of config.programFiles){const s=await lstat(p.path);if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o022)||sha256(await readFile(p.path))!==p.sha256)throw Error("RETENTION_PROGRAM_CHANGED");}
 const stateFile=join(config.directory,"STATE_PRIVATE.json"),last=await exists(stateFile)?JSON.parse(await privateText(stateFile)):null;
 const sync=JSON.parse(await privateText(config.syncState));
 let status:string=await admission(config,last,sync,Date.now());
 if(await exists(join(config.directory,"PAUSED_PRIVATE.json")))status="MANUALLY_PAUSED";
 else if(await exists(config.websitePause))status="WEBSITE_PAUSED";
 return {status,syncStatus:sync.status,sql:0,writes:0,credentialsRead:false,childProcesses:0};
}
/** Never unlinks a busy lock or a replaced lock, including when partial acquisition fails. */
export async function acquireRetentionLocks(paths:readonly string[],nonce:string){
 const owned:{path:string;ino:number;dev:number;sha256:string}[]=[];
 async function release(){
  let okay=true;
  for(const row of [...owned].reverse())try{
   const s=await lstat(row.path);if(s.ino!==row.ino||s.dev!==row.dev||s.isSymbolicLink()||sha256(await privateText(row.path))!==row.sha256){okay=false;continue;}
   await unlink(row.path);
  }catch{okay=false;}
  return okay;
 }
 try{
  for(const path of paths){
   const f=await open(path,"wx",0o600),s=await f.stat(),raw=JSON.stringify({kind:"retention-daily",nonce,pid:process.pid});
   owned.push({path,ino:s.ino,dev:s.dev,sha256:sha256(raw)});
   try{await f.writeFile(raw);await f.sync();}finally{await f.close();}
  }
  return {owned,release};
 }catch(error){
  if(!await release())throw Error("RETENTION_LOCK_RELEASE_REQUIRES_REVIEW");
  if((error as NodeJS.ErrnoException).code==="EEXIST")return null;throw error;
 }
}
/** Separate scheduler: a failed cleanup never changes website sync state or its suspend flag. */
export async function scheduledTick(config:ScheduledConfig){
 if(!["retention-daily-config-v2","retention-after-sync-config-v3"].includes(config.format)||config.lockFiles.length!==4||new Set(config.lockFiles).size!==4||
  !config.absentLocks.length||!config.programFiles.length)throw Error("RETENTION_CONFIG_INVALID");
 const maximumRuns=retentionRunLimit(config.maximumRuns);
 for(const p of [config.directory,config.archiveDirectory,config.syncState,config.websitePause,...config.lockFiles,...config.absentLocks,config.envFile,config.cli,config.tailCatalog,config.tailRunsDirectory])
  if(!p.startsWith("/")||resolve(p)!==p)throw Error("RETENTION_CONFIG_PATH_INVALID");
 await mkdir(config.directory,{mode:0o700,recursive:true});const dir=await lstat(config.directory);
 if(!dir.isDirectory()||dir.isSymbolicLink()||(dir.mode&0o077))throw Error("RETENTION_DIRECTORY_INVALID");
 const stateFile=join(config.directory,"STATE_PRIVATE.json");
 if(await exists(join(config.directory,"PAUSED_PRIVATE.json")))return {status:"MANUALLY_PAUSED"};
 let last:LastAttempt|null=null;if(await exists(stateFile))last=JSON.parse(await privateText(stateFile));
 const syncRaw=await privateText(config.syncState),sync=JSON.parse(syncRaw),decision=await admission(config,last,sync,Date.now());
 if(decision!=="READY")return {status:decision};
 if(await exists(config.websitePause))return {status:"WEBSITE_PAUSED"};
 if([...config.lockFiles,...config.absentLocks].some(p=>!p.startsWith("/")))throw Error("RETENTION_LOCK_PATH_INVALID");
 for(const p of config.absentLocks)if(await exists(p))return {status:"WRITER_BUSY"};
 const operation=randomUUID(),locks=await acquireRetentionLocks(config.lockFiles,operation);if(!locks)return {status:"WRITER_BUSY"};
 let result:{status:string;operation?:string;finishedAt?:number;reason?:string}={status:"STOPPED",operation};
 let stateWritten=false,completionPath:string|undefined;
 let rollingState:RollingLedger|undefined,rollingRaw:string|undefined,settlement:Usage|undefined;
 const save=async(path:string,value:unknown)=>{
  const tmp=path+"."+randomUUID();const f=await open(tmp,"wx",0o600);
  try{await f.writeFile(JSON.stringify(value,null,2)+"\n");await f.sync();}finally{await f.close();}
  await rename(tmp,path);const d=await open(dirname(path),"r");try{await d.sync();}finally{await d.close();}
 };
 try{
  // Close the gap between reading PASS and acquiring the shared admission lock.
  if(await privateText(config.syncState)!==syncRaw)throw Error("RETENTION_SKIP_SYNC_CHANGED");
  const lockedLast=await exists(stateFile)?JSON.parse(await privateText(stateFile)):null;
  if(JSON.stringify(lockedLast)!==JSON.stringify(last))throw Error("RETENTION_SKIP_SYNC_CHANGED");
  if(await exists(config.websitePause))throw Error("RETENTION_SKIP_WEBSITE_PAUSED");
  for(const p of config.absentLocks)if(await exists(p))throw Error("RETENTION_SKIP_WRITER_BUSY");
  const proofs:{path:string;sha256:string}[]=[];
  async function proof(path:string){const raw=await privateText(path);proofs.push({path,sha256:sha256(raw)});return JSON.parse(raw);}
  const pipeline=await proof(join(sync.operation,"PIPELINE_FINISHED_PRIVATE.json"));
  if(pipeline.status!=="PASS"||pipeline.runId!==sync.runId)throw Error("RETENTION_PIPELINE_NOT_VERIFIED");
  for(const path of [
   `thumbnail-post/runs/${sync.runId}/receipt-private.json`,"proved-thumbnail-post/RECEIPT_PRIVATE.json",
   "acceptance-operation-private/SNAPSHOT_RECEIPT_PRIVATE.json",
  ]){const r=await proof(join(sync.operation,path));if(r.status!=="PASS"||r.runId!==sync.runId)throw Error("RETENTION_SAME_BATCH_PROOF_MISSING");}
  await verifyVisitorAcceptance(sync.operation,sync.runId,pipeline,proof);
  if(config.format==="retention-after-sync-config-v3"){
   const directory=await proof(join(sync.operation,"acceptance-operation-private/COURSE_DIRECTORY_PRIVATE.json"));
   if(directory.format!=="published-course-directory-v1"||directory.runId!==sync.runId)throw Error("RETENTION_COURSE_DIRECTORY_NOT_VERIFIED");
  }
  const catalogRaw=await privateText(config.tailCatalog),catalogSHA=sha256(catalogRaw);
  proofs.push({path:config.tailCatalog,sha256:catalogSHA});
  let tail;
  try{tail=await proof(join(config.tailRunsDirectory,sync.runId,catalogSHA,"RECEIPT_PRIVATE.json"));}
  catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")throw Error("RETENTION_SKIP_WAITING_FOR_TAIL");throw error;}
  if(["PENDING","RUNNING"].includes(tail.status)||(tail.status==="PASS"&&(!tail.connectionsClosed||!tail.ownLocksReleased)))throw Error("RETENTION_SKIP_WAITING_FOR_TAIL");
  if(tail.status!=="PASS"||tail.runId!==sync.runId||tail.catalogSHA256!==catalogSHA||!tail.connectionsClosed||!tail.ownLocksReleased||
   [tail.inFlight,tail.unknownWriteGroup,tail.acknowledgedUnverifiedGroup].some(value=>value!==null&&value!==undefined))throw Error("RETENTION_TAIL_NOT_VERIFIED");
  for(const p of config.programFiles){const s=await lstat(p.path);if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o022)||sha256(await readFile(p.path))!==p.sha256)throw Error("RETENTION_PROGRAM_CHANGED");}
  await privateText(config.envFile); // Check permissions without logging or copying values.
  const folder=join(config.directory,operation);await mkdir(folder,{mode:0o700});completionPath=join(folder,"COMPLETION_PRIVATE.json");
  const windowPath=join(folder,"WINDOW_PRIVATE.json"),deadline=Date.now()+30*60*1000;
  let rolling;
  if(config.format==="retention-after-sync-config-v3"){
   const current=await readRolling(config,Date.now());
   rollingState=reserveRolling(current.ledger,sync.runId,operation,Date.now(),maximumRuns);
   await save(rollingLedgerPath(config.archiveDirectory),rollingState);
   rollingRaw=await privateText(rollingLedgerPath(config.archiveDirectory));
   proofs.push({path:rollingLedgerPath(config.archiveDirectory),sha256:sha256(rollingRaw)});
   rolling={reservationId:operation,stateDirectory:config.directory,limits:rollingState.entries.find(e=>e.id===operation)!.reserved};
  }
  await save(windowPath,{format:rolling?"retention-after-sync-window-v3":"retention-daily-window-v2",maximumRuns:rolling?.limits.runs??maximumRuns,runId:sync.runId,deadline,syncState:config.syncState,operation:sync.operation,
   locks:locks.owned,absentLocks:config.absentLocks,proofs,archiveDirectory:config.archiveDirectory,healthURL:config.healthURL,programFiles:config.programFiles,...(rolling?{rolling}:{})});
  await save(stateFile,{status:"RUNNING",operation,startedAt:Date.now(),runId:sync.runId});stateWritten=true;
  const log=await open(join(folder,"PROCESS_PRIVATE.log"),"wx",0o600);
  let code:number|null=null;
  try{
   code=await new Promise<number|null>((resolveCode,reject)=>{
    const child=spawn(process.execPath,["--conditions=react-server",`--env-file=${config.envFile}`,config.cli,"--window",windowPath],
     {stdio:["ignore",log.fd,log.fd],env:{PATH:process.env.PATH??"/usr/bin:/bin",NODE_ENV:"production",NEXT_TELEMETRY_DISABLED:"1"}});
    let hard:ReturnType<typeof setTimeout>|undefined;
    const stop=()=>{child.kill("SIGTERM");hard=setTimeout(()=>child.kill("SIGKILL"),20_000);};
    process.once("SIGTERM",stop);process.once("SIGINT",stop);
    const timer=setTimeout(stop,Math.max(1,deadline-Date.now()));
    const clean=()=>{clearTimeout(timer);clearTimeout(hard);process.removeListener("SIGTERM",stop);process.removeListener("SIGINT",stop);};
    child.once("error",e=>{clean();reject(e);});child.once("exit",c=>{clean();resolveCode(c);});
   });
  }finally{await log.close();}
  result={status:code===0?"PASS":"STOPPED",operation,finishedAt:Date.now()};
  if(rollingState&&code===0){
   const usage=JSON.parse(await privateText(join(folder,"USAGE_PRIVATE.json")));
   if(usage.status!=="PASS"||usage.reservationId!==operation||usage.runId!==sync.runId||usage.windowSHA256!==sha256(await privateText(windowPath))||usage.connectionsClosed!==true)
    throw Error("RETENTION_ROLLING_USAGE_INVALID");
   settlement={runs:usage.runs,returnedBytes:usage.returnedBytes,deleteCalls:usage.deleteCalls,deletedRows:usage.deletedRows};
   settleRolling(rollingState,operation,settlement,Date.now()); // Validate before releasing any reservation.
   if(await privateText(rollingLedgerPath(config.archiveDirectory))!==rollingRaw)throw Error("RETENTION_ROLLING_LEDGER_CHANGED");
  }
 }catch(error){
  if(!stateWritten&&error instanceof Error&&error.message.startsWith("RETENTION_SKIP_"))result={status:error.message.slice("RETENTION_SKIP_".length)};
  else{result={status:"STOPPED",operation,finishedAt:Date.now(),reason:error instanceof Error&&/^RETENTION_[A-Z_]+$/.test(error.message)?error.message:"RETENTION_REQUIRES_REVIEW"};stateWritten=true;}
 }finally{
  if(!await locks.release()){result={status:"STOPPED",operation,finishedAt:Date.now(),reason:"RETENTION_LOCK_RELEASE_REQUIRES_REVIEW"};stateWritten=true;}
  if(rollingState&&result.status==="PASS"&&settlement){
   try{
    if(await privateText(rollingLedgerPath(config.archiveDirectory))!==rollingRaw)throw Error("RETENTION_ROLLING_LEDGER_CHANGED");
    await save(rollingLedgerPath(config.archiveDirectory),settleRolling(rollingState,operation,settlement,Date.now()));
   }catch{result={status:"STOPPED",operation,finishedAt:Date.now(),reason:"RETENTION_ROLLING_SETTLEMENT_REQUIRES_REVIEW"};}
  }
  if(completionPath)await save(completionPath,{...result,runId:sync.runId,automaticRetry:false});
  if(stateWritten)await save(stateFile,{...result,...(config.format==="retention-after-sync-config-v3"?{runId:sync.runId}:{})});
 }
 return result;
}
