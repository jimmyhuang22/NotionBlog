import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import * as sqlite from "node:sqlite";
import { hostFixture } from "./helpers/incremental-host.ts";
import { runIncrementalHost } from "../scripts/website-incremental-sync/host.ts";
import { openIncrementalQueue } from "../scripts/website-incremental-sync/queue.ts";
import { openStudyCheckpoint } from "../scripts/website-incremental-sync/study-checkpoint.ts";
import { openContentCache } from "../scripts/website-incremental-sync/content-cache.ts";
import { preparePublicationDelta } from "../src/server/database/incremental-publication.ts";
import { demoId } from "../scripts/notion-sync/demo.ts";

const Constructor = (sqlite as unknown as { Database?: typeof sqlite.DatabaseSync }).Database ?? sqlite.DatabaseSync;
function readRows(path: string, sql: string) {
  const db = new Constructor(path, { readOnly: true });
  try { return db.prepare(sql).all(); } finally { db.close(); }
}
function queueSnapshot(runtime: string) {
  const path = join(runtime, "queue", "incremental.sqlite");
  return {
    jobs: readRows(path, "SELECT source,page,generation,completed_generation,reasons,state,available_at,active_attempt,error_code FROM jobs ORDER BY source,page"),
    attempts: readRows(path, "SELECT id,source,page,generation,state,payload_digest FROM attempts ORDER BY id"),
    failed: readRows(path, "SELECT source,page,generation,count(*) AS failures FROM attempts WHERE state='failed' GROUP BY source,page,generation ORDER BY source,page,generation"),
  };
}

for (const expired of [true, false]) test(`host recovery preserves queued work and failure history with an ${expired ? "expired" : "unexpired"} preparation`, async t => {
  const f = await hostFixture(); t.after(() => f.close());
  assert.equal((await runIncrementalHost(f.options, f.deps)).outcome, "initialized");
  const sourceKeys = f.config.sources.map(source => source.key), runtime = f.options.runtimeDirectory;
  const now = Date.now() - (expired ? 6000 : 0), orphan = demoId(1000), pending = demoId(1001), retry = demoId(1002);
  const queue = await openIncrementalQueue(join(runtime, "queue"), { digest: f.digest, sourceKeys }, () => now);
  const study = await openStudyCheckpoint(join(runtime, "study"), f.digest);
  const cache = await openContentCache(join(runtime, "content"), f.digest, sourceKeys);
  let operationId = "";
  try {
    const enqueue = (pageKey: string, eventId: string) => queue.enqueue([{ eventId, sourceKey: "status", pageKey, reason: "content", observedAt: now }]);
    enqueue(orphan, "orphan");
    const [ticket] = queue.claim(1, expired ? 1000 : 900000); operationId = ticket.operationId;
    const record = structuredClone(f.artifact.collection.records.find(item => item.detail.item.kind === "status")!);
    record.detail.item.title = "Unsubmitted recovery fixture";
    const delta = preparePublicationDelta({ expectedRevision: f.state.publicationRevision, configDigest: f.digest, upserts: [record], media: [], withdrawals: [] });
    study.stageOtherPublication(operationId, delta); cache.stage(operationId, delta, f.state);
    enqueue(retry, "retry");
    for (let attempt = 0; attempt < 2; attempt++) {
      const [failed] = queue.claim(1); assert.equal(failed.pageKey, retry);
      queue.retryPreparation(failed, "TEMPORARY", 0);
      for (const proof of queue.pendingRetirements()) queue.acknowledgeRetirement(proof);
    }
    enqueue(pending, "pending");
  } finally { queue.close(); study.close(); cache.close(); }
  const before = queueSnapshot(runtime), unchangedPages = before.jobs.filter(job => job.page !== orphan);
  assert.equal(before.attempts.length, 3); assert.equal(before.failed[0].failures, 2);
  for (let invocation = 0; invocation < 3; invocation++) {
    const report = await runIncrementalHost({ ...f.options, command: "recover" }, {
      ...f.deps, sources: async () => assert.fail("Recovery must not construct source ports"),
    });
    assert.equal(report.outcome, expired ? "recovered" : "failed", JSON.stringify(report));
    if (!expired) assert.equal(report.errorCode, "HOST_RECOVERY_BLOCKED");
    const after = queueSnapshot(runtime);
    assert.deepEqual(after.jobs.filter(job => job.page !== orphan), unchangedPages);
    assert.deepEqual(after.failed, before.failed);
    assert.deepEqual(after.attempts.map(attempt => attempt.id), before.attempts.map(attempt => attempt.id));
    assert.equal(after.attempts.find(attempt => attempt.id === operationId)!.state, expired ? "abandoned" : "preparing");
    assert.equal(after.jobs.find(job => job.page === orphan)!.state, expired ? "pending" : "leased");
    if (!expired) assert.deepEqual(after.jobs, before.jobs);
    const expectedStatus = expired ? "retired" : "prepared";
    for (const [directory, filename] of [["study", "study.sqlite"], ["content", "content.sqlite"]]) {
      assert.equal(readRows(join(runtime, directory, filename), "SELECT status FROM operations")[0].status, expectedStatus);
    }
    assert.equal(f.counts.factories, 0); assert.equal(f.counts.sourceCalls, 0); assert.equal(f.counts.submits, 0);
  }
});
