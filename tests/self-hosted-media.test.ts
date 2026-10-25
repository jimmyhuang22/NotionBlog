import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile, readFile, chmod, rename, symlink, readdir, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import sharp from "sharp";
import { mediaIdentity } from "../src/server/database/validation.ts";
import { type ThumbnailProjection } from "../src/server/database/thumbnail-index.ts";
import { WEBSITE_SCHEMA_DIGEST } from "../contracts/website-sync.ts";
import { buildDisplayBundle, prepareDisplayAsset } from "../scripts/self-hosted-media/bundle.ts";
import { createDisplayStore, verifyDisplayBytes } from "../src/server/self-hosted-media/files.ts";
import { displayMediaResponse, displayWidth } from "../src/server/self-hosted-media/response.ts";
import { validateDisplayManifest, selectDisplayFile } from "../src/server/self-hosted-media/manifest.ts";
import { displayProjectionSql } from "../src/server/self-hosted-media/projection.ts";
import { selfHostedDisplayStore } from "../src/server/self-hosted-media/runtime.ts";
import { generateDisplayVariants } from "../scripts/self-hosted-media/encode.ts";
import { cleanEnvironment } from "../scripts/development/clean-environment.mjs";

const hash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
async function source(width = 1000, height = 700, transparent = false) {
  const bytes = await sharp({ create: { width, height, channels: transparent ? 4 : 3, background: transparent ? { r: 20, g: 80, b: 190, alpha: 0.3 } : "#d0dff0" } }).png().toBuffer();
  const sha = hash(bytes), owner = "display-fixture-page", assetId = mediaIdentity(owner, "cover", sha);
  const projection: ThumbnailProjection = { version: "v2", runId: randomUUID(), thumbnail: null, source: {
    media: { assetId, ownerPageId: owner, objectKey: "sha256/" + sha, sha256: sha, mime: "image/png", byteSize: bytes.length, width, height },
    binding: { assetId, ownerPageId: owner, sha256: sha, locator: { kind: "cover" }, delivery: "notion", sourceFingerprint: "a".repeat(64) },
  } };
  return { source: projection, bytes };
}
async function fixture(width = 1000, height = 700, transparent = false) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "display-fixture-"))), item = await source(width, height, transparent);
  const root = join(parent, "store"), manifest = await buildDisplayBundle(root, item.source.runId, [item]);
  const store = createDisplayStore(root);
  return { ...item, parent, root, manifest, store, close: () => rm(parent, { recursive: true, force: true }) };
}

test("display bundle keeps a native-size maximum when the legacy1600 is absent, without copying the original", async () => {
  const f = await fixture();
  try {
    const asset = f.manifest.assets[0]; assert.equal(asset.base.width, 1000); assert.equal(asset.base.height, 700);
    const names = await readdir(join(f.root, "objects")); assert(!names.includes(hash(f.bytes) + ".webp"));
    const selected = selectDisplayFile(asset, 1600); assert.equal(selected.sha256, asset.base.sha256);
    const response = await displayMediaResponse(asset.assetId, null, { qualify: async () => f.source, store: f.store });
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "private, no-store");
    const body = Buffer.from(await response.arrayBuffer()); assert.equal(hash(body), asset.base.sha256);
    const meta = await sharp(body).metadata(); assert.equal(meta.width, 1000); assert(!meta.exif);
  } finally { await f.close(); }
});

test("large and transparent inputs use bounded derived WebP; small aliases and zero-benefit bases survive", async () => {
  for (const [w, h, alpha] of [[1800, 900, false], [80, 60, true]] as const) {
    const f = await fixture(w, h, alpha);
    try {
      const asset = f.manifest.assets[0]; assert.equal(asset.base.width, Math.min(w, 1600));
      for (const cap of [400, 800, 1600] as const) {
        const descriptor = selectDisplayFile(asset, cap), bytes = await f.store.read(descriptor);
        const meta = await sharp(bytes).metadata(); assert.equal(meta.width, descriptor.width); assert.equal(meta.hasAlpha, alpha);
      }
      if (w < 400) assert.equal((await readdir(join(f.root, "objects"))).length, 1);
    } finally { await f.close(); }
  }
  const bytes = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#ddeeff" } }).webp({ lossless: true }).toBuffer();
  const s = (await source(64, 64)).source; s.source.media.mime = "image/webp";
  s.source.media.sha256 = hash(bytes); s.source.media.byteSize = bytes.length; s.source.media.objectKey = "sha256/" + hash(bytes);
  const id = mediaIdentity(s.source.media.ownerPageId, "cover", hash(bytes)); s.source.media.assetId = id;
  Object.assign(s.source.binding, { assetId: id, sha256: hash(bytes) });
  const out = await prepareDisplayAsset(s, bytes); assert.equal(out.asset.base.byteSize, bytes.length); assert.equal(out.objects.size, 1);
});

