import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { WEBSITE_SCHEMA_DIGEST } from "../contracts/website-sync.ts";
import { createDemo, demoId, demoParagraph, DEMO_PNG } from "../scripts/notion-sync/demo.ts";
import type { BlockObjectResponse } from "@notionhq/client";
import { parseWebsiteNotionConfig } from "../src/server/notion/website-config.ts";
import { createWebsiteWriter } from "../src/server/database/website-writer.ts";
import { configDigest } from "../src/server/database/website-validation.ts";
import { runWebsiteSync, websitePolicy } from "../scripts/website-sync/worker.ts";
import { createCollectionCapture, readCollectionCaptureForRevalidation } from "../scripts/website-sync/collection-capture.ts";
import { PublicationRevalidationError, type PublicationRevalidationProgress } from "../scripts/website-sync/publication-revalidation.ts";
import { createWebsiteImageDownloader, websiteImageFailure } from "../scripts/website-sync/download.ts";
import { bindFreshCollectionDeadline, bindCollectionDeadline, runRevalidatedWebsiteSync, prepareCollectionResume } from "../scripts/website-sync/collection-revalidation.ts";
import protocol from "../database/qualified-revalidation-protocol.json" with { type: "json" };

import freshProtocol from "../database/fresh-qualification-protocol.json" with { type: "json" };

const storage = { put: async () => {}, read: async () => DEMO_PNG };
async function fixture(t: test.TestContext, withImage = false, transformed = false) {
  const db = await PGlite.create(), root = await realpath(await mkdtemp(join(tmpdir(), "revalidation-")));
  t.after(async () => { await db.close(); await rm(root, { recursive: true, force: true }); });
  await db.exec(await readFile(new URL("../database/website-migrations/001_website.sql", import.meta.url), "utf8"));
  await db.query("UPDATE nb_v2.state SET schema_digest=$1", [WEBSITE_SCHEMA_DIGEST]);
  await db.exec(await readFile(new URL(`../supabase/migrations/${protocol.migration.file}`, import.meta.url), "utf8"));
  await db.exec(await readFile(new URL(`../supabase/migrations/${freshProtocol.migration.file}`, import.meta.url), "utf8"));
  const demo = createDemo(2), config = parseWebsiteNotionConfig({ schemaVersion: 2, sources: [{ ...demo.config.sources[0], kind: "game" }] });
  if (withImage) demo.blocks.set(demoId(1000), [{ ...demoParagraph(demoId(9000), demoId(1000), ""), type: "image",
    image: { type: "external", external: { url: "https://assets.example.test/old.png" }, caption: [] } } as BlockObjectResponse]);
  const policy = await websitePolicy(demo.client, config, 3600);
  await db.query("SELECT nb_v2_api.configure_policy($1,$2,$3::jsonb,$4::jsonb)", [policy.configDigest, policy.freshnessSeconds, JSON.stringify(policy.sources), JSON.stringify(policy.permits)]);
  const writer = createWebsiteWriter(db), previous = await writer.begin(randomUUID(), policy.configDigest);
  const identity = { runId: previous.runId, configDigest: policy.configDigest, sourceSha256: "b".repeat(64), releaseCommit: "a".repeat(40) };
  const directory = join(root, "capture"), capture = await createCollectionCapture(directory, identity);
  // Save one complete page and fail on the second; nothing staged or published.
  const client = { ...demo.client, listBlocks: async (id: string) => {
    if (id === demoId(1001)) throw new Error("Synthetic interruption");
    return demo.client.listBlocks(id);
  } };
  await assert.rejects(runWebsiteSync({ config, client, mode: "stage", writer: { ...writer, begin: async () => previous }, storage,
    captureCollection: capture, download: async () => ({ bytes: DEMO_PNG, mime: "image/png", transformed: transformed ? true : undefined }),
    mediaSources: { stage: async () => assert.fail() } }), /Synthetic interruption/);
  const old = (await db.query<{ valid_until: string }>("SELECT valid_until::text FROM nb_v2.runs WHERE id=$1", [previous.runId])).rows[0];
  const recovery = () => runRevalidatedWebsiteSync({ db, directory, identity, publicationMode: "qualified", mode: "publish", client: demo.client, config, storage,
    download: async () => ({ bytes: DEMO_PNG, mime: "image/png", transformed: transformed ? true : undefined }), mediaSources: { stage: async () => {} } });
  return { db, demo, config, policy, writer, previous, identity, directory, recovery, old };
}

