import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { copyCapturedMedia, type CapturedMediaEvent } from "../scripts/website-incremental-sync/captured-media.ts";
import { createLocalMediaStorage } from "../src/server/database/local-storage.ts";
import { mediaIdentity } from "../src/server/database/website-validation.ts";

test("captured media copies real immutable bytes once and stops at an uncertain write", async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "captured-media-"))); t.after(() => rm(directory, {recursive: true, force: true}));
  const bytes = await Promise.all(["red", "blue"].map(background => sharp({create: {width: 2, height: 2, channels: 4, background}}).png().toBuffer()));
  const media = bytes.map((data, i) => {const hash = createHash("sha256").update(data).digest("hex"), owner = `owner-${i}`;
    return {assetId: mediaIdentity(owner, "cover", hash), ownerPageId: owner, sha256: hash, objectKey: `sha256/${hash}`, byteSize: data.length, mime: "image/png" as const, width: 2, height: 2};});
  const storage = createLocalMediaStorage(directory, "postgresql://fixture@127.0.0.1/fixture", "writer");
  const events: CapturedMediaEvent[] = [], input = {media: [media[0], {...media[0], ownerPageId: "other", assetId: mediaIdentity("other", "cover", media[0].sha256)}, media[1]],
    maxBytes: 1048576, storage, readLocal: async (m: {sha256: string}) => bytes.find(b => createHash("sha256").update(b).digest("hex") === m.sha256)!, record: async (event: CapturedMediaEvent) => {events.push(event);}};
  assert.equal((await copyCapturedMedia(input, new AbortController().signal)).objects, 2);
  assert.deepEqual(await storage.read(media[0]), bytes[0]); assert.deepEqual(events.map(e => e.phase), ["sending", "stored", "sending", "stored"]);
  let attempts = 0; events.length = 0;
  await assert.rejects(copyCapturedMedia({...input, storage: {put: async (m, data) => {attempts++; await storage.put(m, data); throw Error("Lost reply");}}}, new AbortController().signal), /CAPTURE_MEDIA_OUTCOME_UNKNOWN/);
  assert.equal(attempts, 1); assert.deepEqual(events.map(e => e.phase), ["sending", "unconfirmed"]);
  events.length = 0;
  await assert.rejects(copyCapturedMedia({...input, readLocal: async () => Buffer.from("corrupt")}, new AbortController().signal));
  assert.equal(events.length, 0);
  const controller = new AbortController(); events.length = 0;
  await assert.rejects(copyCapturedMedia({...input, record: async event => {events.push(event); if (event.phase === "sending") controller.abort();},
    storage: {put: async () => assert.fail("Cancellation before send cannot write")}}, controller.signal));
  assert.deepEqual(events.map(e => e.phase), ["sending", "not-sent"]);
});
