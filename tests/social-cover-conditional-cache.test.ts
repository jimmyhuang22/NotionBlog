import test from "node:test";
import assert from "node:assert/strict";
import { hash } from "../scripts/social-sync/model.ts";
import { publicationCoverSource } from "../scripts/social-media/sources.ts";
import { prepareCover } from "../scripts/social-media/worker.ts";
import { coverReference } from "../src/server/social/covers.ts";
import { socialMediaResponse } from "../src/server/social/media.ts";
import { hasSafeMediaCachePolicy, MEDIA_REVALIDATE_CACHE_CONTROL } from "../src/server/media/cache.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";
import type { StoredMedia } from "../contracts/sync.ts";
import { coverTestEngine, coverTestImage } from "./helpers/social-cover-engine.ts";

async function fixture(t: Parameters<typeof coverTestEngine>[0]) {
  const e = await coverTestEngine(t), row = await e.add("BV0000000003", "work-a"), source = publicationCoverSource(row);
  const prepared = await prepareCover(source, await coverTestImage());
  await e.writer.register(source, "retained", prepared.files);
  const reference = coverReference(source.kind, source.key), path = `/media/social/${reference}`;
  let reads = 0;
  const storage = { put: async () => {}, read: async (m: StoredMedia) => { reads++; return prepared.bodies.get(m.sha256)!; } };
  const noStorage = () => { throw Error("a matching validator must not open object storage"); };
  const response = (etag: string | null = null, width: 400 | 800 | null = 400) => socialMediaResponse(reference, width, "retained", e.reader, () => storage, etag);
  return { ...e, row, source, prepared, reference, path, response, noStorage, reads: () => reads };
}

test("same bytes across source renewal validate without object IO; variants and invalid tags cannot reuse them", async t => {
  const e = await fixture(t), first = await e.response(), etag = first.headers.get("etag")!;
  assert.equal(first.status, 200); assert.match(etag, /^"sc1-[a-f0-9]{64}"$/);
  assert.equal(first.headers.get("cache-control"), MEDIA_REVALIDATE_CACHE_CONTROL);
  assert.equal(first.headers.get("cdn-cache-control"), "no-store"); assert.equal(first.headers.get("vercel-cdn-cache-control"), "no-store");
  assert.equal(hasSafeMediaCachePolicy(first, e.path), true);
  assert.deepEqual(Buffer.from(await first.arrayBuffer()), Buffer.from(e.prepared.bodies.get(e.prepared.files.previews["400"].sha256)!));
  e.row.coverUrl = "https://i0.hdslb.com/example.png?reference=renewed";
  e.row.observedAt = new Date(Date.parse(e.row.observedAt) + 1).toISOString();
  await e.worker.query("SELECT * FROM social_sync.ingest($1,$2,$3)", [e.source.key, hash(JSON.stringify(e.row)), JSON.stringify(e.row)]);
  await e.writer.register(publicationCoverSource(e.row), "retained", e.prepared.files);
  for (const tag of [etag, `W/${etag}`, `"other,tag", W/${etag}`, "*", `\t${etag}, "other" `, `, ,${etag},,`]) {
    let qualifications = 0;
    const reader: SqlExecutor = { query: async <T>(sql: string, values?: unknown[]) => { qualifications++; return e.reader.query<T>(sql, values); } };
    const response = await socialMediaResponse(e.reference, 400, "retained", reader, e.noStorage, tag);
    assert.equal(response.status, 304); assert.equal(qualifications, 2);
    assert.equal(response.headers.get("etag"), etag); assert.equal(response.headers.get("cache-control"), first.headers.get("cache-control"));
    assert.equal(response.headers.get("content-length"), null); assert.equal((await response.arrayBuffer()).byteLength, 0);
    assert.equal(hasSafeMediaCachePolicy(response, e.path), true);
  }
  assert.equal(e.reads(), 1);
  for (const invalid of ["sc1-unquoted", `${etag}, *`, `${etag}, broken`, "w/" + etag, "W/" + "x".repeat(8192), "\"unrelated\""]) {
    const before = e.reads(); assert.equal((await e.response(invalid)).status, 200); assert.equal(e.reads(), before + 1);
  }
  for (const width of [800, null] as const) {
    const response = await e.response(etag, width); assert.equal(response.status, 200); assert.notEqual(response.headers.get("etag"), etag);
  }
  assert.equal((await socialMediaResponse(e.reference, 400, "trial", e.reader, e.noStorage, etag)).status, 404);
});