test("installed published-cache repair admits the last success without rewriting it or weakening the new lease", async t => {
  const f = await fixture(t);
  await f.db.query("UPDATE nb_v2.runs SET status='published',valid_until=clock_timestamp()-interval '1 minute' WHERE id=$1", [f.previous.runId]);
  const next = await f.writer.begin(randomUUID(), f.policy.configDigest);
  await assert.rejects(bindFreshCollectionDeadline(f.db, next, f.previous));
  const before = (await f.db.query("SELECT to_jsonb(r) AS row FROM nb_v2.runs r WHERE id=$1", [f.previous.runId])).rows;
  await f.db.exec(await readFile(new URL("../supabase/migrations/20261016064210_fresh_verification_accept_published_cache.sql", import.meta.url), "utf8"));
  await f.db.exec("SET ROLE nb_writer");
  await bindFreshCollectionDeadline(f.db, next, f.previous);
  await assert.rejects(bindFreshCollectionDeadline(f.db, next, { ...f.previous, fence: "9999" }));
  await f.db.exec("RESET ROLE");
  assert.deepEqual((await f.db.query("SELECT to_jsonb(r) AS row FROM nb_v2.runs r WHERE id=$1", [f.previous.runId])).rows, before);
  await f.db.exec("SET ROLE nb_reader");
  await assert.rejects(f.db.query("SELECT nb_revalidation_api.inspect_fresh_run($1,$2,$3,$4,$5)", [next.runId,next.fence,f.previous.runId,f.previous.fence,f.previous.revision]), /permission denied/);
  await f.db.exec("RESET ROLE");
  await f.db.query("UPDATE nb_v2.runs SET valid_until=clock_timestamp()-interval '1 second' WHERE id=$1", [next.runId]);
  await assert.rejects(bindFreshCollectionDeadline(f.db, next, f.previous));
});

test("partial capture is freshly verified, missing work collected, and published deadline stays at the original server value", async t => {
  const f = await fixture(t), before = f.demo.requests.length;
  const result = await f.recovery();
  assert.equal(result.revalidatedPages, 1); assert.equal(result.records, 2); assert.equal(result.outcome, "publish");
  assert.equal(Date.parse(result.qualification.validUntil), Date.parse(f.old.valid_until));
  assert.ok(f.demo.requests.length > before, "Saved content cannot skip fresh source reads");
  const rows = (await f.db.query<{ status: string; valid_until: string }>("SELECT status,valid_until::text FROM nb_v2.runs ORDER BY started_at")).rows;
  assert.deepEqual(rows.map(r => r.status), ["failed", "published"]);
  assert.equal(Date.parse(rows[0].valid_until), Date.parse(rows[1].valid_until));
  await f.db.query("SELECT nb_v2_api.read_snapshot(ARRAY['game'],true)");
  await f.db.query("UPDATE nb_v2.runs SET valid_until=clock_timestamp()-interval '1 second' WHERE status='published'");
  await assert.rejects(f.db.query("SELECT nb_v2_api.read_snapshot(ARRAY['game'],true)"), /NB_UNAVAILABLE/);
});

test("edited body with unchanged page timestamp, missing page, moved page and changed image binding block all staging", async t => {
  for (const scenario of ["body", "missing", "moved", "image"] as const) await t.test(scenario, async t => {
    const f = await fixture(t, scenario === "image"), id = demoId(1000);
    if (scenario === "body") f.demo.blocks.set(id, [demoParagraph(demoId(10_000), id, "Changed without page timestamp")]);
    if (scenario === "missing") f.demo.pages.delete(id);
    if (scenario === "moved") f.demo.pages.get(id)!.parent = { type: "page_id", page_id: demoId(9999) };
    if (scenario === "image") {
      const block = f.demo.blocks.get(id)![0]; assert.equal(block.type, "image");
      if (block.type === "image") block.image = { type: "external", external: { url: "https://assets.example.test/replacement.png" }, caption: [] };
    }
    await assert.rejects(f.recovery());
    assert.equal((await f.db.query<{ n: number }>("SELECT count(*)::int AS n FROM nb_v2.records")).rows[0].n, 0);
    assert.equal((await f.db.query<{ current_run: unknown }>("SELECT current_run FROM nb_v2.state")).rows[0].current_run, null);
  });
});

test("expired, revoked or reconfigured originals fail before new Notion requests", async t => {
  for (const scenario of ["expired", "denied", "policy"] as const) await t.test(scenario, async t => {
    const f = await fixture(t);
    if (scenario === "expired") await f.db.query("UPDATE nb_v2.runs SET valid_until=clock_timestamp()-interval '1 second' WHERE id=$1", [f.previous.runId]);
    if (scenario === "denied") await f.db.query("SELECT nb_v2_api.set_denied($1,true)", [demoId(1000)]);
    if (scenario === "policy") await f.db.query("SELECT nb_v2_api.configure_policy($1,3600,$2::jsonb,$3::jsonb)", [f.policy.configDigest, JSON.stringify(f.policy.sources), JSON.stringify(f.policy.permits)]);
    const requests = f.demo.requests.length;
    await assert.rejects(f.recovery()); assert.equal(f.demo.requests.length, requests);
    assert.equal((await f.db.query<{ lease_run: unknown }>("SELECT lease_run FROM nb_v2.state")).rows[0].lease_run, null);
  });
});

