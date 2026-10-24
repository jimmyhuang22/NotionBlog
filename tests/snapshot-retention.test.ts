import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {PGlite} from "@electric-sql/pglite";
import {archiveIndexSQL, archivePayloadSQL, retentionPlanSQL, runArray, deleteChunkSQL} from "../scripts/database-retention/plan.ts";

const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
async function fixture() {
  const db = new PGlite();
  await db.exec(`CREATE SCHEMA nb_v2; CREATE SCHEMA nb_publication; CREATE SCHEMA nb_v2_media;
  CREATE SCHEMA nb_thumbnails; CREATE SCHEMA nb_revalidation; CREATE SCHEMA nb_delta;
  CREATE TABLE nb_v2.state(singleton boolean,current_run uuid,lease_run uuid);
  CREATE TABLE nb_publication.state(singleton boolean,run_id uuid);
  CREATE TABLE nb_v2.runs(id uuid PRIMARY KEY,status text,started_at timestamptz,finished_at timestamptz,valid_until timestamptz);
  CREATE TABLE nb_v2.records(run_id uuid,id text,item jsonb,PRIMARY KEY(run_id,id));
  CREATE TABLE nb_v2.media(run_id uuid,asset_id text,owner_page_id text,descriptor jsonb,PRIMARY KEY(run_id,asset_id));
  CREATE TABLE nb_v2_media.sources(run_id uuid,asset_id text,binding jsonb);
  CREATE TABLE nb_v2.tombstones(run_id uuid,id text,reason text);
  CREATE TABLE nb_thumbnails.media(version text,run_id uuid,parent_asset_id text,parent_sha text,width_cap integer,descriptor jsonb);
  CREATE TABLE nb_revalidation.bindings(run_id uuid,previous_run uuid);
  CREATE TABLE nb_delta.operations(operation_id uuid,expected_revision text);
  INSERT INTO nb_v2.state VALUES(true,'${id(10)}','${id(12)}');
  INSERT INTO nb_publication.state VALUES(true,'${id(2)}');`);
  for (let n = 1; n <= 12; n++) {
    await db.query(`INSERT INTO nb_v2.runs VALUES($1,$2,now()-($3||' days')::interval,now()-($3||' days')::interval,now()-interval '1 hour')`, [id(n), n === 12 ? "staging" : "published", 20-n]);
    await db.query(`INSERT INTO nb_v2.records VALUES($1,'same',$2)`, [id(n),{body:"same content"}]);
  }
  return db;
}
test("retention protects pointers, rollback, active work, recent successes and transitive thumbnail donors", async () => {
  const db = await fixture();
  try {
    for (const [run, asset, owner, sha] of [[10,"a","owner","aa"],[4,"a","owner","aa"],[4,"b","other","bb"],[5,"b","other","bb"],[6,"a","wrong","aa"]] as const) {
      await db.query("INSERT INTO nb_v2.media VALUES($1,$2,$3,$4)", [id(run),asset,owner,{sha256:sha}]);
    }
    for (const [run, asset, sha] of [[4,"a","aa"],[5,"b","bb"],[6,"a","aa"]] as const) {
      await db.query("INSERT INTO nb_thumbnails.media VALUES('v2',$1,$2,$3,800,'{}')", [id(run),asset,sha]);
    }
    await db.query("INSERT INTO nb_revalidation.bindings VALUES($1,$2)", [id(7),id(3)]);
    await db.query("INSERT INTO nb_delta.operations VALUES($1,$2)", [id(8),id(1)+":1"]);
    const result = (await db.query<{plan:{protected:string[];candidates:{id:string}[]}}>(retentionPlanSQL([id(11)]))).rows[0].plan;
    assert.ok([1,2,3,4,5,7,8,9,10,11,12].every(n=>result.protected.includes(id(n))));
    assert.deepEqual(result.candidates.map(x=>x.id),[id(6)]);
  } finally { await db.close(); }
});
test("retention also protects valid qualification and the last day of completions",async()=>{
  const db=await fixture();
  try {
    await db.query("UPDATE nb_v2.runs SET finished_at=now()-interval '1 hour' WHERE id=$1",[id(1)]);
    await db.query("UPDATE nb_v2.runs SET valid_until=now()+interval '1 hour' WHERE id=$1",[id(3)]);
    const p=(await db.query<{plan:{protected:string[]}}>(retentionPlanSQL([]))).rows[0].plan;
    assert.ok(p.protected.includes(id(1))&&p.protected.includes(id(3)));
  } finally {await db.close();}
});
test("unknown completion times cannot displace three completed versions or lose their donor dependencies",async()=>{
  const db=await fixture();
  try {
    for(const n of [13,14,15,16]) await db.query(`INSERT INTO nb_v2.runs VALUES($1,'published',now()-interval '5 days',NULL,now()-interval '1 day')`,[id(n)]);
    await db.query("INSERT INTO nb_v2.media VALUES($1,'a','owner','{\"sha256\":\"aa\"}'),($2,'a','owner','{\"sha256\":\"aa\"}')",[id(13),id(4)]);
    await db.query("INSERT INTO nb_thumbnails.media VALUES('v2',$1,'a','aa',800,'{}')",[id(4)]);
    // Equal completion times still use the existing deterministic ID tie-break.
    await db.query("UPDATE nb_v2.runs SET finished_at=now()-interval '2 days' WHERE id=ANY($1)",[[7,8,9,10,11].map(id)]);
    const p=(await db.query<{plan:{protected:string[];candidates:{id:string}[]}}>(retentionPlanSQL([]))).rows[0].plan;
    for(const n of [4,9,10,11,13,14,15,16]) assert.ok(p.protected.includes(id(n)),`run ${n} must remain protected`);
    assert.ok(p.candidates.some(row=>row.id===id(8)),"older tied run is not mistaken for a top-three completion");
    assert.equal(p.candidates.some(row=>[9,10,11,13,14,15,16].map(id).includes(row.id)),false);
  }finally{await db.close();}
});
test("archive fetches shared payload once and restores exact data to both original runs",async()=>{
  const db=await fixture();
  try {
    const index=(await db.query<{sha:string;bytes:number;sample_run:string;key:string;width:null;runs:string[]}>(archiveIndexSQL("nb_v2.records",[id(1),id(2)]))).rows;
    assert.equal(index.length,1);assert.deepEqual(index[0].runs,[id(1),id(2)]);
    const payload=(await db.query<{sha:string;data:string}>(archivePayloadSQL("nb_v2.records",index))).rows;
    assert.equal(payload.length,1);assert.equal(createHash("sha256").update(payload[0].data).digest("hex"),index[0].sha);
    await db.exec("CREATE TEMP TABLE restored(LIKE nb_v2.records INCLUDING ALL)");
    for(const run of index[0].runs)await db.query("INSERT INTO restored SELECT * FROM jsonb_populate_record(NULL::nb_v2.records,$1::jsonb)",[JSON.stringify({...JSON.parse(payload[0].data),run_id:run})]);
    assert.deepEqual((await db.query("SELECT * FROM restored ORDER BY run_id")).rows,(await db.query("SELECT * FROM nb_v2.records WHERE run_id=ANY($1) ORDER BY run_id",[[id(1),id(2)]])).rows);
  } finally{await db.close();}
});
test("run and export selectors reject injected identifiers",()=>{
  assert.throws(()=>runArray(["x';delete from nb_v2.records;--"]));
  assert.throws(()=>archiveIndexSQL("unknown" as never,[]));
  assert.throws(()=>archivePayloadSQL("nb_v2.records",[{sha:"x",sample_run:id(1),key:"a",width:null}]));
});
test("deletion requires matching archived hashes and idle unchanged pointers; summaries survive",async()=>{
  const db=await fixture();
  try {
    await db.exec("ALTER TABLE nb_v2.state ADD COLUMN lease_until timestamptz; UPDATE nb_v2.state SET lease_run=NULL");
    const plan=(await db.query<{plan:{stateSHA256:string;publicationSHA256:string;candidates:{id:string;summary_sha256:string}[]}}>(retentionPlanSQL([]))).rows[0].plan;
    const candidate=plan.candidates.find(x=>x.id===id(1))!;
    const index=(await db.query<{sha:string}>(archiveIndexSQL("nb_v2.records",[id(1)]))).rows;
    const remaining=createHash("sha256").update(index.map(x=>x.sha).sort().join("")).digest("hex");
    const guard={run:id(1),stateSHA256:plan.stateSHA256,publicationSHA256:plan.publicationSHA256,summarySHA256:candidate.summary_sha256,remainingPayloadSHA256:remaining};
    const wrong=(await db.query<{result:{guardAccepted:boolean;deleted:string[]}}>(deleteChunkSQL("nb_v2.records",{...guard,remainingPayloadSHA256:"0".repeat(64)}))).rows[0].result;
    assert.equal(wrong.guardAccepted,false);assert.deepEqual(wrong.deleted,[]);
    await db.query("UPDATE nb_v2.state SET lease_run=$1",[id(12)]);
    assert.equal((await db.query<{result:{guardAccepted:boolean}}>(deleteChunkSQL("nb_v2.records",guard))).rows[0].result.guardAccepted,false);
    await db.exec("UPDATE nb_v2.state SET lease_run=NULL");
    const ok=(await db.query<{result:{guardAccepted:boolean;deleted:string[]}}>(deleteChunkSQL("nb_v2.records",guard,1))).rows[0].result;
    assert.equal(ok.guardAccepted,true);assert.deepEqual(ok.deleted,index.map(x=>x.sha));
    assert.equal((await db.query<{n:number}>("SELECT count(*)::integer n FROM nb_v2.runs")).rows[0].n,12);
    assert.equal((await db.query<{result:{guardAccepted:boolean}}>(deleteChunkSQL("nb_v2.records",guard))).rows[0].result.guardAccepted,false);
  }finally{await db.close();}
});
