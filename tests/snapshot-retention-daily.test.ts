import test from "node:test";
import assert from "node:assert/strict";
import {PGlite} from "@electric-sql/pglite";
import {retentionMigrationSQL} from "../scripts/database-retention/migration.ts";
import {dailyRetention, sha256, hashesDigest, RolledBackError, RetentionStop, type ArchiveStore, type DailyContext, type RetentionPort, type RetentionPlan} from "../scripts/database-retention/daily.ts";
import {verifyOfflineRestore} from "../scripts/database-retention/archive.ts";
import {PAYLOAD_TABLES, type PayloadTable, type DeleteGuard} from "../scripts/database-retention/plan.ts";
import {retentionRunLimit} from "../scripts/database-retention/limits.ts";
import {retentionCatalogInspectionSQL,reviewRetentionCatalog,type CatalogSnapshot} from "../scripts/database-retention/catalog-review.ts";

const id=(n:number)=>`00000000-0000-0000-0000-${String(n).padStart(12,"0")}`;
async function fixture(){
 const db=new PGlite();
 await db.exec(`CREATE ROLE nb_reader; CREATE ROLE nb_writer; CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
 CREATE SCHEMA nb_v2; CREATE SCHEMA nb_publication; CREATE SCHEMA nb_v2_media; CREATE SCHEMA nb_thumbnails; CREATE SCHEMA nb_revalidation; CREATE SCHEMA nb_delta;
 CREATE TABLE nb_v2.state(singleton boolean,current_run uuid,lease_run uuid,lease_until timestamptz);
 CREATE TABLE nb_publication.state(singleton boolean,run_id uuid);
 CREATE TABLE nb_v2.runs(id uuid PRIMARY KEY,status text NOT NULL,started_at timestamptz,finished_at timestamptz,valid_until timestamptz);
 CREATE TABLE nb_v2.records(run_id uuid NOT NULL REFERENCES nb_v2.runs,id text NOT NULL,item jsonb NOT NULL,PRIMARY KEY(run_id,id));
 CREATE TABLE nb_v2.media(run_id uuid NOT NULL,asset_id text NOT NULL,owner_page_id text NOT NULL,descriptor jsonb NOT NULL,PRIMARY KEY(run_id,asset_id),FOREIGN KEY(run_id,owner_page_id) REFERENCES nb_v2.records(run_id,id));
 CREATE TABLE nb_v2_media.sources(run_id uuid NOT NULL,asset_id text NOT NULL,binding jsonb NOT NULL,PRIMARY KEY(run_id,asset_id),FOREIGN KEY(run_id,asset_id) REFERENCES nb_v2.media ON DELETE CASCADE);
 CREATE TABLE nb_v2.tombstones(run_id uuid NOT NULL REFERENCES nb_v2.runs,id text NOT NULL,reason text,PRIMARY KEY(run_id,id));
 CREATE TABLE nb_thumbnails.media(version text NOT NULL,run_id uuid NOT NULL,parent_asset_id text NOT NULL,parent_sha text,width_cap integer NOT NULL CHECK(width_cap IN(400,800,1600)),descriptor jsonb,PRIMARY KEY(version,run_id,parent_asset_id,width_cap));
 CREATE TABLE nb_revalidation.bindings(run_id uuid,previous_run uuid); CREATE TABLE nb_delta.operations(operation_id uuid,expected_revision text);
 INSERT INTO nb_v2.state VALUES(true,'${id(5)}',NULL,NULL); INSERT INTO nb_publication.state VALUES(true,'${id(5)}');
 INSERT INTO nb_v2.runs SELECT ('00000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'published',now()-interval '3 days',now()-interval '2 days'+n*interval '1 minute',now()-interval '1 day' FROM generate_series(1,5) n;
 INSERT INTO nb_v2.records SELECT id,'owner','{"number": 9007199254740993, "decimal": 7.0}'::jsonb FROM nb_v2.runs;
 INSERT INTO nb_v2.media SELECT id,'asset','owner','{"sha256":"aa"}'::jsonb FROM nb_v2.runs;
 INSERT INTO nb_v2_media.sources SELECT id,'asset','{"locator":"opaque"}'::jsonb FROM nb_v2.runs;`);
 await db.exec(retentionMigrationSQL);
 await db.exec("UPDATE nb_retention.config SET enabled=true,catalog_sha=nb_retention.catalog_sha()");
 const rpc=async<T>(name:string,args:unknown[]=[])=>{
   const values=args.map((_,i)=>`$${i+1}`).join(",");
   return (await db.query<{result:T}>(`SELECT nb_retention_api.${name}(${values}) AS result`,args)).rows[0].result;
 };
 const port:RetentionPort={plan:()=>rpc("plan"),schema:()=>rpc("archive_schema"),index:(t,r)=>rpc("archive_index",[t,r]),
   payload:(t,refs)=>rpc("archive_payload",[t,JSON.stringify(refs)]),fingerprint:(t,r)=>rpc("fingerprint",[t,r]),
   deleteChunk:(t,g,l,o,a)=>rpc("delete_chunk",[t,JSON.stringify(g),l,o,a])};
 return {db,port,rpc};
}
function memoryStore(){
 const files=new Map<string,string>();
 const store:ArchiveStore={getBlob:async(t,h)=>files.get(`${t}/${h}`)??null,putBlob:async(t,h,s)=>{files.set(`${t}/${h}`,s);},
 save:async(n,v)=>{assert.ok(!files.has(n),"journal is immutable");const text=JSON.stringify(v);files.set(n,text);return sha256(text);}};
 return {store,files};
}
async function guard(port:RetentionPort,table:PayloadTable,run:string):Promise<DeleteGuard>{
 const p=await port.plan(); const c=p.candidates.find(c=>c.id===run);
 return {run,stateSHA256:p.stateSHA256,publicationSHA256:p.publicationSHA256,summarySHA256:c?.summary_sha256??"a".repeat(64),
 remainingPayloadSHA256:hashesDigest((await port.index(table,run)).map(x=>x.sha))};
}
test("daily extension denies existing app roles, direct deletes and owner configuration",async()=>{
 const {db}=await fixture();
 try{
  for(const role of ["nb_reader","nb_writer","anon","authenticated","service_role","nb_retention_executor"]){
   await db.exec(`SET ROLE ${role}`);
   await assert.rejects(db.exec("DELETE FROM nb_v2.records"),/permission denied/);
   await assert.rejects(db.exec("UPDATE nb_retention.config SET enabled=true"),/permission denied/);
   if(role!=="nb_retention_executor")await assert.rejects(db.exec("SELECT nb_retention_api.plan()"),/permission denied/);
   else assert.ok((await db.query("SELECT nb_retention_api.plan() AS p")).rows[0]);
   await db.exec("RESET ROLE");
  }
 }finally{await db.close();}
});
test("database rechecks newly pinned and 1600 donor dependencies after archive",async()=>{
 const {db,port}=await fixture();
 try{
  const g=await guard(port,"nb_v2_media.sources",id(1));
  await db.query("INSERT INTO nb_retention.pins VALUES($1,'rollback')",[id(1)]);
  await assert.rejects(port.deleteChunk("nb_v2_media.sources",g,500,id(101),"a".repeat(64)),/RETENTION_PROTECTED_RUN/);
  await db.exec("DELETE FROM nb_retention.pins");
  await db.query("INSERT INTO nb_thumbnails.media VALUES('v2',$1,'asset','aa',1600,'{}')",[id(1)]);
  await assert.rejects(port.deleteChunk("nb_v2_media.sources",g,500,id(102),"a".repeat(64)),/RETENTION_PROTECTED_RUN/);
  assert.equal((await port.index("nb_v2_media.sources",id(1))).length,1);
 }finally{await db.close();}
});
test("installed retention plan keeps completed rollback versions despite null timestamps and blocks their deletion",async()=>{
 const {db,port}=await fixture();
 try{
  for(const n of [6,7,8,9])await db.query("INSERT INTO nb_v2.runs VALUES($1,'published',now()-interval '3 days',NULL,now()-interval '1 day')",[id(n)]);
  await db.exec("SET ROLE nb_retention_executor");
  const plan=await port.plan();
  for(const n of [3,4,5,6,7,8,9])assert.ok(plan.protected.includes(id(n)));
  assert.deepEqual(plan.candidates.map(row=>row.id),[id(1),id(2)]);
  const g=await guard(port,"nb_v2_media.sources",id(3));
  await assert.rejects(port.deleteChunk("nb_v2_media.sources",g,500,id(103),"a".repeat(64)),/RETENTION_PROTECTED_RUN/);
  assert.equal((await port.index("nb_v2_media.sources",id(3))).length,1);
 }finally{await db.close();}
});
test("catalog additions, changed pointers, bad hashes and duplicate operation IDs stop deletion",async()=>{
 const {db,port}=await fixture();
 try{
  const g=await guard(port,"nb_v2_media.sources",id(1));
  await assert.rejects(port.deleteChunk("nb_v2_media.sources",{...g,remainingPayloadSHA256:"b".repeat(64)},500,id(101),"a".repeat(64)),/RETENTION_GUARD_CHANGED/);
  await db.query("UPDATE nb_publication.state SET run_id=$1",[id(4)]);
  await assert.rejects(port.deleteChunk("nb_v2_media.sources",g,500,id(101),"a".repeat(64)),/RETENTION_GUARD_CHANGED/);
  await db.query("UPDATE nb_publication.state SET run_id=$1",[id(5)]);
  const result=await port.deleteChunk("nb_v2_media.sources",g,500,id(101),"a".repeat(64));assert.equal(result.deleted.length,1);
  await assert.rejects(port.deleteChunk("nb_v2_media.sources",g,500,id(101),"a".repeat(64)),/RETENTION_RECONCILE_REQUIRED/);
  const receipt=await db.query<{n:number}>("SELECT deleted_count n FROM nb_retention.chunks WHERE operation_id=$1",[id(101)]);assert.equal(receipt.rows[0].n,1);
  await db.exec("CREATE TABLE nb_v2.external_reference(run_id uuid,id text,FOREIGN KEY(run_id,id) REFERENCES nb_v2.records)");
  await assert.rejects(port.plan(),/RETENTION_DISABLED_OR_CATALOG_CHANGED/);
 }finally{await db.close();}
});
test("complete daily archive restores exact numeric JSONB, protects live rows, and deletes in FK order",async()=>{
 const {db,port}=await fixture(),{store,files}=memoryStore();let health=0;
 try{
  const result=await dailyRetention({db:port,store,maximumRuns:2,now:()=>0,assertWindow:async()=>{},restore:verifyOfflineRestore,health:async()=>{health++;}});
  assert.equal(result.status,"PASS");assert.equal(result.archivedRuns,2);assert.equal(result.deletedRows,6);assert.equal(health,1);
  assert.equal((await db.query<{n:number}>("SELECT count(*)::integer n FROM nb_v2.runs")).rows[0].n,5);
  assert.equal((await db.query<{n:number}>("SELECT count(*)::integer n FROM nb_v2.records")).rows[0].n,3);
  assert.ok([...files.values()].some(s=>s.includes('"number": 9007199254740993')&&s.includes('"decimal": 7.0')));
 }finally{await db.close();}
});
test("missing archive and unknown write outcomes cannot trigger another delete",async()=>{
 const {db,port}=await fixture();
 try{
  for(const fail of ["payload","unknown"]){
   const {store,files}=memoryStore();let calls=0;
   const ctx:DailyContext={maximumRuns:2,db:{...port,payload:async(t,r)=>fail==="payload"?[]:port.payload(t,r),
    deleteChunk:async()=>{calls++;throw Error("TRANSPORT_OUTCOME_UNKNOWN");}},store,now:()=>0,assertWindow:async()=>{},restore:async()=>{},health:async()=>{throw Error("must not reach health");}};
   await assert.rejects(dailyRetention(ctx),fail==="payload"?/RETENTION_PAYLOAD_MISSING/:/TRANSPORT_OUTCOME_UNKNOWN/);
   assert.equal(calls,fail==="payload"?0:1);
   const stop=JSON.parse([...files.entries()].find(([k])=>k.endsWith("/stopped"))![1]);
   assert.equal(stop.automaticRetry,false);assert.equal(Boolean(stop.inFlightIntent),fail==="unknown");
  }
 }finally{await db.close();}
});

