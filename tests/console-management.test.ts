import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { hostFixture } from "./helpers/incremental-host.ts";
import { ManagementBackend, type ManagementPorts, type ManagementConfig } from "../scripts/console-management/backend.ts";
import { runIncrementalHost } from "../scripts/website-incremental-sync/host.ts";
import { installFreeze } from "../scripts/website-sync/freeze-migration.ts";
import { createFreezeStore } from "../src/server/database/freeze.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";
import type { FreezePreview, UnfreezePreview, SectionSummary, ContentPage } from "../console/lib/types.ts";
import { DEMO } from "../scripts/notion-sync/demo.ts";

test("console management uses the database-backed plans, operation history and existing sync entry", async t => {
  const f = await hostFixture(); t.after(() => f.close());
  const owner: SqlExecutor = {async query<T>(sql: string, values?: unknown[]) {
    if (sql.startsWith("-- Opt-in")) { await f.db.exec(sql); return {rows: [] as T[]}; }
    return f.db.query<T>(sql, values);
  }};
  const initialized = await runIncrementalHost(f.options, f.deps); assert.equal(initialized.outcome, "initialized");
  await installFreeze(owner); await f.db.query("UPDATE nb_freeze.state SET enabled=true");
  const db: SqlExecutor = {query: <T>(sql: string, values?: unknown[]) => f.db.transaction(async tx => {
    await tx.exec("SET LOCAL ROLE nb_freeze_operator"); return tx.query<T>(sql, values);
  })};
  let fingerprint = "v1", failEnqueue = false, dispatched = 0, synched = 0;
  const queued: string[] = [];
  let syncReport: unknown;
  const config: ManagementConfig = {version: 1, enabled: true, stateDir: join(f.root, ".local", "management"),
    lockDirectory: f.options.lockDirectory, runtimeDirectory: f.options.runtimeDirectory, sourceConfigPath: join(f.root, "config.json"),
    siteOrigin: "https://example.test", durationMs: 120000, mediaBytes: 64 * 1024 * 1024};
  const ports: ManagementPorts = {database: async () => db,
    verifyMedia: async () => assert.fail("Fixture contains no media"),
    inspectSource: async () => ({fingerprint, missing: []}),
    enqueue: async members => { if (failEnqueue) throw Error("Synthetic queue persistence failure"); queued.push(...members.map(m => m.id)); },
    assertIdle: async () => {}, dispatch: async () => {dispatched++;}, latestReport: async () => initialized,
    runSync: async (input, signal) => {synched++; const report = await runIncrementalHost({...f.options, command: "run", signal,
      target: input.target ?? undefined, freezeEnabled: true, expectedPublicationRevision: input.expectedRevision,
      refreshFrozenGroup: input.refresh?.groupId, expectedFreezeGeneration: input.refresh?.generation}, f.deps); syncReport = report; return report;},
  };
  const backend = new ManagementBackend(config, ports);
  const item = await backend.resolve(DEMO.course);
  const preview = await backend.preview(item.href, "freeze") as FreezePreview;
  assert.equal(preview.pages, 2);
  const started = await backend.start("freeze.start", {target: item.href, digest: preview.digest});
  assert.equal(dispatched, 1); assert.equal((await backend.operation(started.operationId)).state, "queued");
  await backend.work(started.operationId);
  assert.equal((await backend.operation(started.operationId)).state, "succeeded");
  assert.equal((await backend.resolve(item.href)).state, "frozen");
  const sections = await backend.request("content.sections", {}) as SectionSummary[];
  assert.deepEqual(sections.find(s => s.section === "study"), {section: "study", count: 1, frozen: 1});
  assert.equal(sections.find(s => s.section === "movie")?.count, 0);
  const notes = await backend.request("content.list", {section: "study", parentId: DEMO.course}) as ContentPage;
  assert.equal(notes.items[0].inheritedFrozen, true);
  await assert.rejects(backend.start("sync.start", {target: item.id}), /FREEZE_ALREADY_FROZEN/);
  await assert.rejects(backend.work(started.operationId), /FREEZE_OPERATION_CONFLICT/);

  const stale = await backend.preview(item.id, "once") as UnfreezePreview;
  fingerprint = "changed-source";
  const refused = await backend.start("unfreeze.start", {target: item.id, mode: "once", digest: stale.digest});
  await backend.work(refused.operationId);
  assert.equal((await backend.operation(refused.operationId)).error?.code, "PREVIEW_STALE");
  assert.equal(synched, 0);
  assert.equal((await createFreezeStore(owner).state()).members.length, 2);

  const permanent = await backend.preview(item.id, "permanent") as UnfreezePreview;
  const thawed = await backend.start("unfreeze.start", {target: item.id, mode: "permanent", digest: permanent.digest});
  await backend.work(thawed.operationId);
  assert.equal((await backend.operation(thawed.operationId)).state, "succeeded");
  assert.deepEqual([...queued].sort(), [DEMO.course, DEMO.week].sort());
  assert.equal((await backend.resolve(item.id)).state, "syncing");

  const sync = await backend.start("sync.start", {target: DEMO.week}); await backend.work(sync.operationId);
  assert.equal((await backend.operation(sync.operationId)).state, "succeeded", JSON.stringify(syncReport));
  assert.equal(synched, 1);
  assert.equal((await backend.operation(sync.operationId)).counts, null);
  assert.equal((await backend.operations()).length, 4);

  const again = await backend.preview(item.id, "freeze") as FreezePreview;
  const frozen = await backend.start("freeze.start", {target: item.id, digest: again.digest}); await backend.work(frozen.operationId);
  const last = await backend.preview(item.id, "permanent") as UnfreezePreview;
  failEnqueue = true;
  const unknown = await backend.start("unfreeze.start", {target: item.id, mode: "permanent", digest: last.digest}); await backend.work(unknown.operationId);
  assert.equal((await backend.operation(unknown.operationId)).state, "unknown");
  assert.equal((await createFreezeStore(owner).state()).members.length, 0);
  await assert.rejects(backend.work(unknown.operationId), /FREEZE_OPERATION_CONFLICT/);
});