test("a withdrawal or changed run/source/owner during disk reading returns404, with no original port", async () => {
  const f = await fixture(120, 80);
  try {
    for (const mutation of ["withdrawn", "run", "sha", "fingerprint", "owner"] as const) {
      let reads = 0;
      const changed = structuredClone(f.source);
      if (mutation === "run") changed.runId = randomUUID();
      if (mutation === "sha") changed.source.media.sha256 = "b".repeat(64);
      if (mutation === "fingerprint") changed.source.binding.sourceFingerprint = "b".repeat(64);
      if (mutation === "owner") changed.source.media.ownerPageId = "another-owner";
      const response = await displayMediaResponse(f.source.source.media.assetId, 800, {
        store: f.store, qualify: async () => ++reads === 1 ? f.source : mutation === "withdrawn" ? null : changed,
      });
      assert.equal(response.status, 404); assert.equal(reads, 2); assert.equal((await response.arrayBuffer()).byteLength, 0);
    }
    let disk = 0;
    assert.equal((await displayMediaResponse(f.source.source.media.assetId, 400, { qualify: async () => null,
      store: { ...f.store, read: async () => { disk++; throw Error(); } } })).status, 404); assert.equal(disk, 0);
  } finally { await f.close(); }
});

test("declared missing or corrupted files and symlink/hardlink/permission escapes fail instead of selecting another image", async () => {
  const f = await fixture(100, 70);
  const descriptor = f.manifest.assets[0].base, file = join(f.root, "objects", descriptor.sha256 + ".webp");
  try {
    const original = await readFile(file); await writeFile(file, Buffer.alloc(original.length));
    await assert.rejects(f.store.read(descriptor)); await writeFile(file, original);
    await chmod(file, 0o644); await assert.rejects(f.store.read(descriptor)); await chmod(file, 0o600);
    await link(file, file + ".second"); await assert.rejects(f.store.read(descriptor)); await rm(file + ".second");
    await rename(file, file + ".saved");
    await assert.rejects(displayMediaResponse(f.source.source.media.assetId, null, { qualify: async () => f.source, store: f.store }));
    await symlink(file + ".saved", file); await assert.rejects(f.store.read(descriptor)); await rm(file); await rename(file + ".saved", file);
    await rename(join(f.root, "objects"), join(f.root, "saved")); await symlink(join(f.root, "saved"), join(f.root, "objects"));
    await assert.rejects(f.store.read(descriptor));
  } finally { await f.close(); }
});

test("manifest and request validation reject paths, invalid caps, mismatched dimensions and mixed batches", async () => {
  const f = await fixture(90, 70);
  try {
    assert.throws(() => createDisplayStore(join(process.cwd(), "public", "display")));
    for (const query of ["?thumbnail=999", "?thumbnail=400&thumbnail=800", "?path=/private", "?thumbnail=400&x=1"])
      assert.throws(() => displayWidth("http://localhost/image" + query));
    assert.equal(displayWidth("http://localhost/image?thumbnail=1600"), 1600);
    await assert.rejects(f.store.manifest("../private"));
    const wrong = structuredClone(f.manifest); wrong.assets[0].base.sha256 = "../private"; assert.throws(() => validateDisplayManifest(wrong));
    const base = f.manifest.assets[0].base, bytes = await f.store.read(base);
    assert.throws(() => verifyDisplayBytes({ ...base, width: 1 }, bytes));
    const staleManifest = structuredClone(f.manifest); staleManifest.runId = randomUUID();
    const manifestFile = join(f.root, "runs", f.source.runId + ".json");
    await writeFile(manifestFile, JSON.stringify(staleManifest)); await assert.rejects(f.store.manifest(f.source.runId));
    const wrongRun = structuredClone(f.source); wrongRun.runId = randomUUID();
    await assert.rejects(buildDisplayBundle(join(f.parent, "bad"), f.source.runId, [{ source: wrongRun, bytes: f.bytes }]));
    await assert.rejects(buildDisplayBundle(f.root, f.source.runId, [{ source: f.source, bytes: f.bytes }]));
    await assert.rejects(buildDisplayBundle(join(f.parent, "budget"), f.source.runId, [{ source: f.source, bytes: f.bytes }], 1));
    await assert.rejects(readFile(join(f.parent, "budget/runs", f.source.runId + ".json")));
    const previousDirectory = process.cwd();
    await symlink(f.root, join(f.parent, "public"));
    try {
      process.chdir(f.parent); const exposed = createDisplayStore(f.root);
      await assert.rejects(exposed.verifyRoot()); await assert.rejects(exposed.read(base));
    } finally { process.chdir(previousDirectory); }
  } finally { await f.close(); }
});

