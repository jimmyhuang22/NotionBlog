import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFile, stat, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";
import { hostFixture } from "./helpers/incremental-host.ts";
import { runIncrementalHost } from "../scripts/website-incremental-sync/host.ts";
import { incrementalMain, parseIncrementalArguments } from "../scripts/website-incremental-sync/cli.ts";
import { openIncrementalQueue } from "../scripts/website-incremental-sync/queue.ts";
import { openStudyCheckpoint, StudyCheckpointStore } from "../scripts/website-incremental-sync/study-checkpoint.ts";
import { openContentCache, ContentCacheStore } from "../scripts/website-incremental-sync/content-cache.ts";
import { preparePublicationDelta, readPublicationState } from "../src/server/database/incremental-publication.ts";
import { acquireLock } from "../scripts/notion-sync/state.ts";
import { demoText, demoId, demoPage, demoParagraph, DEMO } from "../scripts/notion-sync/demo.ts";

test("the actual host initializes both stores and recovers mixed SQL/local replies without source replay", async t => {
  const f = await hostFixture(); t.after(() => f.close());
  const run = (command: "initialize" | "run" | "recover") => runIncrementalHost({ ...f.options, command }, f.deps);
  const initialized = await run("initialize"); assert.equal(initialized.outcome, "initialized", JSON.stringify(initialized));
  assert.equal(initialized.baselineRecords, 3); assert.equal(f.counts.factories, 0); assert.equal(f.counts.sourceCalls, 0);
  assert.equal(f.counts.pageReads, 3, "the complete raw reader proves each page once for both caches");
  assert.equal((await stat(join(f.options.runtimeDirectory, "incremental-ready.json"))).mode & 0o077, 0);
  const initialReplay = await run("initialize"); assert.equal(initialReplay.outcome, "initialized");
  const first = await run("run"); assert.equal(first.outcome, "unchanged", JSON.stringify(first)); assert.equal(first.published, 0); assert.equal(f.counts.submits, 0);
  function edit(label: string) {
    const page = f.demo.pages.get(demoId(1000))!;
    page.properties.Name = { id: "title", type: "title", title: [demoText(label)] };
    page.last_edited_time = new Date().toISOString();
  }
  edit("Updated status");
  const update = await run("run"); assert.equal(update.outcome, "updated", JSON.stringify(update)); assert.equal(update.published, 1);
  await t.test("a lost successful SQL response remains unknown and is verified before any new source call", async () => {
    edit("SQL reply lost"); f.setLoseCommit();
    const lost = await run("run"); assert.equal(lost.outcome, "blocked", JSON.stringify(lost)); assert.equal(lost.queue!.awaiting_verification, 1);
    const before = { ...f.counts };
    const recovered = await runIncrementalHost({ ...f.options, command: "recover" }, { ...f.deps, sources: async () => { assert.fail("Source during recovery"); } });
    assert.equal(recovered.outcome, "recovered", JSON.stringify(recovered)); assert.equal(recovered.recovered, 1); assert.equal(recovered.queue!.awaiting_verification, 0);
    assert.equal(f.counts.sourceCalls, before.sourceCalls); assert.equal(f.counts.submits, before.submits);
  });
  await t.test("a lost successful second cache installation reopens and installs idempotently", async () => {
    edit("Cache reply lost"); const original = ContentCacheStore.prototype.install; let fail = true;
    ContentCacheStore.prototype.install = function(proof) { const result = original.call(this, proof); if (fail) { fail = false; throw Error("Synthetic private install reply"); } return result; };
    try { const lost = await run("run"); assert.equal(lost.outcome, "blocked", JSON.stringify(lost)); assert.equal(lost.queue!.awaiting_verification, 1); }
    finally { ContentCacheStore.prototype.install = original; }
    const before = { ...f.counts }, recovered = await run("recover");
    assert.equal(recovered.outcome, "recovered", JSON.stringify(recovered)); assert.equal(recovered.recovered, 1);
    assert.equal(f.counts.sourceCalls, before.sourceCalls); assert.equal(f.counts.submits, before.submits);
    const cache = await openContentCache(join(f.options.runtimeDirectory, "content"), f.digest, f.config.sources.map(s => s.key));
    const study = await openStudyCheckpoint(join(f.options.runtimeDirectory, "study"), f.digest);
    try { const state = await readPublicationState(f.db);
      assert.equal(cache.readPublished({ sourceKey: "status", pageKey: demoId(1000) }, state)!.record.detail.item.title, "Cache reply lost");
      assert.equal(study.load().version, state.publicationRevision);
    } finally { cache.close(); study.close(); }
  });
  await t.test("new ordinary pages get their position from the actual source metadata", async () => {
    const page = demoPage(demoId(1001), "New status", { type: "data_source_id", data_source_id: DEMO.statuses, database_id: demoId(100) });
    page.last_edited_time = new Date().toISOString(); f.demo.pages.set(page.id, page);
    f.demo.blocks.set(page.id, [demoParagraph(demoId(400), page.id, "New synthetic body")]);
    const result = await run("run"); assert.equal(result.outcome, "updated", JSON.stringify(result)); assert.equal(result.published, 1);
    const cache = await openContentCache(join(f.options.runtimeDirectory, "content"), f.digest, f.config.sources.map(s => s.key));
    try { const state = await readPublicationState(f.db); assert.equal(cache.readPublished({ sourceKey: "status", pageKey: page.id }, state)!.record.evidence.ordinal, 1); }
    finally { cache.close(); }
  });
  await t.test("owned children appear even when the parent edit timestamp is unchanged", async () => {
    const page = demoPage(demoId(700), "New owned child", { type: "page_id", page_id: DEMO.week }); f.demo.pages.set(page.id, page);
    f.demo.blocks.set(page.id, [demoParagraph(demoId(701), page.id, "New child body")]);
    f.demo.blocks.get(DEMO.week)!.push({ ...demoParagraph(page.id, DEMO.week, ""), type: "child_page", child_page: { title: "New owned child" } } as import("@notionhq/client").BlockObjectResponse);
    const result = await run("run"); assert.equal(result.outcome, "updated", JSON.stringify(result)); assert.equal(result.published, 1);
    const cache = await openContentCache(join(f.options.runtimeDirectory, "content"), f.digest, f.config.sources.map(s => s.key));
    try { const state = await readPublicationState(f.db), stored = cache.readPublished({ sourceKey: "notes", pageKey: page.id }, state)!;
      assert.equal(stored.record.evidence.parentId, DEMO.week); assert.equal(stored.record.detail.item.title, "New owned child"); assert.ok(stored.record.detail.document);
    } finally { cache.close(); }
  });
  const unchanged = await run("run"); assert.equal(unchanged.outcome, "unchanged", JSON.stringify(unchanged)); assert.equal(unchanged.published, 0);
  assert.equal(f.counts.pools, f.counts.closed);
  const report = await readFile(join(f.options.runtimeDirectory, "incremental-latest.json"), "utf8");
  for (const secret of [f.options.database.readerUrl, f.options.database.writerUrl, "Cache reply lost", DEMO.week]) assert.equal(report.includes(secret), false);
  await assert.rejects(access(join(f.options.lockDirectory, "worker.lock")));
});

