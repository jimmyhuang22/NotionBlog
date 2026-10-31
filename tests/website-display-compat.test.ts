import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { WEBSITE_SCHEMA_DIGEST } from "../contracts/website-sync.ts";
import { displayDeliveryMode, readDisplayMedia } from "../src/server/database/display.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";
import { databaseDisplayProjectionSql, databaseDisplayResponse } from "../src/server/media/display.ts";
import { DISPLAY_V2_RECIPE, type DisplayAsset } from "../src/server/self-hosted-media/manifest.ts";
import { verifyDisplayBytes } from "../src/server/self-hosted-media/files.ts";

const runId = "00000000-0000-0000-0000-000000000001";
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function fixture(animated = false, width = 6) {
  const pixels = Buffer.alloc(width * 2 * 4 * 2, 255); pixels.fill(30, 0, width * 2 * 4);
  const bytes = animated
    ? await sharp(pixels, { animated: true, raw: { width, height: 4, channels: 4, pageHeight: 2 } }).webp({ lossless: true, loop: 0, delay: [100, 200] }).toBuffer()
    : await sharp({ create: { width, height: 2, channels: 3, background: "#3579ab" } }).webp({ lossless: true }).toBuffer();
  const file = { sha256: sha(bytes), byteSize: bytes.length, mime: "image/webp" as const, width, height: 2 };
  const asset: DisplayAsset = { assetId: "a1." + "a".repeat(64), ownerPageId: "1".repeat(32), sourceSha256: "b".repeat(64), sourceFingerprint: "c".repeat(64), base: file, variants: { "400": file } };
  return { bytes, file, asset, projection: { runId, revision: "1", asset } };
}

test("cloud display is opt-in and its reader passes the reviewed protocol identity", async () => {
  assert.equal(displayDeliveryMode(undefined), false); assert.equal(displayDeliveryMode("legacy"), false);
  assert.equal(displayDeliveryMode("display-only"), true); assert.throws(() => displayDeliveryMode(""));
  const f = await fixture();
  const db: SqlExecutor = { async query<T>(sql: string, values?: unknown[]) {
    assert.equal(sql, "SELECT nb_display_api.read_media($1,$2,$3) AS result");
    assert.deepEqual(values, [f.asset.assetId, "qualified", "ae599beef7a9f273e3d41f9a6d95c5f822b8005e4939cf98771b64edc40387a5"]);
    return { rows: [{ result: f.projection }] as T[] };
  } };
  assert.deepEqual(await readDisplayMedia(db, f.asset.assetId, "qualified"), f.projection);
  assert.equal(await readDisplayMedia({ query: async () => assert.fail("invalid id reached SQL") }, "invalid", "qualified"), null);
});

test("display mappings add delivery metadata in one bounded read and fail closed on incomplete mappings", async () => {
  const f = await fixture(), image = { id: f.asset.assetId, src: "/media/v2/" + f.asset.assetId };
  const envelope = { schemaDigest: WEBSITE_SCHEMA_DIGEST, runId, revision: "1", mediaIds: [image.id], records: [{ cover: image }, { cover: image }] };
  let mappings = 0;
  const content: SqlExecutor = { async query<T>(sql: string, values?: unknown[]) {
    assert.equal(sql, "existing-content-query"); assert.deepEqual(values, [1]); return { rows: [{ result: envelope }] as T[] };
  } };
  const mapping: SqlExecutor = { async query<T>(sql: string, values?: unknown[]) {
    mappings++; assert.equal(sql, "SELECT nb_display_api.read_assets($1,$2::text[],$3,$4) AS result");
    assert.deepEqual(values?.slice(0, 3), [runId, [image.id], "qualified"]);
    return { rows: [{ result: { runId, revision: "1", assets: [f.asset] } }] as T[] };
  } };
  const out = await databaseDisplayProjectionSql(content, mapping, "qualified").query<{ result: typeof envelope & { records: { cover: { delivery: unknown } }[] } }>("existing-content-query", [1]);
  assert.deepEqual(out.rows[0]!.result.records[0]!.cover.delivery, { mode: "display-only", maxWidth: 6, maxHeight: 2 });
  assert.equal(mappings, 1); assert.equal(Object.hasOwn(image, "delivery"), false);
  const missing: SqlExecutor = { async query<T>() { return { rows: [{ result: { runId, revision: "1", assets: [] } }] as T[] }; } };
  await assert.rejects(databaseDisplayProjectionSql(content, missing, "qualified").query("existing-content-query", [1]), /display projection is unavailable/);
});

test("display media verifies bytes and requalifies after reading without any original fallback", async () => {
  const f = await fixture(); let reads = 0, objects = 0;
  const storage = () => ({ async read(media: { sha256: string }) {
    objects++; assert.equal(media.sha256, f.file.sha256); assert.notEqual(media.sha256, f.asset.sourceSha256); return f.bytes;
  } });
  const response = await databaseDisplayResponse(f.asset.assetId, 400, { read: async () => { reads++; return f.projection; }, storage });
  assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.bytes); assert.equal(reads, 2); assert.equal(objects, 1);
  reads = 0;
  const withdrawn = await databaseDisplayResponse(f.asset.assetId, null, { read: async () => ++reads === 1 ? f.projection : null, storage });
  assert.equal(withdrawn.status, 404); assert.equal((await withdrawn.arrayBuffer()).byteLength, 0);
  await assert.rejects(databaseDisplayResponse(f.asset.assetId, null, { read: async () => f.projection, storage: () => ({ read: async () => Buffer.from("corrupt") }) }));
});

test("the website animation reader accepts both reviewed widths and rejects invalid recipes, frames and frame counts", async () => {
  for (const width of [4, 6]) {
    const f = await fixture(true, width);
    verifyDisplayBytes(f.file, f.bytes, DISPLAY_V2_RECIPE);
    assert.throws(() => verifyDisplayBytes(f.file, f.bytes, "display-webp-v1:" + "a".repeat(64)));
    const bad = Buffer.from(f.bytes), frame = bad.indexOf("ANMF"); assert.ok(frame > 0); bad[frame + 8 + 15] = 128;
    const descriptor = (b: Buffer) => ({ ...f.file, sha256: sha(b), byteSize: b.length });
    assert.throws(() => verifyDisplayBytes(descriptor(bad), bad, DISPLAY_V2_RECIPE));
    const chunks: Buffer[] = [];
    for (let p = 12; p < f.bytes.length;) { const n = f.bytes.readUInt32LE(p + 4), end = p + 8 + n + n % 2; chunks.push(f.bytes.subarray(p, end)); p = end; }
    const headers = chunks.filter(b => b.toString("ascii", 0, 4) !== "ANMF"), first = chunks.find(b => b.toString("ascii", 0, 4) === "ANMF")!;
    const many = Buffer.concat([f.bytes.subarray(0, 12), ...headers, ...Array.from({ length: 301 }, () => first)]); many.writeUInt32LE(many.length - 8, 4);
    assert.throws(() => verifyDisplayBytes(descriptor(many), many, DISPLAY_V2_RECIPE));
  }
});