test("server cap is monotonic through renewal and chained attempts; expiry prevents stage and promote", async t => {
  const f = await fixture(t), next = await f.writer.begin(randomUUID(), f.policy.configDigest);
  const bound = await bindCollectionDeadline(f.db, next, f.previous);
  await f.writer.renew(next);
  assert.equal((await bindCollectionDeadline(f.db, next, f.previous)).receipt.validUntil, bound.receipt.validUntil);
  await f.writer.fail(next);
  const third = await f.writer.begin(randomUUID(), f.policy.configDigest);
  const chain = await bindCollectionDeadline(f.db, third, next);
  assert.equal(chain.receipt.validUntil, bound.receipt.validUntil);
  await f.db.query("UPDATE nb_v2.runs SET valid_until=clock_timestamp()-interval '1 second' WHERE id=$1", [third.runId]);
  await assert.rejects(f.writer.stage(third, []));
  await assert.rejects(f.writer.renew(third));
  await assert.rejects(f.writer.promote(third, { records: 0, media: 0, complete: true }));
});

test("reader/public cannot bind recovery or access private bindings; writer cannot rewrite deadlines", async t => {
  const f = await fixture(t);
  const grants = (await f.db.query<{ reader: boolean; writer: boolean; direct: boolean; rls: boolean; fixed_path: boolean }>(`SELECT
    has_function_privilege('nb_reader','nb_revalidation_api.bind_run(uuid,bigint,uuid,bigint,bigint)','EXECUTE') AS reader,
    has_function_privilege('nb_writer','nb_revalidation_api.bind_run(uuid,bigint,uuid,bigint,bigint)','EXECUTE') AS writer,
    has_table_privilege('nb_writer','nb_v2.runs','UPDATE') AS direct,
    (SELECT relrowsecurity FROM pg_class WHERE oid='nb_revalidation.bindings'::regclass) AS rls,
    (SELECT proconfig @> ARRAY['search_path=pg_catalog, nb_v2, pg_temp'] FROM pg_proc WHERE oid='nb_revalidation_api.bind_run(uuid,bigint,uuid,bigint,bigint)'::regprocedure) AS fixed_path`)).rows[0];
  assert.deepEqual(grants, { reader: false, writer: true, direct: false, rls: true, fixed_path: true });
  await f.db.exec("SET ROLE nb_reader");
  await assert.rejects(f.db.query("SELECT nb_revalidation_api.bind_run($1,1,$2,1,1)", [randomUUID(), f.previous.runId]), /permission denied/);
  await f.db.exec("RESET ROLE; SET ROLE nb_writer");
  await assert.rejects(f.db.query("UPDATE nb_v2.runs SET valid_until=clock_timestamp()+interval '1 day'"), /permission denied/);
  await assert.rejects(f.db.query("SELECT * FROM nb_revalidation.bindings"), /permission denied/);
  await f.db.exec("RESET ROLE");
});

test("capture from another release and absent extension fail closed without source work", async t => {
  const f = await fixture(t), before = f.demo.requests.length;
  await assert.rejects(runRevalidatedWebsiteSync({ db: f.db, directory: f.directory, identity: { ...f.identity, releaseCommit: "c".repeat(40) },
    publicationMode: "qualified", mode: "publish", client: f.demo.client, config: f.config, storage }));
  await f.db.exec("DROP SCHEMA nb_revalidation_api CASCADE");
  await assert.rejects(f.recovery()); assert.equal(f.demo.requests.length, before);
  assert.equal((await f.db.query<{ lease_run: unknown }>("SELECT lease_run FROM nb_v2.state")).rows[0].lease_run, null);
});

test("revocation during fresh body reading is checked before any stage", async t => {
  const f = await fixture(t), client = { ...f.demo.client, listBlocks: async (id: string) => {
    const blocks = await f.demo.client.listBlocks(id);
    if (id === demoId(1000)) f.demo.pages.get(id)!.archived = true;
    return blocks;
  } };
  await assert.rejects(runRevalidatedWebsiteSync({ db: f.db, directory: f.directory, identity: f.identity,
    publicationMode: "qualified", mode: "publish", client, config: f.config, storage }));
  assert.equal((await f.db.query<{ n: number }>("SELECT count(*)::int AS n FROM nb_v2.records")).rows[0].n, 0);
});

