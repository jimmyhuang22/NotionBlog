import test from "node:test";
import assert from "node:assert/strict";
import { publicHttpResponse } from "../src/server/public-cache/http.ts";
import { excludeFromSharedCache } from "../src/server/public-cache/policy.ts";
import { cacheableMediaHeaders, hasSafeMediaCachePolicy, MEDIA_REVISIT_CACHE_CONTROL, MEDIA_REVALIDATE_CACHE_CONTROL } from "../src/server/media/cache.ts";
import { socialMediaResponse } from "../src/server/social/media.ts";
import { versionedCoverReference, coverReference } from "../src/server/social/covers.ts";
import { publicationCoverSource } from "../scripts/social-media/sources.ts";
import { prepareCover } from "../scripts/social-media/worker.ts";
import { coverTestEngine, coverTestImage } from "./helpers/social-cover-engine.ts";

function activate(t: test.TestContext) {
  const previous = { ...process.env };
  Object.assign(process.env, { VERCEL: "", PUBLIC_CONTENT_CACHE: "tagged-v1", CONTENT_PROVIDER: "database", DATABASE_CONTENT_VERSION: "2", DATABASE_PUBLICATION_MODE: "qualified", PUBLIC_CACHE_SITE_KEY: "fixture", CACHE_PURGE_SECRET: "a".repeat(64), PUBLIC_CACHE_ORIGIN: "https://example.test" });
  delete process.env.PUBLIC_CACHE_PURGE_SECRET;
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous); });
}
const digest = "a".repeat(64), etag = `"pc1-${digest}"`;
const url = `https://example.test/media/v2/a1.${digest}?thumbnail=400`;
const bytes = () => new Response("image", { headers: cacheableMediaHeaders({ ETag: etag }) });

test("qualified versioned images keep a one-day private window on GET, HEAD and both 304 paths", async t => {
  activate(t);
  assert.equal(MEDIA_REVISIT_CACHE_CONTROL, "private, max-age=86400, must-revalidate");
  for (const path of [`/media/v2/a1.${digest}`, `/media/social/s1.${digest}`, `/media/social/s3.publication.${digest}.${digest}`, `/media/social/s3.collection.${digest}.${digest}`]) {
    for (const method of ["GET", "HEAD"]) {
      const request = new Request(`https://example.test${path}?thumbnail=400`, { method });
      const full = await publicHttpResponse(request, bytes(), "media");
      assert.equal(full.status, 200);
      assert.equal(full.headers.get("Cache-Control"), MEDIA_REVISIT_CACHE_CONTROL);
      assert.equal(full.headers.get("CDN-Cache-Control"), "no-store");
      assert.equal(full.headers.get("ETag"), etag);
      assert.equal(hasSafeMediaCachePolicy(full, request.url), true);
      assert.equal(await full.text(), method === "HEAD" ? "" : "image");
      const conditional = new Request(request, { headers: { "If-None-Match": etag } });
      for (const source of [bytes(), new Response(null, { status: 304, headers: cacheableMediaHeaders({ ETag: etag }) })]) {
        const result = await publicHttpResponse(conditional, source, "media");
        assert.equal(result.status, 304);
        assert.equal(result.headers.get("Cache-Control"), MEDIA_REVISIT_CACHE_CONTROL);
        assert.equal(await result.text(), "");
      }
    }
  }
});

