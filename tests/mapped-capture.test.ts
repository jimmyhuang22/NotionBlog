import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { BlockObjectResponse } from "@notionhq/client";
import type { SqlExecutor } from "../src/server/database/sql.ts";
import { WEBSITE_SCHEMA_DIGEST } from "../contracts/website-sync.ts";
import { createDemo, DEMO, DEMO_PNG, demoId, demoParagraph } from "../scripts/notion-sync/demo.ts";
import { parseWebsiteNotionConfig } from "../src/server/notion/website-config.ts";
import { createWebsiteWriter } from "../src/server/database/website-writer.ts";
import { configDigest } from "../src/server/database/website-validation.ts";
import { runWebsiteSync, websitePolicy } from "../scripts/website-sync/worker.ts";
import { createCollectionCapture } from "../scripts/website-sync/collection-capture.ts";
import { bindFreshCollectionDeadline, prepareCollectionResume } from "../scripts/website-sync/collection-revalidation.ts";
import { courseRatingRemoval, applyCourseRatingRemovalPolicy } from "../scripts/website-sync/mapped-capture.ts";
import { recoveryFixture } from "./helpers/capture-recovery-fixture.ts";
import revalidation from "../database/qualified-revalidation-protocol.json" with { type: "json" };
import fresh from "../database/fresh-qualification-protocol.json" with { type: "json" };
import mapped from "../database/mapped-capture-protocol.json" with { type: "json" };

const storage = { put: async () => assert.fail("No image upload expected"), read: async () => DEMO_PNG };
function configurations() {
  const demo = createDemo(2);
  const previous = { schemaVersion: 2, timeZone: "Australia/Melbourne", sources: demo.config.sources.slice(0,2) };
  previous.sources[1].fields = { title: "Name", recommendation: "Recommendation", difficulty: "Difficulty" };
  const current = structuredClone(previous); current.sources[1].fields = { title: "Name" };
  return { demo, previous, current, previousText: JSON.stringify(previous), currentText: JSON.stringify(current) };
}

test("mapping transition accepts only the removal of course recommendation/difficulty, never scope or other mappings", () => {
  const f = configurations(), transition = courseRatingRemoval(f.previousText, f.currentText);
  assert.equal(transition.removedMappings,2);
  for (const mutate of [
    (x: typeof f.current) => { x.timeZone = "UTC"; },
    (x: typeof f.current) => { x.sources[0].dataSourceId = demoId(999); },
    (x: typeof f.current) => { x.sources[1].publication.allowlistPageIds.push(demoId(99)); },
    (x: typeof f.current) => { x.sources[1].fields = {...x.sources[1].fields,title:"Other"}; },
    (x: typeof f.current) => { x.sources[1].fields = {...x.sources[1].fields,difficulty:"Difficulty"}; },
    (x: typeof f.current) => { x.sources[0].enabled = false; },
  ]) { const changed = structuredClone(f.current); mutate(changed); assert.throws(()=>courseRatingRemoval(f.previousText,JSON.stringify(changed))); }
  assert.throws(()=>courseRatingRemoval(f.previousText,f.previousText));
});

