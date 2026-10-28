import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile, readFile, lstat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireManagementCoordination, withManagementCoordination } from "../scripts/console-management/coordination.ts";
import { ManagementBackend } from "../scripts/console-management/backend.ts";
import { acquireLock } from "../scripts/notion-sync/state.ts";

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "console-coordination-")));
  t.after(() => rm(root, {recursive: true, force: true}));
  const locks = ["maintenance.lock", "manual-run.lock", "writer-session.lock"].map(n => join(root, n));
  const path = join(root, "locks.json"); await writeFile(path, JSON.stringify({version: 1, locks}), {mode: 0o600});
  return {root, locks, path};
}
test("console worker coordinates with recovery before its canonical lock and releases after work", async t => {
  const f = await fixture(t); let calls = 0;
  assert.equal(await withManagementCoordination(f.path, async () => {
    for (const p of f.locks) { assert.equal((await lstat(p)).mode & 0o777, 0o600); assert.equal(JSON.parse(await readFile(p, "utf8")).pid, process.pid); }
    const release = await acquireLock(f.root, "fixture-worker");
    try { calls++; return "done"; } finally { await release(); }
  }), "done");
  assert.equal(calls, 1);
  for (const p of [...f.locks, join(f.root, "worker.lock")]) await assert.rejects(lstat(p), {code: "ENOENT"});
});
test("a busy shared lock preserves foreign data and releases only the acquired prefix", async t => {
  const f = await fixture(t); await writeFile(f.locks[1], "other-operation", {mode: 0o600});
  await assert.rejects(withManagementCoordination(f.path, async () => assert.fail("No SQL/source work while busy")), /BUSY/);
  assert.equal(await readFile(f.locks[1], "utf8"), "other-operation");
  for (const p of [f.locks[0], f.locks[2]]) await assert.rejects(lstat(p), {code: "ENOENT"});
});
test("work failure releases locks but a changed ownership file is retained", async t => {
  const f = await fixture(t);
  await assert.rejects(withManagementCoordination(f.path, async () => {throw Error("work-failed");}), /work-failed/);
  await assert.rejects(withManagementCoordination(f.path, async () => {
    await unlink(f.locks[1]); await writeFile(f.locks[1], "replaced", {mode: 0o600});
  }), /MISCONFIGURED/);
  assert.equal(await readFile(f.locks[1], "utf8"), "replaced");
  for (const p of [f.locks[0], f.locks[2]]) await assert.rejects(lstat(p), {code: "ENOENT"});
});
test("an invalid lock order is rejected before work; unconfigured hosts keep their original behavior", async t => {
  const f = await fixture(t); await writeFile(f.path, JSON.stringify({version: 1, locks: [...f.locks].reverse()}));
  await assert.rejects(withManagementCoordination(f.path, async () => assert.fail()), /MISCONFIGURED/);
  assert.equal(await withManagementCoordination(undefined, async () => 3), 3);
});
test("coordination never creates a missing parent as a second lock namespace", async t => {
  const f = await fixture(t), absent = join(f.root, "missing");
  await writeFile(f.path, JSON.stringify({version: 1, locks: [join(absent, "maintenance.lock"), ...f.locks.slice(1)]}));
  await assert.rejects(withManagementCoordination(f.path, async () => assert.fail()), {code: "ENOENT"});
  await assert.rejects(lstat(absent), {code: "ENOENT"});
});
test("a busy coordinated worker records failure before SQL or source work", async t => {
  const f = await fixture(t); let queries = 0;
  const backend = new ManagementBackend({version: 1, enabled: true, stateDir: join(f.root, ".local", "management"),
    lockDirectory: f.root, runtimeDirectory: join(f.root, "runtime"), sourceConfigPath: join(f.root, "source.json"),
    siteOrigin: "https://example.test", durationMs: 1000, mediaBytes: 1048576}, {
    database: async () => ({query: async <T>(sql: string) => {
      queries++;
      return {rows: [{result: sql.includes("check_capability") ? true : {enabled: true, generation: "0", configDigest: "a".repeat(64),
        publicationRevision: "11111111-1111-4111-8111-111111111111:9", publishedAt: null, members: []}}] as T[]};
    }}), assertIdle: async () => {}, dispatch: async () => {}, latestReport: async () => null,
    verifyMedia: async () => assert.fail(), inspectSource: async () => assert.fail(),
    runSync: async () => assert.fail("Source cannot start while recovery is busy"), enqueue: async () => assert.fail(),
  });
  const operation = await backend.start("sync.start", {}), before = queries;
  await writeFile(f.locks[0], "other-recovery", {mode: 0o600});
  await backend.work(operation.operationId, () => acquireManagementCoordination(f.path));
  assert.equal(queries, before);
  const result = await backend.operation(operation.operationId);
  assert.equal(result.state, "failed"); assert.equal(result.error?.code, "BUSY");
  assert.equal(await readFile(f.locks[0], "utf8"), "other-recovery");
});
