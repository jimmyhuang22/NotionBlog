import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants, unlinkSync } from "node:fs";
import fsPromises from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { chmod, link, lstat, mkdtemp, readFile, readdir, realpath, rm, symlink, truncate, unlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { canonicalJson } from "../src/server/database/validation.ts";
import { ContentServiceError } from "../contracts/repository.ts";
import { initializeThumbnailBudgetLedger, openThumbnailBudgetAttempt as coreOpen, parseThumbnailExecutionBudget,
  thumbnailPlanDigest, type ThumbnailExecutionBudget, type ThumbnailBudgetGuard } from "../scripts/media-thumbnails/budget.ts";
import type { ThumbnailPlan } from "../scripts/media-thumbnails/plan.ts";

const RUN = "00000000-0000-4000-8000-000000000001";
const BUDGET = "00000000-0000-4000-8000-000000000002";
const PRIVATE = "PRIVATE_BUDGET_FIXTURE_DO_NOT_DISCLOSE";
const plan: ThumbnailPlan = { version: "v2", runId: RUN, assetIds: [`a1.${"a".repeat(64)}`, `a1.${"b".repeat(64)}`] };
const limits = { maxParents: 2, maxOriginalBytes: 100, maxUploadRequests: 2, maxUploadBodyBytes: 100,
  maxDurationSeconds: 5, maxTotalParentAttempts: 8, maxTotalOriginalBytes: 200, maxTotalUploadRequests: 4,
  maxTotalUploadBodyBytes: 200, maxTotalReservedDurationSeconds: 20 };
const active = new Map<string, ThumbnailBudgetGuard[]>();
async function openThumbnailBudgetAttempt(file: string, selected: ThumbnailPlan) {
  const guard = await coreOpen(file, selected);
  active.set(file, [...active.get(file) ?? [], guard]);
  return guard;
}
async function cleanup(f: { dir: string; file: string }) {
  const results = await Promise.allSettled((active.get(f.file) ?? []).map(g => g.close()));
  active.delete(f.file);
  await rm(f.dir, { recursive: true, force: true });
  for (const result of results) if (result.status === "rejected") throw result.reason;
}
function budget(): ThumbnailExecutionBudget {
  return { format: "notionblog-thumbnail-execution-budget-v1", budgetId: BUDGET,
    version: "v2", runId: RUN, planSHA256: [thumbnailPlanDigest(plan)], limits: { ...limits } };
}
function anonymous(error: unknown): boolean {
  assert.ok(error instanceof ContentServiceError);
  assert.equal(error.message, "Thumbnail execution budget could not safely permit this attempt.");
  for (const value of [RUN, BUDGET, PRIVATE, ...plan.assetIds]) assert.ok(!error.message.includes(value));
  return true;
}
async function fixture(value = budget()) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "nb-thumbnail-budget-")));
  await chmod(dir, 0o700);
  const file = join(dir, "budget.json"), ledger = join(dir, "thumbnail-execution-ledger.json");
  await writeFile(file, JSON.stringify(value), { mode: 0o600 });
  return { dir, file, ledger };
}
async function disk(path: string) { return JSON.parse(await readFile(path, "utf8")); }
async function edit(path: string, mutate: (value: Record<string, unknown>) => void) {
  const value = await disk(path); mutate(value); await writeFile(path, JSON.stringify(value), { mode: 0o600 });
}

test("plan digest uses validated canonical JSON and binds ordered complete parent identities", () => {
  assert.equal(thumbnailPlanDigest(plan), createHash("sha256").update(canonicalJson(plan)).digest("hex"));
  assert.equal(thumbnailPlanDigest({ assetIds: plan.assetIds, runId: RUN, version: "v2" }), thumbnailPlanDigest(plan));
  assert.notEqual(thumbnailPlanDigest({ ...plan, assetIds: [...plan.assetIds].reverse() }), thumbnailPlanDigest(plan));
  assert.throws(() => thumbnailPlanDigest({ ...plan, secret: PRIVATE }), anonymous);
  const input = budget(), parsed = parseThumbnailExecutionBudget(input);
  parsed.limits.maxParents = 1; parsed.planSHA256.push("c".repeat(64));
  assert.deepEqual(input.limits, limits);
  assert.equal(input.planSHA256.length, 1);
});