test("binding cannot switch originals, use a forged fence or start after records were staged", async t => {
  const f = await fixture(t), other = await f.writer.begin(randomUUID(), f.policy.configDigest);
  await f.writer.fail(other);
  const next = await f.writer.begin(randomUUID(), f.policy.configDigest);
  await assert.rejects(bindCollectionDeadline(f.db, next, { ...f.previous, fence: "9999" }));
  await bindCollectionDeadline(f.db, next, f.previous);
  await assert.rejects(bindCollectionDeadline(f.db, next, other));
  await f.writer.fail(next);
  const late = await f.writer.begin(randomUUID(), f.policy.configDigest);
  const { readCollectionCaptureForRevalidation } = await import("../scripts/website-sync/collection-capture.ts");
  const capture = await readCollectionCaptureForRevalidation(f.directory, f.identity);
  await f.writer.stage(late, [capture.pages[0].record]);
  await assert.rejects(bindCollectionDeadline(f.db, late, f.previous));
});


test("host resume reuses completed projections, recollects changed pages and preserves the fixed host run identity", async t => {
  for (const changed of [false, true]) await t.test(changed ? "changed" : "unchanged", async t => {
    const f = await fixture(t), id = demoId(1000), runId = randomUUID();
    if(changed) f.demo.blocks.set(id,[demoParagraph(demoId(10_000),id,"New body with same page edit time")]);
    const resume = await prepareCollectionResume({directory:f.directory,identity:f.identity,db:f.db});
    const nextCapture=await createCollectionCapture(join(f.directory,"next"),{...f.identity,runId});
    let planned=false, stagedRun="";
    const result=await runWebsiteSync({client:f.demo.client,config:f.config,mode:"publish",storage,
      writer:{...f.writer,begin:async(_id,digest)=>f.writer.begin(runId,digest),stage:async(lease,records,media)=>{
        stagedRun=lease.runId;return f.writer.stage(lease,records,media);
      }},resumeCollection:resume,captureCollection:nextCapture,onResumePlan:async plan=>{
        planned=true;assert.equal(plan.currentPages,2);assert.equal(plan.unseenPages,1);assert.equal(plan.guaranteedCompletion,false);
      }});
    assert.equal(planned,true);assert.equal(stagedRun,runId);
    assert.equal(result.resume?.reusedPages,changed?0:1);assert.equal(result.resume?.recollectedPages,changed?1:0);
    assert.equal(result.resume?.newPages,1);assert.equal(nextCapture.statistics().pages,2);
    const rows=await f.db.query<{document:{blocks:{text:{text:string}[]}[]}}>("SELECT document FROM nb_v2.records WHERE run_id=$1 AND id=$2",[runId,id]);
    assert.match(rows.rows[0].document.blocks[0].text[0].text,changed?/New body/:/Synthetic body/);
    assert.equal((await f.db.query<{value:string}>("SELECT valid_until::text AS value FROM nb_v2.runs WHERE id=$1",[runId])).rows[0].value,f.old.valid_until);
  });
});

test("resume checks the budget plan before media work and leaves both old work and new lease clean on refusal", async t=>{
  const f=await fixture(t,true), resume=await prepareCollectionResume({directory:f.directory,identity:f.identity,db:f.db});
  await assert.rejects(runWebsiteSync({client:f.demo.client,config:f.config,mode:"publish",storage,writer:f.writer,
    resumeCollection:resume,captureCollection:{save:async()=>assert.fail(),seal:async()=>assert.fail()},
    onResumePlan:async()=>{throw new Error("Insufficient planned request reserve");},download:async()=>assert.fail()}),/Insufficient/);
  assert.equal((await f.db.query<{lease_run:unknown}>("SELECT lease_run FROM nb_v2.state")).rows[0].lease_run,null);
  assert.equal((await f.db.query<{status:string}>("SELECT status FROM nb_v2.runs WHERE id=$1",[f.previous.runId])).rows[0].status,"failed");
});


test("completed converted images are independently read back on resume without repeated uploads", async t=>{
  const f=await fixture(t,true,true), resume=await prepareCollectionResume({directory:f.directory,identity:f.identity,db:f.db});
  let readBack=0,downloads=0;
  const result=await runWebsiteSync({client:f.demo.client,config:f.config,mode:"publish",writer:f.writer,
    storage:{put:async()=>assert.fail("Resume must not upload an already committed object"),read:async()=>{readBack++;return DEMO_PNG;}},
    resumeCollection:resume,captureCollection:{save:async()=>{},seal:async()=>{}},mediaSources:{stage:async()=>{}},
    download:async()=>{downloads++;return {bytes:DEMO_PNG,mime:"image/png",transformed:true};}});
  assert.equal(result.resume?.reusedPages,1);assert.equal(downloads,1);assert.equal(readBack,1);
});

