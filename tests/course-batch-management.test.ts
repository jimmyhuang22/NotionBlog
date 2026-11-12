import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagementBackend } from "../scripts/console-management/backend.ts";
import type { FreezePlan } from "../src/server/database/freeze.ts";

for (const failure of ["none", "rejected", "unknown", "budget"] as const) test(`course batches persist progress and stop correctly: ${failure}`, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "course-batches-")));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const groupId = "11111111-1111-4111-8111-111111111111", revision = (n: number) => `${groupId}:${n}`;
  const members = Array.from({length: 58}, (_, i) => ({id: i.toString(16).padStart(32, "0"), sourceKey: "synthetic", title: "Synthetic"}));
  const plan: FreezePlan = {action: "once", rootId: members[0].id, groupId, digest: "a".repeat(64), generation: "0",
    publicationRevision: revision(0), pages: 58, images: 0, missingImages: 0, title: "Synthetic", href: "/study/synthetic", kind: "course",
    media: [], thumbnailIds: [], members};
  const target = {id: plan.rootId, state: "frozen", title: plan.title, href: plan.href};
  let completed = 0, calls = 0;
  const selections: string[][] = [];
  const backend = new ManagementBackend({version: 1, enabled: true, stateDir: directory, lockDirectory: join(directory, "locks"),
    runtimeDirectory: join(directory, "runtime"), sourceConfigPath: join(directory, "config.json"), siteOrigin: "https://example.test", durationMs: 10000, mediaBytes: 1024}, {
    database: async () => ({query: async <T>(sql: string) => ({rows: [{result:
      sql.includes("check_capability") ? true : sql.includes("resolve_item") ? target : sql.includes("resolve_task") ? {sourceKey: "synthetic", pageKey: plan.rootId} :
      sql.includes("preview") ? plan : {enabled: true, generation: String(completed), configDigest: "b".repeat(64), publicationRevision: revision(completed), publishedAt: null,
        members: members.map(m => ({...m, groupId, rootId: plan.rootId, frozenAt: "2026-01-01T00:00:00Z"}))}}] as T[]})}),
    verifyMedia: async () => assert.fail(), enqueue: async () => assert.fail(), assertIdle: async () => {}, dispatch: async () => {}, latestReport: async () => null,
    inspectSource: async () => ({fingerprint: "unchanged", missing: []}),
    runSync: async input => {
      assert.equal(input.refresh?.generation, String(completed)); assert.equal(input.expectedRevision, revision(completed));
      assert.equal(input.budget?.sourceRequests, 400 - calls);
      selections.push(input.refresh!.pageIds!); calls++;
      const fail = calls === 2 && failure !== "none";
      if (!fail) completed++;
      return {format: "incremental-host-report-v1", outcome: fail ? "blocked" : "updated", phase: "publication", errorCode: fail ? "SYNTHETIC_FAILURE" : null,
        startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:00:01Z", recovered: 0, published: fail ? 0 : 1, unchanged: 0, retired: 0,
        discoveredPages: 0, discoveredHints: 0, baselineRecords: 0, baselineMedia: 0, budget: {errorCode: null, sourceRequests: failure === "budget" ? 400 : 1, sourceBytes: 0, mediaBytes: 0},
        queue: {pending: 0, leased: 0, retry: 0, awaiting_verification: fail && failure === "unknown" ? 1 : 0, needs_review: fail && failure === "rejected" ? 1 : 0,
          done: completed, events: calls, checkpoints: 0, retirement_pending: 0}};
    },
  });
  const preview = await backend.preview(plan.rootId, "once");
  const started = await backend.start("unfreeze.start", {target: plan.rootId, mode: "once", digest: preview.digest});
  await backend.work(started.operationId);
  const result = await backend.operation(started.operationId);
  assert.equal(result.state, failure === "none" ? "succeeded" : failure === "unknown" ? "unknown" : "failed");
  assert.equal(result.steps[0].state, "done");
  if (failure === "none") { assert.equal(calls, 3); assert.deepEqual(selections.flat(), members.map(m => m.id)); }
  else { assert.equal(calls, failure === "budget" ? 1 : 2); assert.equal(completed, 1); assert.equal(result.steps[1].state, "failed"); assert.equal(result.steps[2].state, "pending"); }
  await assert.rejects(backend.work(started.operationId), /FREEZE_OPERATION_CONFLICT/);
});
