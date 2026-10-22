import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, readFile, writeFile, stat, link, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCollectionCapture, inspectCollectionCapture, readCollectionCaptureForRevalidation } from "../scripts/website-sync/collection-capture.ts";
import { runWebsiteSync } from "../scripts/website-sync/worker.ts";
import { createDemo, demoId, demoParagraph, DEMO_PNG } from "../scripts/notion-sync/demo.ts";
import type { BlockObjectResponse } from "@notionhq/client";
import { parseWebsiteNotionConfig } from "../src/server/notion/website-config.ts";
import { configDigest } from "../src/server/database/website-validation.ts";

async function fixture(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "collection-capture-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const demo = createDemo(2), config = parseWebsiteNotionConfig({ schemaVersion: 2, sources: [{ ...demo.config.sources[0], kind: "game" }] });
  const identity = { runId: "00000000-0000-4000-8000-000000000001", releaseCommit: "a".repeat(40), sourceSha256: "b".repeat(64), configDigest: configDigest(config) };
  const directory = join(root, "capture"), capture = await createCollectionCapture(directory, identity);
  return { root, directory, identity, capture, demo, config };
}

test("a failed second page leaves the first body durably inspectable but not resumable or published", async t => {
  const f = await fixture(t), original = f.demo.client.listBlocks;
  const client = { ...f.demo.client, listBlocks: async (id: string) => {
    if (id === demoId(1001)) throw new Error("Synthetic interruption");
    return original(id);
  } };
  await assert.rejects(runWebsiteSync({ client, config: f.config, mode: "dry-run", captureCollection: f.capture }), /Synthetic interruption/);
  const checked = await inspectCollectionCapture(f.directory, f.identity);
  assert.equal(checked.pages, 1); assert.equal(checked.collectionComplete, false);
  assert.equal(checked.resumable, false); assert.equal(checked.publicationEvidence, false);
  const pagePath = join(f.directory, `page-${demoId(1000)}.json`);
  const page = JSON.parse(await readFile(pagePath, "utf8"));
  assert.equal(page.record.detail.document.blocks[0].type, "paragraph");
  assert.equal(page.lease, null);
  assert.equal((await stat(pagePath)).mode & 0o777, 0o600);
  assert.equal((await stat(f.directory)).mode & 0o777, 0o700);
  await assert.rejects(createCollectionCapture(f.directory, f.identity), { code: "EEXIST" });
});

test("complete collection seals exact order; a new source/release, corrupt record or hard link is rejected", async t => {
  const f = await fixture(t);
  await runWebsiteSync({ client: f.demo.client, config: f.config, mode: "dry-run", captureCollection: f.capture });
  const checked = await inspectCollectionCapture(f.directory, f.identity);
  assert.equal(checked.collectionComplete, true); assert.equal(checked.pages, 2); assert.equal(checked.resumable, false);
  const index = JSON.parse(await readFile(join(f.directory, "index-private.json"), "utf8"));
  assert.deepEqual(index.order, [demoId(1000), demoId(1001)]);
  await assert.rejects(inspectCollectionCapture(f.directory, { ...f.identity, sourceSha256: "c".repeat(64) }));
  await assert.rejects(inspectCollectionCapture(f.directory, { ...f.identity, releaseCommit: "d".repeat(40) }));
  const file = join(f.directory, `page-${demoId(1000)}.json`), original = await readFile(file, "utf8");
  await link(file, join(f.root, "linked.json"));
  await assert.rejects(inspectCollectionCapture(f.directory, f.identity));
  await unlink(join(f.root, "linked.json"));
  const value = JSON.parse(original); value.record.detail.item.title = "Tampered title";
  await writeFile(file, JSON.stringify(value), { mode: 0o600 });
  await assert.rejects(inspectCollectionCapture(f.directory, f.identity));
});

test("failure to persist a completed page blocks staging and promotion", async () => {
  const demo = createDemo(1), config = { schemaVersion: 2, sources: [{ ...demo.config.sources[0], kind: "game" }] };
  let failed = 0;
  await assert.rejects(runWebsiteSync({ client: demo.client, config, mode: "publish",
    writer: { begin: async (runId, configDigest) => ({ runId, configDigest, fence: "1", revision: "1", deniedPageIds: [] }),
      renew: async () => {}, stage: async () => assert.fail(), promote: async () => assert.fail(), fail: async () => { failed++; } },
    storage: { put: async () => assert.fail(), read: async () => assert.fail() },
    captureCollection: { save: async () => { throw new Error("Synthetic disk failure"); }, seal: async () => assert.fail() } }), /Synthetic disk failure/);
  assert.equal(failed, 1);
});