const stoppedReceipt=(files:Map<string,string>)=>JSON.parse([...files.entries()].find(([name])=>name.endsWith("/stopped"))![1]);
test("a smaller chunk size splits each guarded delete without changing what is deleted",async()=>{
 const {db,port}=await fixture(),{store,files}=memoryStore();
 try{
  await db.query("INSERT INTO nb_v2.records SELECT $1::uuid,'extra-'||n,'{}'::jsonb FROM generate_series(1,6) n",[id(1)]);
  const result=await dailyRetention({db:port,store,maximumRuns:1,chunkRows:3,now:()=>0,assertWindow:async()=>{},restore:verifyOfflineRestore,health:async()=>{}});
  assert.equal(result.status,"PASS");assert.equal(result.deletedRows,9);
  // One source and one media row take a call each (no thumbnails here); seven records take three.
  assert.equal(result.deleteCalls,5);
  const intents=[...files.entries()].filter(([name])=>name.includes("/intents/")).map(([,v])=>JSON.parse(v));
  assert.ok(intents.length===5&&intents.every(intent=>intent.limit===3));
  assert.equal((await db.query("SELECT * FROM nb_v2.records WHERE run_id=$1",[id(1)])).rows.length,0);
  for(const value of [0,501,1.5])await assert.rejects(dailyRetention({db:port,store,maximumRuns:1,chunkRows:value,now:()=>0,assertWindow:async()=>{},restore:verifyOfflineRestore,health:async()=>{}}),/RETENTION_CHUNK_ROWS_INVALID/);
 }finally{await db.close();}
});
test("a delete the server rolled back is a clean stop; a server rejection or unknown outcome needs review",async()=>{
 for(const [failure,reason,clean,inFlight] of [
  [new RolledBackError("57014"),"RETENTION_DELETE_ROLLED_BACK",true,false],
  [new RolledBackError("55P03"),"RETENTION_DELETE_ROLLED_BACK",true,false],
  [new RolledBackError("P0001","RETENTION_GUARD_CHANGED"),"RETENTION_GUARD_CHANGED",false,false],
  [new RolledBackError(""),"RETENTION_DELETE_NOT_COMMITTED",false,false],
  [Error("TRANSPORT_OUTCOME_UNKNOWN"),"TRANSPORT_OUTCOME_UNKNOWN",false,true],
 ] as const){
  const {db,port}=await fixture(),{store,files}=memoryStore();let calls=0;
  try{
   const error=await dailyRetention({db:{...port,deleteChunk:async()=>{calls++;throw failure;}},store,maximumRuns:2,now:()=>0,
    assertWindow:async()=>{},restore:verifyOfflineRestore,health:async()=>{throw Error("must not reach readiness");}}).then(()=>null,e=>e);
   assert.ok(error instanceof RetentionStop,reason);assert.equal(error.message,reason);assert.equal(error.cleanStop,clean,reason);assert.equal(calls,1);
   const stop=stoppedReceipt(files);
   assert.equal(stop.cleanStop,clean,reason);assert.equal(Boolean(stop.inFlightIntent),inFlight,reason);assert.equal(Boolean(stop.rolledBackIntent),!inFlight,reason);
   assert.equal((await db.query("SELECT * FROM nb_v2.records")).rows.length,5);
  }finally{await db.close();}
 }
});
test("a read timeout before any delete is clean; a failed proof after deleting is not",async()=>{
 const {db,port}=await fixture();
 try{
  const read=memoryStore();
  const error=await dailyRetention({db:{...port,plan:async()=>{throw new RolledBackError("57014");}},store:read.store,maximumRuns:2,now:()=>0,
   assertWindow:async()=>{},restore:verifyOfflineRestore,health:async()=>{}}).then(()=>null,e=>e);
  assert.ok(error instanceof RetentionStop);assert.equal(error.message,"RETENTION_READ_ROLLED_BACK");assert.equal(error.cleanStop,true);
  const after=memoryStore();
  const late=await dailyRetention({db:port,store:after.store,maximumRuns:2,now:()=>0,assertWindow:async()=>{},restore:verifyOfflineRestore,
   health:async()=>{throw Error("RETENTION_READINESS_FAILED");}}).then(()=>null,e=>e);
  assert.ok(late instanceof RetentionStop);assert.equal(late.cleanStop,false);assert.equal(stoppedReceipt(after.files).deletedRows,6);
  assert.equal(stoppedReceipt(after.files).cleanStop,false);
 }finally{await db.close();}
});