async function fixture(t: test.TestContext) {
  const f = configurations(), db = await PGlite.create(), root = await realpath(await mkdtemp(join(tmpdir(),"mapped-capture-")));
  t.after(async()=>{ await db.close(); await rm(root,{recursive:true,force:true}); });
  await db.exec(await readFile(new URL("../database/website-migrations/001_website.sql",import.meta.url),"utf8"));
  await db.query("UPDATE nb_v2.state SET schema_digest=$1",[WEBSITE_SCHEMA_DIGEST]);
  for (const protocol of [revalidation,fresh,mapped]) await db.exec(await readFile(new URL(`../supabase/migrations/${protocol.migration.file}`,import.meta.url),"utf8"));
  for (const [name,id,value] of [["Recommendation","recommendation",4],["Difficulty","difficulty",2]] as const) {
    f.demo.schemas.get(DEMO.courses)!.properties[name] = { id,name,description:null,type:"number",number:{format:"number"} };
    f.demo.pages.get(DEMO.course)!.properties[name] = { id,type:"number",number:value };
  }
  const config = parseWebsiteNotionConfig(f.previous), policy = await websitePolicy(f.demo.client,config,3600);
  await db.query("SELECT nb_v2_api.configure_policy($1,$2,$3::jsonb,$4::jsonb)",[policy.configDigest,3600,JSON.stringify(policy.sources),JSON.stringify(policy.permits)]);
  const writer = createWebsiteWriter(db), previousLease = await writer.begin(randomUUID(),policy.configDigest);
  const identity = {runId:previousLease.runId,sourceSha256:createHash("sha256").update(f.previousText).digest("hex"),configDigest:policy.configDigest,releaseCommit:"a".repeat(40)};
  const directory = join(root,"old");
  await runWebsiteSync({config,client:f.demo.client,mode:"publish",writer:{...writer,begin:async()=>previousLease},storage,
    captureCollection:await createCollectionCapture(directory,identity)});
  const oldRun = (await db.query("SELECT to_jsonb(r) AS row FROM nb_v2.runs r WHERE id=$1",[previousLease.runId])).rows;
  const indexBytes = await readFile(join(directory,"index-private.json"));
  delete f.demo.schemas.get(DEMO.courses)!.properties.Recommendation;
  delete f.demo.schemas.get(DEMO.courses)!.properties.Difficulty;
  delete f.demo.pages.get(DEMO.course)!.properties.Recommendation;
  delete f.demo.pages.get(DEMO.course)!.properties.Difficulty;
  const nextConfig = parseWebsiteNotionConfig(f.current), nextPolicy = await websitePolicy(f.demo.client,nextConfig,3600);
  const state = (await db.query<{revision:string;epoch:string;currentRun:string}>("SELECT revision::text,epoch::text,current_run::text AS \"currentRun\" FROM nb_v2.state")).rows[0];
  return {...f,db,root,writer,previousLease,identity,directory,oldRun,indexBytes,nextConfig,nextPolicy,state};
}

test("actual worker keeps the last success readable, freshly collects changed courses/bodies and reuses only freshly verified unaffected pages",async t=>{
  const f = await fixture(t);
  await applyCourseRatingRemovalPolicy(f.db,f.previousText,f.currentText,f.nextPolicy,f.state);
  const before = (await f.db.query<{result:{records:{item:{kind:string;ratings?:{recommendation:{value:number}|null}}}[]}}>("SELECT nb_v2_api.read_snapshot(ARRAY['status','course'],true) AS result")).rows[0].result;
  assert.equal(before.records.find(x=>x.item.kind==="course")!.item.ratings!.recommendation!.value,4);
  assert.deepEqual((await f.db.query("SELECT to_jsonb(r) AS row FROM nb_v2.runs r WHERE id=$1",[f.previousLease.runId])).rows,f.oldRun);
  f.demo.blocks.set(demoId(1000),[demoParagraph(demoId(8000),demoId(1000),"Changed body without changing page timestamp")]);
  const transition = courseRatingRemoval(f.previousText,f.currentText);
  const resume = await prepareCollectionResume({directory:f.directory,identity:f.identity,db:f.db,qualification:"fresh",recovery:{admission:recoveryFixture("course-rating-removal").admit(),mapping:transition,current:{sourceSha256:transition.currentSourceSha256,configDigest:transition.currentConfigDigest,releaseCommit:"d".repeat(40)}}});
  assert.equal(resume.pages.length,2); assert.ok(resume.pages.every(x=>x.record.detail.item.kind!=="course"));
  const next = await f.writer.begin(randomUUID(),f.nextPolicy.configDigest);
  const result = await runWebsiteSync({config:f.nextConfig,client:f.demo.client,mode:"publish",writer:{...f.writer,begin:async()=>next},storage,resumeCollection:resume,
    captureCollection:await createCollectionCapture(join(f.root,"new"),{...f.identity,runId:next.runId,configDigest:f.nextPolicy.configDigest,sourceSha256:transition.currentSourceSha256})});
  assert.deepEqual(result.resume,{reusedPages:1,recollectedPages:1,newPages:1,unseenSavedPages:0});
  const after = (await f.db.query<{result:{records:{item:{kind:string;ratings?:{recommendation:null;difficulty:null}};document:unknown}[]}}>("SELECT nb_v2_api.read_snapshot(ARRAY['status','course'],true) AS result")).rows[0].result;
  const course = after.records.find(x=>x.item.kind==="course")!.item;
  assert.equal(course.ratings!.recommendation,null); assert.equal(course.ratings!.difficulty,null);
  assert.match(JSON.stringify(after),/Changed body without changing page timestamp/);
  assert.deepEqual(await readFile(join(f.directory,"index-private.json")),f.indexBytes);
  assert.deepEqual((await f.db.query("SELECT to_jsonb(r) AS row FROM nb_v2.runs r WHERE id=$1",[f.previousLease.runId])).rows,f.oldRun);
});

