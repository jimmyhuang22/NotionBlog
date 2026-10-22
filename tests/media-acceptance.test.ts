import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "pg";
import sharp from "sharp";
import { hostFixture } from "./helpers/incremental-host.ts";
import { installPublishedThumbnails } from "../scripts/website-sync/published-thumbnail-migration.ts";
import { createPublishedThumbnailRegistrar } from "../src/server/database/published-thumbnails.ts";
import { publicationWriter } from "../src/server/database/publication.ts";
import { readPublicationState } from "../src/server/database/incremental-publication.ts";
import { mediaIdentity } from "../src/server/database/website-validation.ts";
import { planMediaAcceptance, verifyMediaAcceptance, type AcceptanceThumbnail } from "../scripts/website-incremental-sync/media-acceptance.ts";
import { createMediaAcceptanceBudget } from "../scripts/website-incremental-sync/media-acceptance-budget.ts";
import { mediaAcceptanceMain, parseMediaAcceptanceArguments } from "../scripts/website-incremental-sync/media-acceptance-cli.ts";
import thumbnailProtocol from "../database/thumbnail-protocol.json" with { type: "json" };
import type { ThumbnailScope } from "../scripts/website-incremental-sync/thumbnail-scope.ts";

const limits = { durationMs: 10000, sqlResponseBytes: 1024 ** 2, controlBytes: 8192 };
async function fixture() {
  const f = await hostFixture();
  try {
  const migration = thumbnailProtocol.migrations[0];
  await f.db.exec(await readFile(new URL(`../supabase/migrations/${migration.file}`, import.meta.url), "utf8"));
  await f.db.query("UPDATE nb_thumbnails.migrations SET digest=$1", [migration.sha256]);
  await installPublishedThumbnails({ query: async <T>(sql: string, values?: unknown[]) => {
    if (sql.startsWith("--")) { await f.db.exec(sql); return { rows: [] as T[] }; } return f.db.query<T>(sql, values);
  } });
  const data = Buffer.alloc(128 * 128 * 3); let seed = 73;
  for (let n = 0; n < data.length; n++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; data[n] = seed >>> 24; }
  const png = await sharp(data, { raw: { width: 128, height: 128, channels: 3 } }).png().toBuffer();
  const webp = await sharp(png).webp({ quality: 65 }).toBuffer();
  const hash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex"), sha = hash(png);
  const media = f.artifact.collection.records.slice(0, 2).map(r => ({ assetId: mediaIdentity(r.detail.item.id, "cover", sha), ownerPageId: r.detail.item.id,
    objectKey: `sha256/${sha}`, sha256: sha, byteSize: png.length, mime: "image/png" as const, width: 128, height: 128 }));
  const original = media[0], thumbSha = hash(webp), thumbnail = { ...original,
    assetId: mediaIdentity(original.ownerPageId, `thumbnail:400:${original.assetId}`, thumbSha), objectKey: `sha256/${thumbSha}`, sha256: thumbSha, byteSize: webp.length, mime: "image/webp" as const };
  const candidates: AcceptanceThumbnail[] = [{ parentAssetId: original.assetId, parentSha256: sha, widthCap: 400, thumbnail }];
  const reader = f.open({ connectionString: f.options.database.readerUrl }), writer = f.open({ connectionString: f.options.database.writerUrl });
  const publisher = publicationWriter(writer, "published"), lease = await publisher.begin(randomUUID(), f.digest);
  await publisher.stage(lease, f.artifact.collection.records, media); await publisher.promote(lease, { records: 3, media: 2, complete: true });
  f.artifact.fullRunId = lease.runId; f.artifact.state = await readPublicationState(reader); f.artifact.media = media;
  await createPublishedThumbnailRegistrar(writer).register({ expectedRevision: f.artifact.state.publicationRevision, ...candidates[0] });
  const bytes = new Map([[original.objectKey, png], [thumbnail.objectKey, webp]]);
  const plan = planMediaAcceptance(f.config, f.artifact, candidates, limits);
  return { ...f, reader, writer, plan, candidates, bytes, original, thumbnail };
  } catch (error) { await f.close(); throw error; }
}

