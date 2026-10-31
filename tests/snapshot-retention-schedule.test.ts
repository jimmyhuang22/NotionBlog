import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,readFile,lstat,unlink,rm,chmod,symlink,mkdir,readdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {acquireRetentionLocks,dailyDecision,scheduledTick,inspectScheduledReadiness,MAXIMUM_CONSECUTIVE_DEFERRALS,RETENTION_DEFERRED_EXIT_CODE,type ScheduledConfig} from "../scripts/database-retention/schedule.ts";
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
/** A finished round as the coordinator writes it: published + reader-verified, then either a full PASS or a close-out. */
async function roundFixture(dir:string,{status="PUBLISHED_POST_INCOMPLETE",finishedAtUTC="2026-01-01T00:00:00Z",source={} as Record<string,unknown>,
 close=true as boolean|Record<string,unknown>,adoption=true as boolean|Record<string,unknown>}={}){
 const operation=join(dir,"operation"),sync=join(dir,"sync.json");
 await privateWrite(sync,{status,runId,operation,finishedAtUTC});
 await privateWrite(join(operation,"SOURCE_DRIVER_PRIVATE.json"),{status:"PASS",runId,published:true,readerVerified:true,...source});
 if(status==="PASS")await privateWrite(join(operation,"PIPELINE_FINISHED_PRIVATE.json"),{status:"PASS",runId});
 else if(close)await privateWrite(join(operation,"CLOSE_PUBLISHED_PRIVATE.json"),{status:"PASS",publishedRunId:runId,state:status,maintenanceLockReleased:true,...(close===true?{}:close)});
 if(adoption)await privateWrite(join(dir,"s13-latest.json"),{status:"ADOPTED_VERIFIED",runId,exitCode:0,...(adoption===true?{}:adoption)});
 return {operation,sync};
}
function configFor(dir:string,sync:string,extra:Partial<ScheduledConfig>={}):ScheduledConfig{
 return {format:"retention-daily-config-v5",maximumRuns:2,chunkRows:100,deleteTimeoutSeconds:20,settleMinutes:0,directory:join(dir,"maintenance"),archiveDirectory:join(dir,"archive"),syncState:sync,
  lockFiles:[0,1,2,3].map(n=>join(dir,`lock${n}`)),absentLocks:[join(dir,"native")],envFile:join(dir,"missing.env"),...readiness,cli:join(dir,"missing.ts"),
  adoptionReceipt:join(dir,"s13-latest.json"),adoptionWaitMinutes:240,
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

test("admission settles after a published round and only retries clean stops a bounded number of times",()=>{
 const sync={status:"PASS",finishedAtUTC:"2026-01-01T00:00:00Z"},finished=Date.parse(sync.finishedAtUTC);
 assert.equal(dailyDecision(null,sync,finished+179*60_000,180),"SETTLING");
 assert.equal(dailyDecision(null,sync,finished+180*60_000,180),"READY");
 assert.equal(dailyDecision(null,{status:"PASS"},finished,180),"WAITING_FOR_SYNC");
 assert.equal(dailyDecision(null,{status:"PUBLISHED_POST_INCOMPLETE",finishedAtUTC:sync.finishedAtUTC},finished+1e9,180),"READY");
 for(const status of ["RUNNING","FAILED","PUBLISHED_POST_PENDING"])assert.equal(dailyDecision(null,{status,finishedAtUTC:sync.finishedAtUTC},finished+1e9,180),"WAITING_FOR_SYNC");
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

test("a published round is admitted only when closed, reader-verified and adopted (or past the adoption wait)",async()=>{
 const cases:[string,Parameters<typeof roundFixture>[1],Record<string,unknown>,boolean][]=[
  ["closed and adopted",{},{status:"PASS"},true],
  ["full PASS round",{status:"PASS"},{status:"PASS"},true],
  ["close-out not written yet",{close:false},{status:"WAITING_FOR_CLOSE"},false],
  ["close-out for another run",{close:{publishedRunId:"other"}},{status:"STOPPED",reason:"RETENTION_CLOSE_NOT_VERIFIED"},false],
  ["close-out still holding the lock",{close:{maintenanceLockReleased:false}},{status:"STOPPED",reason:"RETENTION_CLOSE_NOT_VERIFIED"},false],
  ["not reader-verified",{source:{readerVerified:false}},{status:"STOPPED",reason:"RETENTION_PUBLICATION_NOT_VERIFIED"},false],
  ["not published",{source:{published:false}},{status:"STOPPED",reason:"RETENTION_PUBLICATION_NOT_VERIFIED"},false],
  ["adoption missing within the wait",{adoption:false,finishedAtUTC:new Date().toISOString()},{status:"WAITING_FOR_ADOPTION"},false],
  ["adoption of an older run within the wait",{adoption:{runId:"older"},finishedAtUTC:new Date().toISOString()},{status:"WAITING_FOR_ADOPTION"},false],
  ["adoption failed within the wait",{adoption:{status:"FAILED"},finishedAtUTC:new Date().toISOString()},{status:"WAITING_FOR_ADOPTION"},false],
  ["adoption never came, wait over",{adoption:false},{status:"PASS"},true],
 ];
 for(const [label,options,expected,spawned] of cases){
  const dir=await mkdtemp(join(tmpdir(),"retention-gate-"));
  try{
   const {sync}=await roundFixture(dir,options),config=configFor(dir,sync,await fakeCli(dir,0));
   const result=await scheduledTick(config);
   for(const [k,v] of Object.entries(expected))assert.equal((result as Record<string,unknown>)[k],v,label);
   assert.equal(result.status==="PASS",spawned,label);
   for(const lock of config.lockFiles)await assert.rejects(lstat(lock),{code:"ENOENT"},label);
   if(!spawned&&result.status!=="STOPPED")await assert.rejects(lstat(join(config.directory,"STATE_PRIVATE.json")),{code:"ENOENT"},label);
  }finally{await rm(dir,{recursive:true,force:true});}
 }
 const pass=await mkdtemp(join(tmpdir(),"retention-gate-pipeline-"));
 try{
  const {operation,sync}=await roundFixture(pass,{status:"PASS"});await rm(join(operation,"PIPELINE_FINISHED_PRIVATE.json"));
  const result=await scheduledTick(configFor(pass,sync,await fakeCli(pass,0)));
  assert.equal(result.status,"STOPPED");assert.equal(result.reason,"RETENTION_PIPELINE_NOT_VERIFIED");
 }finally{await rm(pass,{recursive:true,force:true});}
});

test("invalid scheduler limits fail before filesystem admission or credential access",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"retention-invalid-limit-"));
 try{
  const config=configFor(dir,join(dir,"missing-sync"),{directory:join(dir,"not-created")});
  for(const [field,values,error] of [["maximumRuns",[undefined,null,0,-1,3,8,1.5,"2"],/RETENTION_RUN_LIMIT_INVALID/],
   ["chunkRows",[undefined,0,501,2.5,"100"],/RETENTION_CHUNK_ROWS_INVALID/],["adoptionWaitMinutes",[undefined,-1,1441,0.5],/RETENTION_ADOPTION_WAIT_INVALID/],["deleteTimeoutSeconds",[undefined,7,31,8.5,"20"],/RETENTION_DELETE_TIMEOUT_INVALID/],["settleMinutes",[undefined,-1,1441,0.5],/RETENTION_SETTLE_INVALID/]] as const){
   for(const value of values){
    const invalid={...config,[field]:value} as ScheduledConfig;
    await assert.rejects(inspectScheduledReadiness(invalid),error);await assert.rejects(scheduledTick(invalid),error);
   }
  }
  for(const format of ["retention-daily-config-v3","retention-daily-config-v4"])await assert.rejects(scheduledTick({...config,format} as unknown as ScheduledConfig),/RETENTION_CONFIG_INVALID/);
  await assert.rejects(lstat(config.directory),{code:"ENOENT"});
  for(const lock of config.lockFiles)await assert.rejects(lstat(lock),{code:"ENOENT"});
 }finally{await rm(dir,{recursive:true,force:true});}
});

test("the run limit, chunk size and round proofs reach the spawned window unchanged",async()=>{
 for(const maximumRuns of [1,2]){
  const dir=await mkdtemp(join(tmpdir(),"retention-window-limit-"));
  try{
   const {operation,sync}=await roundFixture(dir);
   const config=configFor(dir,sync,{maximumRuns,chunkRows:25,...await fakeCli(dir,0)});
   const result=await scheduledTick(config);assert.equal(result.status,"PASS");assert.ok(result.operation);
   const observed=JSON.parse(await readFile(join(config.directory,result.operation,"OBSERVED_PRIVATE.json"),"utf8"));
   assert.equal(observed.maximumRuns,maximumRuns);assert.equal(observed.chunkRows,25);assert.equal(observed.deleteTimeoutSeconds,20);
   assert.equal(observed.format,"retention-daily-window-v5");assert.equal(observed.adopted,true);
   assert.equal(observed.readinessURL,config.readinessURL);assert.deepEqual(observed.readinessSample,config.readinessSample);
   assert.equal(Object.hasOwn(observed,"healthURL"),false);assert.equal(Object.hasOwn(observed,"RETENTION_READINESS_SECRET"),false);
   for(const path of [join(operation,"SOURCE_DRIVER_PRIVATE.json"),join(operation,"CLOSE_PUBLISHED_PRIVATE.json"),config.adoptionReceipt]){
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
