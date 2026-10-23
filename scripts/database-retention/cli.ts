import {lstat, open, readFile} from "node:fs/promises";
import {constants} from "node:fs";
import {dirname,basename,join} from "node:path";
import {rollingLedgerPath,validateRollingLedger,type Usage} from "./rolling-ledger.ts";
import {Pool} from "pg";
import {databasePoolConfig} from "../../src/server/database/connection.ts";
import {createArchiveStore, verifyOfflineRestore} from "./archive.ts";
import {dailyRetention, sha256, type RetentionPort} from "./daily.ts";
import {retentionRunLimit} from "./limits.ts";
import {RetentionResponseBudget} from "./response-budget.ts";

interface Window {
 format:"retention-daily-window-v2"|"retention-after-sync-window-v3";rolling?:{reservationId:string;stateDirectory:string;limits:Usage};maximumRuns:number;runId:string;deadline:number;syncState:string;operation:string;
 locks:{path:string;ino:number;dev:number;sha256:string}[];absentLocks:string[];
 proofs:{path:string;sha256:string}[];archiveDirectory:string;healthURL:string;
 programFiles:{path:string;sha256:string}[];
}
async function privateFile(path:string,maximum=2*1024*1024){
 const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const s=await file.stat();if(!s.isFile()||s.uid!==process.getuid?.()||(s.mode&0o077)||s.nlink!==1||s.size>maximum)throw Error("RETENTION_PRIVATE_FILE_INVALID");
  const raw=await file.readFile("utf8"),after=await lstat(path);if(s.ino!==after.ino||s.dev!==after.dev||s.mtimeMs!==after.mtimeMs)throw Error("RETENTION_PRIVATE_FILE_CHANGED");return {raw,s};
 }finally{await file.close();}
}
async function main(){
 const [flag,path,...extra]=process.argv.slice(2);if(flag!=="--window"||!path||extra.length)throw Error("RETENTION_EXPLICIT_WINDOW_REQUIRED");
 const initial=await privateFile(path),window=JSON.parse(initial.raw) as Window;
 const maximumRuns=retentionRunLimit(window.maximumRuns);
 if(!["retention-daily-window-v2","retention-after-sync-window-v3"].includes(window.format)||window.locks.length!==4||window.proofs.length<5||window.absentLocks.length<1||
  !window.programFiles?.length||!Number.isFinite(window.deadline)||window.deadline>Date.now()+30*60*1000||window.deadline<Date.now()+60_000)throw Error("RETENTION_WINDOW_INVALID");
 const rolling=window.rolling;
 if(window.format==="retention-after-sync-window-v3"){
  if(!rolling||rolling.stateDirectory!==dirname(dirname(path))||rolling.reservationId!==basename(dirname(path)))throw Error("RETENTION_ROLLING_WINDOW_INVALID");
  const ledgerPath=rollingLedgerPath(window.archiveDirectory),raw=(await privateFile(ledgerPath)).raw;
  const ledger=validateRollingLedger(JSON.parse(raw),rolling.stateDirectory,window.archiveDirectory,Date.now());
  const entry=ledger.entries.find(e=>e.id===rolling.reservationId&&e.sourceRunId===window.runId&&e.status==="RUNNING");
  if(!entry||JSON.stringify(entry.reserved)!==JSON.stringify(rolling.limits)||rolling.limits.runs!==maximumRuns||
   !window.proofs.some(p=>p.path===ledgerPath&&p.sha256===sha256(raw)))throw Error("RETENTION_ROLLING_WINDOW_INVALID");
 }else if(rolling!==undefined)throw Error("RETENTION_ROLLING_WINDOW_INVALID");
 let cancelled=false;
 const cancel=()=>{cancelled=true;};process.once("SIGTERM",cancel);process.once("SIGINT",cancel);
 async function assertWindow(){
  if(cancelled||Date.now()+35_000>=window.deadline)throw Error("RETENTION_WINDOW_STOPPED");
  if((await privateFile(path)).raw!==initial.raw)throw Error("RETENTION_WINDOW_CHANGED");
  for(const lock of window.locks){const {raw,s}=await privateFile(lock.path);if(s.ino!==lock.ino||s.dev!==lock.dev||sha256(raw)!==lock.sha256)throw Error("RETENTION_LOCK_CHANGED");}
  for(const absent of window.absentLocks){try{await lstat(absent);}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")continue;throw e;}throw Error("RETENTION_WORKER_BUSY");}
  const state=JSON.parse((await privateFile(window.syncState)).raw);
  if(state.status!=="PASS"||state.runId!==window.runId||state.operation!==window.operation)throw Error("RETENTION_SUCCESS_CHANGED");
  for(const proof of window.proofs)if(sha256((await privateFile(proof.path)).raw)!==proof.sha256)throw Error("RETENTION_PROOF_CHANGED");
  for(const proof of window.programFiles){const s=await lstat(proof.path);if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o022)||sha256(await readFile(proof.path))!==proof.sha256)throw Error("RETENTION_PROGRAM_CHANGED");}
 }
 await assertWindow();
 const budget=new RetentionResponseBudget(rolling?.limits.returnedBytes);
 let completed:Awaited<ReturnType<typeof dailyRetention>>|undefined;
 const pool=new Pool({...databasePoolConfig(process.env.RETENTION_DATABASE_URL,process.env.DATABASE_TLS,process.env.DATABASE_CA_CERT),
  max:1,statement_timeout:30000,query_timeout:35000,application_name:"notionblog-retention"});
 pool.on("error",()=>{});
 try{
  const role=(await pool.query(`SELECT current_user AS name,r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls,
   pg_has_role(current_user,'nb_retention_executor','member') AS maintenance,
   pg_has_role(current_user,'nb_reader','member') OR pg_has_role(current_user,'nb_writer','member') AS app
   FROM pg_roles r WHERE r.rolname=current_user`)).rows[0];
  budget.charge(role);
  if(!role?.maintenance||role.app||role.rolsuper||role.rolcreatedb||role.rolcreaterole||role.rolreplication||role.rolbypassrls)throw Error("RETENTION_ROLE_INVALID");
  const invoke=async<T>(name:string,values:unknown[]=[],write=false):Promise<T>=>{
   await assertWindow();const client=await pool.connect();let failed=false;
   try{await client.query(write?"BEGIN":"BEGIN READ ONLY");
    await client.query(`SET LOCAL statement_timeout='${write?8:30}s'; SET LOCAL lock_timeout='2s'; SET LOCAL idle_in_transaction_session_timeout='8s'`);
    const query=budget.query(name,values);
    const row=(await client.query<{bytes:number;result:T|null}>(query.text,query.values)).rows[0];
    const value=budget.accept(row);
    await client.query("COMMIT");return value;
   }catch(error){failed=true;try{await client.query("ROLLBACK");}catch{}throw error;}finally{client.release(failed);}
  };
  const db:RetentionPort={plan:()=>invoke("plan"),schema:()=>invoke("archive_schema"),index:(t,r)=>invoke("archive_index",[t,r]),
   payload:(t,r)=>invoke("archive_payload",[t,JSON.stringify(r)]),fingerprint:(t,r)=>invoke("fingerprint",[t,r]),
   deleteChunk:(t,g,l,o,a)=>invoke("delete_chunk",[t,JSON.stringify(g),l,o,a],true)};
  const expected=await db.plan();if(expected.state.current_run!==window.runId)throw Error("RETENTION_PUBLISHED_RUN_CHANGED");
  const store=await createArchiveStore(window.archiveDirectory);
  await store.save(`windows/${sha256(initial.raw)}`,window);
  const result=await dailyRetention({db,store,maximumRuns,maximumReturnedBytes:rolling?budget.remaining:undefined,maximumDeleteCalls:rolling?.limits.deleteCalls,maximumDeletedRows:rolling?.limits.deletedRows,now:Date.now,assertWindow,restore:verifyOfflineRestore,health:async()=>{
   await assertWindow();const url=new URL(window.healthURL);if(url.protocol!=="https:"||url.pathname!=="/api/health/content"||url.search||url.hash||url.username||url.password)throw Error("RETENTION_HEALTH_URL_INVALID");
   const response=await fetch(url,{signal:AbortSignal.timeout(10_000),redirect:"error"});
   const reader=response.body?.getReader();if(!reader)throw Error("RETENTION_HEALTH_FAILED");let bytes=0;
   try{for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>4096)throw Error("RETENTION_HEALTH_TOO_LARGE");}}
   finally{await reader.cancel();}
   if(response.status!==200)throw Error("RETENTION_HEALTH_FAILED");
  }});
  completed=result;
  if(!rolling)console.log(JSON.stringify(result));
 }finally{await pool.end();process.removeListener("SIGTERM",cancel);process.removeListener("SIGINT",cancel);}
 if(rolling&&completed){
  const usage={status:"PASS",reservationId:rolling.reservationId,runId:window.runId,windowSHA256:sha256(initial.raw),connectionsClosed:true,
   runs:completed.archivedRuns,returnedBytes:rolling.limits.returnedBytes-budget.remaining,deleteCalls:completed.deleteCalls,deletedRows:completed.deletedRows};
  const file=await open(join(dirname(path),"USAGE_PRIVATE.json"),"wx",0o600);
  try{await file.writeFile(JSON.stringify(usage)+"\n");await file.sync();}finally{await file.close();}
  const dir=await open(dirname(path),"r");try{await dir.sync();}finally{await dir.close();}
  console.log(JSON.stringify(usage));
 }
}
main().catch(error=>{
 // Provider messages can contain rows, SQL text and connection data. Preserve details privately only.
 const reason=error instanceof Error&&/^RETENTION_[A-Z_]+$/.test(error.message)?error.message:"RETENTION_FAILED_REQUIRES_REVIEW";
 console.error(JSON.stringify({status:"STOPPED",reason,automaticRetry:false}));process.exitCode=1;
});