test("the offline CLI generates only derived objects and never overwrites a prepared batch", async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "display-cli-"))), item = await source(60, 40);
  try {
    const originalFile = join(parent, "fictional.png"), plan = join(parent, "plan.json"), output = join(parent, "bundle");
    await writeFile(originalFile, item.bytes, { mode: 0o600 });
    await writeFile(plan, JSON.stringify({ format: "notionblog-display-input-v1", runId: item.source.runId,
      assets: [{ originalFile, source: item.source }] }), { mode: 0o600 });
    const args = ["scripts/self-hosted-media/run.mjs", "build", "--input", plan, "--output", output];
    const execute = () => spawnSync(process.execPath, args, { env: { ...cleanEnvironment(), NODE_ENV: "test" }, encoding: "utf8", timeout: 30000 });
    const first = execute(); assert.equal(first.status, 0, first.stderr); assert.equal(JSON.parse(first.stdout).status, "DISPLAY_BUNDLE_BUILT_NOT_PUBLISHED");
    const manifest = await createDisplayStore(output).manifest(item.source.runId); assert.equal(manifest.assets.length, 1);
    assert.deepEqual(await readFile(originalFile), item.bytes); assert((await readdir(join(output, "objects"))).every(name => /^[a-f0-9]{64}\.webp$/.test(name)));
    const second = execute(); assert.equal(second.status, 1); assert.equal(second.stderr.trim(), "SELF_HOSTED_DISPLAY_BUILD_FAILED");
    assert.deepEqual(await createDisplayStore(output).manifest(item.source.runId), manifest);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test("display encoding normalizes orientation but refuses animation and high-bit-depth originals without fallback", async () => {
  const oriented = await sharp({ create: { width: 240, height: 960, channels: 3, background: "#2e658f" } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const outputs = await generateDisplayVariants(oriented);
  assert.deepEqual(outputs.map(x => [x.widthCap, x.width, x.height]), [[400, 400, 100], [800, 800, 200], [1600, 960, 240]]);
  for (const output of outputs) { const meta = await sharp(output.bytes).metadata(); assert(!meta.exif); assert(!meta.icc); assert(!meta.orientation); }
  const pixels = Buffer.alloc(8 * 16 * 4, 255);
  const animated = await sharp(pixels, { raw: { width: 8, height: 16, channels: 4, pageHeight: 8 } }).gif({ delay: [100, 100], keepDuplicateFrames: true }).toBuffer();
  assert.equal((await sharp(animated, { animated: true }).metadata()).pages, 2);
  const highBit = await sharp({ create: { width: 12, height: 8, channels: 3, background: "#556677" } }).toColourspace("rgb16").png().toBuffer();
  assert.equal((await sharp(highBit).metadata()).depth, "ushort");
  for (const bytes of [animated, highBit]) {
    const s = (await source()).source, sha = hash(bytes);
    Object.assign(s.source.media, { sha256: sha, byteSize: bytes.length, objectKey: "sha256/" + sha, mime: bytes === animated ? "image/gif" : "image/png", assetId: mediaIdentity(s.source.media.ownerPageId, "cover", sha) });
    Object.assign(s.source.binding, { sha256: sha, assetId: s.source.media.assetId });
    assert.deepEqual(await generateDisplayVariants(bytes), []); await assert.rejects(prepareDisplayAsset(s, bytes));
  }
  assert.equal(selfHostedDisplayStore({ SELF_HOSTED_MEDIA_MODE: "display-only", SELF_HOSTED_MEDIA_ROOT: "/private/never-opened" }), undefined);
});

test("delivery DTO decoration is bound to a qualified projection/run and never mutates stored records", async () => {
  const f = await fixture(110, 80);
  try {
    const id = f.source.source.media.assetId, image = { id, src: "/media/v2/" + id, alt: "Fictional", width: 110, height: 80 };
    const projection = { schemaDigest: WEBSITE_SCHEMA_DIGEST, runId: f.source.runId, revision: "1", mediaIds: [id], links: [],
      records: [{ item: { cover: image }, document: { blocks: [{ type: "image", image: { ...image, src: "https://original.example.invalid/private.png" } }] } }] };
    let sql = 0;
    const db = displayProjectionSql({ query: async <T>() => { sql++; return { rows: [{ result: projection }] as T[] }; } }, f.store);
    const value = (await db.query<{ result: typeof projection & { records: { item: { cover: typeof image & { delivery: unknown } }; document: unknown }[] } }>("fixture")).rows[0].result;
    assert.deepEqual(value.records[0].item.cover.delivery, { mode: "display-only", maxWidth: 110, maxHeight: 80 });
    assert.equal((projection.records[0].item.cover as typeof image & { delivery?: unknown }).delivery, undefined); assert.equal(sql, 1);
    assert.equal((value.records[0].document as { blocks: { image: unknown }[] }).blocks[0].image, null);
    const unrelated = { version: "fixture", image };
    const passthrough = displayProjectionSql({ query: async <T>() => ({ rows: [unrelated] as T[] }) }, f.store);
    assert.deepEqual((await passthrough.query("fixture")).rows[0], unrelated);
  } finally { await f.close(); }
});