test("mapped inspection enforces current lease and historical identity, rejects readers and never changes either run deadline",async t=>{
  const f = await fixture(t); await applyCourseRatingRemovalPolicy(f.db,f.previousText,f.currentText,f.nextPolicy,f.state);
  await f.db.query("UPDATE nb_v2.runs SET valid_until=clock_timestamp()-interval '1 day' WHERE id=$1",[f.previousLease.runId]);
  const next = await f.writer.begin(randomUUID(),f.nextPolicy.configDigest), transition = courseRatingRemoval(f.previousText,f.currentText);
  const before = (await f.db.query("SELECT id,valid_until FROM nb_v2.runs ORDER BY id")).rows;
  await f.db.exec("SET ROLE nb_writer");
  await bindFreshCollectionDeadline(f.db,next,f.previousLease,transition);
  await assert.rejects(bindFreshCollectionDeadline(f.db,next,{...f.previousLease,fence:"999999"},transition));
  await assert.rejects(bindFreshCollectionDeadline(f.db,next,f.previousLease));
  await f.db.exec("RESET ROLE; SET ROLE nb_reader");
  await assert.rejects(f.db.query("SELECT nb_revalidation_api.inspect_mapped_fresh_run($1,$2,$3,$4,$5,$6)",[next.runId,next.fence,f.previousLease.runId,f.previousLease.fence,f.previousLease.revision,f.previousLease.configDigest]),/permission denied/);
  await f.db.exec("RESET ROLE");
  assert.deepEqual((await f.db.query("SELECT id,valid_until FROM nb_v2.runs ORDER BY id")).rows,before);
  await f.db.query("UPDATE nb_v2.runs SET valid_until=clock_timestamp()-interval '1 second' WHERE id=$1",[next.runId]);
  await assert.rejects(bindFreshCollectionDeadline(f.db,next,f.previousLease,transition));
});

test("mapping-only policy refuses changed scope or a concurrent writer and rolls back all state",async t=>{
  for (const scenario of ["scope","source","writer","revision","epoch","current-run","freshness","old-digest","orphan-lease"] as const) await t.test(scenario,async t=>{
    const f = await fixture(t), policy = structuredClone(f.nextPolicy);
    if(scenario==="scope")policy.permits.push({...policy.permits[0],id:demoId(200)});
    if(scenario==="source")policy.sources[0].dataSourceId=demoId(201);
    if(scenario==="writer")await f.writer.begin(randomUUID(),f.identity.configDigest);
    if(scenario==="revision")await f.db.query("UPDATE nb_v2.state SET revision=revision+1");
    if(scenario==="epoch")await f.db.query("UPDATE nb_v2.state SET epoch=epoch+1");
    if(scenario==="current-run")await f.db.query("UPDATE nb_v2.state SET current_run=NULL");
    if(scenario==="freshness")policy.freshnessSeconds++;
    if(scenario==="old-digest")await f.db.query("UPDATE nb_v2.state SET config_digest=$1",["0".repeat(64)]);
    if(scenario==="orphan-lease")await f.db.query("UPDATE nb_v2.state SET lease_until=clock_timestamp()+interval '1 minute'");
    const before = (await f.db.query("SELECT to_jsonb(s) AS row FROM nb_v2.state s")).rows;
    await assert.rejects(applyCourseRatingRemovalPolicy(f.db,f.previousText,f.currentText,policy,f.state));
    assert.deepEqual((await f.db.query("SELECT to_jsonb(s) AS row FROM nb_v2.state s")).rows,before);
  });
});