test("one or two selected historical runs are pruned while additional candidates and live data remain",async()=>{
 for(const maximumRuns of [1,2]){
  const {db,port}=await fixture(),{store}=memoryStore();
  try{
   for(let n=101;n<=104;n++){
    await db.query("INSERT INTO nb_v2.runs VALUES($1,'failed',now()-interval '6 days',now()-interval '5 days',now()-interval '4 days')",[id(n)]);
    await db.query("INSERT INTO nb_v2.records VALUES($1,'old','{}')",[id(n)]);
   }
   const before=await port.plan();assert.equal(before.candidates.length,6);
   const result=await dailyRetention({db:port,store,maximumRuns,now:()=>0,assertWindow:async()=>{},restore:verifyOfflineRestore,health:async()=>{}});
   assert.equal(result.archivedRuns,maximumRuns);
   assert.equal((await port.plan()).candidates.length,6-maximumRuns);
   assert.equal((await db.query("SELECT * FROM nb_v2.records WHERE run_id=$1",[id(5)])).rows.length,1);
  }finally{await db.close();}
 }
});

test("invalid limits stop before even reading a plan or writing a journal",async()=>{
 for(const value of [undefined,null,0,-1,3,8,1.5,"2",NaN,Infinity]){
  assert.throws(()=>retentionRunLimit(value),/RETENTION_RUN_LIMIT_INVALID/);
  let calls=0;
  const unexpected=async()=>{calls++;throw Error("unexpected I/O");};
  await assert.rejects(dailyRetention({maximumRuns:value as number,db:{plan:unexpected} as unknown as RetentionPort,
   store:{save:unexpected} as unknown as ArchiveStore,now:()=>0,assertWindow:unexpected,restore:unexpected,health:unexpected}),/RETENTION_RUN_LIMIT_INVALID/);
  assert.equal(calls,0);
 }
});

