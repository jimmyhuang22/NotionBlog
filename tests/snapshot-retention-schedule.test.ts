import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,readFile,lstat,unlink,rm,chmod,symlink,mkdir,readdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {acquireRetentionLocks,dailyDecision,scheduledTick,inspectScheduledReadiness,verifyVisitorAcceptance,MAXIMUM_CONSECUTIVE_DEFERRALS,RETENTION_DEFERRED_EXIT_CODE,type ScheduledConfig} from "../scripts/database-retention/schedule.ts";
import {createArchiveStore} from "../scripts/database-retention/archive.ts";
import {sha256} from "../scripts/database-retention/daily.ts";

test("daily admission waits for full sync, applies 24h cooldown and never retries failed/unknown attempts",()=>{
 assert.equal(dailyDecision(null,{status:"RUNNING"},0),"WAITING_FOR_SYNC");
 assert.equal(dailyDecision(null,{status:"PASS"},0),"READY");
 assert.equal(dailyDecision({status:"PASS",finishedAt:0},{status:"PASS"},86_399_999),"NOT_DUE");
 assert.equal(dailyDecision({status:"PASS",finishedAt:0},{status:"PASS"},86_400_000),"READY");
 for(const status of ["RUNNING","STOPPED"] as const)assert.equal(dailyDecision({status},{status:"PASS"},1e12),"REQUIRES_REVIEW");
});
test("partial lock acquisition preserves the busy writer and releases only owned locks",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"retention-locks-"));
 try{const paths=[0,1,2,3].map(n=>join(dir,String(n)));await writeFile(paths[2],"other owner",{mode:0o600});
  assert.equal(await acquireRetentionLocks(paths,"nonce"),null);
  assert.equal(await readFile(paths[2],"utf8"),"other owner");
  for(const i of [0,1,3])await assert.rejects(lstat(paths[i]),{code:"ENOENT"});
 }finally{await rm(dir,{recursive:true,force:true});}
});
test("lock release leaves a replacement owned by another process untouched",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"retention-locks-"));
 try{const paths=[0,1].map(n=>join(dir,String(n))),held=await acquireRetentionLocks(paths,"nonce");assert.ok(held);
  await unlink(paths[0]);await writeFile(paths[0],"replacement",{mode:0o600});
  assert.equal(await held.release(),false);assert.equal(await readFile(paths[0],"utf8"),"replacement");
  await assert.rejects(lstat(paths[1]),{code:"ENOENT"});
 }finally{await rm(dir,{recursive:true,force:true});}
});
const readiness={readinessURL:"https://example.org/api/internal/content-readiness",readinessSample:{id:"synthetic-status-id",slug:"synthetic-status"}};
const runId="00000000-0000-0000-0000-000000000001";
async function privateWrite(path:string,value:unknown){
 await mkdir(path.slice(0,path.lastIndexOf("/")),{recursive:true,mode:0o700});
 await writeFile(path,typeof value==="string"?value:JSON.stringify(value),{mode:0o600});
}
/** A finished round folder as the coordinator writes it, including the body tail inside the round. */
async function roundFixture(dir:string,{tail=true,tailFolders=1,finishedAtUTC="2026-01-01T00:00:00Z",receipt={} as Record<string,unknown>}={}){
 const operation=join(dir,"operation"),sync=join(dir,"sync.json");
 for(const name of ["PIPELINE_FINISHED_PRIVATE.json",`thumbnail-post/runs/${runId}/receipt-private.json`,"proved-thumbnail-post/RECEIPT_PRIVATE.json",
  "acceptance-operation-private/PRODUCTION_VISITOR_RECEIPT_PRIVATE.json","acceptance-operation-private/SNAPSHOT_RECEIPT_PRIVATE.json"])
  await privateWrite(join(operation,name),{status:"PASS",runId});
 await privateWrite(sync,{status:"PASS",runId,operation,finishedAtUTC});
 await privateWrite(join(operation,"body-post/CATALOG_PRIVATE.json"),"{}");
 if(tail)for(let n=0;n<tailFolders;n++)await privateWrite(join(operation,"body-post/runs",runId,String(n).repeat(64),"RECEIPT_PRIVATE.json"),
  {status:"PASS",runId,operation,catalogSHA256:sha256("{}"),connectionsClosed:true,ownLocksReleased:true,inFlight:null,unknownWriteGroup:null,acknowledgedUnverifiedGroup:null,...receipt});
 return {operation,sync};
}
function configFor(dir:string,sync:string,extra:Partial<ScheduledConfig>={}):ScheduledConfig{
 return {format:"retention-daily-config-v4",maximumRuns:2,chunkRows:100,deleteTimeoutSeconds:20,settleMinutes:0,directory:join(dir,"maintenance"),archiveDirectory:join(dir,"archive"),syncState:sync,
  lockFiles:[0,1,2,3].map(n=>join(dir,`lock${n}`)),absentLocks:[join(dir,"native")],envFile:join(dir,"missing.env"),...readiness,cli:join(dir,"missing.ts"),
  programFiles:[{path:join(dir,"missing.ts"),sha256:"a".repeat(64)}],...extra};
}
/** A stand-in CLI that records its window and exits with the given code. */
async function fakeCli(dir:string,code:number){
 const cli=join(dir,"fake-cli.mjs"),envFile=join(dir,"empty.env");
 const program=`import {readFile,writeFile} from 'node:fs/promises';import {dirname,join} from 'node:path';
  const path=process.argv.at(-1),window=JSON.parse(await readFile(path,'utf8'));
  await writeFile(join(dirname(path),'OBSERVED_PRIVATE.json'),JSON.stringify(window),{mode:0o600});process.exitCode=${code};`;
 await privateWrite(cli,program);await privateWrite(envFile,"");
 return {cli,envFile,programFiles:[{path:cli,sha256:sha256(program)}]};
}