test("mapping transition binds raw bytes and aliases and rejects changes to disabled sources or unknown fields", () => {
  const f = configurations(), previous = structuredClone(f.previous);
  previous.sources[1].fields = { title: "Name", recommendationRating: "Recommendation", difficultyRating: "Difficulty" };
  const transition = courseRatingRemoval(JSON.stringify(previous), f.currentText);
  assert.equal(transition.removedMappings, 2);
  assert.equal(transition.previousSourceSha256, createHash("sha256").update(JSON.stringify(previous)).digest("hex"));
  assert.notEqual(courseRatingRemoval(JSON.stringify(previous, null, 2), f.currentText).previousSourceSha256, transition.previousSourceSha256);
  for (const after of [
    { ...f.current, additionalOverride: true },
    { ...f.current, sources: [...f.current.sources, { kind: "course", enabled: false, fields: {} }] },
    { ...f.current, sources: [...f.current.sources].reverse() },
  ]) assert.throws(() => courseRatingRemoval(f.previousText, JSON.stringify(after)));
  const disabled = { ...f.previous, sources: [...f.previous.sources, { kind: "course", enabled: false, fields: { recommendation: "Keep" } as Record<string, string> }] };
  const changed = structuredClone(disabled); changed.sources[1].fields = { title: "Name" };
  changed.sources[2] = { ...changed.sources[2], fields: {} };
  assert.throws(() => courseRatingRemoval(JSON.stringify(disabled), JSON.stringify(changed)));
});

test("only the owner transaction can apply policy and an exception after UPDATE rolls it back", async t => {
  const f = await fixture(t);
  const before = (await f.db.query("SELECT to_jsonb(s) AS row FROM nb_v2.state s")).rows;
  await f.db.exec("SET ROLE nb_writer");
  await assert.rejects(applyCourseRatingRemovalPolicy(f.db, f.previousText, f.currentText, f.nextPolicy, f.state), /permission denied/);
  await f.db.exec("RESET ROLE");
  const owner = { transaction: <T>(work: (tx: SqlExecutor) => Promise<T>) => f.db.transaction(async tx => {
    const result = await work(tx); assert.ok(result); throw new Error("Synthetic transaction failure after UPDATE");
  }) };
  await assert.rejects(applyCourseRatingRemovalPolicy(owner, f.previousText, f.currentText, f.nextPolicy, f.state), /Synthetic transaction failure/);
  assert.deepEqual((await f.db.query("SELECT to_jsonb(s) AS row FROM nb_v2.state s")).rows, before);
  await applyCourseRatingRemovalPolicy(f.db, f.previousText, f.currentText, f.nextPolicy, f.state);
  const after = (await f.db.query<{revision:string;epoch:string;currentRun:string}>("SELECT revision::text,epoch::text,current_run::text AS \"currentRun\" FROM nb_v2.state")).rows[0];
  assert.deepEqual(after, { ...f.state, revision: String(BigInt(f.state.revision) + 1n) });
  assert.deepEqual((await f.db.query("SELECT to_jsonb(r) AS row FROM nb_v2.runs r WHERE id=$1", [f.previousLease.runId])).rows, f.oldRun);
});

test("mapped recovery refuses forged configuration receipts and wrong source identities before reading a capture", async () => {
  const f = configurations(), mapping = courseRatingRemoval(f.previousText, f.currentText);
  const identity = { runId:randomUUID(), sourceSha256:mapping.previousSourceSha256, configDigest:mapping.previousConfigDigest, releaseCommit:"a".repeat(40) };
  const current = { sourceSha256:mapping.currentSourceSha256, configDigest:mapping.currentConfigDigest, releaseCommit:"d".repeat(40) };
  const recovery = { admission:recoveryFixture("course-rating-removal").admit(), mapping, current };
  const input = { directory:"/missing", identity, db:{query:async()=>assert.fail("No SQL expected")} };
  for (const qualification of [undefined, "original"] as const) await assert.rejects(prepareCollectionResume({...input,qualification,recovery}));
  for (const changed of [
    {...recovery,mapping:{...mapping}},
    {...recovery,current:{...current,sourceSha256:"0".repeat(64)}},
    {...recovery,current:{...current,configDigest:"0".repeat(64)}},
    {...recovery,current:{...current,releaseCommit:"e".repeat(40)}},
    {...recovery,admission:recoveryFixture().admit()},
  ]) await assert.rejects(prepareCollectionResume({...input,qualification:"fresh",recovery:changed}), error => {
    assert.ok(error && typeof error === "object" && "code" in error);
    assert.notEqual(error.code,"ENOENT","Identity rejection must precede capture access"); return true;
  });
});

