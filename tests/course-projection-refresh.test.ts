import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {mkdtemp,realpath,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {PGlite} from "@electric-sql/pglite";
import type {WebsiteRecord} from "../contracts/website-sync.ts";
import {WEBSITE_SCHEMA_DIGEST} from "../contracts/website-sync.ts";
import {createDemo} from "../scripts/notion-sync/demo.ts";
import {parseWebsiteNotionConfig} from "../src/server/notion/website-config.ts";
import {createWebsiteWriter} from "../src/server/database/website-writer.ts";
import {createCollectionCapture} from "../scripts/website-sync/collection-capture.ts";
import {prepareCollectionResume} from "../scripts/website-sync/collection-revalidation.ts";
import {runWebsiteSync,websitePolicy} from "../scripts/website-sync/worker.ts";
import type {CaptureRecoveryAdmission} from "../scripts/website-sync/capture-recovery-admission.ts";
import {recoveryFixture} from "./helpers/capture-recovery-fixture.ts";
import revalidation from "../database/qualified-revalidation-protocol.json" with {type:"json"};
import fresh from "../database/fresh-qualification-protocol.json" with {type:"json"};

test("course refresh needs fresh qualification and an in-process reviewed admission before capture or SQL",async()=>{
  const db={query:async()=>assert.fail("No SQL expected")};
  const identity={runId:randomUUID(),releaseCommit:"a".repeat(40),sourceSha256:"b".repeat(64),configDigest:"c".repeat(64)};
  const current={...identity,releaseCommit:"d".repeat(40)};
  const input={directory:"/missing",identity,db};
  for(const qualification of [undefined,"original"] as const)
    await assert.rejects(prepareCollectionResume({...input,qualification,recovery:{admission:recoveryFixture().admit(),current}}));
  await assert.rejects(prepareCollectionResume({...input,qualification:"fresh",recovery:{admission:true as unknown as CaptureRecoveryAdmission,current}}),{code:"RELEASE_INVALID"});
  await assert.rejects(prepareCollectionResume({...input,qualification:"fresh",recovery:{admission:recoveryFixture().admit(),current:{...current,sourceSha256:"e".repeat(64)}}}));
});

/** Model a previous complete course projection with the same source proofs.
 * Without forced reprojection its empty old DTO could otherwise be reused. */
function legacyCourse(record:WebsiteRecord):WebsiteRecord {
  const value=structuredClone(record);
  if(value.detail.item.kind==="course")value.detail.document={blocks:[],toc:[],completeness:"complete"};
  return value;
}

test("actual publisher reprojects only courses, freshly verifies other cached pages and preserves the old capture and run",async t=>{
  const db=await PGlite.create(),root=await realpath(await mkdtemp(join(tmpdir(),"course-projection-")));
  t.after(async()=>{await db.close();await rm(root,{recursive:true,force:true});});
  await db.exec(await readFile(new URL("../database/website-migrations/001_website.sql",import.meta.url),"utf8"));
  await db.query("UPDATE nb_v2.state SET schema_digest=$1",[WEBSITE_SCHEMA_DIGEST]);
  for(const file of [revalidation.migration.file,fresh.migration.file,"20261016064210_fresh_verification_accept_published_cache.sql"])
    await db.exec(await readFile(new URL("../supabase/migrations/"+file,import.meta.url),"utf8"));
  const demo=createDemo(2),config=parseWebsiteNotionConfig({schemaVersion:2,sources:demo.config.sources.slice(0,2)});
  const policy=await websitePolicy(demo.client,config,3600);
  await db.query("SELECT nb_v2_api.configure_policy($1,$2,$3::jsonb,$4::jsonb)",[policy.configDigest,3600,JSON.stringify(policy.sources),JSON.stringify(policy.permits)]);
  const writer=createWebsiteWriter(db),previous=await writer.begin(randomUUID(),policy.configDigest);
  const identity={runId:previous.runId,releaseCommit:"a".repeat(40),sourceSha256:"b".repeat(64),configDigest:policy.configDigest};
  const directory=join(root,"old"),capture=await createCollectionCapture(directory,identity);
  const storage={put:async()=>assert.fail("No image upload expected"),read:async()=>assert.fail("No object read expected")};
  await runWebsiteSync({client:demo.client,config,mode:"publish",storage,writer:{...writer,begin:async()=>previous,
    stage:(lease,records,media)=>writer.stage(lease,records.map(legacyCourse),media)},
    captureCollection:{save:page=>capture.save({...page,record:legacyCourse(page.record)}),seal:capture.seal}});
  const oldIndex=await readFile(join(directory,"index-private.json"));
  const oldRun=(await db.query("SELECT to_jsonb(r) AS row FROM nb_v2.runs r WHERE id=$1",[previous.runId])).rows;
  const resume=await prepareCollectionResume({directory,identity,db,qualification:"fresh",recovery:{admission:recoveryFixture().admit(),current:{...identity,releaseCommit:"d".repeat(40)}}});
  assert.equal(resume.pages.length,2);assert.ok(resume.pages.every(p=>p.record.detail.item.kind!=="course"));
  assert.deepEqual(resume.courseProjectionRefresh,{forcedCoursePages:1,preservedPages:2,originalCaptureUnchanged:true});
  const next=await writer.begin(randomUUID(),policy.configDigest),beforeRequests=demo.requests.length;
  const result=await runWebsiteSync({client:demo.client,config,mode:"publish",storage,resumeCollection:resume,
    writer:{...writer,begin:async()=>next},captureCollection:await createCollectionCapture(join(root,"new"),{...identity,runId:next.runId,releaseCommit:"d".repeat(40)})});
  assert.deepEqual(result.resume,{reusedPages:2,recollectedPages:0,newPages:1,unseenSavedPages:0});
  assert.ok(demo.requests.length>beforeRequests,"Unchanged DTOs still need fresh source proof");
  const snapshot=(await db.query<{result:{records:{item:{kind:string};document:unknown}[]}}>("SELECT nb_v2_api.read_snapshot(ARRAY['course'],true) AS result")).rows[0].result;
  assert.match(JSON.stringify(snapshot.records.find(r=>r.item.kind==="course")!.document),/Synthetic learning body/);
  assert.deepEqual(await readFile(join(directory,"index-private.json")),oldIndex);
  assert.deepEqual((await db.query("SELECT to_jsonb(r) AS row FROM nb_v2.runs r WHERE id=$1",[previous.runId])).rows,oldRun);
});