test("v4 admission settles after a passed round and only retries clean stops a bounded number of times",()=>{
 const sync={status:"PASS",finishedAtUTC:"2026-01-01T00:00:00Z"},finished=Date.parse(sync.finishedAtUTC);
 assert.equal(dailyDecision(null,sync,finished+179*60_000,180),"SETTLING");
 assert.equal(dailyDecision(null,sync,finished+180*60_000,180),"READY");
 assert.equal(dailyDecision(null,{status:"PASS"},finished,180),"WAITING_FOR_SYNC");
 assert.equal(dailyDecision(null,{status:"PUBLISHED_POST_INCOMPLETE",finishedAtUTC:sync.finishedAtUTC},finished+1e9,180),"WAITING_FOR_SYNC");
 assert.equal(dailyDecision({status:"DEFERRED",finishedAt:0,deferrals:1},sync,86_399_999),"NOT_DUE");
 assert.equal(dailyDecision({status:"DEFERRED",finishedAt:0,deferrals:MAXIMUM_CONSECUTIVE_DEFERRALS-1},sync,86_400_000),"READY");
 for(const deferrals of [MAXIMUM_CONSECUTIVE_DEFERRALS,undefined,1.5,-1,0])
  assert.equal(dailyDecision({status:"DEFERRED",finishedAt:0,deferrals},sync,1e12),"REQUIRES_REVIEW");
});

test("a busy website round does not read credentials, write state or create an archive",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"retention-schedule-"));
 try{
  const sync=join(dir,"sync.json"),program=join(dir,"program.ts");await privateWrite(program,"// frozen test fixture");
  await privateWrite(sync,{status:"RUNNING"});
  const config=configFor(dir,sync,{programFiles:[{path:program,sha256:sha256("// frozen test fixture")}]});await privateWrite(config.lockFiles[1],"writer");
  assert.deepEqual(await inspectScheduledReadiness(config),{status:"WAITING_FOR_SYNC",syncStatus:"RUNNING",sql:0,writes:0,credentialsRead:false,childProcesses:0});
  assert.deepEqual(await scheduledTick(config),{status:"WAITING_FOR_SYNC"});
  await privateWrite(sync,{status:"PASS",runId,operation:join(dir,"operation")});assert.deepEqual(await scheduledTick(config),{status:"WRITER_BUSY"});
  for(const p of [config.archiveDirectory,join(config.directory,"STATE_PRIVATE.json")])await assert.rejects(lstat(p),{code:"ENOENT"});
  assert.equal(await readFile(config.lockFiles[1],"utf8"),"writer");
  await writeFile(join(config.directory,"PAUSED_PRIVATE.json"),"{}",{mode:0o600});
  assert.deepEqual(await scheduledTick(config),{status:"MANUALLY_PAUSED"});
  assert.equal((await inspectScheduledReadiness(config)).status,"MANUALLY_PAUSED");
 }finally{await rm(dir,{recursive:true,force:true});}
});