test("budget rejects unknown fields, malformed identities, duplicate hashes and all hard-limit violations", async t => {
  const cases: [string, (value: Record<string, unknown>) => void][] = [
    ["extra", b => { b.secret = PRIVATE; }], ["format", b => { b.format = "old-six-post-budget"; }],
    ["budget-id", b => { b.budgetId = BUDGET + "\n"; }], ["run-id", b => { b.runId = PRIVATE; }],
    ["version", b => { b.version = "v3"; }], ["hash-newline", b => { b.planSHA256 = ["a".repeat(64) + "\n"]; }],
    ["hash-duplicate", b => { b.planSHA256 = [thumbnailPlanDigest(plan), thumbnailPlanDigest(plan)]; }],
    ["hash-empty", b => { b.planSHA256 = []; }], ["limits-extra", b => { (b.limits as Record<string, unknown>).eligibilityReserveSeconds = 0; }],
  ];
  const maxima = { maxParents: 20_000, maxOriginalBytes: 1024 ** 3, maxUploadRequests: 40_000, maxUploadBodyBytes: 2 * 1024 ** 3,
    maxDurationSeconds: 480, maxTotalParentAttempts: 20_000, maxTotalOriginalBytes: 64 * 1024 ** 3,
    maxTotalUploadRequests: 40_000, maxTotalUploadBodyBytes: 64 * 1024 ** 3, maxTotalReservedDurationSeconds: 86400 };
  for (const [key, maximum] of Object.entries(maxima)) cases.push([key, b => { (b.limits as Record<string, unknown>)[key] = maximum + 1; }]);
  for (const key of Object.keys(maxima)) cases.push([`negative-${key}`, b => { (b.limits as Record<string, unknown>)[key] = -1; }]);
  for (const key of ["maxParents", "maxDurationSeconds", "maxTotalParentAttempts", "maxTotalReservedDurationSeconds"])
    cases.push([`zero-${key}`, b => { (b.limits as Record<string, unknown>)[key] = 0; }]);
  cases.push(["fraction", b => { (b.limits as Record<string, unknown>).maxDurationSeconds = 1.5; }]);
  for (const [name, mutate] of cases) await t.test(name, () => {
    const b = structuredClone(budget()) as unknown as Record<string, unknown>; mutate(b);
    assert.throws(() => parseThumbnailExecutionBudget(b), anonymous);
  });
});

test("zero image allowances keep attempts durable and stop any original or upload reservation", async t => {
  for (const action of ["original", "upload"] as const) await t.test(action, async () => {
    const value = budget();
    Object.assign(value.limits, { maxOriginalBytes: 0, maxUploadRequests: 0, maxUploadBodyBytes: 0,
      maxTotalOriginalBytes: 0, maxTotalUploadRequests: 0, maxTotalUploadBodyBytes: 0 });
    const f = await fixture(value);
    try {
      await initializeThumbnailBudgetLedger(f.file);
      const guard = await openThumbnailBudgetAttempt(f.file, plan);
      guard.check();
      const before = await readFile(f.ledger);
      await assert.rejects(action === "original" ? guard.reserveOriginal(1) : guard.reserveUpload(1), anonymous);
      assert.equal(guard.signal.aborted, true);
      assert.deepEqual(await readFile(f.ledger), before, "denied image I/O never reaches a durable reservation");
      assert.equal(guard.snapshot().totalParentAttempts, 2);
      assert.equal(guard.snapshot().totalReservedDurationSeconds, 5);
      assert.equal(guard.snapshot().totalOriginalBytes, 0);
      assert.equal(guard.snapshot().totalUploadRequests, 0);
      assert.equal(guard.snapshot().totalUploadBodyBytes, 0);
    } finally { await cleanup(f); }
  });
});

