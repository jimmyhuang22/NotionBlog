import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, mkdir, readFile, readdir, writeFile, chmod, symlink, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createWebsiteImageCache, imageCacheKey } from "../scripts/website-sync/image-cache.ts";
import { createWebsiteImageDownloader } from "../scripts/website-sync/download.ts";
import { WorkerError } from "../scripts/notion-sync/errors.ts";
import { DEMO_PNG } from "../scripts/notion-sync/demo.ts";
import type { ImageResponse } from "../scripts/notion-sync/download.ts";

const url = "https://images.example.test/original.png", agent = "NotionBlogSyncBot/1.0";
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const dns = async () => [{ address: "8.8.8.8", family: 4 }];
const rejected = (error: unknown) => error instanceof WorkerError && error.code === "IMAGE_REJECTED";
function response(status: number, etag?: string, bytes = DEMO_PNG, extra: Record<string, string> = {}): ImageResponse {
  return { status, headers: { "content-type": "image/png", ...(etag ? { etag } : {}), ...extra },
    bytes: (async function* () { assert.notEqual(status, 304, "304 response body must never be read"); yield bytes; })(), cancel() {} };
}
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "website-image-cache-"))); await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "cache"), cache = await createWebsiteImageCache({ directory });
  return { root, directory, cache };
}