test("a true image change sends verified new bytes and a new validator before later returning 304", async t => {
  const e = await fixture(t), old = (await e.response()).headers.get("etag")!;
  const replacement = await prepareCover(e.source, await coverTestImage(640, 480));
  await e.writer.register(e.source, "retained", replacement.files);
  const storage = { put: async () => {}, read: async (m: StoredMedia) => replacement.bodies.get(m.sha256)! };
  const response = await socialMediaResponse(e.reference, 400, "retained", e.reader, () => storage, old);
  assert.equal(response.status, 200); assert.notEqual(response.headers.get("etag"), old);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(replacement.bodies.get(replacement.files.previews["400"].sha256)!));
  assert.equal((await socialMediaResponse(e.reference, 400, "retained", e.reader, e.noStorage, response.headers.get("etag"))).status, 304);
  await assert.rejects(socialMediaResponse(e.reference, 400, "retained", e.reader,
    () => ({ put: async () => {}, read: async () => Buffer.from("corrupt") }), old));
});

test("a matching tag cannot authorize withdrawn, disabled or removed covers, including withdrawal between reads", async t => {
  const e = await fixture(t), etag = (await e.response()).headers.get("etag")!;
  let calls = 0;
  const during: SqlExecutor = { query: async <T>(sql: string, values?: unknown[]) => {
    if (++calls === 2) await e.db.query("UPDATE social_sync.works SET approved=false WHERE work_id=$1", [e.row.workId]);
    return e.reader.query<T>(sql, values);
  } };
  const withdrawn = await socialMediaResponse(e.reference, 400, "retained", during, e.noStorage, etag);
  assert.equal(withdrawn.status, 404); assert.equal(withdrawn.headers.get("etag"), null);
  assert.equal(withdrawn.headers.get("cache-control"), "private, no-store");
  assert.equal((await socialMediaResponse(e.reference, 400, "retained", e.reader, e.noStorage, "*")).status, 404);
  await e.db.query("UPDATE social_sync.works SET approved=true WHERE work_id=$1", [e.row.workId]);
  await e.db.query("UPDATE social_sync.bindings SET enabled=false WHERE publication_key=$1", [e.source.key]);
  assert.equal((await socialMediaResponse(e.reference, 400, "retained", e.reader, e.noStorage, etag)).status, 404);
  await e.db.query("UPDATE social_sync.bindings SET enabled=true WHERE publication_key=$1", [e.source.key]);
  e.row.coverUrl = null; e.row.observedAt = new Date(Date.parse(e.row.observedAt) + 1).toISOString();
  await e.worker.query("SELECT * FROM social_sync.ingest($1,$2,$3)", [e.source.key, hash(JSON.stringify(e.row)), JSON.stringify(e.row)]);
  assert.equal((await socialMediaResponse(e.reference, 400, "retained", e.reader, e.noStorage, etag)).status, 404);
});

test("a validator cannot suppress qualification errors or image replacement during revalidation", async t => {
  const e = await fixture(t), etag = (await e.response()).headers.get("etag")!;
  for (const failureAt of [1, 2]) {
    let calls = 0;
    const failing: SqlExecutor = { query: async <T>(sql: string, values?: unknown[]) => {
      if (++calls === failureAt) throw Error("private database failure");
      return e.reader.query<T>(sql, values);
    } };
    await assert.rejects(socialMediaResponse(e.reference, 400, "retained", failing, e.noStorage, etag), { code: "CONTENT_UNAVAILABLE" });
  }
  const replacement = await prepareCover(e.source, await coverTestImage(640, 480));
  let calls = 0;
  const changing: SqlExecutor = { query: async <T>(sql: string, values?: unknown[]) => {
    if (++calls === 2) await e.writer.register(e.source, "retained", replacement.files);
    return e.reader.query<T>(sql, values);
  } };
  await assert.rejects(socialMediaResponse(e.reference, 400, "retained", changing, e.noStorage, etag), { code: "CONTENT_UNAVAILABLE" });
});

test("the cache acceptance exception admits only qualified stable image 200/304 responses with validators", () => {
  const path = `/media/social/s2.publication.${"a".repeat(64)}?thumbnail=400`;
  const headers = { "Cache-Control": MEDIA_REVALIDATE_CACHE_CONTROL, ETag: `"sc1-${"b".repeat(64)}"`, "CDN-Cache-Control": "no-store", "Vercel-CDN-Cache-Control": "no-store" };
  for (const status of [200, 304]) assert.equal(hasSafeMediaCachePolicy(new Response(null, { status, headers }), path), true);
  for (const status of [302, 404, 503]) assert.equal(hasSafeMediaCachePolicy(new Response(null, { status, headers }), path), false);
  for (const other of ["/api/social/works", `/media/v2/a1.${"a".repeat(64)}`, `/media/social/s1.${"a".repeat(64)}`, "/media/social/s2.unknown." + "a".repeat(64)]) {
    assert.equal(hasSafeMediaCachePolicy(new Response(null, { headers }), other), false);
  }
  for (const change of [{ ETag: "" }, { "Cache-Control": "public, no-cache, must-revalidate" }, { "Cache-Control": "private, max-age=86400" }, { "CDN-Cache-Control": "max-age=60" }, { "Vercel-CDN-Cache-Control": "public, max-age=60" }]) {
    assert.equal(hasSafeMediaCachePolicy(new Response(null, { headers: { ...headers, ...change } }), path), false);
  }
});
