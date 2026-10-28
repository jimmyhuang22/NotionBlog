import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { deliveryStatus } from "../scripts/self-hosted-delivery/result.mjs";
import { mkdtemp, realpath, mkdir, writeFile, readFile, readdir, copyFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { buildDisplayBundle } from "../scripts/self-hosted-media/bundle.ts";
import { createDisplayStore } from "../src/server/self-hosted-media/files.ts";
import { selectDisplayFile } from "../src/server/self-hosted-media/manifest.ts";
import { mediaIdentity } from "../src/server/database/validation.ts";
import type { ThumbnailProjection } from "../src/server/database/thumbnail-index.ts";

test("foreground delivery and source wrapper preserve version, locks, adoption order and source exit", () => {
  const result = spawnSync("python3", ["-B", "tests/self_hosted_delivery_test.py"], { encoding: "utf8", timeout: 60000 });
  assert.equal(result.status, 0, result.stderr + result.stdout);
});

test("a new generated image reaches a local receiver as verified display files; missing files prevent acceptance", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "delivery-image-")));
  try {
    const bytes = await sharp({ create: { width: 1200, height: 700, channels: 3, background: "#c5d7e9" } }).png().toBuffer();
    const sha = createHash("sha256").update(bytes).digest("hex"), runId = randomUUID(), owner = "fictional-delivery-page";
    const assetId = mediaIdentity(owner, "cover", sha);
    const source: ThumbnailProjection = { version: "v2", runId, thumbnail: null, source: {
      media: { assetId, ownerPageId: owner, objectKey: "sha256/" + sha, sha256: sha, mime: "image/png", byteSize: bytes.length, width: 1200, height: 700 },
      binding: { assetId, ownerPageId: owner, sha256: sha, locator: { kind: "cover" }, delivery: "notion", sourceFingerprint: "b".repeat(64) },
    } };
    const original = join(root, "original.png"); await writeFile(original, bytes, { mode: 0o600 });
    const spool = join(root, "spool"), receiver = join(root, "receiver");
    const manifest = await buildDisplayBundle(spool, runId, [{ source, bytes }]);
    for (const path of [receiver, join(receiver, "objects"), join(receiver, "runs")]) await mkdir(path, { mode: 0o700 });
    const manifestPath = join(receiver, "runs", runId + ".json");
    await copyFile(join(spool, "runs", runId + ".json"), manifestPath); await chmod(manifestPath, 0o600);
    const store = createDisplayStore(receiver), asset = (await store.manifest(runId)).assets[0];
    await assert.rejects(store.read(asset.base));
    const names = await readdir(join(spool, "objects"));
    assert(names.length > 0); assert(names.every(name => /^[a-f0-9]{64}\.webp$/.test(name)));
    for (const name of names) {
      const target = join(receiver, "objects", name); await copyFile(join(spool, "objects", name), target); await chmod(target, 0o600);
    }
    for (const width of [400, 800, 1600] as const) {
      const file = selectDisplayFile(manifest.assets[0], width), delivered = await store.read(file);
      assert.equal(createHash("sha256").update(delivered).digest("hex"), file.sha256);
      assert(file.width <= Math.min(1200, width));
    }
    assert(!names.includes(sha + ".webp")); assert.deepEqual(await readFile(original), bytes);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("delivery outcomes keep published failures distinct from no publication and unknown commit", () => {
  assert.equal(deliveryStatus({ published: true, readerVerified: true, websiteAndImagesVerified: true }), "COMPLETE");
  assert.equal(deliveryStatus({ published: true, readerVerified: false, status: "PUBLISHED_VERIFICATION_FAILED" }), "PUBLISHED_VERIFICATION_FAILED");
  assert.equal(deliveryStatus({ published: true, readerVerified: true, websiteAndImagesVerified: false }), "PUBLISHED_HTTP_CHECK_PENDING");
  assert.equal(deliveryStatus({ published: false, status: "FAILED_KNOWN_NOT_PUBLISHED" }), "FAILED_KNOWN_NOT_PUBLISHED");
  for (const input of [{ status: "NOT_STARTED" }, {}, { published: true, pendingMutation: "promote" }, { outcomeUnknown: true }]) {
    assert.equal(deliveryStatus(input), "WRITE_OUTCOME_UNKNOWN");
  }
});
