import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,readFile,lstat,unlink,rm,chmod,symlink,mkdir,readdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {acquireRetentionLocks,dailyDecision,scheduledTick,inspectScheduledReadiness,verifyVisitorAcceptance,type ScheduledConfig} from "../scripts/database-retention/schedule.ts";
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
test("a busy website round does not read credentials, write state, pause sync or create an archive",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"retention-schedule-"));
 try{
  const sync=join(dir,"sync.json"),pause=join(dir,"pause"),locks=[0,1,2,3].map(n=>join(dir,`lock${n}`));
  const program=join(dir,"program.ts");await writeFile(program,"// frozen test fixture",{mode:0o600});
  await writeFile(sync,JSON.stringify({status:"RUNNING"}),{mode:0o600});await writeFile(locks[1],"writer",{mode:0o600});
  const config:ScheduledConfig={format:"retention-daily-config-v2",maximumRuns:2,directory:join(dir,"maintenance"),archiveDirectory:join(dir,"archive"),syncState:sync,websitePause:pause,
   lockFiles:locks,absentLocks:[join(dir,"native")],envFile:join(dir,"missing.env"),healthURL:"https://example.org/api/health/content",cli:join(dir,"missing.ts"),
   tailCatalog:join(dir,"missing.json"),tailRunsDirectory:join(dir,"runs"),programFiles:[{path:program,sha256:sha256("// frozen test fixture")}]};
  assert.deepEqual(await inspectScheduledReadiness(config),{status:"WAITING_FOR_SYNC",syncStatus:"RUNNING",sql:0,writes:0,credentialsRead:false,childProcesses:0});
  assert.deepEqual(await scheduledTick(config),{status:"WAITING_FOR_SYNC"});
  await writeFile(sync,JSON.stringify({status:"PASS"}),{mode:0o600});assert.deepEqual(await scheduledTick(config),{status:"WRITER_BUSY"});
  for(const p of [pause,config.archiveDirectory,join(config.directory,"STATE_PRIVATE.json")])await assert.rejects(lstat(p),{code:"ENOENT"});
  assert.equal(await readFile(locks[1],"utf8"),"writer");
  await writeFile(join(config.directory,"PAUSED_PRIVATE.json"),"{}",{mode:0o600});
  assert.deepEqual(await scheduledTick(config),{status:"MANUALLY_PAUSED"});
 }finally{await rm(dir,{recursive:true,force:true});}
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

test("the gap between successful acceptance and the 1600 tail waits without marking cleanup failed",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"retention-tail-gap-"));
 try{
  const runId="00000000-0000-0000-0000-000000000001",operation=join(dir,"operation"),sync=join(dir,"sync.json"),catalog=join(dir,"catalog.json");
  for(const name of ["PIPELINE_FINISHED_PRIVATE.json",`thumbnail-post/runs/${runId}/receipt-private.json`,"proved-thumbnail-post/RECEIPT_PRIVATE.json",
   "acceptance-operation-private/PRODUCTION_VISITOR_RECEIPT_PRIVATE.json","acceptance-operation-private/SNAPSHOT_RECEIPT_PRIVATE.json"]){
   const path=join(operation,name);await mkdir(path.slice(0,path.lastIndexOf("/")),{mode:0o700,recursive:true});
   await writeFile(path,JSON.stringify({status:"PASS",runId}),{mode:0o600});
  }
  await writeFile(sync,JSON.stringify({status:"PASS",runId,operation}),{mode:0o600});await writeFile(catalog,"{}",{mode:0o600});
  const locks=[0,1,2,3].map(n=>join(dir,`lock${n}`));
  const result=await scheduledTick({format:"retention-daily-config-v2",maximumRuns:2,directory:join(dir,"maintenance"),archiveDirectory:join(dir,"archive"),syncState:sync,
   websitePause:join(dir,"pause"),lockFiles:locks,absentLocks:[join(dir,"native")],envFile:join(dir,"missing.env"),healthURL:"https://example.org/api/health/content",cli:join(dir,"missing.ts"),
   tailCatalog:catalog,tailRunsDirectory:join(dir,"tail-runs"),programFiles:[{path:join(dir,"missing.ts"),sha256:"a".repeat(64)}]});
  assert.deepEqual(result,{status:"WAITING_FOR_TAIL"});
  for(const p of [...locks,join(dir,"maintenance/STATE_PRIVATE.json")])await assert.rejects(lstat(p),{code:"ENOENT"});
  const tailDirectory=join(dir,"tail-runs",runId,sha256("{}"));await mkdir(tailDirectory,{recursive:true,mode:0o700});
  await writeFile(join(tailDirectory,"RECEIPT_PRIVATE.json"),JSON.stringify({status:"PASS",runId,catalogSHA256:sha256("{}"),connectionsClosed:true,ownLocksReleased:true,
   inFlight:null,unknownWriteGroup:0,acknowledgedUnverifiedGroup:null}),{mode:0o600});
  const rejected=await scheduledTick({format:"retention-daily-config-v2",maximumRuns:2,directory:join(dir,"maintenance"),archiveDirectory:join(dir,"archive"),syncState:sync,
   websitePause:join(dir,"pause"),lockFiles:locks,absentLocks:[join(dir,"native")],envFile:join(dir,"missing.env"),healthURL:"https://example.org/api/health/content",cli:join(dir,"missing.ts"),
   tailCatalog:catalog,tailRunsDirectory:join(dir,"tail-runs"),programFiles:[{path:join(dir,"missing.ts"),sha256:"a".repeat(64)}]});
  assert.equal(rejected.status,"STOPPED");assert.equal(rejected.reason,"RETENTION_TAIL_NOT_VERIFIED");
 }finally{await rm(dir,{recursive:true,force:true});}
});