test("final eligibility pass catches an earlier page revoked while a later body is collected", async t=>{
  const f=await fixture(t),resume=await prepareCollectionResume({directory:f.directory,identity:f.identity,db:f.db});
  const client={...f.demo.client,listBlocks:async(id:string)=>{
    const blocks=await f.demo.client.listBlocks(id);
    if(id===demoId(1001))f.demo.pages.get(demoId(1000))!.archived=true;
    return blocks;
  }};
  let sealed=false;
  await assert.rejects(runWebsiteSync({client,config:f.config,mode:"publish",storage,writer:f.writer,resumeCollection:resume,
    captureCollection:{save:async()=>{},seal:async()=>{sealed=true;}}}),/ownership changed/);
  assert.equal(sealed,false);
  assert.equal((await f.db.query<{n:number}>("SELECT count(*)::int AS n FROM nb_v2.records")).rows[0].n,0);
});

test("a late edit recollects only the changed owner, persists its new proof and publishes after a fresh stable pass", async t=>{
  const f=await fixture(t),id=demoId(1000),runId=randomUUID();
  const resume=await prepareCollectionResume({directory:f.directory,identity:f.identity,db:f.db});
  const directory=join(f.directory,"publication-repair"),identity={...f.identity,runId};
  const capture=await createCollectionCapture(directory,identity),events:PublicationRevalidationProgress[]=[];
  const beforeQueries=f.demo.requests.filter(r=>r.category==="rows").length;
  const bodyReads=new Map<string,number>();
  const client={...f.demo.client,listBlocks:async(owner:string)=>{
    bodyReads.set(owner,(bodyReads.get(owner)??0)+1);
    const blocks=await f.demo.client.listBlocks(owner);
    if(owner===demoId(1001)){
      f.demo.pages.get(id)!.last_edited_time="2026-10-02T00:00:00.000Z";
      f.demo.blocks.set(id,[demoParagraph(demoId(10_000),id,"Late source edit, freshly collected")]);
    }
    return blocks;
  }};
  const result=await runWebsiteSync({client,config:f.config,mode:"publish",storage,
    writer:{...f.writer,begin:(_id,digest)=>f.writer.begin(runId,digest)},resumeCollection:resume,captureCollection:capture,
    publicationRepair:{maxPages:2,maxPasses:2},onPublicationRevalidation:async event=>{events.push(event);}});
  assert.deepEqual(result.publicationRevalidation,{passes:2,repairedPages:1});
  assert.equal(f.demo.requests.filter(r=>r.category==="rows").length-beforeQueries,3,"one collection listing plus a new complete listing in each final pass");
  assert.equal(result.resume?.reusedPages,1);
  assert.equal(bodyReads.get(demoId(1001)),1,"unchanged later body is never recollected");
  const row=(await f.db.query<{document:{blocks:{text:{text:string}[]}[]}}>("SELECT document FROM nb_v2.records WHERE run_id=$1 AND id=$2",[runId,id])).rows[0];
  assert.match(row.document.blocks[0].text[0].text,/Late source edit/);
  const saved=await readCollectionCaptureForRevalidation(directory,identity);
  assert.equal(saved.collectionComplete,true);assert.equal(saved.pages.length,2);
  assert.equal(saved.pages.find(p=>p.record.detail.item.id===id)!.record.detail.item.updatedAt,"2026-10-02T00:00:00.000Z");
  assert.ok(events.some(e=>e.change?.ownerId===id&&e.change.kind==="revision"&&e.change.changedPaths.includes("page.edited")));
  assert.equal(events.at(-1)?.phase,"complete");
  assert.equal((await f.db.query<{value:string}>("SELECT valid_until::text AS value FROM nb_v2.runs WHERE id=$1",[runId])).rows[0].value,f.old.valid_until);
});