test("orphaned preparation retirement is real, durable and source-free; an unexpired lease is never stolen", async t => {
  for (const expired of [true, false]) await t.test(expired ? "expired" : "unexpired", async () => {
    const f = await hostFixture(); try {
      assert.equal((await runIncrementalHost(f.options, f.deps)).outcome, "initialized");
      const scope = { digest: f.digest, sourceKeys: f.config.sources.map(s => s.key) };
      const queue = await openIncrementalQueue(join(f.options.runtimeDirectory, "queue"), scope, expired ? () => Date.now() - 5000 : Date.now);
      const study = await openStudyCheckpoint(join(f.options.runtimeDirectory, "study"), f.digest), cache = await openContentCache(join(f.options.runtimeDirectory, "content"), f.digest, scope.sourceKeys);
      let operationId: string, prepared!: ReturnType<typeof preparePublicationDelta>;
      try {
        queue.enqueue([{ eventId: "orphan-preparation", sourceKey: "status", pageKey: demoId(1000), reason: "content", observedAt: Date.now() - 6000 }]);
        const [ticket] = queue.claim(1, expired ? 1000 : 900000); operationId = ticket.operationId;
        const record = structuredClone(f.artifact.collection.records.find(r => r.detail.item.kind === "status")!); record.detail.item.title = "Never submitted";
        const delta = preparePublicationDelta({ expectedRevision: f.state.publicationRevision, configDigest: f.digest, upserts: [record], media: [], withdrawals: [] });
        prepared = delta; study.stageOtherPublication(ticket.operationId, delta); cache.stage(ticket.operationId, delta, f.state);
      } finally { queue.close(); study.close(); cache.close(); }
      const result = await runIncrementalHost({ ...f.options, command: "recover" }, { ...f.deps, sources: async () => { assert.fail("Source in orphan recovery"); } });
      assert.equal(result.outcome, expired ? "recovered" : "failed", JSON.stringify(result));
      if (expired) assert.ok(result.retired >= 1); else assert.equal(result.errorCode, "HOST_RECOVERY_BLOCKED");
      assert.equal(f.counts.factories, 0); assert.equal(f.counts.submits, 0);
      const reopened = await openStudyCheckpoint(join(f.options.runtimeDirectory, "study"), f.digest);
      try {
        assert.equal(reopened.load().version, f.state.publicationRevision);
        if (expired) assert.throws(() => reopened.stageOtherPublication(operationId!, prepared), { code: "STUDY_OPERATION_CONFLICT" });
        else assert.doesNotThrow(() => reopened.stageOtherPublication(operationId!, prepared));
      }
      finally { reopened.close(); }
    } finally { await f.close(); }
  });
});

