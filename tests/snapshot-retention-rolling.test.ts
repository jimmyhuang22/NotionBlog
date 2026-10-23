import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,readFile,rm,lstat,readdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {initialRollingLedger,rollingAdmission,reserveRolling,settleRolling,validateRollingLedger,rollingLedgerPath,ROLLING_PERIOD,type Usage} from "../scripts/database-retention/rolling-ledger.ts";
import {scheduledTick,inspectScheduledReadiness,type ScheduledConfig} from "../scripts/database-retention/schedule.ts";
import {sha256} from "../scripts/database-retention/daily.ts";

const id=(n:number)=>`00000000-0000-0000-0000-${String(n).padStart(12,"0")}`;
const usage:Usage={runs:1,returnedBytes:100,deleteCalls:1,deletedRows:1};
const fresh=()=>initialRollingLedger("/private/state","/private/archive",0);
test("new accepted runs need no daily cooldown, while a source run is never processed twice",()=>{
 let ledger=reserveRolling(fresh(),id(1),id(101),0,2);
 assert.equal(rollingAdmission(ledger,id(2),ROLLING_PERIOD*3,2).status,"REQUIRES_REVIEW");
 ledger=settleRolling(ledger,id(101),usage,1);
 assert.equal(rollingAdmission(ledger,id(2),2,2).status,"READY");
 assert.equal(rollingAdmission(ledger,id(1),ROLLING_PERIOD*3,2).status,"SOURCE_ALREADY_PROCESSED");
 const next=reserveRolling(ledger,id(2),id(102),ROLLING_PERIOD*3,2);
 assert.equal(next.entries.length,1);assert.deepEqual(next.seenSourceRuns,[id(1),id(2)]);
});
test("attempt, run, response, delete-call and row ceilings share the same rolling account",()=>{
 let ledger=fresh();
 for(let n=1;n<=8;n++){ledger=reserveRolling(ledger,id(n),id(100+n),n*2,2);ledger=settleRolling(ledger,id(100+n),{...usage,runs:2},n*2+1);}
 assert.equal(rollingAdmission(ledger,id(9),18,2).status,"ROLLING_BUDGET_EXHAUSTED");
 assert.equal(rollingAdmission(ledger,id(9),ROLLING_PERIOD+17,2).status,"READY");
 for(const cost of [{returnedBytes:32*1024*1024},{deleteCalls:750},{deletedRows:250_000}]){
  let item=reserveRolling(fresh(),id(1),id(101),0,2);item=settleRolling(item,id(101),{...usage,...cost},1);
  if("returnedBytes" in cost){item=reserveRolling(item,id(2),id(102),2,2);item=settleRolling(item,id(102),{...usage,...cost},3);}
  assert.equal(rollingAdmission(item,id(9),4,2).status,"ROLLING_BUDGET_EXHAUSTED");
 }
});
test("remaining allowances reach reservations without being reset for a new attempt",()=>{
 let ledger=reserveRolling(fresh(),id(1),id(101),0,2);
 ledger=settleRolling(ledger,id(101),{runs:2,returnedBytes:10_000,deleteCalls:749,deletedRows:249_999},1);
 const next=reserveRolling(ledger,id(2),id(102),2,2).entries.at(-1)!;
 assert.deepEqual(next.reserved,{runs:2,returnedBytes:32*1024*1024,deleteCalls:1,deletedRows:1});
 assert.throws(()=>settleRolling(reserveRolling(ledger,id(2),id(102),2,2),id(102),{...usage,deleteCalls:2},3),/USAGE_INVALID/);
});
test("restarts, path changes, clock rollback and malformed accounting cannot renew a reservation",()=>{
 const reserved=reserveRolling(fresh(),id(1),id(101),10,2),reloaded=JSON.parse(JSON.stringify(reserved));
 assert.equal(rollingAdmission(reloaded,id(2),ROLLING_PERIOD*10,2).status,"REQUIRES_REVIEW");
 assert.throws(()=>validateRollingLedger(reloaded,"/private/new-state","/private/archive",11),/LEDGER_INVALID/);
 assert.throws(()=>validateRollingLedger(reloaded,"/private/state","/private/new-archive",11),/LEDGER_INVALID/);
 assert.throws(()=>rollingAdmission(reloaded,id(2),9,2),/LEDGER_INVALID/);
 for(const amount of [-1,NaN,Infinity,1.5])assert.throws(()=>settleRolling(reloaded,id(101),{...usage,returnedBytes:amount},11),/USAGE_INVALID/);
 assert.throws(()=>validateRollingLedger({...reloaded,seenSourceRuns:[]},"/private/state","/private/archive",11),/LEDGER_INVALID/);
});