test("the body tail is read from the round's own folder and waits without marking cleanup failed",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"retention-tail-gap-"));
 try{
  const {sync}=await roundFixture(dir,{tail:false}),config=configFor(dir,sync);
  assert.deepEqual(await scheduledTick(config),{status:"WAITING_FOR_TAIL"});
  for(const p of [...config.lockFiles,join(dir,"maintenance/STATE_PRIVATE.json")])await assert.rejects(lstat(p),{code:"ENOENT"});
 }finally{await rm(dir,{recursive:true,force:true});}
 for(const [options,label] of [[{tailFolders:2},"two tail folders"],[{receipt:{operation:"/elsewhere"}},"another round's receipt"],
  [{receipt:{catalogSHA256:"b".repeat(64)}},"another catalog"],[{receipt:{unknownWriteGroup:0}},"an unknown write group"]] as const){
  const dir=await mkdtemp(join(tmpdir(),"retention-tail-bad-"));
  try{
   const {sync}=await roundFixture(dir,options),result=await scheduledTick(configFor(dir,sync));
   assert.equal(result.status,"STOPPED",label);assert.equal(result.reason,"RETENTION_TAIL_NOT_VERIFIED",label);
  }finally{await rm(dir,{recursive:true,force:true});}
 }
});

test("invalid scheduler limits fail before filesystem admission or credential access",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"retention-invalid-limit-"));
 try{
  const config=configFor(dir,join(dir,"missing-sync"),{directory:join(dir,"not-created")});
  for(const [field,values,error] of [["maximumRuns",[undefined,null,0,-1,3,8,1.5,"2"],/RETENTION_RUN_LIMIT_INVALID/],
   ["chunkRows",[undefined,0,501,2.5,"100"],/RETENTION_CHUNK_ROWS_INVALID/],["deleteTimeoutSeconds",[undefined,7,31,8.5,"20"],/RETENTION_DELETE_TIMEOUT_INVALID/],["settleMinutes",[undefined,-1,1441,0.5],/RETENTION_SETTLE_INVALID/]] as const){
   for(const value of values){
    const invalid={...config,[field]:value} as ScheduledConfig;
    await assert.rejects(inspectScheduledReadiness(invalid),error);await assert.rejects(scheduledTick(invalid),error);
   }
  }
  await assert.rejects(scheduledTick({...config,format:"retention-daily-config-v3"} as unknown as ScheduledConfig),/RETENTION_CONFIG_INVALID/);
  await assert.rejects(lstat(config.directory),{code:"ENOENT"});
  for(const lock of config.lockFiles)await assert.rejects(lstat(lock),{code:"ENOENT"});
 }finally{await rm(dir,{recursive:true,force:true});}
});