test("partial baseline initialization resumes only missing state and never begins discovery", async t => {
  for (const saved of [false, true]) await t.test(saved ? "lost successful study installation reply" : "study installation failed", async () => {
    const f = await hostFixture(), initialize = StudyCheckpointStore.prototype.initialize;
    try {
      StudyCheckpointStore.prototype.initialize = function(state, proof) {
        if (saved) initialize.call(this, state, proof);
        throw Error("Synthetic private baseline installation failure");
      };
      const failed = await runIncrementalHost(f.options, f.deps); assert.equal(failed.outcome, "failed");
      assert.equal(f.counts.pageReads, 3);
      const content = await openContentCache(join(f.options.runtimeDirectory, "content"), f.digest, f.config.sources.map(s => s.key));
      try { content.assertState(f.state); } finally { content.close(); }
      await assert.rejects(access(join(f.options.runtimeDirectory, "incremental-ready.json")));
      const blocked = await runIncrementalHost({ ...f.options, command: "run" }, f.deps);
      assert.equal(blocked.errorCode, "HOST_BASELINE_MISSING"); assert.equal(f.counts.factories, 0);
      StudyCheckpointStore.prototype.initialize = initialize;
      const resumed = await runIncrementalHost(f.options, f.deps);
      assert.equal(resumed.outcome, "initialized", JSON.stringify(resumed));
      assert.equal(f.counts.pageReads, saved ? 6 : 8, "resume independently proves the full cache and only installs missing study state");
      assert.equal(f.counts.factories, 0); assert.equal(f.counts.submits, 0);
    } finally { StudyCheckpointStore.prototype.initialize = initialize; await f.close(); }
  });
});

test("the canonical lock prevents a second runtime before any SQL or source allocation", async t => {
  const f = await hostFixture(); t.after(() => f.close()); const release = await acquireLock(f.options.lockDirectory, randomUUID());
  try {
    const result = await runIncrementalHost(f.options, f.deps); assert.equal(result.errorCode, "HOST_BUSY"); assert.equal(f.counts.pools, 0); assert.equal(f.counts.factories, 0);
    await access(join(f.options.lockDirectory, "worker.lock"));
  } finally { await release(); }
});