test("fresh mapping recovery blocks late revocation or movement and rejected images before staging", async t => {
  for (const scenario of ["late-revoke","late-move","bad-image"] as const) await t.test(scenario,async t=>{
    const f = await fixture(t); await applyCourseRatingRemovalPolicy(f.db,f.previousText,f.currentText,f.nextPolicy,f.state);
    const mapping = courseRatingRemoval(f.previousText,f.currentText), nextId = randomUUID();
    const resume = await prepareCollectionResume({directory:f.directory,identity:f.identity,db:f.db,qualification:"fresh",
      recovery:{admission:recoveryFixture("course-rating-removal").admit(),mapping,
        current:{sourceSha256:mapping.currentSourceSha256,configDigest:mapping.currentConfigDigest,releaseCommit:"d".repeat(40)}}});
    if(scenario==="bad-image")f.demo.blocks.set(demoId(1000),[{...demoParagraph(demoId(18000),demoId(1000),""),type:"image",
      image:{type:"external",external:{url:"https://assets.example.test/rejected.png"},caption:[]}} as BlockObjectResponse]);
    const client={...f.demo.client,listBlocks:async(id:string)=>{
      const blocks=await f.demo.client.listBlocks(id);
      if(id===DEMO.course){
        if(scenario==="late-revoke")f.demo.pages.get(id)!.archived=true;
        if(scenario==="late-move")f.demo.pages.get(id)!.parent={type:"page_id",page_id:demoId(19000)};
      }
      return blocks;
    }};
    let staged=0;
    await assert.rejects(runWebsiteSync({config:f.nextConfig,client,mode:"publish",storage,resumeCollection:resume,
      writer:{...f.writer,begin:(_id,digest)=>f.writer.begin(nextId,digest),stage:async(...args)=>{staged++;await f.writer.stage(...args);}},
      download:async()=>{throw new Error("Synthetic image rejection");},
      captureCollection:await createCollectionCapture(join(f.root,"new"),{...f.identity,runId:nextId,sourceSha256:mapping.currentSourceSha256,
        configDigest:mapping.currentConfigDigest,releaseCommit:"d".repeat(40)})}));
    assert.equal(staged,0);
    assert.equal((await f.db.query<{n:number}>("SELECT count(*)::int AS n FROM nb_v2.records WHERE run_id=$1",[nextId])).rows[0].n,0);
    assert.equal((await f.db.query<{current_run:string}>("SELECT current_run::text FROM nb_v2.state")).rows[0].current_run,f.previousLease.runId);
    assert.deepEqual((await f.db.query("SELECT to_jsonb(r) AS row FROM nb_v2.runs r WHERE id=$1",[f.previousLease.runId])).rows,f.oldRun);
  });
});