test("invalid scheduler limits fail before filesystem admission or credential access",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"retention-invalid-limit-"));
 try{
  const config:ScheduledConfig={format:"retention-daily-config-v2",maximumRuns:2,directory:join(dir,"not-created"),archiveDirectory:join(dir,"archive"),
   syncState:join(dir,"missing-sync"),websitePause:join(dir,"pause"),lockFiles:[0,1,2,3].map(n=>join(dir,`lock${n}`)),
   absentLocks:[join(dir,"native")],envFile:join(dir,"missing-secret"),healthURL:"https://example.org/api/health/content",cli:join(dir,"cli.ts"),
   tailCatalog:join(dir,"catalog"),tailRunsDirectory:join(dir,"runs"),programFiles:[{path:join(dir,"missing-program"),sha256:"a".repeat(64)}]};
  for(const value of [undefined,null,0,-1,3,8,1.5,"2"]){
   const invalid={...config,maximumRuns:value as number};
   await assert.rejects(inspectScheduledReadiness(invalid),/RETENTION_RUN_LIMIT_INVALID/);
   await assert.rejects(scheduledTick(invalid),/RETENTION_RUN_LIMIT_INVALID/);
  }
  await assert.rejects(lstat(config.directory),{code:"ENOENT"});
  for(const lock of config.lockFiles)await assert.rejects(lstat(lock),{code:"ENOENT"});
 }finally{await rm(dir,{recursive:true,force:true});}
});

