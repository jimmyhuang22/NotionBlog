import {lstat, open, readFile} from "node:fs/promises";
import {constants} from "node:fs";
import {Pool} from "pg";
import {databasePoolConfig} from "../../src/server/database/connection.ts";
import {createArchiveStore, verifyOfflineRestore} from "./archive.ts";
import {CLEAN_STOP_REASONS, dailyRetention, RetentionStop, RolledBackError, sha256, type RetentionPort} from "./daily.ts";
import {RETENTION_DEFERRED_EXIT_CODE, retentionChunkRows, retentionDeleteTimeout} from "./schedule.ts";
import {retentionRunLimit} from "./limits.ts";
import {verifyRetentionReadiness} from "./readiness.ts";
import type {ReadinessSample} from "../../src/server/content-readiness/protocol.ts";
import {RetentionResponseBudget} from "./response-budget.ts";

interface Window {
 format:"retention-daily-window-v4";maximumRuns:number;chunkRows:number;deleteTimeoutSeconds:number;runId:string;deadline:number;syncState:string;operation:string;
 locks:{path:string;ino:number;dev:number;sha256:string}[];absentLocks:string[];
 proofs:{path:string;sha256:string}[];archiveDirectory:string;readinessURL:string;readinessSample:ReadinessSample;
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
 if(window.format!=="retention-daily-window-v4"||window.locks.length!==4||window.proofs.length<5||window.absentLocks.length<1||
  !window.programFiles?.length||!Number.isFinite(window.deadline)||window.deadline>Date.now()+30*60*1000||window.deadline<Date.now()+60_000)throw Error("RETENTION_WINDOW_INVALID");
 const chunkRows=retentionChunkRows(window.chunkRows),deleteTimeoutSeconds=retentionDeleteTimeout(window.deleteTimeoutSeconds);
 const stop=new AbortController();
 let cancelled=false;
 const cancel=()=>{cancelled=true;stop.abort();};process.once("SIGTERM",cancel);process.once("SIGINT",cancel);
 async function assertWindow(){
  if(cancelled||Date.now()+35_000>=window.deadline)throw Error("RETENTION_WINDOW_STOPPED");
  if((await privateFile(path)).raw!==initial.raw)throw Error("RETENTION_WINDOW_CHANGED");
  for(const lock of window.locks){const {raw,s}=await privateFile(lock.path);if(s.ino!==lock.ino||s.dev!==lock.dev||sha256(raw)!==lock.sha256)throw Error("RETENTION_LOCK_CHANGED");}
  for(const absent of window.absentLocks){try{await lstat(absent);}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")continue;throw e;}throw Error("RETENTION_WORKER_BUSY");}
  const state=JSON.parse((await privateFile(window.syncState)).raw);
  if(state.status!=="PASS"||state.runId!==window.runId||state.operation!==window.operation)throw Error("RETENTION_SUCCESS_CHANGED");
  for(const proof of window.proofs)if(sha256((await privateFile(proof.path)).raw)!==proof.sha256)throw Error("RETENTION_PROOF_CHANGED");
  for(const proof of window.programFiles){const s=await lstat(proof.path);if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o022)||sha256(await readFile(proof.path,"utf8"))!==proof.sha256)throw Error("RETENTION_PROGRAM_CHANGED");}
 }
 await assertWindow();
 // Both private proofs bind this exact published run and public Status sample.
 const health=async()=>{await assertWindow();await verifyRetentionReadiness(window.readinessURL,process.env.RETENTION_READINESS_SECRET,window.runId,window.readinessSample,fetch,stop.signal);await assertWindow();};
 // Nothing has been read or written yet, so a failed first proof is a clean stop.
 try{await health();}catch(error){
  const reason=error instanceof Error&&/^RETENTION_[A-Z_]+$/.test(error.message)?error.message:"RETENTION_READINESS_FAILED";
  // A missing secret, bad sample or changed lock/proof is a configuration problem, not a transient one.
  throw new RetentionStop(reason,["RETENTION_READINESS_FAILED","RETENTION_READINESS_TOO_LARGE","RETENTION_WINDOW_STOPPED"].includes(reason));
 }
 const budget=new RetentionResponseBudget();
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
   await assertWindow();const client=await pool.connect();let failed=false,committing=false;
   try{await client.query(write?"BEGIN":"BEGIN READ ONLY");
    await client.query(`SET LOCAL statement_timeout='${write?deleteTimeoutSeconds:30}s'; SET LOCAL lock_timeout='2s'; SET LOCAL idle_in_transaction_session_timeout='${write?deleteTimeoutSeconds:8}s'`);
    const query=budget.query(name,values);
    const row=(await client.query<{bytes:number;result:T|null}>(query.text,query.values)).rows[0];
    const value=budget.accept(row);
    committing=true;await client.query("COMMIT");return value;
   }catch(error){
    failed=true;try{await client.query("ROLLBACK");}catch{}
    // A failure during COMMIT may still have committed; only earlier failures are provably rolled back.
    if(committing)throw error;
    const code=(error as {code?:unknown}).code,message=error instanceof Error?error.message:"";
    throw new RolledBackError(typeof code==="string"&&/^[0-9A-Z]{5}$/.test(code)?code:"",/^RETENTION_[A-Z_]+$/.test(message)?message:undefined);
   }finally{client.release(failed);}
  };
  const db:RetentionPort={plan:()=>invoke("plan"),schema:()=>invoke("archive_schema"),index:(t,r)=>invoke("archive_index",[t,r]),
   payload:(t,r)=>invoke("archive_payload",[t,JSON.stringify(r)]),fingerprint:(t,r)=>invoke("fingerprint",[t,r]),
   deleteChunk:(t,g,l,o,a)=>invoke("delete_chunk",[t,JSON.stringify(g),l,o,a],true)};
  const expected=await db.plan();if(expected.state.current_run!==window.runId)throw Error("RETENTION_PUBLISHED_RUN_CHANGED");
  const store=await createArchiveStore(window.archiveDirectory);
  await store.save(`windows/${sha256(initial.raw)}`,window);
  const result=await dailyRetention({db,store,maximumRuns,chunkRows,now:Date.now,assertWindow,restore:verifyOfflineRestore,health});
  console.log(JSON.stringify(result));
 }finally{await pool.end();process.removeListener("SIGTERM",cancel);process.removeListener("SIGINT",cancel);}
}
main().catch(error=>{
 // Provider messages can contain rows, SQL text and connection data. Preserve details privately only.
 const reason=error instanceof Error&&/^RETENTION_[A-Z_]+$/.test(error.message)?error.message:"RETENTION_FAILED_REQUIRES_REVIEW";
 const cleanStop=error instanceof RetentionStop&&error.cleanStop&&(CLEAN_STOP_REASONS.has(reason)||reason==="RETENTION_READINESS_FAILED"||reason==="RETENTION_READINESS_TOO_LARGE");
 console.error(JSON.stringify({status:"STOPPED",reason,cleanStop,automaticRetry:false}));process.exitCode=cleanStop?RETENTION_DEFERRED_EXIT_CODE:1;
});