test("only explicit initialization writes zero; existing or missing ledgers never become zero at run time", async () => {
  const f = await fixture();
  try {
    await assert.rejects(openThumbnailBudgetAttempt(f.file, plan), anonymous);
    assert.deepEqual(await readdir(f.dir), ["budget.json"]);
    assert.deepEqual(await initializeThumbnailBudgetLedger(f.file), { status: "BUDGET_INITIALIZED" });
    const initial = await readFile(f.ledger);
    assert.deepEqual((await disk(f.ledger)).totals, { parentAttempts: 0, originalBytes: 0, uploadRequests: 0, uploadBodyBytes: 0, reservedDurationSeconds: 0 });
    await assert.rejects(initializeThumbnailBudgetLedger(f.file), anonymous);
    assert.deepEqual(await readFile(f.ledger), initial);
    assert.equal((await lstat(f.ledger)).mode & 0o777, 0o600);
    assert.equal((await lstat(f.dir)).mode & 0o777, 0o700);
  } finally { await cleanup(f); }
});

test("attempt parents and duration are durable before I/O; reservations remain spent across close and reopen", async () => {
  const f = await fixture();
  try {
    await initializeThumbnailBudgetLedger(f.file);
    const first = await openThumbnailBudgetAttempt(f.file, plan);
    assert.equal((await disk(f.ledger)).totals.parentAttempts, 2);
    assert.equal((await disk(f.ledger)).totals.reservedDurationSeconds, 5);
    await first.reserveOriginal(10); await first.reserveUpload(20);
    const copied = first.snapshot();
    assert.ok(Object.isFrozen(copied));
    assert.ok(Object.values(copied).every(value => Number.isSafeInteger(value) && value >= 0));
    assert.ok(!JSON.stringify(copied).includes(RUN));
    await first.close(); await first.close();
    assert.notEqual(first.signal.reason.name, "TimeoutError");
    assert.equal(first.deadlineSignal.aborted, false);
    assert.throws(first.check, anonymous);
    const second = await openThumbnailBudgetAttempt(f.file, plan);
    assert.equal(second.snapshot().attemptCount, 2);
    assert.equal(second.snapshot().totalParentAttempts, 4);
    assert.equal(second.snapshot().totalOriginalBytes, 10);
    assert.equal(second.snapshot().totalUploadRequests, 1);
    assert.equal(second.snapshot().totalUploadBodyBytes, 20);
    assert.equal(second.snapshot().totalReservedDurationSeconds, 10);
    assert.equal(second.snapshot().attemptOriginalBytes, 0);
    await second.close();
    assert.equal((await lstat(f.ledger)).mode & 0o777, 0o600);
    assert.deepEqual((await readdir(f.dir)).sort(), ["budget.json", "thumbnail-execution-ledger.json"]);
  } finally { await cleanup(f); }
});

test("the budget directory lock excludes overlapping attempts and initialization, and releases only its own lock", async () => {
  const f = await fixture();
  try {
    await initializeThumbnailBudgetLedger(f.file);
    const first = await openThumbnailBudgetAttempt(f.file, plan);
    await assert.rejects(openThumbnailBudgetAttempt(f.file, plan), anonymous);
    await assert.rejects(initializeThumbnailBudgetLedger(f.file), anonymous);
    assert.equal((await disk(f.ledger)).attempts.length, 1);
    assert.equal((await disk(join(f.dir, "worker.lock"))).runId, BUDGET);
    await unlink(join(f.dir, "worker.lock"));
    await writeFile(join(f.dir, "replacement"), PRIVATE, { mode: 0o600 });
    await fsPromises.rename(join(f.dir, "replacement"), join(f.dir, "worker.lock"));
    await first.close();
    assert.equal(await readFile(join(f.dir, "worker.lock"), "utf8"), PRIVATE);
  } finally { await cleanup(f); }
});

