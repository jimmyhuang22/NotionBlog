import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { StoredMedia } from "../contracts/sync.ts";
import { createSupabaseStorage, TransientStorageReadError, type ObjectStorage } from "../src/server/database/storage.ts";
import { createCosStorage } from "../src/server/database/cos-storage.ts";
import { mediaIdentity } from "../src/server/database/validation.ts";
import { withMediaReadBudget } from "../src/server/media/read-budget.ts";
import { readMediaObject } from "../src/server/media/storage-read.ts";
import { createThumbnailByteReader, readThumbnailBytes } from "../src/server/media/thumbnail-bytes.ts";

function deferred<T = void>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(size = 32) {
  const bytes = Buffer.alloc(size); bytes.write("RIFF"); bytes.write("WEBP", 8);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const media: StoredMedia = { assetId: mediaIdentity("fixture-owner", "cover", sha256), ownerPageId: "fixture-owner",
    objectKey: `sha256/${sha256}`, sha256, byteSize: size, mime: "image/webp", width: 400, height: 300 };
  return { bytes, media };
}
const token = () => `e30.${Buffer.from(JSON.stringify({ role: "authenticated", exp: Date.now() / 1000 + 300,
  app_metadata: { notionblog_storage_role: "reader" } })).toString("base64url")}.fixture`;
const factories: Record<string, (fetcher: typeof fetch, credentialGate?: Promise<void>) => ObjectStorage> = {
  supabase: (fetcher, gate) => createSupabaseStorage({ url: "https://storage.example.test/storage/v1", bucket: "fixture-media",
    apiKey: "sb_publishable_fixture", token: gate ? async () => { await gate; return token(); } : token(), role: "reader", fetch: fetcher }),
  cos: (fetcher, gate) => createCosStorage({ bucket: "fixture-media-123456789", region: "ap-shanghai", prefix: "notionblog", role: "reader",
    credentials: gate ? async () => { await gate; return { secretId: "fixtureSecretId", secretKey: "fixtureSecretKey" }; }
      : { secretId: "fixtureSecretId", secretKey: "fixtureSecretKey" }, fetch: fetcher }),
};

for (const [provider, factory] of Object.entries(factories)) {
  test(`${provider}: cancellation aborts the real storage transport before headers and never selects fallback`, async () => {
    const f = fixture(), started = deferred<AbortSignal>(), controller = new AbortController();
    const storage = factory(async (_url, init) => {
      const signal = init!.signal!; started.resolve(signal);
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    });
    const result = storage.read(f.media, controller.signal);
    const rejected = assert.rejects(result, error => !(error instanceof TransientStorageReadError));
    const transport = await started.promise;
    controller.abort(new DOMException("Read deadline", "TimeoutError"));
    await rejected; assert.equal(transport.aborted, true);
  });

  test(`${provider}: an image deadline cancels an already-streaming response body`, async () => {
    const f = fixture(), started = deferred(), stopped = deferred(); let produced = 0;
    const storage = factory(async (_url, init) => new Response(new ReadableStream({
      start(stream) {
        stream.enqueue(f.bytes.subarray(0, 12)); produced += 12; started.resolve();
        init!.signal!.addEventListener("abort", () => { stream.error(init!.signal!.reason); stopped.resolve(); }, { once: true });
      },
    })));
    const result = withMediaReadBudget(new AbortController().signal, () => readMediaObject(storage, f.media), 25);
    const rejected = assert.rejects(result, { code: "CONTENT_UNAVAILABLE" });
    // Keep the test event loop live while AbortSignal.timeout's unref timer expires.
    const keepAlive = setTimeout(() => {}, 1000);
    try { await started.promise; await rejected; await stopped.promise; assert.equal(produced, 12); }
    finally { clearTimeout(keepAlive); }
  });

  test(`${provider}: abort before or during credential acquisition cannot start an object request`, async () => {
    const f = fixture(), gate = deferred(); let requests = 0;
    const storage = factory(async () => { requests++; return new Response(f.bytes); }, gate.promise);
    const pre = new AbortController(); pre.abort();
    await assert.rejects(storage.read(f.media, pre.signal));
    const waiting = new AbortController(), result = storage.read(f.media, waiting.signal);
    waiting.abort(); gate.resolve(); await assert.rejects(result);
    assert.equal(requests, 0);
  });

  test(`${provider}: a departing thumbnail leader cannot cancel its surviving waiter`, async () => {
    const f = fixture(), started = deferred<AbortSignal>(), release = deferred(); let requests = 0;
    const storage = factory(async (_url, init) => {
      requests++; const signal = init!.signal!; started.resolve(signal); await release.promise;
      signal.throwIfAborted(); return new Response(f.bytes);
    });
    const first = new AbortController(), second = new AbortController();
    const a = withMediaReadBudget(first.signal, () => readThumbnailBytes(storage, f.media));
    const rejected = assert.rejects(a, { code: "CONTENT_UNAVAILABLE" });
    const transport = await started.promise;
    const b = withMediaReadBudget(second.signal, () => readThumbnailBytes(storage, f.media));
    first.abort(); await rejected; assert.equal(transport.aborted, false);
    release.resolve(); assert.deepEqual(Buffer.from((await b).bytes), f.bytes);
    assert.equal(requests, 1); assert.equal((await readThumbnailBytes(storage, f.media)).source, "hit");
  });
}