test("image cache downloads once then revalidates without consuming another response body", async t => {
  const { cache } = await fixture(t); let calls = 0;
  const download = createWebsiteImageDownloader({ resolve: dns, request: async (_url, _address, _signal, headers) => {
    if (++calls === 1) { assert.equal(headers["If-None-Match"], undefined); return response(200, '"first"'); }
    assert.equal(headers["If-None-Match"], '"first"'); return response(304, '"first"');
  } }, { cache });
  assert.deepEqual((await download(url)).bytes, DEMO_PNG); assert.deepEqual((await download(url)).bytes, DEMO_PNG);
  assert.deepEqual(download.statistics(), { requests: 2, receivedBodyBytes: DEMO_PNG.length, revalidatedImages: 1, reusedBytes: DEMO_PNG.length,
    downloadedImages: 1, rateLimitResponses: 0, lastRetryAfterSeconds: null });
});
test("changed origin replaces the validator and cached original only after verified bytes", async t => {
  const { cache } = await fixture(t); const changed = Buffer.concat([DEMO_PNG, Buffer.from([1])]); let calls = 0;
  const download = createWebsiteImageDownloader({ resolve: dns, request: async (_url, _address, _signal, h) => {
    if (++calls === 1) return response(200, '"first"');
    if (calls === 2) { assert.equal(h["If-None-Match"], '"first"'); return response(200, '"second"', changed); }
    assert.equal(h["If-None-Match"], '"second"'); return response(304, '"second"');
  } }, { cache });
  await download(url); assert.deepEqual((await download(url)).bytes, changed); assert.deepEqual((await download(url)).bytes, changed);
  assert.equal(download.statistics().receivedBodyBytes, DEMO_PNG.length + changed.length);
});
test("weak validators, wildcard variants, and no-store responses do not prime the cache", async t => {
  for (const [etag, extra] of [[undefined, {}], ['W/"weak"', {}], ['"tag"', { vary: "*" }], ['"tag"', { "cache-control": "private, no-store" }]] as const) {
    const { cache } = await fixture(t); let calls = 0;
    const download = createWebsiteImageDownloader({ resolve: dns, request: async (_url, _address, _signal, h) => {
      calls++; assert.equal(h["If-None-Match"], undefined); return response(200, etag, DEMO_PNG, extra);
    } }, { cache });
    await download(url); await download(url); assert.equal(calls, 2); assert.equal(download.statistics().revalidatedImages, 0);
  }
});
test("a cached original never masks denial, rate limiting, or invalid 304 evidence", async t => {
  for (const [status, etag, extra] of [[403, undefined, {}], [404, undefined, {}], [429, undefined, {}], [304, undefined, {}], [304, 'W/"first"', {}], [304, '"other"', {}], [304, '"first"', { vary: "*" }], [304, '"first"', { "content-type": "image/jpeg" }]] as const) {
    const { cache } = await fixture(t); let calls = 0;
    const download = createWebsiteImageDownloader({ resolve: dns, request: async () => ++calls === 1 ? response(200, '"first"') : response(status, etag, DEMO_PNG, extra) },
      { cache, wait: async () => assert.fail("No cache fallback retries") });
    await download(url); await assert.rejects(download(url)); assert.equal(calls, 2); assert.equal(download.statistics().revalidatedImages, 0);
  }
});
test("missing or corrupt cached bytes cause an unconditional safe download and repair", async t => {
  const { directory, cache } = await fixture(t); let calls = 0;
  const download = createWebsiteImageDownloader({ resolve: dns, request: async (_url, _address, _signal, h) => {
    calls++; assert.equal(h["If-None-Match"], undefined); return response(200, '"first"');
  } }, { cache });
  await download(url); const path = join(directory, "sha256", sha(DEMO_PNG));
  await writeFile(path, Buffer.from("corrupt")); await download(url); assert.deepEqual(await readFile(path), DEMO_PNG);
  await rm(path); await download(url); assert.equal(calls, 3);
});
test("existing private mirror is reused by hash without copying or changing its index", async t => {
  const { root } = await fixture(t), mirror = join(root, "mirror"); await mkdir(mirror, { mode: 0o700 }); await mkdir(join(mirror, "sha256"), { mode: 0o700 });
  await writeFile(join(mirror, "sha256", sha(DEMO_PNG)), DEMO_PNG, { mode: 0o600 });
  await writeFile(join(mirror, "index-private.json"), "original index", { mode: 0o600 });
  const directory = join(root, "mirror-cache"), cache = await createWebsiteImageCache({ directory, originalsDirectory: mirror }); let calls = 0;
  const download = createWebsiteImageDownloader({ resolve: dns, request: async () => response(++calls === 1 ? 200 : 304, '"first"') }, { cache });
  await download(url); await download(url); assert.deepEqual(await readdir(join(directory, "sha256")), []);
  assert.equal(await readFile(join(mirror, "index-private.json"), "utf8"), "original index"); assert.equal(download.statistics().revalidatedImages, 1);
  await assert.rejects(createWebsiteImageCache({ directory: mirror, originalsDirectory: mirror }));
  await assert.rejects(createWebsiteImageCache({ directory: join(mirror, "nested-cache"), originalsDirectory: mirror }));
  assert.deepEqual((await readdir(mirror)).sort(), ["index-private.json", "sha256"]);
});
test("cache rejects unsafe file permissions, symlinks and directories before any request", async t => {
  const { root, directory, cache } = await fixture(t);
  const download = createWebsiteImageDownloader({ resolve: dns, request: async () => response(200, '"first"') }, { cache });
  await download(url); const object = join(directory, "sha256", sha(DEMO_PNG)); await chmod(object, 0o644);
  const noRequest = createWebsiteImageDownloader({ resolve: dns, request: async () => assert.fail("Unsafe cache must not reach origin") }, { cache });
  await assert.rejects(noRequest(url), error => error instanceof WorkerError && error.code === "MISCONFIGURED");
  await chmod(object, 0o600); await rm(object); await symlink(join(root, "elsewhere"), object); await assert.rejects(noRequest(url));
  await chmod(directory, 0o755); await assert.rejects(createWebsiteImageCache({ directory }));
});
test("cache hits still enforce fresh DNS, redirect checks, cancellation and image limits", async t => {
  const { cache } = await fixture(t); await createWebsiteImageDownloader({ resolve: dns, request: async () => response(200, '"first"') }, { cache })(url);
  await assert.rejects(createWebsiteImageDownloader({ resolve: async () => [...await dns(), { address: "10.0.0.1", family: 4 }], request: async () => assert.fail("No private origin") }, { cache })(url), rejected);
  await assert.rejects(createWebsiteImageDownloader({ resolve: dns, maxBytes: 2, request: async () => response(304, '"first"') }, { cache })(url), rejected);
  await assert.rejects(createWebsiteImageDownloader({ resolve: dns, request: async () => response(302, undefined, DEMO_PNG, { location: "https://127.0.0.1/private" }) }, { cache })(url), rejected);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(createWebsiteImageDownloader({ resolve: dns, request: async () => assert.fail("No aborted request") }, { cache })(url, controller.signal));
});
test("S3 authentication rotation preserves the key while semantic queries and negotiation remain separate", () => {
  const signed = (example: string) => {
    const value = new URL("https://example.s3.us-west-2.amazonaws.com/file.png");
    for (const [key, field] of Object.entries({ "X-Amz-Algorithm": "AWS4-HMAC-SHA256", "X-Amz-SignedHeaders": "host", versionId: "one", "X-Amz-Date": example, "X-Amz-Signature": example })) value.searchParams.set(key, field);
    return value;
  };
  assert.equal(imageCacheKey(signed("first"), agent), imageCacheKey(signed("second"), agent));
  const anotherVersion = signed("first"); anotherVersion.searchParams.set("versionId", "two");
  assert.notEqual(imageCacheKey(signed("first"), agent), imageCacheKey(anotherVersion, agent));
  const externalFirst = new URL(url), externalSecond = new URL(url);
  externalFirst.searchParams.set("signature", "first"); externalSecond.searchParams.set("signature", "second");
  assert.notEqual(imageCacheKey(externalFirst, agent), imageCacheKey(externalSecond, agent));
  assert.notEqual(imageCacheKey(new URL(url), agent), imageCacheKey(new URL(url), "another bot"));
  const encoded = signed("first"), plus = signed("second"); encoded.search += "&variant=a%20b"; plus.search += "&variant=a+b";
  assert.notEqual(imageCacheKey(encoded, agent), imageCacheKey(plus, agent));
});