test("explicit byte scope crosses 15MiB without changing original limits and is bound before any reads", async () => {
  const f = await fixture();
  try {
    const artifact = structuredClone(f.artifact); for (const media of artifact.media) media.byteSize = 20 * 1024 ** 2;
    const candidates = structuredClone(f.candidates); candidates[0].thumbnail.byteSize = 16 * 1024 ** 2;
    const thumbnailScope: ThumbnailScope = { format: "thumbnail-scope-v1", maxBindings: 1, maxObjects: 1, maxBytes: 16 * 1024 ** 2 };
    assert.throws(() => planMediaAcceptance(f.config, artifact, candidates, limits), { code: "MEDIA_ACCEPTANCE_THUMBNAIL_LIMIT" });
    const plan = planMediaAcceptance(f.config, artifact, candidates, { ...limits, thumbnailScope });
    assert.equal(plan.summary.additionalThumbnailBytes, thumbnailScope.maxBytes); assert.equal(plan.summary.uniqueObjects, 2);
    assert.equal(plan.summary.mediaResponseBytes, 36 * 1024 ** 2 + limits.controlBytes);
    assert.throws(() => planMediaAcceptance(f.config, artifact, candidates, { ...limits, thumbnailScope: { ...thumbnailScope, maxBytes: thumbnailScope.maxBytes - 1 } }),
      { code: "MEDIA_ACCEPTANCE_THUMBNAIL_LIMIT" });
    const changed = structuredClone(plan); changed.thumbnailScope!.maxBytes++;
    const budget = createMediaAcceptanceBudget(plan.summary); let accessed = false;
    try {
      await assert.rejects(verifyMediaAcceptance(changed, { reader: { query: async () => { accessed = true; throw Error(); } },
        readerUrl: f.options.database.readerUrl, storage: { read: async () => { accessed = true; throw Error(); } }, budget }),
        { code: "MEDIA_ACCEPTANCE_PLAN_CHANGED" });
      assert.equal(accessed, false);
    } finally { budget.close(); }
  } finally { await f.close(); }
});
test("scope counts shared objects once but bounds every parent binding and rejects extra unique objects", async () => {
  const f = await fixture();
  try {
    const parent = f.artifact.media[1], second = { ...f.candidates[0], parentAssetId: parent.assetId, parentSha256: parent.sha256,
      thumbnail: { ...f.thumbnail, ownerPageId: parent.ownerPageId,
        assetId: mediaIdentity(parent.ownerPageId, `thumbnail:400:${parent.assetId}`, f.thumbnail.sha256) } };
    const thumbnailScope: ThumbnailScope = { format: "thumbnail-scope-v1", maxBindings: 2, maxObjects: 1, maxBytes: f.thumbnail.byteSize };
    const candidates = [...f.candidates, second], plan = planMediaAcceptance(f.config, f.artifact, candidates, { ...limits, thumbnailScope });
    assert.equal(plan.summary.thumbnailBindings, 2); assert.equal(plan.summary.uniqueObjects, 2);
    assert.equal(plan.summary.additionalThumbnailBytes, f.thumbnail.byteSize);
    assert.throws(() => planMediaAcceptance(f.config, f.artifact, candidates, { ...limits, thumbnailScope: { ...thumbnailScope, maxBindings: 1 } }),
      { code: "MEDIA_ACCEPTANCE_THUMBNAIL_LIMIT" });
    const different = structuredClone(second), sha = "a".repeat(64);
    Object.assign(different.thumbnail, { sha256: sha, objectKey: `sha256/${sha}`, assetId: mediaIdentity(parent.ownerPageId, `thumbnail:400:${parent.assetId}`, sha) });
    assert.throws(() => planMediaAcceptance(f.config, f.artifact, [...f.candidates, different], { ...limits, thumbnailScope: { ...thumbnailScope, maxBytes: f.thumbnail.byteSize * 2 } }),
      { code: "MEDIA_ACCEPTANCE_THUMBNAIL_LIMIT" });
    different.thumbnail.ownerPageId = f.original.ownerPageId;
    assert.throws(() => planMediaAcceptance(f.config, f.artifact, [...f.candidates, different], { ...limits, thumbnailScope: { ...thumbnailScope, maxObjects: 2, maxBytes: f.thumbnail.byteSize * 2 } }),
      { code: "MEDIA_ACCEPTANCE_INPUT_INVALID" });
  } finally { await f.close(); }
});
test("offline selection deduplicates bytes while retaining all owner checks and rejects conflicting plans", async () => {
  const f = await fixture();
  try {
    assert.equal(f.plan.summary.originalAssets, 2); assert.equal(f.plan.summary.originalObjects, 1);
    assert.equal(f.plan.summary.uniqueObjects, 2); assert.equal(f.plan.summary.sqlQueries, 19);
    assert.equal(f.plan.summary.originalBytes, f.original.byteSize);
    const historical = { ...f.candidates[0], parentAssetId: `a1.${"0".repeat(64)}` };
    assert.equal(planMediaAcceptance(f.config, f.artifact, [...f.candidates, historical], limits).summary.excludedHistoricalBindings, 1);
    assert.throws(() => planMediaAcceptance(f.config, f.artifact, [...f.candidates, ...f.candidates], limits));
    assert.throws(() => planMediaAcceptance(f.config, f.artifact, [{ ...f.candidates[0], parentSha256: "0".repeat(64) }], limits));
    const changed = structuredClone(f.artifact); changed.media[1].byteSize++;
    assert.throws(() => planMediaAcceptance(f.config, changed, f.candidates, limits));
    const budget = createMediaAcceptanceBudget(f.plan.summary), tampered = structuredClone(f.plan); tampered.objects[0].byteSize++;
    try { await assert.rejects(verifyMediaAcceptance(tampered, { reader: f.reader, readerUrl: f.options.database.readerUrl, budget, storage: { read: async () => assert.fail("Tampered plan read") } }), { code: "MEDIA_ACCEPTANCE_PLAN_CHANGED" }); }
    finally { budget.close(); }
  } finally { await f.close(); }
});
test("real reader SQL verifies all members and variants with exactly derived query and unique object ceilings", async () => {
  const f = await fixture(), budget = createMediaAcceptanceBudget(f.plan.summary); let reads = 0;
  try {
    const proof = await verifyMediaAcceptance(f.plan, { reader: f.reader, readerUrl: f.options.database.readerUrl, budget,
      storage: { read: async m => { reads++; const b = f.bytes.get(m.objectKey)!; budget.observe("mediaResponseBytes", b.length); return b; } } });
    assert.equal(proof.outcome, "verified"); assert.equal(reads, 2); assert.equal(budget.statistics().sqlQueries, 19);
    assert.equal(budget.statistics().mediaResponseBytes, f.original.byteSize + f.thumbnail.byteSize);
    assert.equal(budget.statistics().failure, null);
  } finally { budget.close(); await f.close(); }
});
test("withdrawal during reading, missing expected variants, wrong reader and SQL exhaustion never pass", async t => {
  for (const scenario of ["withdraw", "ancestor", "missing", "unexpected", "publication", "writer", "sql-limit"] as const) await t.test(scenario, async () => {
    const f = await fixture(), budget = createMediaAcceptanceBudget({ ...f.plan.summary, ...(scenario === "sql-limit" ? { sqlQueries: 1 } : {}) }); let reads = 0;
    try {
      if (scenario === "missing") await f.db.query("DELETE FROM nb_thumbnails.media");
      if (scenario === "unexpected") {
        const thumbnail = { ...f.thumbnail, assetId: mediaIdentity(f.thumbnail.ownerPageId, `thumbnail:800:${f.original.assetId}`, f.thumbnail.sha256) };
        await createPublishedThumbnailRegistrar(f.writer).register({ expectedRevision: f.plan.state.publicationRevision,
          parentAssetId: f.original.assetId, parentSha256: f.original.sha256, widthCap: 800, thumbnail });
      }
      await assert.rejects(verifyMediaAcceptance(f.plan, { reader: scenario === "writer" ? f.writer : f.reader,
        readerUrl: scenario === "writer" ? f.options.database.writerUrl : f.options.database.readerUrl, budget,
        storage: { read: async m => { reads++;
          if (scenario === "withdraw") await f.db.query("INSERT INTO nb_v2.denied VALUES($1)", [f.original.ownerPageId]);
          if (scenario === "ancestor") await f.db.query("INSERT INTO nb_v2.denied VALUES($1)", [f.artifact.collection.records.find(r => r.detail.item.kind === "course")!.detail.item.id]);
          if (scenario === "publication" && reads === 1) await f.db.query("UPDATE nb_v2.state SET revision=revision+1");
          return f.bytes.get(m.objectKey)!; } } }));
      if (scenario !== "withdraw" && scenario !== "ancestor" && scenario !== "publication") assert.equal(reads, 0);
      if (scenario === "sql-limit") { assert.equal(budget.statistics().sqlQueries, 1); assert.equal(budget.statistics().failure, "MEDIA_ACCEPTANCE_SQL_LIMIT"); }
    } finally { budget.close(); await f.close(); }
  });
});
test("budget cancels a pending read, retains failed reservations and refuses excessive response bytes", async () => {
  const b = createMediaAcceptanceBudget({ durationMs: 20, sqlQueries: 1, sqlResponseBytes: 1, mediaResponseBytes: 1 });
  try {
    await assert.rejects(b.sql({ query: async () => { throw Error("Synthetic private SQL"); } }).query("SELECT 1"));
    assert.equal(b.statistics().sqlQueries, 1);
    await Promise.all([assert.rejects(b.wait(() => new Promise(() => {}))), new Promise(resolve => setTimeout(resolve, 40))]);
    assert.equal(b.statistics().failure, "MEDIA_ACCEPTANCE_DEADLINE");
  } finally { b.close(); }
  const extra = createMediaAcceptanceBudget({ durationMs: 1000, sqlQueries: 1, sqlResponseBytes: 1, mediaResponseBytes: 1 });
  try { assert.throws(() => extra.observe("mediaResponseBytes", 2), { code: "MEDIA_ACCEPTANCE_BYTE_LIMIT" }); assert.equal(extra.statistics().mediaResponseBytes, 2); }
  finally { extra.close(); }
});
test("actual CLI plans with no connections then verifies via one read-only Client and counted COS GETs", async () => {
  const f = await fixture();
  await writeFile(f.artifactPath, JSON.stringify(f.artifact), { mode: 0o600 });
  const thumbnailPath = join(f.root, "thumbnails.json"); await writeFile(thumbnailPath, JSON.stringify({ format: "media-acceptance-thumbnails-v1", entries: f.candidates }), { mode: 0o600 });
  const original = { connect: Client.prototype.connect, query: Client.prototype.query, end: Client.prototype.end, fetch: globalThis.fetch, log: console.log };
  let connections = 0, closed = 0, gets = 0, badMime = false; const output: string[] = [];
  Client.prototype.connect = (async function(this: Client & { connectionParameters: { options: string } }) { connections++;
    assert.equal(this.connectionParameters.options, "-c default_transaction_read_only=on"); return this; }) as typeof original.connect;
  Client.prototype.query = (function(_sql: string, values?: unknown[]) { return f.reader.query(_sql, values); }) as typeof original.query;
  Client.prototype.end = (async () => { closed++; }) as typeof original.end;
  globalThis.fetch = async (input, init) => {
    gets++; assert.equal(init?.method, "GET"); assert.equal(init?.redirect, "error");
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    assert.equal(url.origin, "https://fiction-12345.cos.ap-shanghai.myqcloud.com");
    const key = url.pathname.slice("/fiction/".length), bytes = f.bytes.get(key)!; assert.ok(bytes);
    return new Response(bytes, { headers: { "content-type": badMime ? "text/plain" : key === f.original.objectKey ? "image/png" : "image/webp", "content-length": String(bytes.length) } });
  }; console.log = value => output.push(String(value));
  const args = ["--config", join(f.root, "config.json"), "--artifact", f.artifactPath, "--thumbnails", thumbnailPath,
    "--duration-ms", "10000", "--sql-response-bytes", "1048576", "--control-bytes", "8192"];
  const env = { NODE_ENV: "test" as const, SYNC_READER_DATABASE_URL: f.options.database.readerUrl, STORAGE_PROVIDER: "cos",
    COS_BUCKET: "fiction-12345", COS_REGION: "ap-shanghai", COS_PREFIX: "fiction", COS_SECRET_ID: "fictionkey", COS_SECRET_KEY: "fiction-secret" };
  try {
    assert.equal(await mediaAcceptanceMain(["--help"], { NODE_ENV: "test" }), 0);
    assert.equal(await mediaAcceptanceMain(["plan", ...args], { NODE_ENV: "test" }), 0); const digest = JSON.parse(output.at(-1)!).planDigest;
    assert.equal(connections, 0); assert.equal(gets, 0);
    const scopePath = join(f.root, "scope.json"), scope = { format: "thumbnail-scope-v1", maxBindings: 200, maxObjects: 200, maxBytes: 32 * 1024 ** 2 };
    await writeFile(scopePath, JSON.stringify(scope), { mode: 0o600 });
    const scopedArgs = [...args, "--thumbnail-scope", scopePath];
    assert.equal(await mediaAcceptanceMain(["plan", ...scopedArgs], { NODE_ENV: "test" }), 0);
    const scopedDigest = JSON.parse(output.at(-1)!).planDigest; assert.notEqual(scopedDigest, digest);
    await writeFile(scopePath, JSON.stringify({ ...scope, maxBytes: scope.maxBytes - 1 }), { mode: 0o600 });
    await assert.rejects(mediaAcceptanceMain(["verify", ...scopedArgs, "--plan-sha256", scopedDigest], env), { code: "MEDIA_ACCEPTANCE_PLAN_CHANGED" });
    await writeFile(scopePath, JSON.stringify({ ...scope, maxObjects: 4001 }), { mode: 0o600 });
    await assert.rejects(mediaAcceptanceMain(["plan", ...scopedArgs], { NODE_ENV: "test" }), { code: "MEDIA_ACCEPTANCE_INPUT_INVALID" });
    assert.equal(connections, 0); assert.equal(gets, 0);
    await assert.rejects(mediaAcceptanceMain(["verify", ...args, "--plan-sha256", "0".repeat(64)], env), { code: "MEDIA_ACCEPTANCE_PLAN_CHANGED" });
    assert.equal(connections, 0); assert.equal(gets, 0);
    assert.equal(await mediaAcceptanceMain(["verify", ...args, "--plan-sha256", digest], env), 0);
    const report = JSON.parse(output.at(-1)!); assert.equal(report.outcome, "verified"); assert.equal(report.httpRequests, 2);
    assert.equal(report.counters.sqlQueries, 19); assert.equal(connections, 1); assert.equal(closed, 1); assert.equal(gets, 2);
    badMime = true;
    assert.equal(await mediaAcceptanceMain(["verify", ...args, "--plan-sha256", digest], env), 1);
    const bad = JSON.parse(output.at(-1)!); assert.equal(bad.errorCode, "MEDIA_ACCEPTANCE_OBJECT_MISMATCH");
    assert.equal(bad.httpRequests, 1); assert.equal(bad.counters.mediaResponseBytes, f.original.byteSize);
    assert.equal(connections, 2); assert.equal(closed, 2); assert.equal(gets, 3);
    let partial = false;
    globalThis.fetch = async (_input, init) => {
      gets++;
      const body = new ReadableStream<Uint8Array>({
        start(controller) { init!.signal!.addEventListener("abort", () => controller.error(new DOMException("Synthetic cancellation", "AbortError")), { once: true }); },
        pull(controller) { if (!partial) { partial = true; controller.enqueue(f.bytes.get(f.original.objectKey)!.subarray(0, 7)); }
          else queueMicrotask(() => process.emit("SIGTERM")); },
      });
      return new Response(body, { headers: { "content-type": "image/png", "content-length": String(f.original.byteSize) } });
    };
    assert.equal(await mediaAcceptanceMain(["verify", ...args, "--plan-sha256", digest], env), 1);
    const cancelled = JSON.parse(output.at(-1)!); assert.equal(cancelled.errorCode, "MEDIA_ACCEPTANCE_CANCELLED");
    assert.equal(cancelled.httpRequests, 1); assert.equal(cancelled.counters.mediaResponseBytes, 7);
    assert.equal(connections, 3); assert.equal(closed, 3); assert.equal(gets, 4);
    for (const secret of [env.COS_SECRET_KEY, env.SYNC_READER_DATABASE_URL, f.artifact.fullRunId, f.root, f.original.assetId]) assert.equal(output.join("\n").includes(secret), false);
    assert.throws(() => parseMediaAcceptanceArguments(["verify", ...args]));
  } finally { Client.prototype.connect = original.connect; Client.prototype.query = original.query; Client.prototype.end = original.end; globalThis.fetch = original.fetch; console.log = original.log; await f.close(); }
});