test("mapped SQL rejects historical identity, wrong status, late staging and stale fences without changing either run", async t => {
  const f = await fixture(t);
  await applyCourseRatingRemovalPolicy(f.db, f.previousText, f.currentText, f.nextPolicy, f.state);
  const next = await f.writer.begin(randomUUID(), f.nextPolicy.configDigest), transition = courseRatingRemoval(f.previousText, f.currentText);
  for (const previous of [
    { ...f.previousLease, runId: randomUUID() }, { ...f.previousLease, revision: "99999" },
    { ...f.previousLease, configDigest: "0".repeat(64) }, next,
  ]) await assert.rejects(bindFreshCollectionDeadline(f.db, next, previous, transition));
  await assert.rejects(bindFreshCollectionDeadline(f.db, { ...next, fence: "99999" }, f.previousLease, transition));
  const sql = "SELECT nb_revalidation_api.inspect_mapped_fresh_run($1,$2,$3,$4,$5,$6)";
  const args = [next.runId, next.fence, f.previousLease.runId, f.previousLease.fence, f.previousLease.revision, f.previousLease.configDigest];
  const baseline = (await f.db.query("SELECT to_jsonb(r) AS row FROM nb_v2.runs r ORDER BY id")).rows;
  const stateBefore = (await f.db.query("SELECT to_jsonb(s) AS row FROM nb_v2.state s")).rows;
  for(const value of [null,"0".repeat(64),"invalid-digest"]){
    await assert.rejects(f.db.query(sql,[...args.slice(0,5),value]),/NB_MAPPED_FRESH_VERIFICATION_INVALID/);
  }
  await assert.rejects(f.db.transaction(async tx=>{
    await tx.query("UPDATE nb_v2.runs SET status='failed' WHERE id=$1",[f.previousLease.runId]);
    await tx.query(sql,args); throw new Error("Synthetic rollback after accepting failed history");
  }),/Synthetic rollback after accepting failed history/);
  for (const change of [
    "UPDATE nb_v2.runs SET status='staging' WHERE id=$1",
    "UPDATE nb_v2.runs SET finished_at=NULL WHERE id=$1",
    "UPDATE nb_v2.runs SET started_at=clock_timestamp()+interval '1 day' WHERE id=$1",
  ]) {
    await assert.rejects(f.db.transaction(async tx => { await tx.query(change, [f.previousLease.runId]); await tx.query(sql, args); throw new Error("Unexpected acceptance"); }), /NB_MAPPED_FRESH_VERIFICATION_INVALID/);
  }
  for (const populate of [
    "INSERT INTO nb_revalidation.bindings SELECT id,$2,valid_until FROM nb_v2.runs WHERE id=$1",
    "INSERT INTO nb_v2.tombstones VALUES($1,'synthetic-page','out-of-scope')",
    "INSERT INTO nb_v2.records SELECT $1,id,kind,source_key,course_id,parent_id,ordinal,item,document FROM nb_v2.records WHERE run_id=$2",
    // Deferred FK deliberately leaves an orphan media row visible within this transaction.
    "INSERT INTO nb_v2.media VALUES($1,'synthetic-asset','synthetic-page','{}')",
  ]) {
    await assert.rejects(f.db.transaction(async tx => {
      await tx.query(populate, populate.includes("$2") ? [next.runId, f.previousLease.runId] : [next.runId]);
      await tx.query(sql, args); throw new Error("Unexpected acceptance");
    }), /NB_MAPPED_FRESH_VERIFICATION_INVALID/);
  }
  const grants = (await f.db.query<{reader:boolean;writer:boolean;direct:boolean;path:boolean}>(`SELECT
    has_function_privilege('nb_reader','nb_revalidation_api.inspect_mapped_fresh_run(uuid,bigint,uuid,bigint,bigint,text)','EXECUTE') AS reader,
    has_function_privilege('nb_writer','nb_revalidation_api.inspect_mapped_fresh_run(uuid,bigint,uuid,bigint,bigint,text)','EXECUTE') AS writer,
    has_table_privilege('nb_writer','nb_v2.state','UPDATE') AS direct,
    (SELECT proconfig @> ARRAY['search_path=pg_catalog, nb_v2, pg_temp'] FROM pg_proc WHERE oid='nb_revalidation_api.inspect_mapped_fresh_run(uuid,bigint,uuid,bigint,bigint,text)'::regprocedure) AS path`)).rows[0];
  assert.deepEqual(grants, { reader:false, writer:true, direct:false, path:true });
  await f.db.exec("CREATE ROLE synthetic_unprivileged NOLOGIN; GRANT USAGE ON SCHEMA nb_revalidation_api TO synthetic_unprivileged; SET ROLE synthetic_unprivileged");
  await assert.rejects(f.db.query(sql, args), /permission denied/); await f.db.exec("RESET ROLE");
  assert.deepEqual((await f.db.query("SELECT to_jsonb(r) AS row FROM nb_v2.runs r ORDER BY id")).rows, baseline);
  assert.deepEqual((await f.db.query("SELECT to_jsonb(s) AS row FROM nb_v2.state s")).rows, stateBefore);
  await f.db.exec("DROP FUNCTION nb_revalidation_api.inspect_mapped_fresh_run(uuid,bigint,uuid,bigint,bigint,text)");
  await assert.rejects(bindFreshCollectionDeadline(f.db, next, f.previousLease, transition));
});