test("the selected one-or-two run limit reaches the actual spawned window unchanged",async()=>{
 for(const maximumRuns of [1,2]){
  const dir=await mkdtemp(join(tmpdir(),"retention-window-limit-"));
  try{
   const runId="00000000-0000-0000-0000-000000000001",operation=join(dir,"operation"),sync=join(dir,"sync.json"),catalog=join(dir,"catalog.json");
   for(const name of ["PIPELINE_FINISHED_PRIVATE.json",`thumbnail-post/runs/${runId}/receipt-private.json`,"proved-thumbnail-post/RECEIPT_PRIVATE.json",
    "acceptance-operation-private/PRODUCTION_VISITOR_RECEIPT_PRIVATE.json","acceptance-operation-private/SNAPSHOT_RECEIPT_PRIVATE.json"]){
    const path=join(operation,name);await mkdir(path.slice(0,path.lastIndexOf("/")),{recursive:true,mode:0o700});
    await writeFile(path,JSON.stringify({status:"PASS",runId}),{mode:0o600});
   }
   await writeFile(sync,JSON.stringify({status:"PASS",runId,operation}),{mode:0o600});await writeFile(catalog,"{}",{mode:0o600});
   const visitor=join(operation,"acceptance-operation-private/PRODUCTION_VISITOR_RECEIPT_PRIVATE.json");
   const continuation=join(operation,"acceptance-operation-private/PRODUCTION_VISITOR_CONTINUATION_RECEIPT_PRIVATE.json");
   if(maximumRuns===2){
    await writeFile(join(operation,"PIPELINE_FINISHED_PRIVATE.json"),JSON.stringify({status:"PASS",runId,firstAttemptStatus:"FAIL",firstAttemptReason:"PRODUCTION-VISITOR_FAILED",visitorContinuationReceipt:continuation,finishedAtUTC:"2026-01-01T00:02:00Z"}),{mode:0o600});
    await writeFile(visitor,JSON.stringify({status:"FAIL",runId,errorCode:"VISITOR_CACHE_HEADERS",planSHA256:"a".repeat(64),origin:"https://example.org",finishedAtUTC:"2026-01-01T00:00:00Z"}),{mode:0o600});
    await writeFile(continuation,JSON.stringify({status:"PASS",runId,planSHA256:"a".repeat(64),origin:"https://example.org",priorFailure:"VISITOR_CACHE_HEADERS",continuationPolicy:"nb-public-cache-v1",failure:null,finishedAtUTC:"2026-01-01T00:01:00Z"}),{mode:0o600});
   }
   const tail=join(dir,"tail",runId,sha256("{}"));await mkdir(tail,{recursive:true,mode:0o700});
   await writeFile(join(tail,"RECEIPT_PRIVATE.json"),JSON.stringify({status:"PASS",runId,catalogSHA256:sha256("{}"),connectionsClosed:true,
    ownLocksReleased:true,inFlight:null,unknownWriteGroup:null,acknowledgedUnverifiedGroup:null}),{mode:0o600});
   const envFile=join(dir,"empty.env"),cli=join(dir,"inspect-window.mjs");await writeFile(envFile,"",{mode:0o600});
   const program=`import {readFile,writeFile} from 'node:fs/promises';import {dirname,join} from 'node:path';
    const path=process.argv.at(-1),window=JSON.parse(await readFile(path,'utf8'));
    await writeFile(join(dirname(path),'OBSERVED_PRIVATE.json'),JSON.stringify({maximumRuns:window.maximumRuns,format:window.format,proofs:window.proofs}),{mode:0o600});`;
   await writeFile(cli,program,{mode:0o600});
   const config:ScheduledConfig={format:"retention-daily-config-v2",maximumRuns,directory:join(dir,"maintenance"),archiveDirectory:join(dir,"archive"),
    syncState:sync,websitePause:join(dir,"pause"),lockFiles:[0,1,2,3].map(n=>join(dir,`lock${n}`)),absentLocks:[join(dir,"native")],envFile,
    healthURL:"https://example.org/api/health/content",cli,tailCatalog:catalog,tailRunsDirectory:join(dir,"tail"),programFiles:[{path:cli,sha256:sha256(program)}]};
   const result=await scheduledTick(config);assert.equal(result.status,"PASS");assert.ok(result.operation);
   const observed=JSON.parse(await readFile(join(config.directory,result.operation,"OBSERVED_PRIVATE.json"),"utf8"));
   assert.equal(observed.maximumRuns,maximumRuns);assert.equal(observed.format,"retention-daily-window-v2");
   for(const path of maximumRuns===2?[visitor,continuation]:[visitor]){
    const expected=sha256(await readFile(path,"utf8"));
    assert.ok(observed.proofs.some((p:{path:string;sha256:string})=>p.path===path&&p.sha256===expected));
   }
   assert.equal((await readdir(config.directory)).filter(name=>name!=="STATE_PRIVATE.json").length,1);
   for(const lock of config.lockFiles)await assert.rejects(lstat(lock),{code:"ENOENT"});
  }finally{await rm(dir,{recursive:true,force:true});}
 }
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