test("the production CLI recovery needs no Notion or storage credentials and prints only an aggregate receipt", async t => {
  const f = await hostFixture(); t.after(() => f.close()); assert.equal((await runIncrementalHost(f.options, f.deps)).outcome, "initialized");
  const query = Pool.prototype.query, end = Pool.prototype.end, log = console.log, output: string[] = [];
  Pool.prototype.query = function(this: Pool & { options: import("pg").PoolConfig }, sql: string, values?: unknown[]) { return f.open(this.options).query(sql, values); } as typeof query;
  Pool.prototype.end = async () => {};
  console.log = value => output.push(String(value));
  try {
    const exit = await incrementalMain(["recover", "--config", join(f.root, "config.json"), "--lock-dir", f.options.lockDirectory, "--runtime-dir", f.options.runtimeDirectory],
      { NODE_ENV: "test", SYNC_PUBLICATION_MODE: "published", SYNC_MEDIA_PROVIDER: "storage", SYNC_READER_DATABASE_URL: f.options.database.readerUrl, SYNC_DATABASE_URL: f.options.database.writerUrl });
    assert.equal(exit, 0); assert.equal(JSON.parse(output.at(-1)!).outcome, "recovered"); assert.equal(f.counts.factories, 0);
    await t.test("status cannot print an unexpected private payload", async () => {
      const statusArgs = ["status", "--runtime-dir", f.options.runtimeDirectory];
      assert.equal(await incrementalMain(statusArgs, { NODE_ENV: "test" }), 0);
      const saved = JSON.parse(await readFile(join(f.options.runtimeDirectory, "incremental-latest.json"), "utf8"));
      await writeFile(join(f.options.runtimeDirectory, "incremental-latest.json"), JSON.stringify({ ...saved, privateBody: "Synthetic private payload" }));
      const printed = output.length;
      await assert.rejects(incrementalMain(statusArgs, { NODE_ENV: "test" }), { code: "HOST_STATE_INVALID" });
      assert.equal(output.length, printed);
    });
    await t.test("the website reader URI cannot fill a missing independent sync reader", async () => {
      const before = f.counts.pools;
      await assert.rejects(incrementalMain(["recover", "--config", join(f.root, "config.json"), "--lock-dir", f.options.lockDirectory, "--runtime-dir", f.options.runtimeDirectory],
        { NODE_ENV: "test", SYNC_PUBLICATION_MODE: "published", SYNC_MEDIA_PROVIDER: "storage", SYNC_DATABASE_URL: f.options.database.writerUrl,
          DATABASE_URL: f.options.database.readerUrl }), { code: "HOST_INPUT_INVALID" });
      assert.equal(f.counts.pools, before);
    });
  } finally { Pool.prototype.query = query; Pool.prototype.end = end; console.log = log; }
});

test("cancelled startup allocates no transport and leaves the canonical state untouched", async t => {
  const f = await hostFixture(); t.after(() => f.close());
  const result = await runIncrementalHost({ ...f.options, signal: AbortSignal.abort() }, f.deps);
  assert.equal(result.outcome, "cancelled"); assert.equal(result.errorCode, "HOST_CANCELLED");
  assert.equal(f.counts.pools, 0); assert.equal(f.counts.factories, 0);
  await assert.rejects(access(join(f.options.lockDirectory, "worker.lock")));
});

test("CLI parsing rejects implicit paths, duplicate flags and unapproved modes without startup", () => {
  for (const args of [["run"], ["run", "--runtime-dir", "relative"], ["run", "--runtime-dir", "/tmp/example", "--runtime-dir", "/tmp/another"],
    ["status", "--runtime-dir", "/tmp/example", "--config", "/tmp/config"], ["publish", "--runtime-dir", "/tmp/example"]]) assert.throws(() => parseIncrementalArguments(args));
  assert.deepEqual(parseIncrementalArguments(["status", "--runtime-dir", "/tmp/example"]), { command: "status", runtimeDirectory: "/tmp/example" });
});