test("the creating lock descriptor remains open and a replacement survives simulated recycled path identity", async t => {
  const f = await fixture(); let restore = false;
  try {
    await initializeThumbnailBudgetLedger(f.file);
    const path = join(f.dir, "worker.lock"), originalOpen = fsPromises.open;
    let retained: FileHandle | undefined;
    t.mock.method(fsPromises, "open", async (...args: Parameters<typeof fsPromises.open>) => {
      const handle = await originalOpen(...args);
      if (args[0] === path && typeof args[1] === "number" && (args[1] & constants.O_EXCL)) retained = handle;
      return handle;
    });
    syncBuiltinESMExports(); restore = true;
    const g = await openThumbnailBudgetAttempt(f.file, plan), before = await lstat(path);
    assert.ok(retained); assert.ok(retained.fd >= 0);
    const owner = await disk(path), originalBody = await readFile(path, "utf8");
    const changedNonce = owner.nonce.slice(0, -1) + (owner.nonce.endsWith("0") ? "1" : "0");
    const replacement = originalBody.replace(owner.nonce, changedNonce);
    await unlink(path); await writeFile(path, replacement, { mode: 0o600 });
    // The original descriptor still resolves the unlinked inode until close.
    assert.equal((await retained.stat()).ino, before.ino);
    const originalLstat = fsPromises.lstat;
    t.mock.method(fsPromises, "lstat", async (...args: Parameters<typeof fsPromises.lstat>) => {
      const info = await originalLstat(...args);
      if (args[0] === path) return Object.assign(info, { ino: before.ino, dev: before.dev });
      return info;
    });
    syncBuiltinESMExports();
    await g.close();
    assert.equal(retained.fd, -1);
    assert.equal(await readFile(path, "utf8"), replacement);
  } finally {
    if (restore) { t.mock.restoreAll(); syncBuiltinESMExports(); }
    await cleanup(f);
  }
});

test("an in-place lock owner change with the same inode and size is preserved", async () => {
  const f = await fixture();
  try {
    await initializeThumbnailBudgetLedger(f.file); const g = await openThumbnailBudgetAttempt(f.file, plan);
    const path = join(f.dir, "worker.lock"), before = await lstat(path), body = await readFile(path, "utf8"), owner = JSON.parse(body);
    assert.equal(owner.pid, process.pid); assert.equal(owner.runId, BUDGET);
    const changedNonce = owner.nonce.slice(0, -1) + (owner.nonce.endsWith("0") ? "1" : "0");
    const replacement = body.replace(owner.nonce, changedNonce);
    await writeFile(path, replacement);
    const after = await lstat(path);
    assert.equal(after.ino, before.ino); assert.equal(after.size, before.size);
    await g.close();
    assert.equal(await readFile(path, "utf8"), replacement);
  } finally { await cleanup(f); }
});

test("failed lock synchronization closes its descriptor and removes only its own path", async t => {
  const f = await fixture(); let restore = false;
  try {
    const path = join(f.dir, "worker.lock"), originalOpen = fsPromises.open;
    let retained: FileHandle | undefined;
    t.mock.method(fsPromises, "open", async (...args: Parameters<typeof fsPromises.open>) => {
      const handle = await originalOpen(...args);
      if (args[0] === path && typeof args[1] === "number" && (args[1] & constants.O_EXCL)) {
        retained = handle;
        t.mock.method(handle, "sync", async () => { throw new Error(PRIVATE); });
      }
      return handle;
    });
    syncBuiltinESMExports(); restore = true;
    await assert.rejects(initializeThumbnailBudgetLedger(f.file), anonymous);
    assert.ok(retained); assert.equal(retained.fd, -1);
    assert.deepEqual(await readdir(f.dir), ["budget.json"]);
    t.mock.restoreAll(); syncBuiltinESMExports(); restore = false;
    await initializeThumbnailBudgetLedger(f.file);
  } finally {
    if (restore) { t.mock.restoreAll(); syncBuiltinESMExports(); }
    await cleanup(f);
  }
});

test("parallel reservations serialize and reject the excess request without exceeding durable request/body limits", async () => {
  const f = await fixture();
  try {
    await initializeThumbnailBudgetLedger(f.file); const guard = await openThumbnailBudgetAttempt(f.file, plan);
    const results = await Promise.allSettled([guard.reserveUpload(7), guard.reserveUpload(8), guard.reserveUpload(9)]);
    assert.deepEqual(results.map(x => x.status), ["fulfilled", "fulfilled", "rejected"]);
    assert.equal(guard.snapshot().totalUploadRequests, 2);
    assert.equal(guard.snapshot().totalUploadBodyBytes, 15);
    assert.equal((await disk(f.ledger)).totals.uploadRequests, 2);
    assert.equal(guard.signal.aborted, true);
    assert.notEqual(guard.signal.reason.name, "TimeoutError");
    await assert.rejects(guard.reserveOriginal(1), anonymous);
    await guard.close();
  } finally { await cleanup(f); }
});