test("hybrid capture retains exact same-page media descriptors and locator fingerprints", async t => {
  const f = await fixture(t), owner = demoId(1000);
  f.demo.blocks.set(owner, [{ ...demoParagraph(demoId(8000), owner, ""), type: "image",
    image: { type: "external", external: { url: "https://assets.example.test/capture.png" }, caption: [] } } as BlockObjectResponse]);
  await runWebsiteSync({ client: f.demo.client, config: f.config, mode: "dry-run", captureCollection: f.capture,
    mediaSources: { stage: async () => assert.fail() }, download: async () => ({ bytes: DEMO_PNG, mime: "image/png" }) });
  assert.equal((await inspectCollectionCapture(f.directory, f.identity)).collectionComplete, true);
  const page = JSON.parse(await readFile(join(f.directory, `page-${owner}.json`), "utf8"));
  assert.equal(page.media.length, 1); assert.equal(page.bindings.length, 1);
  assert.equal(page.media[0].assetId, page.record.detail.document.blocks[0].image.id);
  assert.equal(page.bindings[0].assetId, page.media[0].assetId);
  assert.equal(page.bindings[0].delivery, "notion");
  assert.equal(JSON.stringify(page).includes("assets.example.test"), false, "No raw image location is persisted in a page projection");
});

test("replacement commits an immutable revision pointer; the previous index stays readable across an interrupted commit",async t=>{
  const f=await fixture(t),id=demoId(1000);
  await assert.rejects(runWebsiteSync({config:f.config,mode:"dry-run",captureCollection:f.capture,client:{...f.demo.client,
    listBlocks:async owner=>{if(owner===demoId(1001))throw new Error("Synthetic interruption");return f.demo.client.listBlocks(owner);}}}),/Synthetic interruption/);
  const indexPath=join(f.directory,"index-private.json"),originalIndex=await readFile(indexPath,"utf8");
  const originalPath=join(f.directory,`page-${id}.json`),original=await readFile(originalPath,"utf8");
  const revised=JSON.parse(original);revised.record.detail.item.title="Freshly revised title";
  await f.capture.replace(revised);
  assert.equal(await readFile(originalPath,"utf8"),original,"indexed old bytes are never overwritten");
  const index=JSON.parse(await readFile(indexPath,"utf8"));
  assert.equal(index.pages[0].file,`page-${id}-${index.pages[0].digest}.json`);
  assert.equal((await readCollectionCaptureForRevalidation(f.directory,f.identity)).pages[0].record.detail.item.title,"Freshly revised title");
  const committedIndex=await readFile(indexPath,"utf8");
  await writeFile(indexPath,originalIndex,{mode:0o600});
  assert.notEqual((await readCollectionCaptureForRevalidation(f.directory,f.identity)).pages[0].record.detail.item.title,"Freshly revised title");
  await writeFile(indexPath,committedIndex,{mode:0o600});
  index.pages[0].file="../untrusted.json";await writeFile(indexPath,JSON.stringify(index),{mode:0o600});
  await assert.rejects(readCollectionCaptureForRevalidation(f.directory,f.identity));
});

test("bounded repair never enumerates siblings of an explicit allowlist and still checks its owner afresh",async t=>{
  const f=await fixture(t),id=demoId(1000);
  f.config.sources[0].publication={mode:"allowlist",allowlistPageIds:[id]};
  const capture=await createCollectionCapture(join(f.root,"allowlist"),{...f.identity,configDigest:configDigest(f.config)});
  const result=await runWebsiteSync({config:f.config,mode:"dry-run",captureCollection:capture,
    publicationRepair:{maxPages:1,maxPasses:1},client:{...f.demo.client,listPages:async()=>assert.fail("Do not enumerate unselected siblings")}});
  assert.equal(result.records,1);
  assert.equal(f.demo.requests.filter(r=>r.category==="pages"&&r.id===id).length,2,"collection and final pass have separate owner reads");
});