test("a new image failing during late body repair retains its exact diagnostic and cannot stage a partial publication", async t => {
  const f = await fixture(t), id = demoId(1000), blockId = demoId(50_001), runId = randomUUID();
  const resume = await prepareCollectionResume({ directory: f.directory, identity: f.identity, db: f.db });
  const directory = join(f.directory, "repair-image-failure"), identity = { ...f.identity, runId };
  const capture = await createCollectionCapture(directory, identity);
  const client = { ...f.demo.client, listBlocks: async (owner: string) => {
    const blocks = await f.demo.client.listBlocks(owner);
    if (owner === demoId(1001)) {
      f.demo.pages.get(id)!.last_edited_time = "2026-10-02T00:00:00.000Z";
      f.demo.blocks.set(id, [{ ...demoParagraph(blockId, id, ""), type: "image",
        image: { type: "external", external: { url: "https://assets.example.test/repair.png" }, caption: [] } } as BlockObjectResponse]);
    }
    return blocks;
  } };
  let requests = 0, escaped: unknown;
  const download = createWebsiteImageDownloader({ resolve: async () => [{ address: "8.8.8.8", family: 4 }],
    request: async () => { requests++; return { status: 403, headers: {}, bytes: (async function* () {})(), cancel() {} }; } });
  t.after(download.close);
  await assert.rejects(runWebsiteSync({ client, config: f.config, mode: "publish", storage, download,
    writer: { ...f.writer, begin: (_id, digest) => f.writer.begin(runId, digest),
      stage: async () => assert.fail("A failed repair must not stage anything"), promote: async () => assert.fail("No partial publication") },
    resumeCollection: resume, captureCollection: capture, publicationRepair: { maxPages: 2, maxPasses: 1 } }), error => {
      escaped = error; return error instanceof Error && "code" in error && error.code === "IMAGE_UNAVAILABLE";
    });
  assert.equal(requests, 1, "Permission denial is never retried");
  assert.deepEqual(websiteImageFailure(escaped)?.context, { ownerPageId: id, locator: { kind: "block", id: blockId } });
  assert.equal((await readCollectionCaptureForRevalidation(directory, identity)).collectionComplete, false);
  assert.equal((await f.db.query<{ n: number }>("SELECT count(*)::int AS n FROM nb_v2.records WHERE run_id=$1", [runId])).rows[0].n, 0);
});

test("publication repair keeps revocation, reparenting and continuing edits fail-closed with inspectable cached work", async t=>{
  for(const scenario of ["archive","move","keeps-editing"] as const)await t.test(scenario,async t=>{
    const f=await fixture(t),id=demoId(1000),runId=randomUUID();
    const resume=await prepareCollectionResume({directory:f.directory,identity:f.identity,db:f.db});
    const directory=join(f.directory,"bounded-repair"),identity={...f.identity,runId};
    const capture=await createCollectionCapture(directory,identity);let ticks=0,changed=false;
    const mutate=()=>{const page=f.demo.pages.get(id)!;
      if(scenario==="archive")page.archived=true;
      else if(scenario==="move")page.parent={type:"page_id",page_id:demoId(9999)};
      else page.last_edited_time=`2026-10-02T00:00:0${++ticks}.000Z`;
    };
    const client={...f.demo.client,listBlocks:async(owner:string)=>{
      const blocks=await f.demo.client.listBlocks(owner);
      if(owner===demoId(1001)){changed=true;mutate();}
      else if(owner===id&&changed&&scenario==="keeps-editing")mutate();
      return blocks;
    }};
    await assert.rejects(runWebsiteSync({client,config:f.config,mode:"publish",storage,
      writer:{...f.writer,begin:(_id,digest)=>f.writer.begin(runId,digest)},resumeCollection:resume,captureCollection:capture,
      publicationRepair:{maxPages:2,maxPasses:1}}),(error:unknown)=>{
        assert.ok(error instanceof PublicationRevalidationError);assert.equal(error.publicationChange.ownerId,id);
        assert.equal(error.publicationChange.kind,scenario==="keeps-editing"?"revision":"unavailable");return true;
      });
    assert.equal((await readCollectionCaptureForRevalidation(directory,identity)).collectionComplete,false);
    assert.equal((await f.db.query<{n:number}>("SELECT count(*)::int AS n FROM nb_v2.records WHERE run_id=$1",[runId])).rows[0].n,0);
  });
});

test("late body repair retires obsolete media descriptors and bindings without deleting or uploading objects",async t=>{
  const f=await fixture(t,true),id=demoId(1000),runId=randomUUID();
  const resume=await prepareCollectionResume({directory:f.directory,identity:f.identity,db:f.db});
  const directory=join(f.directory,"media-repair"),identity={...f.identity,runId};
  const capture=await createCollectionCapture(directory,identity);
  const client={...f.demo.client,listBlocks:async(owner:string)=>{
    const blocks=await f.demo.client.listBlocks(owner);
    if(owner===demoId(1001)){
      f.demo.pages.get(id)!.last_edited_time="2026-10-02T00:00:00.000Z";
      f.demo.blocks.set(id,[demoParagraph(demoId(10_000),id,"Image was removed")]);
    }
    return blocks;
  }};
  const result=await runWebsiteSync({client,config:f.config,mode:"publish",
    storage:{put:async()=>assert.fail("No new objects"),read:async()=>assert.fail("No transformed objects")},
    download:async()=>({bytes:DEMO_PNG,mime:"image/png"}),mediaSources:{stage:async()=>assert.fail("No remaining bindings")},
    writer:{...f.writer,begin:(_id,digest)=>f.writer.begin(runId,digest)},resumeCollection:resume,captureCollection:capture,
    publicationRepair:{maxPages:2,maxPasses:1}});
  assert.equal(result.media,0);assert.equal(result.uniqueObjects,0);assert.equal(result.mediaBytes,0);
  const owner=(await readCollectionCaptureForRevalidation(directory,identity)).pages.find(p=>p.record.detail.item.id===id)!;
  assert.deepEqual(owner.media,[]);assert.deepEqual(owner.bindings,[]);
});