test("per-attempt original/body limits reject before charging or permitting the side effect", async t => {
  for (const kind of ["original", "upload"] as const) await t.test(kind, async () => {
    const f = await fixture();
    try {
      await initializeThumbnailBudgetLedger(f.file); const g = await openThumbnailBudgetAttempt(f.file, plan);
      await assert.rejects(kind === "original" ? g.reserveOriginal(101) : g.reserveUpload(101), anonymous);
      assert.equal(g.snapshot().totalOriginalBytes, 0); assert.equal(g.snapshot().totalUploadRequests, 0);
      assert.equal(g.snapshot().totalUploadBodyBytes, 0); assert.equal(g.snapshot().totalParentAttempts, 2);
      await g.close();
    } finally { await cleanup(f); }
  });
});

test("cumulative parent attempts and reserved duration cannot be refunded by rerunning", async t => {
  for (const key of ["maxTotalParentAttempts", "maxTotalReservedDurationSeconds"] as const) await t.test(key, async () => {
    const b = budget(); b.limits[key] = key === "maxTotalParentAttempts" ? 2 : 5;
    const f = await fixture(b);
    try {
      await initializeThumbnailBudgetLedger(f.file); const first = await openThumbnailBudgetAttempt(f.file, plan); await first.close();
      const spent = await readFile(f.ledger);
      await assert.rejects(openThumbnailBudgetAttempt(f.file, plan), anonymous);
      assert.deepEqual(await readFile(f.ledger), spent);
      assert.deepEqual((await readdir(f.dir)).sort(), ["budget.json", "thumbnail-execution-ledger.json"]);
    } finally { await cleanup(f); }
  });
});

test("cumulative originals, request count and body bytes are enforced across attempts", async t => {
  for (const key of ["maxTotalOriginalBytes", "maxTotalUploadRequests", "maxTotalUploadBodyBytes"] as const) await t.test(key, async () => {
    const b = budget(); b.limits[key] = key === "maxTotalUploadRequests" ? 1 : 9;
    const f = await fixture(b);
    try {
      await initializeThumbnailBudgetLedger(f.file);
      const first = await openThumbnailBudgetAttempt(f.file, plan);
      await (key === "maxTotalOriginalBytes" ? first.reserveOriginal(8) : first.reserveUpload(8)); await first.close();
      const second = await openThumbnailBudgetAttempt(f.file, plan);
      await assert.rejects(key === "maxTotalOriginalBytes" ? second.reserveOriginal(2) : second.reserveUpload(2), anonymous);
      assert.equal(second.snapshot().totalOriginalBytes, key === "maxTotalOriginalBytes" ? 8 : 0);
      assert.equal(second.snapshot().totalUploadRequests, key === "maxTotalOriginalBytes" ? 0 : 1);
      assert.equal(second.snapshot().totalUploadBodyBytes, key === "maxTotalOriginalBytes" ? 0 : 8);
      await second.close();
    } finally { await cleanup(f); }
  });
});

test("plan whitelist, run, version and the complete budget digest must match the initialized ledger", async t => {
  const cases: [string, (b: ThumbnailExecutionBudget) => void, ThumbnailPlan][] = [
    ["unknown-plan", () => {}, { ...plan, assetIds: [plan.assetIds[0]] }],
    ["wrong-run", () => {}, { ...plan, runId: BUDGET }], ["wrong-version", () => {}, { ...plan, version: "v1" }],
    ["changed-budget", b => { b.limits.maxOriginalBytes++; }, plan],
  ];
  for (const [name, mutate, selected] of cases) await t.test(name, async () => {
    const f = await fixture();
    try {
      await initializeThumbnailBudgetLedger(f.file); const unchanged = await readFile(f.ledger);
      const b = budget(); mutate(b); await writeFile(f.file, JSON.stringify(b));
      await assert.rejects(openThumbnailBudgetAttempt(f.file, selected), anonymous);
      assert.deepEqual(await readFile(f.ledger), unchanged);
    } finally { await cleanup(f); }
  });
});