test("freshness requires a qualified response and never extends live, mutable, API or failed responses", async t => {
  activate(t);
  for (const response of [excludeFromSharedCache(bytes()), new Response("image", { headers: { "Cache-Control": "private, no-store" } }), new Response("image")]) {
    const result = await publicHttpResponse(new Request(url), response, "media");
    assert.equal(result.headers.get("Cache-Control"), MEDIA_REVALIDATE_CACHE_CONTROL);
  }
  for (const path of [`/media/social/s2.publication.${digest}`, `/media/a1.${digest}`, "/api/content/status"]) {
    const result = await publicHttpResponse(new Request(`https://example.test${path}`), bytes(), "media");
    assert.equal(result.headers.get("Cache-Control"), MEDIA_REVALIDATE_CACHE_CONTROL);
  }
  for (const scope of ["content", "home", "social"] as const) {
    assert.equal((await publicHttpResponse(new Request(url), bytes(), scope)).headers.get("Cache-Control"), MEDIA_REVALIDATE_CACHE_CONTROL);
  }
  for (const status of [302, 400, 404, 503]) {
    const failed = new Response(null, { status, headers: { "Cache-Control": "private, no-store" } });
    const result = await publicHttpResponse(new Request(url, { headers: { "If-None-Match": etag } }), failed, "media");
    assert.equal(result, failed);
    assert.equal(result.headers.get("Cache-Control"), "private, no-store");
  }
  const cookie = bytes(); cookie.headers.set("Set-Cookie", "fixture=1");
  assert.equal(await publicHttpResponse(new Request(url), cookie, "media"), cookie);
  const post = bytes(); assert.equal(await publicHttpResponse(new Request(url, { method: "POST" }), post, "media"), post);
  process.env.PUBLIC_CONTENT_CACHE = "disabled";
  const legacy = bytes(); assert.equal(await publicHttpResponse(new Request(url), legacy, "media"), legacy);
});

test("visitor acceptance rejects longer windows, stale reuse and freshness on mutable URLs", async t => {
  activate(t);
  const good = await publicHttpResponse(new Request(url), bytes(), "media");
  for (const control of ["private, max-age=301, must-revalidate", "private, max-age=86401, must-revalidate", "private, max-age=86400, stale-if-error=60", "public, max-age=86400, must-revalidate", "private, max-age=86400, must-revalidate, immutable"]) {
    const headers = new Headers(good.headers); headers.set("Cache-Control", control);
    assert.equal(hasSafeMediaCachePolicy(new Response(null, { headers }), url), false);
  }
  for (const path of [`/media/social/s2.publication.${digest}`, "/api/content/status"]) assert.equal(hasSafeMediaCachePolicy(good, path), false);
  for (const status of [302, 404, 503]) assert.equal(hasSafeMediaCachePolicy(new Response(null, { status, headers: good.headers }), url), false);
});

test("real social qualification preserves early 304 and withdrawal with the one-day revisit window", async t => {
  activate(t);
  const engine = await coverTestEngine(t), row = await engine.add("BV0000000003", "work-a");
  const source = publicationCoverSource(row), prepared = await prepareCover(source, await coverTestImage());
  await engine.writer.register(source, "retained", prepared.files);
  const reference = versionedCoverReference(source.kind, source.key, prepared.files);
  const path = `https://example.test/media/social/${reference}?thumbnail=400`;
  let objects = 0;
  const storage = () => ({ put: async () => {}, read: async (m: { sha256: string }) => { objects++; return prepared.bodies.get(m.sha256)!; } });
  const call = async (tag: string | null = null) => publicHttpResponse(new Request(path, { headers: tag ? { "If-None-Match": tag } : {} }), await socialMediaResponse(reference, 400, "retained", engine.reader, storage, tag), "media");
  const first = await call(); assert.equal(first.status, 200); assert.equal(first.headers.get("Cache-Control"), MEDIA_REVISIT_CACHE_CONTROL);
  const tag = first.headers.get("ETag")!;
  const validated = await call(tag); assert.equal(validated.status, 304); assert.equal(validated.headers.get("Cache-Control"), MEDIA_REVISIT_CACHE_CONTROL); assert.equal(objects, 1);
  const mutable = coverReference(source.kind, source.key);
  const mutableResponse = await publicHttpResponse(new Request(`https://example.test/media/social/${mutable}`), await socialMediaResponse(mutable, 400, "retained", engine.reader, storage), "media");
  assert.equal(mutableResponse.headers.get("Cache-Control"), MEDIA_REVALIDATE_CACHE_CONTROL);
  await engine.db.query("UPDATE social_sync.works SET approved=false WHERE work_id=$1", [row.workId]);
  const withdrawn = await call(tag); assert.equal(withdrawn.status, 404); assert.equal(withdrawn.headers.get("Cache-Control"), "private, no-store");
});
