import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { StoredMedia } from "../contracts/sync.ts";
import { mediaIdentity } from "../src/server/database/validation.ts";
import { TransientStorageReadError, type ObjectStorage } from "../src/server/database/storage.ts";
import { createThumbnailByteReader, readThumbnailBytes } from "../src/server/media/thumbnail-bytes.ts";

function fixture(size = 32) {
  const bytes = Buffer.alloc(size);
  bytes.write("RIFF"); bytes.write("WEBP", 8);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const descriptor = (ownerPageId = "example-owner"): StoredMedia => ({
    assetId: mediaIdentity(ownerPageId, "thumbnail:800:fixture", sha256), ownerPageId,
    objectKey: `sha256/${sha256}`, sha256, byteSize: bytes.length, mime: "image/webp", width: 800, height: 600,
  });
  return { bytes, media: descriptor(), descriptor };
}
function storage(read: ObjectStorage["read"]): ObjectStorage {
  return { read, put: async () => assert.fail("Thumbnail delivery must not write objects") };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("repeated and simultaneous reads reuse one verified object but return isolated copies", async () => {
  const f = fixture(), gate = deferred(); let requests = 0;
  const read = createThumbnailByteReader(storage(async () => { requests++; await gate.promise; return f.bytes; }));
  const pending = [read(f.media), read(f.media), read(f.media)];
  gate.resolve();
  const [first, second, third] = await Promise.all(pending);
  assert.equal(requests, 1);
  assert.deepEqual([first.source, second.source, third.source], ["miss", "coalesced", "coalesced"]);
  first.bytes.fill(255); f.bytes.fill(0);
  assert.notDeepEqual(first.bytes, second.bytes);
  assert.deepEqual(third.bytes, second.bytes);
  const hit = await read(f.media); assert.equal(hit.source, "hit");
  assert.deepEqual(hit.bytes, second.bytes); assert.equal(requests, 1);
});

test("object failures and invalid bytes are not retained or retried within a request", async () => {
  for (const transient of [true, false]) {
    const f = fixture(); let requests = 0;
    const read = createThumbnailByteReader(storage(async () => {
      requests++;
      if (requests === 1) {
        if (transient) throw new TransientStorageReadError();
        return Buffer.alloc(f.bytes.length);
      }
      return f.bytes;
    }));
    await assert.rejects(read(f.media)); assert.equal(requests, 1);
    assert.equal((await read(f.media)).source, "miss");
    assert.equal((await read(f.media)).source, "hit"); assert.equal(requests, 2);
  }
});

test("a failed shared download rejects every waiting request and permits a later new attempt", async () => {
  const f = fixture(), gate = deferred(); let requests = 0;
  const read = createThumbnailByteReader(storage(async () => {
    requests++; await gate.promise;
    if (requests === 1) throw new TransientStorageReadError();
    return f.bytes;
  }));
  const waiting = Promise.allSettled([read(f.media), read(f.media)]);
  gate.resolve();
  assert.deepEqual((await waiting).map(x => x.status), ["rejected", "rejected"]);
  assert.equal(requests, 1);
  assert.equal((await read(f.media)).source, "miss"); assert.equal(requests, 2);
});

test("completed bytes expire five minutes after verification; hits do not extend retention", async () => {
  const f = fixture(); let time = 0, requests = 0;
  const read = createThumbnailByteReader(storage(async () => { requests++; time += 100; return f.bytes; }), () => time);
  await read(f.media);
  time = 300099; assert.equal((await read(f.media)).source, "hit");
  time = 300100; assert.equal((await read(f.media)).source, "miss"); assert.equal(requests, 2);
});

test("full descriptors and storage instances are isolated, including changed dimensions and owner", async () => {
  const f = fixture(); let firstRequests = 0, secondRequests = 0;
  const first = storage(async () => { firstRequests++; return f.bytes; });
  const second = storage(async () => { secondRequests++; throw new Error("other credentials denied"); });
  await readThumbnailBytes(first, f.media);
  for (const changed of [{ ...f.media, width: 400 }, f.descriptor("another-owner")]) {
    assert.equal((await readThumbnailBytes(first, changed)).source, "miss");
  }
  assert.equal((await readThumbnailBytes(first, f.media)).source, "hit");
  await assert.rejects(readThumbnailBytes(second, f.media));
  await assert.rejects(readThumbnailBytes(first, { ...f.media, byteSize: f.bytes.length + 1 }));
  assert.equal(firstRequests, 4); assert.equal(secondRequests, 1);
});

test("descriptor mutation during download cannot alter the reserved cache identity", async () => {
  const f = fixture(), gate = deferred(); let requests = 0;
  const read = createThumbnailByteReader(storage(async media => {
    requests++; await gate.promise; assert.deepEqual(media, f.descriptor()); return f.bytes;
  }));
  const input = { ...f.media }, pending = read(input);
  input.ownerPageId = "mutated"; input.byteSize++;
  gate.resolve(); await pending;
  assert.equal((await read(f.media)).source, "hit"); assert.equal(requests, 1);
});

test("entry and byte budgets evict old completed objects without retaining oversized objects", async () => {
  for (const [size, count] of [[32, 129], [1024 * 1024, 17]]) {
    const f = fixture(size); let requests = 0;
    const read = createThumbnailByteReader(storage(async () => { requests++; return f.bytes; }));
    for (let i = 0; i < count; i++) await read(f.descriptor(`owner-${i}`));
    assert.equal((await read(f.descriptor(`owner-${count - 1}`))).source, "hit");
    assert.equal((await read(f.descriptor("owner-0"))).source, "miss"); assert.equal(requests, count + 1);
  }
  const large = fixture(1024 * 1024 + 1); let requests = 0;
  const read = createThumbnailByteReader(storage(async () => { requests++; return large.bytes; }));
  assert.equal((await read(large.media)).source, "bypass");
  assert.equal((await read(large.media)).source, "bypass"); assert.equal(requests, 2);
});

test("pending byte reservations are bounded and an existing in-flight object still coalesces at capacity", async () => {
  const f = fixture(1024 * 1024), gate = deferred(); let requests = 0;
  const read = createThumbnailByteReader(storage(async () => { requests++; await gate.promise; return f.bytes; }));
  const pending = Array.from({ length: 16 }, (_, i) => read(f.descriptor(`owner-${i}`)));
  const coalesced = read(f.descriptor("owner-0")), bypassed = read(f.descriptor("overflow"));
  gate.resolve(); await Promise.all(pending);
  assert.equal((await coalesced).source, "coalesced"); assert.equal((await bypassed).source, "bypass");
  assert.equal(requests, 17);
  assert.equal((await read(f.descriptor("overflow"))).source, "miss"); assert.equal(requests, 18);
});
