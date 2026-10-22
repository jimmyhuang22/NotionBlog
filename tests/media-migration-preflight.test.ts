import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, link, lstat, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";
import { mediaMigrationCommand } from "../scripts/media-migration/cli.ts";
import { MigrationPlanError, planMediaMigration, type MigrationInventory } from "../scripts/media-migration/plan.ts";

const digest = (n: number) => n.toString(16).padStart(64, "0");
function inventory(): MigrationInventory {
  return { format: "media-migration-inventory-v1", assets: [
    { sourceKey: "old/retired.jpg", reference: "current", original: { sha256: digest(1), byteSize: 100 }, candidate: { sha256: digest(11), byteSize: 60 } },
    { sourceKey: "shared/body.png", reference: "unreviewed", original: { sha256: digest(2), byteSize: 200 }, candidate: { sha256: digest(12), byteSize: 100 } },
    { sourceKey: "duplicate.png", reference: "historical", original: { sha256: digest(2), byteSize: 200 }, candidate: { sha256: digest(12), byteSize: 100 } },
    { sourceKey: "current.jpg", reference: "current", original: { sha256: digest(3), byteSize: 300 }, candidate: { sha256: digest(3), byteSize: 300 } },
  ], retiredSourceKeys: ["old/retired.jpg"], protectedSourceKeys: ["shared/body.png"],
  limits: { storageAvailableBytes: null, transferBudgetBytes: null } };
}
test("retired legacy keys are excluded while protected and unreviewed assets survive", () => {
  const p = planMediaMigration(inventory());
  assert.equal(p.executionAuthorized, false); assert.equal(p.publicationScopeVerified, false);
  assert.equal(p.evidence, "metadata-only");
  assert.deepEqual(p.summary, { inventoryAssets: 4, retainedAssets: 3, excludedRetiredAssets: 1,
    retiredKeysNotInInventory: 0, protectedAssets: 1, currentReferenceAssets: 1, historicalReferenceAssets: 1, unreviewedAssets: 1 });
  assert.equal(p.retained.find(a => a.sourceKey === "shared/body.png")?.protected, true);
  assert.equal(JSON.stringify(p).includes("old/retired.jpg"), false);
  assert.equal(p.original.objects.some(o => o.sha256 === digest(1)), false);
});
test("content digests deduplicate independently for originals and compression candidates", () => {
  const p = planMediaMigration(inventory());
  assert.equal(p.original.summary.referencedBytes, 700);
  assert.equal(p.original.summary.uniqueBytes, 500);
  assert.equal(p.original.summary.onePassUploadAndReadBytes, 1000);
  assert.equal(p.candidate.summary.uniqueBytes, 400);
  assert.deepEqual(p.original.objects.find(o => o.sha256 === digest(2))?.sourceKeys, ["duplicate.png", "shared/body.png"]);
  const reversed = inventory(); reversed.assets.reverse();
  assert.deepEqual(planMediaMigration(reversed), p);
});
test("unknown limits stay unknown and zero/finite limits never grant execution", () => {
  assert.equal(planMediaMigration(inventory()).original.summary.fitsStorage, null);
  const i = inventory(); i.limits = { storageAvailableBytes: 450, transferBudgetBytes: 850 };
  const p = planMediaMigration(i);
  assert.equal(p.original.summary.fitsStorage, false); assert.equal(p.original.summary.fitsOnePassTransfer, false);
  assert.equal(p.candidate.summary.fitsStorage, true); assert.equal(p.candidate.summary.fitsOnePassTransfer, true);
  i.limits = { storageAvailableBytes: 0, transferBudgetBytes: 0 };
  assert.equal(planMediaMigration(i).candidate.summary.fitsStorage, false);
});
test("protected omissions, conflicting retirements and inconsistent metadata fail closed", () => {
  const mutations: Array<(i: MigrationInventory) => void> = [
    i => i.retiredSourceKeys.push("shared/body.png"),
    i => { i.assets = i.assets.filter(a => a.sourceKey !== "shared/body.png"); },
    i => i.assets.push(structuredClone(i.assets[0])),
    i => { i.assets[2].original.byteSize++; },
    i => { i.assets[0].candidate.byteSize = 101; },
    i => { i.assets[0].original.sha256 = "INVALID"; },
    i => { i.limits.transferBudgetBytes = Number.MAX_SAFE_INTEGER + 1; },
    i => i.retiredSourceKeys.push(i.retiredSourceKeys[0]),
  ];
  for (const mutate of mutations) { const i = inventory(); mutate(i); assert.throws(() => planMediaMigration(i), MigrationPlanError); }
  assert.throws(() => planMediaMigration({ ...inventory(), executionAuthorized: true }), MigrationPlanError);
});
test("oversized originals are reported rather than masquerading as runtime-compatible", () => {
  const i = inventory(); i.assets[3].original.byteSize = 20 * 1024 * 1024 + 1;
  i.assets[3].candidate.sha256 = digest(13);
  const p = planMediaMigration(i);
  assert.equal(p.original.summary.overRuntimeImageLimit, 1); assert.equal(p.candidate.summary.overRuntimeImageLimit, 0);
});

