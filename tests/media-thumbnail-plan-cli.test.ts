import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fsPromises } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import type { Album, ImageAsset } from "../contracts/content.ts";
import type { StoredMedia } from "../contracts/sync.ts";
import type { PublicContentSnapshot } from "../contracts/website.ts";
import { WEBSITE_SCHEMA_DIGEST } from "../contracts/website-sync.ts";
import { thumbnailPlanCommand } from "../scripts/media-thumbnails/plan-cli.ts";
import { parseThumbnailPlan } from "../scripts/media-thumbnails/plan.ts";
import { parseThumbnailWidthSelection } from "../scripts/media-thumbnails/widths.ts";
import { mediaIdentity } from "../src/server/database/validation.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "scripts/media-thumbnails/plan-cli.ts");
const RUN = "00000000-0000-4000-8000-000000000001";
const OWNER = "00000000000000000000000000000010";
const PRIVATE_TEXT = "PRIVATE_FIXTURE_CONTENT_MUST_NOT_APPEAR";
const limits = { maxParents: 3, maxOriginalBytes: 67108864, maxUploadRequests: 6,
  maxUploadBodyBytes: 2097152, maxDurationSeconds: 480, maxTotalParents: 15,
  maxTotalOriginalBytes: 134217728, maxTotalUploadBodyBytes: 10485760,
  maxTotalDurationSeconds: 2400, eligibilityReserveSeconds: 120 };
const options = { enabledKinds: ["album"], limits };
const controlled = (error: unknown) => error instanceof Error && "code" in error &&
  error.code === "MISCONFIGURED" && error.message === "Thumbnail coverage planning failed. Check private inputs, qualification and the output directory.";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