test("conservative admission includes missing payload and rejects before payload downloads or deletion",async()=>{
 const {db,port}=await fixture(),{store,files}=memoryStore();let payloadCalls=0,deletes=0,restores=0;
 try{
  const plan=await port.plan(),schema=await port.schema();
  const bytes=(value:unknown)=>Buffer.byteLength(JSON.stringify(value));
  let metadata=bytes(plan)+bytes(schema);
  for(const table of PAYLOAD_TABLES)metadata+=bytes(await port.fingerprint(table,plan.protected));
  for(const run of plan.candidates)for(const table of PAYLOAD_TABLES)metadata+=bytes(await port.index(table,run.id));
  await assert.rejects(dailyRetention({maximumRuns:2,maximumReturnedBytes:metadata+4096,
   db:{...port,payload:async(t,r)=>{payloadCalls++;return port.payload(t,r);},deleteChunk:async()=>{deletes++;throw Error("unexpected delete");}},
   store,now:()=>0,assertWindow:async()=>{},restore:async()=>{restores++;},health:async()=>{}}),/RETENTION_ADMISSION_BUDGET/);
  assert.deepEqual([payloadCalls,deletes,restores],[0,0,0]);
  assert.equal((await db.query("SELECT * FROM nb_v2.records")).rows.length,5);
  const stopped=JSON.parse([...files.entries()].find(([name])=>name.endsWith("/stopped"))![1]);
  assert.equal(stopped.inFlightIntent,null);assert.equal(stopped.automaticRetry,false);
 }finally{await db.close();}
});