test("a repaired body cannot exceed the original aggregate collection byte limit",async t=>{
  const f=await fixture(t),id=demoId(1000),runId=randomUUID();
  const resume=await prepareCollectionResume({directory:f.directory,identity:f.identity,db:f.db});
  const capture=await createCollectionCapture(join(f.directory,"oversized-repair"),{...f.identity,runId});
  const client={...f.demo.client,listBlocks:async(owner:string)=>{
    const blocks=await f.demo.client.listBlocks(owner);
    if(owner===demoId(1001)){
      f.demo.pages.get(id)!.last_edited_time="2026-10-02T00:00:00.000Z";
      f.demo.blocks.set(id,Array.from({length:10},(_,n)=>demoParagraph(demoId(15_000+n),id,"Synthetic added text ".repeat(100))));
    }
    return blocks;
  }};
  await assert.rejects(runWebsiteSync({client,config:f.config,mode:"publish",storage,maxCollectionBytes:10000,
    writer:{...f.writer,begin:(_id,digest)=>f.writer.begin(runId,digest)},resumeCollection:resume,captureCollection:capture,
    publicationRepair:{maxPages:2,maxPasses:1}}),/snapshot exceeds/);
  assert.equal(capture.statistics().collectionComplete,false);
  assert.equal((await f.db.query<{n:number}>("SELECT count(*)::int AS n FROM nb_v2.records WHERE run_id=$1",[runId])).rows[0].n,0);
});


test("fresh verification reuses expired work without extending old deadlines, and recollects changed bodies", async t => {
  for (const changed of [false,true]) await t.test(changed ? "changed" : "unchanged",async t => {
    const f=await fixture(t), id=demoId(1000), runId=randomUUID();
    await f.db.query("UPDATE nb_v2.runs SET valid_until=clock_timestamp()-interval '1 hour' WHERE id=$1",[f.previous.runId]);
    const old=(await f.db.query("SELECT to_jsonb(r) AS value FROM nb_v2.runs r WHERE id=$1",[f.previous.runId])).rows;
    if(changed)f.demo.blocks.set(id,[demoParagraph(demoId(10000),id,"Changed with unchanged parent timestamp")]);
    let receipt: {validUntil:string;previousValidUntil:string}|undefined;
    const resume=await prepareCollectionResume({directory:f.directory,identity:f.identity,db:f.db,qualification:"fresh",onBound:async r=>{receipt=r;}});
    const capture=await createCollectionCapture(join(f.directory,"fresh"),{...f.identity,runId});
    const result=await runWebsiteSync({config:f.config,client:f.demo.client,mode:"publish",storage,
      writer:{...f.writer,begin:async(_id,digest)=>f.writer.begin(runId,digest)},resumeCollection:resume,captureCollection:capture});
    assert.equal(result.resume?.reusedPages,changed?0:1);assert.equal(result.resume?.recollectedPages,changed?1:0);assert.equal(result.resume?.newPages,1);
    assert.ok(Date.parse(receipt!.validUntil)>Date.parse(receipt!.previousValidUntil));
    assert.deepEqual((await f.db.query("SELECT to_jsonb(r) AS value FROM nb_v2.runs r WHERE id=$1",[f.previous.runId])).rows,old);
    await f.db.query("SELECT nb_v2_api.read_snapshot(ARRAY['game'],true)");
    const row=(await f.db.query<{document:{blocks:{text:{text:string}[]}[]}}>("SELECT document FROM nb_v2.records WHERE run_id=$1 AND id=$2",[runId,id])).rows[0];
    assert.match(row.document.blocks[0].text[0].text,changed?/Changed with/:/Synthetic body/);
    await f.db.query("UPDATE nb_v2.runs SET valid_until=clock_timestamp()-interval '1 second' WHERE id=$1",[runId]);
    await assert.rejects(f.db.query("SELECT nb_v2_api.read_snapshot(ARRAY['game'],true)"),/NB_UNAVAILABLE/);
  });
});