test("the run limit, chunk size and round proofs reach the spawned window unchanged",async()=>{
 for(const maximumRuns of [1,2]){
  const dir=await mkdtemp(join(tmpdir(),"retention-window-limit-"));
  try{
   const {operation,sync}=await roundFixture(dir);
   const visitor=join(operation,"acceptance-operation-private/PRODUCTION_VISITOR_RECEIPT_PRIVATE.json");
   const continuation=join(operation,"acceptance-operation-private/PRODUCTION_VISITOR_CONTINUATION_RECEIPT_PRIVATE.json");
   if(maximumRuns===2){
    await privateWrite(join(operation,"PIPELINE_FINISHED_PRIVATE.json"),{status:"PASS",runId,firstAttemptStatus:"FAIL",firstAttemptReason:"PRODUCTION-VISITOR_FAILED",visitorContinuationReceipt:continuation,finishedAtUTC:"2026-01-01T00:02:00Z"});
    await privateWrite(visitor,{status:"FAIL",runId,errorCode:"VISITOR_CACHE_HEADERS",planSHA256:"a".repeat(64),origin:"https://example.org",finishedAtUTC:"2026-01-01T00:00:00Z"});
    await privateWrite(continuation,{status:"PASS",runId,planSHA256:"a".repeat(64),origin:"https://example.org",priorFailure:"VISITOR_CACHE_HEADERS",continuationPolicy:"nb-public-cache-v1",failure:null,finishedAtUTC:"2026-01-01T00:01:00Z"});
   }
   const config=configFor(dir,sync,{maximumRuns,chunkRows:25,...await fakeCli(dir,0)});
   const result=await scheduledTick(config);assert.equal(result.status,"PASS");assert.ok(result.operation);
   const observed=JSON.parse(await readFile(join(config.directory,result.operation,"OBSERVED_PRIVATE.json"),"utf8"));
   assert.equal(observed.maximumRuns,maximumRuns);assert.equal(observed.chunkRows,25);assert.equal(observed.deleteTimeoutSeconds,20);assert.equal(observed.format,"retention-daily-window-v4");
   assert.equal(observed.readinessURL,config.readinessURL);assert.deepEqual(observed.readinessSample,config.readinessSample);
   assert.equal(Object.hasOwn(observed,"healthURL"),false);assert.equal(Object.hasOwn(observed,"RETENTION_READINESS_SECRET"),false);
   const bound=[...(maximumRuns===2?[visitor,continuation]:[visitor]),join(operation,"body-post/CATALOG_PRIVATE.json"),
    join(operation,"body-post/runs",runId,"0".repeat(64),"RECEIPT_PRIVATE.json")];
   for(const path of bound){
    const expected=sha256(await readFile(path,"utf8"));
    assert.ok(observed.proofs.some((p:{path:string;sha256:string})=>p.path===path&&p.sha256===expected),path);
   }
   assert.equal((await readdir(config.directory)).filter(name=>name!=="STATE_PRIVATE.json").length,1);
   for(const lock of config.lockFiles)await assert.rejects(lstat(lock),{code:"ENOENT"});
  }finally{await rm(dir,{recursive:true,force:true});}
 }
});

test("the retired website-sync suspend flag no longer blocks a passed round",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"retention-suspend-"));
 try{
  const {sync}=await roundFixture(dir);await privateWrite(join(dir,"notionblog-website-sync.suspend"),"qualified maintenance paused");
  const result=await scheduledTick(configFor(dir,sync,await fakeCli(dir,0)));assert.equal(result.status,"PASS");
 }finally{await rm(dir,{recursive:true,force:true});}
});

test("a clean stop defers to the next day and turns into review after repeated deferrals",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"retention-deferred-"));
 try{
  const {sync}=await roundFixture(dir),config=configFor(dir,sync,await fakeCli(dir,RETENTION_DEFERRED_EXIT_CODE));
  const stateFile=join(config.directory,"STATE_PRIVATE.json");
  for(let n=1;n<=MAXIMUM_CONSECUTIVE_DEFERRALS;n++){
   const result=await scheduledTick(config);assert.equal(result.status,"DEFERRED");assert.equal(result.deferrals,n);
   const state=JSON.parse(await readFile(stateFile,"utf8"));assert.equal(state.deferrals,n);
   // The last allowed clean stop asks for review at once instead of waiting another day.
   assert.deepEqual(await scheduledTick(config),{status:n<MAXIMUM_CONSECUTIVE_DEFERRALS?"NOT_DUE":"REQUIRES_REVIEW"});
   for(const lock of config.lockFiles)await assert.rejects(lstat(lock),{code:"ENOENT"});
   // Move the last attempt back a day, as if the next daily window had arrived.
   await writeFile(stateFile,JSON.stringify({...state,finishedAt:state.finishedAt-86_400_000}),{mode:0o600});
  }
  assert.deepEqual(await scheduledTick(config),{status:"REQUIRES_REVIEW"});
 }finally{await rm(dir,{recursive:true,force:true});}
 const failed=await mkdtemp(join(tmpdir(),"retention-failed-"));
 try{
  const {sync}=await roundFixture(failed),config=configFor(failed,sync,await fakeCli(failed,1));
  assert.equal((await scheduledTick(config)).status,"STOPPED");assert.deepEqual(await scheduledTick(config),{status:"REQUIRES_REVIEW"});
 }finally{await rm(failed,{recursive:true,force:true});}
});

