import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyCoverObjects, type CoverCopyReceipt } from "../scripts/social-media/migrate.ts";
import { socialReaderTransport } from "../src/server/social/media-storage.ts";
import { createCosCoverSession } from "../scripts/social-media/cos-session.ts";
import type { StoredMedia } from "../contracts/sync.ts";

const bytes = Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
const sha = createHash("sha256").update(bytes).digest("hex");
const file: StoredMedia = { assetId: `a1.${"a".repeat(64)}`, ownerPageId: "fiction-cover", objectKey: `sha256/${sha}`, sha256: sha,
  byteSize: bytes.length, mime: "image/png", width: null, height: null };

test("COS worker uses separate writer and reader identities without constructing any Supabase session", async () => {
  const calls: Array<{ method: string; authorization: string }> = [];
  const env = { SOCIAL_MEDIA_STORAGE_PROVIDER: "cos", SOCIAL_MEDIA_COS_BUCKET: "fiction-media-123456789", SOCIAL_MEDIA_COS_REGION: "ap-shanghai", SOCIAL_MEDIA_COS_PREFIX: "fiction",
    SOCIAL_MEDIA_COS_WRITER_SECRET_ID: "FixtureWriterIdentity", SOCIAL_MEDIA_COS_WRITER_SECRET_KEY: "fiction-writer-secret",
    SOCIAL_MEDIA_COS_READER_SECRET_ID: "FixtureReaderIdentity", SOCIAL_MEDIA_COS_READER_SECRET_KEY: "fiction-reader-secret" };
  const storage = createCosCoverSession(env, async (url, init) => {
    assert.equal(new URL(String(url)).hostname, "fiction-media-123456789.cos.ap-shanghai.myqcloud.com");
    const method = init!.method!; calls.push({ method, authorization: (init!.headers as Record<string, string>).authorization });
    return String(url).endsWith("?versioning") ? new Response("<VersioningConfiguration/>") : new Response(method === "GET" ? bytes : null);
  });
  await storage.put(file, bytes); assert.deepEqual(Buffer.from(await storage.read(file)), bytes);
  assert.equal(calls.length, 3);
  assert.match(calls[0].authorization, /FixtureWriterIdentity/); assert.match(calls[1].authorization, /FixtureWriterIdentity/);
  assert.match(calls[2].authorization, /FixtureReaderIdentity/);
  assert.throws(() => createCosCoverSession({ ...env, SOCIAL_MEDIA_COS_READER_SECRET_ID: env.SOCIAL_MEDIA_COS_WRITER_SECRET_ID }, fetch), { code: "COVER_COS_CONFIG_INVALID" });
});

test("local copy deduplicates bytes, independently verifies, resumes only known proofs, and rejects changed input", async () => {
  const objects = new Map<string, Uint8Array>(); let puts = 0, reads = 0, saved: CoverCopyReceipt | undefined;
  const ports = { signal: new AbortController().signal, local: async () => bytes,
    target: { put: async (m: StoredMedia, body: Uint8Array) => { puts++; objects.set(m.sha256, body); }, read: async (m: StoredMedia) => { reads++; return objects.get(m.sha256)!; } },
    save: async (value: CoverCopyReceipt) => { saved = value; } };
  const receipt = await copyCoverObjects([file, { ...file, ownerPageId: "other-owner" }], ports, { objects: 2, bytes: 100 });
  assert.equal(receipt.status, "PASS"); assert.equal(puts, 1); assert.equal(reads, 1);
  await copyCoverObjects([file], { ...ports, previous: receipt }, { objects: 2, bytes: 100 }); assert.equal(puts, 1); assert.equal(reads, 1);
  await assert.rejects(copyCoverObjects([file], { ...ports, previous: { ...receipt, inputSha256: "changed" } }, { objects: 2, bytes: 100 }));
  assert.equal(saved?.status, "PASS");
});

test("an unknown PUT outcome stops and a continuation proves it with GET without another PUT", async () => {
  let saved: CoverCopyReceipt | undefined, puts = 0, reads = 0;
  const ports = { signal: new AbortController().signal, local: async () => bytes, save: async (value: CoverCopyReceipt) => { saved = value; },
    target: { put: async () => { puts++; throw Error("fixture lost acknowledgement"); }, read: async () => { reads++; return bytes; } } };
  await assert.rejects(copyCoverObjects([file], ports, { objects: 1, bytes: 100 }));
  assert.equal(saved?.status, "STOPPED"); assert.equal(saved?.inFlight?.phase, "put");
  const result = await copyCoverObjects([file], { ...ports, previous: saved }, { objects: 1, bytes: 100 });
  assert.equal(result.status, "PASS"); assert.equal(puts, 1); assert.equal(reads, 1);
});

test("oversized batches and corrupt local bytes cannot open a target object", async () => {
  let cloud = 0; const ports = { signal: new AbortController().signal, local: async () => Buffer.from("corrupt"), save: async () => {},
    target: { put: async () => { cloud++; }, read: async () => { cloud++; return bytes; } } };
  await assert.rejects(copyCoverObjects([file], ports, { objects: 1, bytes: 1 }));
  await assert.rejects(copyCoverObjects([file], ports, { objects: 1, bytes: 100 })); assert.equal(cloud, 0);
});

test("cancellation wrapper preserves an explicit native COS reader instead of silently using fetch", async () => {
  assert.equal(socialReaderTransport({}), fetch);
  const transport = socialReaderTransport({ SOCIAL_MEDIA_STORAGE_PROVIDER: "cos", SOCIAL_MEDIA_COS_BUCKET: "fiction-media-123456789",
    SOCIAL_MEDIA_COS_REGION: "ap-shanghai", SOCIAL_MEDIA_COS_READ_TRANSPORT: "native-https" });
  assert.notEqual(transport, fetch);
  await assert.rejects(transport("https://other.example.test/image", { method: "GET", signal: new AbortController().signal, redirect: "error" }), /Invalid COS transport request/);
});

test("explicit COS worker acceleration signs object transfers separately from the regional versioning check", async () => {
  const hosts: string[] = [];
  const env = { SOCIAL_MEDIA_STORAGE_PROVIDER: "cos", SOCIAL_MEDIA_COS_BUCKET: "fiction-media-123456789", SOCIAL_MEDIA_COS_REGION: "ap-shanghai", SOCIAL_MEDIA_COS_PREFIX: "fiction",
    SOCIAL_MEDIA_COS_WRITE_ENDPOINT: "accelerate", SOCIAL_MEDIA_COS_READ_ENDPOINT: "accelerate",
    SOCIAL_MEDIA_COS_WRITER_SECRET_ID: "FixtureWriterIdentity", SOCIAL_MEDIA_COS_WRITER_SECRET_KEY: "fiction-writer-secret",
    SOCIAL_MEDIA_COS_READER_SECRET_ID: "FixtureReaderIdentity", SOCIAL_MEDIA_COS_READER_SECRET_KEY: "fiction-reader-secret" };
  const storage = createCosCoverSession(env, async (url, init) => {
    const u = new URL(String(url)); hosts.push(u.hostname);
    assert.equal((init!.headers as Record<string,string>).host, u.hostname);
    return u.search ? new Response("<VersioningConfiguration/>") : new Response(init!.method === "GET" ? bytes : null);
  });
  await storage.put(file,bytes); await storage.read(file);
  assert.deepEqual(hosts, ["fiction-media-123456789.cos.ap-shanghai.myqcloud.com", "fiction-media-123456789.cos.accelerate.myqcloud.com", "fiction-media-123456789.cos.accelerate.myqcloud.com"]);
});