test("corrupt or legacy ledgers never become zero or acquire a new binding", async t => {
  const mutations: [string, (v: Record<string, unknown>) => void][] = [
    ["unknown-fields", v => { v.secret = PRIVATE; }], ["legacy", v => { v.format = "six-post-private-ledger"; }],
    ["budget-binding", v => { v.budgetSHA256 = "0".repeat(64); }], ["run-binding", v => { v.runId = BUDGET; }],
    ["sum-mismatch", v => { (v.totals as Record<string, unknown>).originalBytes = 1; }],
    ["negative", v => { (v.totals as Record<string, unknown>).uploadRequests = -1; }],
    ["invalid-attempt", v => { const a = (v.attempts as Record<string, unknown>[])[0]; a.reservedDurationSeconds = 0; }],
    ["unknown-plan-hash", v => { (v.attempts as Record<string, unknown>[])[0].planSHA256 = "0".repeat(64); }],
    ["impossible-upload-count", v => {
      (v.attempts as Record<string, unknown>[])[0].uploadBodyBytes = 1;
      (v.totals as Record<string, unknown>).uploadBodyBytes = 1;
    }],
    ["duplicate-attempt", v => { const a = v.attempts as unknown[]; a.push(structuredClone(a[0])); }],
  ];
  for (const [name, mutate] of mutations) await t.test(name, async () => {
    const f = await fixture();
    try {
      await initializeThumbnailBudgetLedger(f.file); const first = await openThumbnailBudgetAttempt(f.file, plan); await first.close();
      await edit(f.ledger, mutate); const bad = await readFile(f.ledger);
      await assert.rejects(openThumbnailBudgetAttempt(f.file, plan), anonymous);
      await assert.rejects(initializeThumbnailBudgetLedger(f.file), anonymous);
      assert.deepEqual(await readFile(f.ledger), bad);
    } finally { await cleanup(f); }
  });
});

test("private canonical directories and 600 regular non-aliased input files are mandatory", async t => {
  for (const name of ["budget-mode", "ledger-mode", "directory-mode", "budget-symlink", "ledger-symlink", "hardlink", "ancestor-symlink", "path-alias", "budget-size", "ledger-size"] as const) await t.test(name, async () => {
    const f = await fixture();
    try {
      await initializeThumbnailBudgetLedger(f.file); let file = f.file;
      if (name === "budget-mode") await chmod(f.file, 0o644);
      if (name === "ledger-mode") await chmod(f.ledger, 0o644);
      if (name === "directory-mode") await chmod(f.dir, 0o755);
      if (name === "budget-symlink" || name === "ledger-symlink") {
        const path = name === "budget-symlink" ? f.file : f.ledger;
        await fsPromises.rename(path, path + ".original"); await symlink(path + ".original", path);
      }
      if (name === "hardlink") await link(f.file, join(f.dir, "alias.json"));
      if (name === "ancestor-symlink") { await symlink(f.dir, join(f.dir, "alias")); file = join(f.dir, "alias", "budget.json"); }
      if (name === "path-alias") file = f.dir + "/../" + f.dir.split("/").at(-1) + "/budget.json";
      if (name === "budget-size") await truncate(f.file, 2 * 1024 * 1024 + 1);
      if (name === "ledger-size") await truncate(f.ledger, 32 * 1024 * 1024 + 1);
      await assert.rejects(openThumbnailBudgetAttempt(file, plan), anonymous);
    } finally { await cleanup(f); }
  });
});

test("atomic persistence failure blocks the side effect, keeps previous charges and cleans only its temporary file", async t => {
  const f = await fixture(); let restore = false;
  try {
    await initializeThumbnailBudgetLedger(f.file); const guard = await openThumbnailBudgetAttempt(f.file, plan);
    const before = await readFile(f.ledger); let sideEffects = 0;
    t.mock.method(fsPromises, "rename", async () => { throw new Error(PRIVATE + f.dir); });
    syncBuiltinESMExports(); restore = true;
    await assert.rejects(async () => { await guard.reserveUpload(1); sideEffects++; }, anonymous);
    assert.equal(sideEffects, 0); assert.equal(guard.signal.aborted, true);
    assert.notEqual(guard.signal.reason.name, "TimeoutError");
    assert.deepEqual(await readFile(f.ledger), before);
    assert.equal(guard.snapshot().totalParentAttempts, 2); assert.equal(guard.snapshot().totalUploadRequests, 0);
    t.mock.restoreAll(); syncBuiltinESMExports(); restore = false;
    await guard.close();
    assert.deepEqual((await readdir(f.dir)).sort(), ["budget.json", "thumbnail-execution-ledger.json"]);
    const reopened = await openThumbnailBudgetAttempt(f.file, plan);
    assert.equal(reopened.snapshot().totalParentAttempts, 4); await reopened.close();
  } finally { if (restore) { t.mock.restoreAll(); syncBuiltinESMExports(); } await cleanup(f); }
});