test("catalog review admits only the pinned observer delta and never changes the database guard",async()=>{
 const {db,port}=await fixture();
 const snapshot=async()=> (await db.query<CatalogSnapshot>(retentionCatalogInspectionSQL)).rows[0];
 try{
  const before=await snapshot();
  await db.exec(`CREATE SCHEMA nb_cache;
   CREATE FUNCTION nb_cache.observe_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
   CREATE TRIGGER nb_cache_projection_change AFTER DELETE ON nb_thumbnails.media FOR EACH STATEMENT EXECUTE FUNCTION nb_cache.observe_test();`);
  const after=await snapshot(),added=after.catalogLines.filter(line=>!before.catalogLines.includes(line));
  assert.equal(added.length,1);
  const expected={beforeSHA256:before.actualCatalogSHA256,afterSHA256:after.actualCatalogSHA256,approvedObserverLineSHA256:sha256(added[0]),
   catalogFunctionSHA256:before.catalogFunctionSHA256,guardFunctionSHA256:before.guardFunctionSHA256};
  const result=reviewRetentionCatalog(after,expected);assert.equal(result.databaseWrites,0);assert.equal(result.maintenanceResumeAuthorized,false);
  await assert.rejects(port.plan(),/RETENTION_DISABLED_OR_CATALOG_CHANGED/);
  assert.equal((await snapshot()).storedGuardSHA256,before.storedGuardSHA256);
  assert.throws(()=>reviewRetentionCatalog({...after,guardFunctionSHA256:"b".repeat(64)},expected),/BINDING_MISMATCH/);
  await db.exec("ALTER TABLE nb_v2.records ADD COLUMN unexpected text");
  const changed=await snapshot();
  assert.throws(()=>reviewRetentionCatalog(changed,{...expected,afterSHA256:changed.actualCatalogSHA256}),/DELTA_MISMATCH/);
  await db.exec("ALTER TABLE nb_thumbnails.media DISABLE TRIGGER nb_cache_projection_change");
  const disabled=await snapshot();
  assert.throws(()=>reviewRetentionCatalog(disabled,{...expected,afterSHA256:disabled.actualCatalogSHA256}),/DELTA_MISMATCH/);
 }finally{await db.close();}
});
