import test from "node:test";
import assert from "node:assert/strict";
import {PGlite} from "@electric-sql/pglite";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {spawn} from "node:child_process";
import {createServer} from "node:net";
import {RetentionResponseBudget} from "../scripts/database-retention/response-budget.ts";

test("oversized SQL results are withheld and a mutating RPC is rolled back before commit",async()=>{
 const db=new PGlite();
 try{
  await db.exec(`CREATE SCHEMA nb_retention_api; CREATE TABLE write_proof(n integer);
   CREATE FUNCTION nb_retention_api.delete_chunk() RETURNS jsonb LANGUAGE plpgsql AS $$ BEGIN
    INSERT INTO write_proof VALUES(1); RETURN jsonb_build_object('large',repeat('x',10000)); END $$;`);
  const budget=new RetentionResponseBudget(1024),query=budget.query("delete_chunk",[]);
  await db.exec("BEGIN");
  const row=(await db.query<{bytes:number;result:unknown}>(query.text,query.values)).rows[0];
  assert.equal(row.result,null);assert.ok(row.bytes>10000);
  assert.ok(Buffer.byteLength(JSON.stringify(row))<100);
  assert.throws(()=>budget.accept(row),/RETENTION_RESPONSE_BUDGET/);
  await db.exec("ROLLBACK");
  assert.equal((await db.query("SELECT * FROM write_proof")).rows.length,0);
 }finally{await db.close();}
});

test("the response budget is cumulative and materialized RPCs execute only once",async()=>{
 const db=new PGlite();
 try{
  await db.exec(`CREATE SCHEMA nb_retention_api; CREATE TABLE calls(n integer);
   CREATE FUNCTION nb_retention_api.plan() RETURNS jsonb LANGUAGE plpgsql AS $$ BEGIN
    INSERT INTO calls VALUES(1); RETURN jsonb_build_object('value',repeat('x',400)); END $$;`);
  const budget=new RetentionResponseBudget(1024);
  for(let n=1;n<=2;n++){
   const q=budget.query("plan",[]);await db.exec("BEGIN");
   const row=(await db.query<{bytes:number;result:{value:string}}>(q.text,q.values)).rows[0];
   if(n===1){assert.equal(budget.accept(row).value.length,400);await db.exec("COMMIT");}
   else{assert.throws(()=>budget.accept(row),/RETENTION_RESPONSE_BUDGET/);await db.exec("ROLLBACK");}
  }
  assert.equal((await db.query("SELECT * FROM calls")).rows.length,1);
  assert.throws(()=>budget.query("plan(); DELETE FROM calls",[]),/RETENTION_RPC_INVALID/);
 }finally{await db.close();}
});

test("invalid CLI limits never open a database connection",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"retention-cli-limit-")),server=createServer(socket=>{connections++;socket.destroy();});
 let connections=0;
 try{
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const address=server.address();assert.ok(address&&typeof address!=="string");
  for(const maximumRuns of [undefined,null,0,3,8,1.5,"2"]){
   const path=join(dir,"window.json");await writeFile(path,JSON.stringify({format:"retention-daily-window-v2",maximumRuns}),{mode:0o600});
   const result=await new Promise<{code:number|null;output:string}>((resolveResult,reject)=>{
    const child=spawn(process.execPath,["--conditions=react-server",resolve("scripts/database-retention/cli.ts"),"--window",path],{
     env:{...process.env,RETENTION_DATABASE_URL:`postgresql://example:example@127.0.0.1:${address.port}/example`},stdio:["ignore","pipe","pipe"]});
    let output="";child.stdout.on("data",data=>{output+=data;});child.stderr.on("data",data=>{output+=data;});
    child.once("error",reject);child.once("exit",code=>resolveResult({code,output}));
   });
   assert.equal(result.code,1);assert.match(result.output,/RETENTION_RUN_LIMIT_INVALID/);
  }
  assert.equal(connections,0);
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(dir,{recursive:true,force:true});}
});


test("forged rolling child allowances are rejected by the real CLI before connecting",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"retention-rolling-cli-"));let connections=0;
 const server=createServer(socket=>{connections++;socket.destroy();});
 try{
  await new Promise<void>(done=>server.listen(0,"127.0.0.1",done));const address=server.address();assert.ok(address&&typeof address!=="string");
  const {initialRollingLedger,reserveRolling,rollingLedgerPath}=await import("../scripts/database-retention/rolling-ledger.ts");
  const {mkdir}=await import("node:fs/promises");const {sha256}=await import("../scripts/database-retention/daily.ts");
  const runId="00000000-0000-0000-0000-000000000001",reservationId="00000000-0000-0000-0000-000000000101";
  const state=join(dir,"state"),archive=join(dir,"archive"),folder=join(state,reservationId);await mkdir(folder,{recursive:true,mode:0o700});await mkdir(archive,{mode:0o700});
  const ledger=reserveRolling(initialRollingLedger(state,archive,Date.now()),runId,reservationId,Date.now(),2),raw=JSON.stringify(ledger),limits=ledger.entries[0].reserved;
  await writeFile(rollingLedgerPath(archive),raw,{mode:0o600});
  const window={format:"retention-after-sync-window-v3",maximumRuns:2,runId,deadline:Date.now()+300_000,archiveDirectory:archive,
   locks:[{},{},{},{}],proofs:[{path:rollingLedgerPath(archive),sha256:sha256(raw)},{},{},{},{}],absentLocks:["/private/fixture/absent"],programFiles:[{}],
   rolling:{reservationId,stateDirectory:state,limits}};
  for(const rolling of [undefined,{...window.rolling,limits:{...limits,returnedBytes:limits.returnedBytes+1}},
   {...window.rolling,limits:{...limits,deletedRows:-1}},{...window.rolling,reservationId:runId}]){
   const path=join(folder,"WINDOW_PRIVATE.json");await writeFile(path,JSON.stringify({...window,rolling}),{mode:0o600});
   const result=await new Promise<{code:number|null;output:string}>((done,reject)=>{
    const child=spawn(process.execPath,["--conditions=react-server",resolve("scripts/database-retention/cli.ts"),"--window",path],{
     env:{...process.env,RETENTION_DATABASE_URL:`postgresql://example:example@127.0.0.1:${address.port}/example`},stdio:["ignore","pipe","pipe"]});
    let output="";child.stdout.on("data",part=>{output+=part;});child.stderr.on("data",part=>{output+=part;});child.once("error",reject);child.once("exit",code=>done({code,output}));
   });assert.equal(result.code,1);assert.match(result.output,/RETENTION_ROLLING_WINDOW_INVALID/);
  }
  assert.equal(connections,0);
 }finally{await new Promise<void>(done=>server.close(()=>done()));await rm(dir,{recursive:true,force:true});}
});