async function fixture(mode="success"){
 const dir=await mkdtemp(join(tmpdir(),"retention-rolling-")),runId=id(1),operation=join(dir,"source"),catalog=join(dir,"catalog.json");
 async function put(path:string,value:unknown){await mkdir(join(path,".."),{recursive:true,mode:0o700});await writeFile(path,JSON.stringify(value),{mode:0o600});}
 for(const name of ["PIPELINE_FINISHED_PRIVATE.json",`thumbnail-post/runs/${runId}/receipt-private.json`,"proved-thumbnail-post/RECEIPT_PRIVATE.json",
  "acceptance-operation-private/SNAPSHOT_RECEIPT_PRIVATE.json","acceptance-operation-private/PRODUCTION_VISITOR_RECEIPT_PRIVATE.json"])
  await put(join(operation,name),{status:"PASS",runId});
 await put(join(operation,"acceptance-operation-private/COURSE_DIRECTORY_PRIVATE.json"),{format:"published-course-directory-v1",runId});
 await put(catalog,{});
 const tail=join(dir,"tail",runId,sha256("{}"));await put(join(tail,"RECEIPT_PRIVATE.json"),{status:"PASS",runId,catalogSHA256:sha256("{}"),connectionsClosed:true,ownLocksReleased:true,
  inFlight:null,unknownWriteGroup:null,acknowledgedUnverifiedGroup:null});
 const sync=join(dir,"sync.json");await put(sync,{status:"PASS",runId,operation});
 const cli=join(dir,"child.mjs"),envFile=join(dir,"empty.env");await writeFile(envFile,"",{mode:0o600});
 const program=`import {readFile,writeFile,unlink} from 'node:fs/promises';import {dirname,join} from 'node:path';import {createHash} from 'node:crypto';
 const path=process.argv.at(-1),raw=await readFile(path,'utf8'),w=JSON.parse(raw),mode=${JSON.stringify(mode)};
 await writeFile(join(dirname(path),'OBSERVED_PRIVATE.json'),raw,{mode:0o600});
 if(mode==='missing')process.exit(0);
 if(mode==='fail')process.exit(1);
 const usage={status:'PASS',reservationId:w.rolling.reservationId,runId:w.runId,windowSHA256:createHash('sha256').update(raw).digest('hex'),connectionsClosed:true,
  runs:1,returnedBytes:100,deleteCalls:1,deletedRows:1};
 if(mode==='overspend')usage.deletedRows=w.rolling.limits.deletedRows+1;
 if(mode==='wrong-window')usage.windowSHA256='a'.repeat(64);
 if(mode==='unclosed')usage.connectionsClosed=false;
 if(mode==='lock-replaced'){await unlink(w.locks[0].path);await writeFile(w.locks[0].path,'other owner',{mode:0o600});}
 await writeFile(join(dirname(path),'USAGE_PRIVATE.json'),JSON.stringify(usage),{mode:0o600});`;
 await writeFile(cli,program,{mode:0o600});
 const config:ScheduledConfig={format:"retention-after-sync-config-v3",maximumRuns:2,directory:join(dir,"state"),archiveDirectory:join(dir,"archive"),syncState:sync,
  websitePause:join(dir,"pause"),lockFiles:[0,1,2,3].map(n=>join(dir,`lock-${n}`)),absentLocks:[join(dir,"writer")],envFile,cli,healthURL:"https://example.org/api/health/content",
  tailCatalog:catalog,tailRunsDirectory:join(dir,"tail"),programFiles:[{path:cli,sha256:sha256(program)}]};
 await put(join(config.directory,"STATE_PRIVATE.json"),{status:"PASS",finishedAt:Date.now()});
 await mkdir(config.archiveDirectory,{mode:0o700});await put(rollingLedgerPath(config.archiveDirectory),initialRollingLedger(config.directory,config.archiveDirectory,Date.now()));
 return {dir,config,put,runId,sync};
}
test("the real spawned child receives remaining limits and successful usage settles the common ledger",async()=>{
 const f=await fixture();
 try{
  let ledger=reserveRolling(initialRollingLedger(f.config.directory,f.config.archiveDirectory,0),id(9),id(109),0,2);
  ledger=settleRolling(ledger,id(109),{...usage,deleteCalls:749,deletedRows:249_999},Date.now());
  await f.put(rollingLedgerPath(f.config.archiveDirectory),ledger);
  assert.equal((await inspectScheduledReadiness(f.config)).status,"READY");
  const result=await scheduledTick(f.config);assert.equal(result.status,"PASS");assert.ok(result.operation);
  const observed=JSON.parse(await readFile(join(f.config.directory,result.operation,"OBSERVED_PRIVATE.json"),"utf8"));
  assert.equal(observed.format,"retention-after-sync-window-v3");assert.equal(observed.rolling.limits.deletedRows,1);assert.equal(observed.rolling.limits.deleteCalls,1);
  const saved=JSON.parse(await readFile(rollingLedgerPath(f.config.archiveDirectory),"utf8"));assert.deepEqual(saved.entries.at(-1).usage,usage);
  assert.equal((await scheduledTick(f.config)).status,"SOURCE_ALREADY_PROCESSED");
  for(const lock of f.config.lockFiles)await assert.rejects(lstat(lock),{code:"ENOENT"});
 }finally{await rm(f.dir,{recursive:true,force:true});}
});
for(const mode of ["missing","fail","overspend","wrong-window","unclosed","lock-replaced"]){
 test(`child ${mode} preserves its entire reservation and stops without replay`,async()=>{
  const f=await fixture(mode);
  try{
   const result=await scheduledTick(f.config);assert.equal(result.status,"STOPPED");
   const saved=JSON.parse(await readFile(rollingLedgerPath(f.config.archiveDirectory),"utf8"));
   assert.equal(saved.entries.length,1);assert.equal(saved.entries[0].status,"RUNNING");assert.equal(saved.entries[0].usage,undefined);
   assert.deepEqual(saved.entries[0].reserved,{runs:2,returnedBytes:32*1024*1024,deleteCalls:750,deletedRows:250_000});
   assert.equal((await scheduledTick(f.config)).status,"REQUIRES_REVIEW");
   assert.equal((await readdir(f.config.directory)).filter(x=>x!=="STATE_PRIVATE.json").length,1);
  }finally{await rm(f.dir,{recursive:true,force:true});}
 });
}
test("concurrent polls never create two attempts for the same accepted source",async()=>{
 const f=await fixture();
 try{
  const results=await Promise.all([scheduledTick(f.config),scheduledTick(f.config)]);
  assert.equal(results.filter(x=>x.status==="PASS").length,1);
  assert.ok(results.some(x=>["WRITER_BUSY","REQUIRES_REVIEW","SOURCE_ALREADY_PROCESSED","SYNC_CHANGED"].includes(x.status)));
  const saved=JSON.parse(await readFile(rollingLedgerPath(f.config.archiveDirectory),"utf8"));assert.equal(saved.entries.length,1);
 }finally{await rm(f.dir,{recursive:true,force:true});}
});
test("missing ledgers, existing STOPPED and source pauses are never initialized or cleared",async()=>{
 const f=await fixture();
 try{
  await f.put(join(f.config.directory,"STATE_PRIVATE.json"),{status:"STOPPED"});
  assert.equal((await scheduledTick(f.config)).status,"REQUIRES_REVIEW");
  await f.put(join(f.config.directory,"STATE_PRIVATE.json"),{status:"PASS"});
  await writeFile(f.config.websitePause,"paused",{mode:0o600});assert.equal((await scheduledTick(f.config)).status,"WEBSITE_PAUSED");
  assert.equal(await readFile(f.config.websitePause,"utf8"),"paused");
  await rm(f.config.websitePause);await rm(rollingLedgerPath(f.config.archiveDirectory));
  await assert.rejects(scheduledTick(f.config),/LEDGER_REQUIRED/);
  await assert.rejects(lstat(rollingLedgerPath(f.config.archiveDirectory)),{code:"ENOENT"});
 }finally{await rm(f.dir,{recursive:true,force:true});}
});