test("archives enforce private permissions, immutable readback and exact content hashes",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"retention-archive-"));
 try{
  const store=await createArchiveStore(join(dir,"archive")),raw='{"id": "x", "number": 9007199254740993, "value": 7.0}',hash=sha256(raw);
  await store.putBlob("nb_v2.records",hash,raw);assert.equal(await store.getBlob("nb_v2.records",hash),raw);
  await assert.rejects(store.putBlob("nb_v2.records",hash,raw+" "),/HASH_MISMATCH/);
  await assert.rejects(store.save("../escape",{}),/PATH_INVALID/);
  await store.save("immutable",{n:1});await assert.rejects(store.save("immutable",{n:2}));
  const bad=join(dir,"wide");await mkdir(bad);await chmod(bad,0o755);await assert.rejects(createArchiveStore(bad),/PERMISSIONS/);
  await symlink(join(dir,"archive"),join(dir,"symlink"));await assert.rejects(createArchiveStore(join(dir,"symlink")),/PERMISSIONS/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test("cache-header continuation binds the original failure and the exact same-plan success",async()=>{
 const operation="/private/fixture/operation",runId="00000000-0000-0000-0000-000000000001";
 const originalPath=join(operation,"acceptance-operation-private/PRODUCTION_VISITOR_RECEIPT_PRIVATE.json");
 const path=join(operation,"acceptance-operation-private/PRODUCTION_VISITOR_CONTINUATION_RECEIPT_PRIVATE.json");
 const original={status:"FAIL",runId,errorCode:"VISITOR_CACHE_HEADERS",planSHA256:"a".repeat(64),origin:"https://example.org",finishedAtUTC:"2026-01-01T00:00:00Z"};
 const continuation={status:"PASS",runId,planSHA256:original.planSHA256,origin:original.origin,priorFailure:"VISITOR_CACHE_HEADERS",continuationPolicy:"nb-public-cache-v1",failure:null,finishedAtUTC:"2026-01-01T00:01:00Z"};
 const pipeline={status:"PASS",runId,firstAttemptStatus:"FAIL",firstAttemptReason:"PRODUCTION-VISITOR_FAILED",visitorContinuationReceipt:path,finishedAtUTC:"2026-01-01T00:02:00Z"};
 const observed:string[]=[];
 const proof=async(p:string)=>{observed.push(p);return p===originalPath?original:continuation;};
 assert.deepEqual(await verifyVisitorAcceptance(operation,runId,pipeline,proof),{continued:true,receipt:path});
 assert.deepEqual(observed,[originalPath,path]);
 assert.equal(original.status,"FAIL");
 assert.deepEqual(await verifyVisitorAcceptance(operation,runId,{status:"PASS",runId},async()=>({status:"PASS",runId})),{continued:false,receipt:originalPath});
 for(const bad of [
  {status:"FAIL"}, {runId:"00000000-0000-0000-0000-000000000002"}, {planSHA256:"b".repeat(64)},
  {origin:"https://other.example.org"}, {priorFailure:"OTHER_FAILURE"}, {continuationPolicy:"unknown"},
  {failure:"unresolved"}, {finishedAtUTC:"2025-12-31T23:59:59Z"}, {finishedAtUTC:"2026-01-01T00:03:00Z"}, {finishedAtUTC:null},
 ])await assert.rejects(verifyVisitorAcceptance(operation,runId,pipeline,async p=>p===originalPath?original:{...continuation,...bad}),/RETENTION_VISITOR_NOT_VERIFIED/);
 for(const bad of [{visitorContinuationReceipt:"/private/another/receipt.json"},{visitorContinuationReceipt:null},{status:"FAIL"},{runId:"other"},{firstAttemptReason:"OTHER_FAILURE"}]){
  let reads=0;
  await assert.rejects(verifyVisitorAcceptance(operation,runId,{...pipeline,...bad},async()=>{reads++;return original;}),/RETENTION_VISITOR_NOT_VERIFIED/);
  assert.equal(reads,1);
 }
 for(const bad of [{status:"PASS"},{errorCode:"OTHER_FAILURE"},{planSHA256:"invalid"},{origin:"https://user:password@example.org"}]){
  await assert.rejects(verifyVisitorAcceptance(operation,runId,pipeline,async p=>p===originalPath?{...original,...bad}:continuation),/RETENTION_VISITOR_NOT_VERIFIED/);
 }
 await assert.rejects(verifyVisitorAcceptance(operation,runId,{status:"PASS",runId},async()=>original),/RETENTION_VISITOR_NOT_VERIFIED/);
});