test("the last thumbnail waiter cancels transport; a late old failure cannot remove the new entry", async () => {
  const f = fixture(), old = deferred<Uint8Array>(), fresh = deferred<Uint8Array>(), started = deferred<AbortSignal>(); let requests = 0;
  const read = createThumbnailByteReader({ put: async () => assert.fail("read only"), read: async (_media, signal) => {
    if (++requests === 1) { started.resolve(signal!); return old.promise; }
    return fresh.promise;
  } });
  const first = new AbortController(), second = new AbortController();
  const a = read(f.media, first.signal), b = read(f.media, second.signal);
  const rejected = Promise.all([assert.rejects(a), assert.rejects(b)]), transport = await started.promise;
  second.abort(); assert.equal(transport.aborted, false);
  first.abort(); await rejected; assert.equal(transport.aborted, true);
  const c = read(f.media); old.reject(new Error("abandoned old transport"));
  await new Promise(resolve => setImmediate(resolve));
  const d = read(f.media); fresh.resolve(f.bytes);
  assert.equal((await c).source, "miss"); assert.equal((await d).source, "coalesced");
  assert.equal((await read(f.media)).source, "hit"); assert.equal(requests, 2);
});

test("cancelled pending downloads retain their byte reservation until the transport settles", async () => {
  const f = fixture(1024 * 1024), gate = deferred(); let requests = 0;
  const read = createThumbnailByteReader({ put: async () => assert.fail("read only"), read: async () => { requests++; await gate.promise; return f.bytes; } });
  const controller = new AbortController();
  const descriptors = Array.from({ length: 16 }, (_, i) => ({ ...f.media, ownerPageId: `owner-${i}`,
    assetId: mediaIdentity(`owner-${i}`, "cover", f.media.sha256) }));
  const pending = descriptors.map(media => read(media, controller.signal));
  const rejected = Promise.all(pending.map(promise => assert.rejects(promise)));
  await new Promise(resolve => setImmediate(resolve)); controller.abort(); await rejected;
  const overflow = read(f.media); gate.resolve(); assert.equal((await overflow).source, "bypass");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await read(f.media)).source, "miss"); assert.equal(requests, 18);
});

test("oversized thumbnail bypass reads inherit the caller cancellation signal", async () => {
  const f = fixture(1024 * 1024 + 1), controller = new AbortController(), started = deferred<AbortSignal>();
  const read = createThumbnailByteReader({ put: async () => assert.fail("read only"), read: async (_media, signal) => {
    started.resolve(signal!); return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
  } });
  const result = read(f.media, controller.signal), rejected = assert.rejects(result);
  assert.equal(await started.promise, controller.signal); controller.abort(); await rejected;
});

test("falsy transport rejections reject all thumbnail waiters without leaving an entry", async () => {
  const f = fixture(); let requests = 0;
  const read = createThumbnailByteReader({ put: async () => assert.fail("read only"), read: async () => {
    if (++requests === 1) throw undefined;
    return f.bytes;
  } });
  const results = await Promise.allSettled([read(f.media), read(f.media)]);
  assert.deepEqual(results, [{ status: "rejected", reason: undefined }, { status: "rejected", reason: undefined }]);
  assert.equal((await read(f.media)).source, "miss"); assert.equal(requests, 2);
});