test("rolling periods do not reset at midnight and tiny identity budgets cannot start a query",()=>{
 const nearMidnight=ROLLING_PERIOD-1000;
 let ledger=reserveRolling(fresh(),id(1),id(101),nearMidnight,2);
 ledger=settleRolling(ledger,id(101),{...usage,returnedBytes:32*1024*1024},nearMidnight+1);
 ledger=reserveRolling(ledger,id(2),id(102),nearMidnight+2,2);
 ledger=settleRolling(ledger,id(102),{...usage,returnedBytes:32*1024*1024-1000},nearMidnight+3);
 assert.equal(rollingAdmission(ledger,id(3),ROLLING_PERIOD+1000,2).status,"ROLLING_BUDGET_EXHAUSTED");
});
test("a missing course acceptance stops before reservation or a child",async()=>{
 const f=await fixture();
 try{
  await rm(join(f.dir,"source/acceptance-operation-private/COURSE_DIRECTORY_PRIVATE.json"));
  assert.equal((await scheduledTick(f.config)).status,"STOPPED");
  const ledger=JSON.parse(await readFile(rollingLedgerPath(f.config.archiveDirectory),"utf8"));assert.equal(ledger.entries.length,0);
 }finally{await rm(f.dir,{recursive:true,force:true});}
});
