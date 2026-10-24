import test from "node:test";
import assert from "node:assert/strict";
import {PGlite} from "@electric-sql/pglite";
import {retentionMigrationSQL} from "../scripts/database-retention/migration.ts";
import {dailyRetention, sha256, hashesDigest, type ArchiveStore, type DailyContext, type RetentionPort, type RetentionPlan} from "../scripts/database-retention/daily.ts";
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


test("rolling row allowance rejects the full archive set before download, restore or delete",async()=>{
 const {db,port}=await fixture(),{store}=memoryStore();let downloads=0,deletes=0,restores=0;
 try{
  await assert.rejects(dailyRetention({maximumRuns:2,maximumDeletedRows:5,db:{...port,
   payload:async()=>{downloads++;return [];},deleteChunk:async()=>{deletes++;throw Error("unexpected write");}},store,now:()=>0,assertWindow:async()=>{},
   restore:async()=>{restores++;},health:async()=>{}}),/RETENTION_ROW_BUDGET/);
  assert.deepEqual([downloads,restores,deletes],[0,0,0]);
  assert.equal((await db.query("SELECT * FROM nb_v2.records")).rows.length,5);
 }finally{await db.close();}
});


test("actual rolling CLI closes its SQL adapter and accounts identity plus extra plan, with row admission before writes",async()=>{
 const {mkdtemp,mkdir,writeFile,readFile,lstat,rm,readdir}=await import("node:fs/promises");
 const {tmpdir}=await import("node:os");const {join,dirname,resolve}=await import("node:path");const {pathToFileURL}=await import("node:url");
 const {initialRollingLedger,reserveRolling,settleRolling,rollingLedgerPath}=await import("../scripts/database-retention/rolling-ledger.ts");
 const key=Symbol.for("notionblog.test.retention-pool");
 const host=globalThis as typeof globalThis&{[key]:{db:PGlite;closed:boolean;rowsBeforeClose?:number}};
 for(const maximumRows of [6,5]){
  const {db}=await fixture(),dir=await mkdtemp(join(tmpdir(),"retention-real-cli-"));
  const originalArgv=process.argv,originalFetch=globalThis.fetch;
  const oldEnv={url:process.env.RETENTION_DATABASE_URL,tls:process.env.DATABASE_TLS};
  host[key]={db,closed:false};
  try{
   await db.exec("SET ROLE nb_retention_executor");
   const state=join(dir,"state"),archive=join(dir,"archive"),reservationId=id(105),folder=join(state,reservationId);
   await mkdir(folder,{recursive:true,mode:0o700});await mkdir(archive,{mode:0o700});
   const shim=join(dir,"pg-fixture.mjs");
   await writeFile(shim,`export class Pool{constructor(){this.host=globalThis[Symbol.for('notionblog.test.retention-pool')];}
    on(){} async query(text,values){if(!values&&text.includes(';')){await this.host.db.exec(text);return {rows:[]};}return this.host.db.query(text,values);}
    async connect(){return {query:this.query.bind(this),release(){}};}
    async end(){await this.host.db.exec('RESET ROLE');this.host.rowsBeforeClose=(await this.host.db.query('SELECT count(*)::integer n FROM nb_v2.records')).rows[0].n;await this.host.db.close();this.host.closed=true;}}`,{mode:0o600});
   const sourcePath=resolve("scripts/database-retention/cli.ts"),source=await readFile(sourcePath,"utf8");
   const originalMain=source.slice(0,source.indexOf('\nmain().catch'));
   assert.ok(originalMain.length>1000);
   const bound=originalMain.replace(/from "([^"\n]+)"/g,(match,specifier:string)=>specifier==='pg'?`from ${JSON.stringify(pathToFileURL(shim).href)}`:
    specifier.startsWith('.')?`from ${JSON.stringify(pathToFileURL(resolve(dirname(sourcePath),specifier)).href)}`:match);
   const entry=join(dir,"cli-under-test.mts");await writeFile(entry,bound+'\nexport {main};\n',{mode:0o600});
   let ledger=reserveRolling(initialRollingLedger(state,archive,0),id(9),id(109),0,2);
   ledger=settleRolling(ledger,id(109),{runs:1,returnedBytes:0,deleteCalls:0,deletedRows:250_000-maximumRows},Date.now());
   ledger=reserveRolling(ledger,id(5),reservationId,Date.now(),2);
   const rawLedger=JSON.stringify(ledger),ledgerPath=rollingLedgerPath(archive);await writeFile(ledgerPath,rawLedger,{mode:0o600});
   const sync=join(dir,"sync.json"),operation=join(dir,"source");await writeFile(sync,JSON.stringify({status:"PASS",runId:id(5),operation}),{mode:0o600});
   const proofs=[{path:ledgerPath,sha256:sha256(rawLedger)}];
   for(let n=0;n<4;n++){const path=join(dir,`proof${n}.json`);await writeFile(path,"{}",{mode:0o600});proofs.push({path,sha256:sha256("{}")});}
   const locks=[];
   for(let n=0;n<4;n++){const path=join(dir,`lock${n}`);await writeFile(path,"owned",{mode:0o600});const st=await lstat(path);locks.push({path,ino:st.ino,dev:st.dev,sha256:sha256("owned")});}
   const binary=join(dir,"dependency.wasm"),binaryBytes=Buffer.from([0xff,0x00,0x61]);await writeFile(binary,binaryBytes,{mode:0o600});
   const windowPath=join(folder,"WINDOW_PRIVATE.json"),window={format:"retention-after-sync-window-v3",maximumRuns:2,runId:id(5),deadline:Date.now()+300_000,syncState:sync,operation,
    locks,absentLocks:[join(dir,"absent")],proofs,archiveDirectory:archive,healthURL:"https://example.org/api/health/content",programFiles:[{path:entry,sha256:sha256(await readFile(entry,"utf8"))},{path:binary,sha256:sha256(binaryBytes)}],
    rolling:{reservationId,stateDirectory:state,limits:ledger.entries.at(-1)!.reserved}};
   const rawWindow=JSON.stringify(window);await writeFile(windowPath,rawWindow,{mode:0o600});
   process.env.RETENTION_DATABASE_URL="postgresql://fixture:fixture@127.0.0.1:1/fixture";process.env.DATABASE_TLS="disable";
   globalThis.fetch=(async(input)=>{assert.equal(String(input),window.healthURL);return new Response("{}",{status:200});}) as typeof fetch;
   process.argv=[process.execPath,entry,"--window",windowPath];const cli=await import(pathToFileURL(entry).href);
   if(maximumRows===6){
    await cli.main();assert.equal(host[key].closed,true);assert.equal(host[key].rowsBeforeClose,3);
    const actual=JSON.parse(await readFile(join(folder,"USAGE_PRIVATE.json"),"utf8"));assert.equal(actual.deletedRows,6);assert.equal(actual.runs,2);assert.equal(actual.connectionsClosed,true);
    assert.equal(actual.windowSHA256,sha256(rawWindow));
    const operation=(await readdir(archive)).find(name=>/^[a-f0-9-]{36}$/.test(name));assert.ok(operation);
    const core=JSON.parse(await readFile(join(archive,operation,"completion.json"),"utf8"));assert.ok(actual.returnedBytes>core.returnedBytes,"entry role and extra plan are also charged");
   }else{
    await assert.rejects(cli.main(),/RETENTION_ROW_BUDGET/);assert.equal(host[key].closed,true);assert.equal(host[key].rowsBeforeClose,5);
    await assert.rejects(lstat(join(folder,"USAGE_PRIVATE.json")),{code:"ENOENT"});
   }
  }finally{
   process.argv=originalArgv;globalThis.fetch=originalFetch;
   if(oldEnv.url===undefined)delete process.env.RETENTION_DATABASE_URL;else process.env.RETENTION_DATABASE_URL=oldEnv.url;
   if(oldEnv.tls===undefined)delete process.env.DATABASE_TLS;else process.env.DATABASE_TLS=oldEnv.tls;
   if(!host[key].closed)await db.close();delete (host as unknown as Record<symbol,unknown>)[key];await rm(dir,{recursive:true,force:true});
  }
 }
});