test("fresh verification excludes newly denied or moved cached pages and rejects uncertain source reads", async t=>{
  for(const scenario of ["denied","moved","unavailable","late-denied"] as const)await t.test(scenario,async t=>{
    const f=await fixture(t), id=demoId(1000),runId=randomUUID();
    await f.db.query("UPDATE nb_v2.runs SET valid_until=clock_timestamp()-interval '1 hour' WHERE id=$1",[f.previous.runId]);
    if(scenario==="denied")await f.db.query("SELECT nb_v2_api.set_denied($1,true)",[id]);
    if(scenario==="moved")f.demo.pages.get(id)!.parent={type:"page_id",page_id:demoId(9999)};
    const resume=await prepareCollectionResume({directory:f.directory,identity:f.identity,db:f.db,qualification:"fresh"});
    const capture=await createCollectionCapture(join(f.directory,"fresh"),{...f.identity,runId});
    const client={...f.demo.client,listBlocks:async(page:string)=>{
      if(scenario==="unavailable"&&page===id)throw new Error("Source unavailable");
      const result=await f.demo.client.listBlocks(page);
      if(scenario==="late-denied"&&page===id)await f.db.query("SELECT nb_v2_api.set_denied($1,true)",[id]);
      return result;
    }};
    const run=()=>runWebsiteSync({config:f.config,client,mode:"publish",storage,writer:{...f.writer,begin:async(_id,digest)=>f.writer.begin(runId,digest)},resumeCollection:resume,captureCollection:capture});
    if(scenario==="denied"||scenario==="moved"){
      const result=await run();
      assert.equal(result.records,1);assert.equal(result.resume?.reusedPages,0);
      assert.equal((await f.db.query<{n:number}>("SELECT count(*)::int AS n FROM nb_v2.records WHERE run_id=$1 AND id=$2",[runId,id])).rows[0].n,0);
    }else await assert.rejects(run());
    assert.equal((await f.db.query<{lease_run:unknown}>("SELECT lease_run FROM nb_v2.state")).rows[0].lease_run,null);
  });
});

test("fresh inspection rejects forged provenance, capped recovery, staged input and reader role",async t=>{
 const f=await fixture(t),lease=await f.writer.begin(randomUUID(),f.policy.configDigest);
 await assert.rejects(bindFreshCollectionDeadline(f.db,lease,{...f.previous,fence:"9999"}));
 await bindCollectionDeadline(f.db,lease,f.previous);
 await assert.rejects(bindFreshCollectionDeadline(f.db,lease,f.previous));
 await f.writer.fail(lease);
 const next=await f.writer.begin(randomUUID(),f.policy.configDigest);
 await f.db.exec("SET ROLE nb_writer");
 await bindFreshCollectionDeadline(f.db,next,f.previous);
 await f.db.exec("RESET ROLE");
 const {readCollectionCaptureForRevalidation}=await import("../scripts/website-sync/collection-capture.ts");
 const saved=await readCollectionCaptureForRevalidation(f.directory,f.identity);
 await f.writer.stage(next,[saved.pages[0].record]);
 await assert.rejects(bindFreshCollectionDeadline(f.db,next,f.previous));
 await f.db.exec("SET ROLE nb_reader");
 await assert.rejects(f.db.query("SELECT nb_revalidation_api.inspect_fresh_run($1,$2,$3,$4,$5)",[next.runId,next.fence,f.previous.runId,f.previous.fence,f.previous.revision]),/permission denied/);
 await f.db.exec("RESET ROLE");
});


test("fresh qualification requires the installed inspection function and a live new lease before source reads",async t=>{
 for(const scenario of ["extension","expired-new"] as const)await t.test(scenario,async t=>{
  const f=await fixture(t),before=f.demo.requests.length,runId=randomUUID();
  if(scenario==="extension")await f.db.exec("DROP FUNCTION nb_revalidation_api.inspect_fresh_run(uuid,bigint,uuid,bigint,bigint)");
  const resume=await prepareCollectionResume({directory:f.directory,identity:f.identity,db:f.db,qualification:"fresh"});
  const capture=await createCollectionCapture(join(f.directory,"fresh"),{...f.identity,runId});
  await assert.rejects(runWebsiteSync({config:f.config,client:f.demo.client,mode:"publish",storage,resumeCollection:resume,captureCollection:capture,
    writer:{...f.writer,begin:async(_id,digest)=>{const lease=await f.writer.begin(runId,digest);
      if(scenario==="expired-new")await f.db.query("UPDATE nb_v2.runs SET valid_until=clock_timestamp()-interval '1 second' WHERE id=$1",[runId]);return lease;}}}));
  assert.equal(f.demo.requests.length,before);
  assert.equal((await f.db.query<{lease_run:unknown}>("SELECT lease_run FROM nb_v2.state")).rows[0].lease_run,null);
 });
});