const CLI = join(dirname(dirname(fileURLToPath(import.meta.url))), "scripts/media-migration/cli.ts");
async function setup(t: TestContext) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "migration-plan-"))); await chmod(dir, 0o700);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const input = join(dir, "private-inventory.json"), output = join(dir, "private-plan.json");
  await writeFile(input, JSON.stringify(inventory()), { mode: 0o600 });
  return { dir, input, output, args: ["--inventory", input, "--output", output] };
}
test("private CLI persists a metadata proposal once and returns only anonymous aggregates", async t => {
  const s = await setup(t), result = await mediaMigrationCommand(s.args);
  assert.equal(result?.status, "PLANNING_ONLY");
  assert.equal(JSON.stringify(result).includes("shared/body.png"), false);
  const p = JSON.parse(await readFile(s.output, "utf8"));
  assert.match(p.inputSHA256, /^[a-f0-9]{64}$/);
  assert.equal(p.executionAuthorized, false);
  assert.equal((await lstat(s.output)).mode & 0o777, 0o600);
  assert.equal((await lstat(s.output)).nlink, 1);
  const original = await readFile(s.output);
  await assert.rejects(mediaMigrationCommand(s.args), MigrationPlanError);
  assert.deepEqual(await readFile(s.output), original);
  assert.deepEqual((await readdir(s.dir)).sort(), ["private-inventory.json", "private-plan.json"]);
});
test("private CLI rejects public, linked or oversized inputs without leaving a plan", async t => {
  const s = await setup(t);
  await chmod(s.input, 0o644); await assert.rejects(mediaMigrationCommand(s.args), MigrationPlanError);
  await chmod(s.input, 0o600);
  const linked = join(s.dir, "linked.json"); await symlink(s.input, linked);
  await assert.rejects(mediaMigrationCommand(["--inventory", linked, "--output", s.output]), MigrationPlanError);
  const hard = join(s.dir, "hard.json"); await link(s.input, hard);
  await assert.rejects(mediaMigrationCommand(s.args), MigrationPlanError); await rm(hard);
  await writeFile(s.input, Buffer.alloc(16 * 1024 * 1024 + 1));
  await assert.rejects(mediaMigrationCommand(s.args), MigrationPlanError);
  assert.equal((await readdir(s.dir)).includes("private-plan.json"), false);
});
test("output symlinks, input aliases and duplicate arguments cannot overwrite data", async t => {
  const s = await setup(t), before = await readFile(s.input);
  await symlink(s.input, s.output);
  await assert.rejects(mediaMigrationCommand(s.args), MigrationPlanError);
  await assert.rejects(mediaMigrationCommand(["--inventory", s.input, "--output", s.input]), MigrationPlanError);
  await assert.rejects(mediaMigrationCommand([...s.args, "--inventory", s.input]), MigrationPlanError);
  assert.deepEqual(await readFile(s.input), before);
  await chmod(s.dir, 0o755); await assert.rejects(mediaMigrationCommand(s.args), MigrationPlanError);
});
test("process errors expose no private keys, paths or malformed input", async t => {
  const s = await setup(t); await writeFile(s.input, "SECRET_PRIVATE_VALUE");
  try { await promisify(execFile)(process.execPath, [CLI, ...s.args]); assert.fail("must fail"); }
  catch (e) {
    const r = e as { stdout: string; stderr: string };
    assert.equal(r.stdout, "");
    assert.deepEqual(JSON.parse(r.stderr), { status: "FAILED", errorCode: "MEDIA_MIGRATION_INPUT_INVALID" });
  }
});