test("editing an open budget or ledger cannot reset counters and the guard becomes unusable", async t => {
  for (const name of ["budget", "ledger"] as const) await t.test(name, async () => {
    const f = await fixture();
    try {
      await initializeThumbnailBudgetLedger(f.file); const g = await openThumbnailBudgetAttempt(f.file, plan);
      if (name === "budget") await edit(f.file, v => { (v.limits as Record<string, number>).maxUploadRequests++; });
      else await writeFile(f.ledger, JSON.stringify({ private: PRIVATE }));
      await assert.rejects(g.reserveUpload(1), anonymous); assert.equal(g.signal.aborted, true);
      assert.throws(g.check, anonymous); await g.close();
    } finally { await cleanup(f); }
  });
});

test("file and directory fsync faults deny permission and preserve the appropriate durable charge across reopen", async t => {
  for (const stage of ["temporary-file", "after-rename-directory"] as const) await t.test(stage, async child => {
    const f = await fixture(); let restore = false;
    try {
      await initializeThumbnailBudgetLedger(f.file); const g = await openThumbnailBudgetAttempt(f.file, plan);
      const originalOpen = fsPromises.open; let faults = 0, sideEffects = 0;
      child.mock.method(fsPromises, "open", async (...args: Parameters<typeof fsPromises.open>) => {
        const handle = await originalOpen(...args);
        const path = String(args[0]);
        if ((stage === "temporary-file" && path.startsWith(join(f.dir, ".thumbnail-budget-"))) ||
            (stage === "after-rename-directory" && path === f.dir)) {
          child.mock.method(handle, "sync", async () => { faults++; throw new Error(PRIVATE); });
        }
        return handle;
      });
      syncBuiltinESMExports(); restore = true;
      await assert.rejects(async () => { await g.reserveOriginal(10); sideEffects++; }, anonymous);
      assert.equal(faults, 1); assert.equal(sideEffects, 0);
      assert.equal(g.signal.aborted, true); assert.notEqual(g.signal.reason.name, "TimeoutError");
      const expected = stage === "temporary-file" ? 0 : 10;
      assert.equal((await disk(f.ledger)).totals.originalBytes, expected);
      child.mock.restoreAll(); syncBuiltinESMExports(); restore = false;
      await g.close();
      assert.deepEqual((await readdir(f.dir)).sort(), ["budget.json", "thumbnail-execution-ledger.json"]);
      const next = await openThumbnailBudgetAttempt(f.file, plan);
      assert.equal(next.snapshot().totalOriginalBytes, expected);
      assert.equal(next.snapshot().totalParentAttempts, 4);
      await next.close();
    } finally {
      if (restore) { child.mock.restoreAll(); syncBuiltinESMExports(); }
      await cleanup(f);
    }
  });
});

test("the real deadline aborts with TimeoutError without refunding the attempt or charging a late request", async () => {
  const b = budget(); b.limits.maxDurationSeconds = 1; const f = await fixture(b);
  try {
    await initializeThumbnailBudgetLedger(f.file); const g = await openThumbnailBudgetAttempt(f.file, plan);
    await delay(1100);
    assert.equal(g.signal.aborted, true); assert.equal(g.signal.reason.name, "TimeoutError");
    assert.equal(g.deadlineSignal.aborted, true); assert.equal(g.deadlineSignal.reason.name, "TimeoutError");
    assert.equal(g.signal.reason.message, "Thumbnail execution deadline exceeded.");
    assert.throws(g.check, anonymous); await assert.rejects(g.reserveUpload(1), anonymous);
    assert.equal((await disk(f.ledger)).totals.reservedDurationSeconds, 1);
    assert.equal((await disk(f.ledger)).totals.uploadRequests, 0); await g.close();
  } finally { await cleanup(f); }
});

