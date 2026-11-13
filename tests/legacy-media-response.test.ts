import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setImmediate as turn } from "node:timers/promises";
import { mediaIdentity } from "../src/server/database/validation.ts";
import type { ThumbnailProjection } from "../src/server/database/thumbnail-index.ts";
import { TransientStorageReadError } from "../src/server/database/storage.ts";
import { sourceFingerprint } from "../src/server/media/notion-source.ts";
import { legacyMediaResponse } from "../src/server/media/legacy.ts";
import { createLegacyMediaReadQueue } from "../src/server/media/legacy-read-queue.ts";
import type { HybridMediaPorts } from "../src/server/media/hybrid.ts";
import type { ThumbnailMediaPorts } from "../src/server/media/thumbnail.ts";

function fixture() {
  const owner = "00000000000000000000000000000064", sha = "a".repeat(64);
  const asset = mediaIdentity(owner, "cover", sha), url = "https://assets.example.test/fictional-cover.jpg";
  const source = {
    media: { assetId: asset, ownerPageId: owner, sha256: sha, objectKey: `sha256/${sha}`, byteSize: 100, mime: "image/jpeg" as const, width: 400, height: 600 },
    binding: { assetId: asset, ownerPageId: owner, sha256: sha, locator: { kind: "cover" as const }, delivery: "notion" as const, sourceFingerprint: sourceFingerprint(url, false) },
  };
  const projection: ThumbnailProjection = { version: "v2", runId: "11111111-1111-4111-8111-111111111111", source, thumbnail: null };
  let denied = false, reads = 0, resolutions = 0;
  const original: HybridMediaPorts = {
    version: "v2", read: async () => { reads++; return denied ? null : structuredClone(source); },
    resolve: async () => { resolutions++; return { url, sourceFingerprint: source.binding.sourceFingerprint }; },
    storage: () => assert.fail("original redirect must not read Storage"),
  };
  const ports: Omit<ThumbnailMediaPorts, "original"> = {
    qualification: "database", read: async () => structuredClone(projection), resolve: original.resolve, storage: original.storage,
  };
  const queue = createLegacyMediaReadQueue({ capacity: 1 });
  const call = () => legacyMediaResponse(new AbortController().signal, asset, original, { width: 400, ports }, queue);
  const block = async () => {
    let resolve!: () => void;
    const hold = new Promise<void>(done => { resolve = done; });
    const active = queue.run(new AbortController().signal, () => hold);
    await turn();
    return async () => { resolve(); await active; };
  };
  const stored = () => {
    const bytes = Buffer.from([82, 73, 70, 70, 4, 0, 0, 0, 87, 69, 66, 80]);
    const hash = createHash("sha256").update(bytes).digest("hex");
    projection.thumbnail = { ...source.media, assetId: mediaIdentity(owner, `thumbnail:400:${asset}`, hash), sha256: hash, objectKey: `sha256/${hash}`, byteSize: bytes.length, mime: "image/webp" };
    ports.storage = () => ({ read: async () => bytes, put: async () => assert.fail("no writes") });
    return bytes;
  };
  return { call, block, stored, projection, original, ports, withdraw: () => { denied = true; }, counts: () => ({ reads, resolutions }) };
}

test("withdrawal while a missing variant waits is checked afresh before any Notion request", async () => {
  const f = fixture(), release = await f.block();
  const response = f.call(); await turn();
  assert.deepEqual(f.counts(), { reads: 0, resolutions: 0 });
  f.withdraw(); await release();
  assert.equal((await response).status, 404);
  assert.deepEqual(f.counts(), { reads: 1, resolutions: 0 });
});

test("withdrawal during an admitted original lookup still blocks the final redirect", async () => {
  const f = fixture(), resolve = f.original.resolve;
  f.original.resolve = async binding => { const source = await resolve(binding); f.withdraw(); return source; };
  const response = await f.call();
  assert.equal(response.status, 404); assert.equal(response.headers.get("Location"), null);
  assert.deepEqual(f.counts(), { reads: 2, resolutions: 1 });
});

test("stored database thumbnails and validators bypass a busy original queue without Notion reads", async () => {
  const f = fixture(), bytes = f.stored(), release = await f.block();
  try {
    const response = await f.call();
    assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    f.ports.ifNoneMatch = `"pc1-${f.projection.thumbnail!.sha256}"`;
    assert.equal((await f.call()).status, 304);
    assert.deepEqual(f.counts(), { reads: 0, resolutions: 0 });
  } finally { await release(); }
});

test("a transient thumbnail read queues a freshly qualified original and never reuses the old projection", async () => {
  const f = fixture(); f.stored();
  f.ports.storage = () => ({ read: async () => { throw new TransientStorageReadError(); }, put: async () => assert.fail("no writes") });
  const release = await f.block(), response = f.call(); await turn();
  assert.deepEqual(f.counts(), { reads: 0, resolutions: 0 });
  f.withdraw(); await release(); assert.equal((await response).status, 404);
});

test("live qualification of stored variants also waits; successful reads retain both live checks", async () => {
  const f = fixture(); f.stored(); f.ports.qualification = "live-notion";
  const release = await f.block(), response = f.call(); await turn();
  assert.equal(f.counts().resolutions, 0);
  await release(); assert.equal((await response).status, 200);
  assert.equal(f.counts().resolutions, 2);
});