function fixture() {
  const sha = "a".repeat(64), assetId = mediaIdentity(OWNER, "cover", sha);
  const image: ImageAsset = { id: assetId, src: `/media/v2/${assetId}`, alt: PRIVATE_TEXT, width: 1200, height: 900 };
  const item: Album = { id: OWNER, kind: "album", slug: "synthetic-private-album", href: "/photos/synthetic-private-album",
    title: PRIVATE_TEXT, summary: null, tags: [], cover: image, updatedAt: null, date: null, photoCount: 0 };
  const snapshot: PublicContentSnapshot = { version: `${RUN}:1`, records: [{ item,
    document: { blocks: [], toc: [], completeness: "complete" } }] };
  const media: StoredMedia = { assetId, ownerPageId: OWNER, objectKey: `sha256/${sha}`, sha256: sha,
    byteSize: 2048, mime: "image/png", width: 1200, height: 900 };
  const binding = { assetId, ownerPageId: OWNER, sha256: sha, locator: { kind: "cover" }, delivery: "notion", sourceFingerprint: "b".repeat(64) };
  const inventory = { format: "notionblog-thumbnail-inventory-v1", version: "v2", runId: RUN,
    snapshotVersion: snapshot.version, qualifiedAt: new Date(Date.now() - 1000).toISOString(),
    validUntil: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
    cells: ([400, 800] as const).map(widthCap => ({ assetId, widthCap, result: {
      thumbnailCapability: "notionblog-thumbnail-index-v1", schemaDigest: WEBSITE_SCHEMA_DIGEST,
      version: "v2", runId: RUN, source: { media, binding }, thumbnail: null,
    } })) };
  return { snapshot, inventory, assetId };
}
async function inputs() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "nb-thumbnail-plan-cli-")));
  await chmod(base, 0o700);
  const data = fixture(), paths = { snapshot: join(base, "snapshot.json"), inventory: join(base, "inventory.json"),
    options: join(base, "options.json"), output: join(base, "proposals") };
  for (const [name, value] of [["snapshot", data.snapshot], ["inventory", data.inventory], ["options", options]] as const) {
    await writeFile(paths[name], JSON.stringify(value), { mode: 0o600 });
  }
  return { base, data, paths, args: ["--snapshot", paths.snapshot, "--inventory", paths.inventory,
    "--options", paths.options, "--output-dir", paths.output] };
}
async function run(args: string[]) {
  try {
    const result = await promisify(execFile)(process.execPath, [CLI, ...args], { cwd: ROOT, env: { NODE_ENV: "test" }, timeout: 30000, maxBuffer: 65536 });
    return { status: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as Error & { code: number; stdout: string; stderr: string };
    return { status: failure.code, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}
function failedWithoutPrivateOutput(result: Awaited<ReturnType<typeof run>>, base: string) {
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.deepEqual(JSON.parse(result.stderr), { status: "FAILED", error: "Thumbnail coverage planning failed. No execution was attempted." });
  for (const forbidden of [PRIVATE_TEXT, OWNER, RUN, base, "a1."]) assert.ok(!result.stderr.includes(forbidden));
}

test("real offline CLI writes complete private proposals, exact plans and enforced-budget requirements", async () => {
  const { base, data, paths, args } = await inputs();
  try {
    const result = await run(args);
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, "");
    const stdout = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(stdout).sort(), ["status", "summary"]);
    assert.equal(stdout.status, "PLANNING_ONLY");
    assert.ok(Object.values(stdout.summary).every(value => typeof value === "number" && Number.isSafeInteger(value) && value >= 0));
    for (const forbidden of [PRIVATE_TEXT, OWNER, RUN, base, data.assetId]) assert.ok(!result.stdout.includes(forbidden));
    assert.equal((await lstat(paths.output)).mode & 0o777, 0o700);
    const names = (await readdir(paths.output)).sort();
    assert.deepEqual(names, ["batch-0001-budget.json", "batch-0001-plan.json", "batch-0001-widths.json", "coverage-complete.json", "coverage-report.json"]);
    for (const name of names) assert.equal((await lstat(join(paths.output, name))).mode & 0o777, 0o600);
    const plan = parseThumbnailPlan(JSON.parse(await readFile(join(paths.output, "batch-0001-plan.json"), "utf8")));
    assert.deepEqual(plan, { version: "v2", runId: RUN, assetIds: [data.assetId] });
    const widths=parseThumbnailWidthSelection(JSON.parse(await readFile(join(paths.output,"batch-0001-widths.json"),"utf8")),plan);
    assert.deepEqual(widths.assets,[{assetId:data.assetId,widthCaps:[400,800]}]);
    const budget = JSON.parse(await readFile(join(paths.output, "batch-0001-budget.json"), "utf8"));
    assert.deepEqual(budget, { maxParents: limits.maxParents, maxOriginalBytes: limits.maxOriginalBytes,
      maxUploadRequests: limits.maxUploadRequests, maxUploadBodyBytes: limits.maxUploadBodyBytes,
      maxDurationSeconds: limits.maxDurationSeconds, requiresRuntimeBudgetGuard: true, requiresRequalification: true, requiresWidthSelection:true });
    const report = JSON.parse(await readFile(join(paths.output, "coverage-report.json"), "utf8"));
    assert.equal(report.status, "PLANNING_ONLY"); assert.deepEqual(report.summary, stdout.summary); assert.equal(report.batches.length, 1);
    const marker = JSON.parse(await readFile(join(paths.output, "coverage-complete.json"), "utf8"));
    assert.equal(marker.status, "PLANNING_ONLY"); assert.equal(marker.proposalsOnly, true); assert.equal(marker.executionAuthorized, false);
    assert.equal(marker.batchCount, 1); assert.equal(marker.files.length, 4);
    for (const file of marker.files) assert.equal(file.sha256, hash(await readFile(join(paths.output, file.file), "utf8")));
    for (const name of ["snapshot", "inventory", "options"] as const) assert.equal(marker.inputSHA256[name], hash(await readFile(paths[name], "utf8")));
    assert.equal((await readdir(base)).some(name => name.startsWith(".thumbnail-coverage-")), false);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("CLI refuses existing proposals and leaves unrelated contents unchanged", async () => {
  const { base, paths, args } = await inputs();
  try {
    await mkdir(paths.output, { mode: 0o700 }); await writeFile(join(paths.output, "unrelated.json"), PRIVATE_TEXT, { mode: 0o600 });
    failedWithoutPrivateOutput(await run(args), base);
    assert.deepEqual(await readdir(paths.output), ["unrelated.json"]);
    assert.equal(await readFile(join(paths.output, "unrelated.json"), "utf8"), PRIVATE_TEXT);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("CLI may atomically populate an existing empty private output directory", async () => {
  const { base, paths, args } = await inputs();
  try {
    await mkdir(paths.output, { mode: 0o700 }); const previous = await lstat(paths.output);
    const result = await run(args); assert.equal(result.status, 0, result.stderr);
    assert.notEqual((await lstat(paths.output)).ino, previous.ino);
    assert.ok((await readdir(paths.output)).includes("coverage-complete.json"));
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("expired, unknown-shape and unmatched inventory fail without creating proposals", async t => {
  for (const mode of ["expired", "snapshot-shape", "inventory-shape", "unmatched", "bad-options", "bad-limit"] as const) await t.test(mode, async () => {
    const { base, data, paths, args } = await inputs();
    try {
      if (mode === "expired") { data.inventory.validUntil = new Date(Date.now() - 1000).toISOString(); await writeFile(paths.inventory, JSON.stringify(data.inventory)); }
      if (mode === "snapshot-shape") await writeFile(paths.snapshot, JSON.stringify({ private: PRIVATE_TEXT }));
      if (mode === "inventory-shape") await writeFile(paths.inventory, JSON.stringify({ ...data.inventory, unsupported: PRIVATE_TEXT }));
      if (mode === "unmatched") { data.inventory.cells[0]!.result.source.media.assetId = `a1.${"0".repeat(64)}`; await writeFile(paths.inventory, JSON.stringify(data.inventory)); }
      if (mode === "bad-options") await writeFile(paths.options, JSON.stringify({ ...options, unsupported: PRIVATE_TEXT }));
      if (mode === "bad-limit") await writeFile(paths.options, JSON.stringify({ ...options, limits: { ...limits, maxOriginalBytes: 1024 * 1024 * 1024 + 1 } }));
      failedWithoutPrivateOutput(await run(args), base);
      await assert.rejects(lstat(paths.output), { code: "ENOENT" });
      assert.equal((await readdir(base)).some(name => name.startsWith(".thumbnail-coverage-")), false);
    } finally { await rm(base, { recursive: true, force: true }); }
  });
});

test("non-private input, symlinks and aliased directories are refused", async t => {
  for (const mode of ["permissions", "leaf-link", "dangling-link", "ancestor-link", "output-link", "parent-permissions", "relative"] as const) await t.test(mode, async () => {
    const { base, paths, args } = await inputs();
    try {
      if (mode === "permissions") await chmod(paths.snapshot, 0o644);
      if (mode === "leaf-link" || mode === "dangling-link") {
        const link = join(base, "snapshot-link.json"); await symlink(mode === "leaf-link" ? paths.snapshot : join(base, "absent"), link); args[1] = link;
      }
      if (mode === "ancestor-link") { const alias = join(base, "alias"); await symlink(base, alias); args[1] = join(alias, "snapshot.json"); }
      if (mode === "output-link") { await mkdir(join(base, "foreign"), { mode: 0o700 }); await symlink(join(base, "foreign"), paths.output); }
      if (mode === "parent-permissions") await chmod(base, 0o755);
      if (mode === "relative") args[1] = "private-relative-snapshot.json";
      failedWithoutPrivateOutput(await run(args), base);
      if (mode === "output-link") assert.deepEqual(await readdir(join(base, "foreign")), []);
      else await assert.rejects(lstat(paths.output), { code: "ENOENT" });
    } finally { await chmod(base, 0o700); await rm(base, { recursive: true, force: true }); }
  });
});

test("snapshot, inventory and options read bounds are checked before parsing", async t => {
  for (const name of ["snapshot", "inventory", "options"] as const) await t.test(name, async () => {
    const { base, paths, args } = await inputs();
    try {
      const file = await open(paths[name], "r+");
      try { await file.truncate((name === "options" ? 2 : 32) * 1024 * 1024 + 1); } finally { await file.close(); }
      failedWithoutPrivateOutput(await run(args), base);
      await assert.rejects(lstat(paths.output), { code: "ENOENT" });
    } finally { await rm(base, { recursive: true, force: true }); }
  });
});

test("CLI rejects extra modes and duplicate options rather than accepting alternate execution inputs", async t => {
  for (const tail of [["--execute"], ["--env", "private-password"], ["--snapshot", "other-snapshot"]]) await t.test(tail[0]!, async () => {
    const { base, paths, args } = await inputs();
    try {
      failedWithoutPrivateOutput(await run([...args, ...tail]), base);
      await assert.rejects(lstat(paths.output), { code: "ENOENT" });
    } finally { await rm(base, { recursive: true, force: true }); }
  });
});

test("failed atomic installation cleans staging and never leaves a completion marker", async t => {
  const { base, paths, args } = await inputs();
  try {
    const failure = t.mock.method(fsPromises, "rename", async () => { throw new Error(PRIVATE_TEXT); });
    syncBuiltinESMExports();
    try { await assert.rejects(thumbnailPlanCommand(args), controlled); }
    finally { failure.mock.restore(); syncBuiltinESMExports(); }
    await assert.rejects(lstat(paths.output), { code: "ENOENT" });
    assert.equal((await readdir(base)).some(name => name.startsWith(".thumbnail-coverage-")), false);
    assert.deepEqual((await readdir(base)).sort(), ["inventory.json", "options.json", "snapshot.json"]);
  } finally { await rm(base, { recursive: true, force: true }); }
});