test("monotonic check catches elapsed time even while the timer callback could not run", async () => {
  const b = budget(); b.limits.maxDurationSeconds = 1; const f = await fixture(b);
  try {
    await initializeThumbnailBudgetLedger(f.file); const g = await openThumbnailBudgetAttempt(f.file, plan);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100);
    assert.equal(g.signal.aborted, false);
    assert.throws(g.check, anonymous); assert.equal(g.signal.reason.name, "TimeoutError");
    assert.equal(g.deadlineSignal.reason.name, "TimeoutError");
    await g.close();
  } finally { await cleanup(f); }
});

test("an ordinary reservation failure cannot suppress the independent deadline during cleanup", async () => {
  const b = budget(); b.limits.maxDurationSeconds = 1; const f = await fixture(b);
  try {
    await initializeThumbnailBudgetLedger(f.file); const g = await openThumbnailBudgetAttempt(f.file, plan);
    await assert.rejects(g.reserveUpload(101), anonymous);
    assert.equal(g.signal.aborted, true); assert.notEqual(g.signal.reason.name, "TimeoutError");
    assert.equal(g.deadlineSignal.aborted, false);
    await delay(1100);
    assert.equal(g.deadlineSignal.aborted, true); assert.equal(g.deadlineSignal.reason.name, "TimeoutError");
    assert.notEqual(g.signal.reason.name, "TimeoutError");
    assert.throws(g.check, anonymous); assert.equal((await disk(f.ledger)).totals.uploadRequests, 0);
    await g.close();
  } finally { await cleanup(f); }
});

test("the independent deadline remains active until an asynchronous lock release settles", async t => {
  const b = budget(); b.limits.maxDurationSeconds = 1; const f = await fixture(b);
  let unblock: (() => void) | undefined, closing: Promise<void> | undefined, restore = false;
  try {
    await initializeThumbnailBudgetLedger(f.file); const g = await openThumbnailBudgetAttempt(f.file, plan);
    const original = fsPromises.unlink;
    const blocked = new Promise<void>(resolve => { unblock = resolve; });
    t.mock.method(fsPromises, "unlink", async (path: Parameters<typeof unlink>[0]) => {
      if (path === join(f.dir, "worker.lock")) await blocked;
      return original(path);
    });
    syncBuiltinESMExports(); restore = true;
    closing = g.close();
    assert.throws(g.check, anonymous);
    await delay(1100);
    assert.equal(g.deadlineSignal.aborted, true); assert.equal(g.deadlineSignal.reason.name, "TimeoutError");
    assert.notEqual(g.signal.reason.name, "TimeoutError");
    assert.ok(unblock); unblock(); await closing;
  } finally {
    unblock?.(); await closing;
    if (restore) { t.mock.restoreAll(); syncBuiltinESMExports(); }
    await cleanup(f);
  }
});

test("a synchronous lock-release stall cannot clear an elapsed deadline before its timer callback runs", async t => {
  const b = budget(); b.limits.maxDurationSeconds = 1; const f = await fixture(b);
  let restore = false;
  try {
    await initializeThumbnailBudgetLedger(f.file); const g = await openThumbnailBudgetAttempt(f.file, plan);
    const original = fsPromises.unlink;
    t.mock.method(fsPromises, "unlink", async (path: Parameters<typeof unlink>[0]) => {
      if (path === join(f.dir, "worker.lock")) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200);
        unlinkSync(path);
        return;
      }
      return original(path);
    });
    syncBuiltinESMExports(); restore = true;
    await g.close();
    assert.equal(g.deadlineSignal.aborted, true);
    assert.equal(g.deadlineSignal.reason.name, "TimeoutError");
    assert.notEqual(g.signal.reason.name, "TimeoutError");
  } finally {
    if (restore) { t.mock.restoreAll(); syncBuiltinESMExports(); }
    await cleanup(f);
  }
});
