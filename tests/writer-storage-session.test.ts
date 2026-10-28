import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, readFile, rm, chmod, symlink, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWriterStorageSession, openPrivateWriterStorageSession } from "../scripts/website-sync/writer-storage-session.ts";
import { createSupabaseStorage } from "../src/server/database/storage.ts";
import { mediaIdentity } from "../src/server/database/validation.ts";
import type { StoredMedia } from "../contracts/sync.ts";

const expected = { SYNC_DATABASE_URL: "postgresql://fiction:fixture@database.example.test/db", DATABASE_CA_CERT: "fixture-ca",
  STORAGE_URL: "https://storage.example.test/storage/v1", STORAGE_BUCKET: "fiction-media", STORAGE_API_KEY: "sb_publishable_fixture", STORAGE_WRITER_USER_ID: "fiction-writer" };
const jwt = (exp: number, claims: Record<string, unknown> = {}) => `e30.${Buffer.from(JSON.stringify({ exp, sub: expected.STORAGE_WRITER_USER_ID,
  iss: "https://storage.example.test/auth/v1", role: "authenticated", app_metadata: { notionblog_storage_role: "writer" }, ...claims })).toString("base64url")}.fixture`;
const bytes = Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]), sha = createHash("sha256").update(bytes).digest("hex");
const media: StoredMedia = { assetId: mediaIdentity("fiction-page", "cover", sha), ownerPageId: "fiction-page", objectKey: `sha256/${sha}`,
  sha256: sha, byteSize: bytes.length, mime: "image/png", width: null, height: null };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

test("writer sessions accept only a project-matched legacy public anon key", async () => {
  const legacy = (claims: Record<string, unknown>) => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.fixture`;
  const base = {...expected, STORAGE_URL: "https://fixture.supabase.co/storage/v1", STORAGE_API_KEY: legacy({role: "anon", ref: "fixture"})};
  const token = jwt(Date.now() / 1000 + 3600, {iss: "https://fixture.supabase.co/auth/v1"});
  let requests = 0;
  const session = createWriterStorageSession({expected: base, read: async () => ({...base, STORAGE_WRITE_TOKEN: token}), guard: () => {},
    refresh: async () => assert.fail("A valid writer token does not need Auth")});
  const storage = createSupabaseStorage({url: base.STORAGE_URL, bucket: base.STORAGE_BUCKET, apiKey: base.STORAGE_API_KEY, role: "writer", token: session.token,
    fetch: async () => {requests++; return new Response(null, {status: 200});}});
  await storage.put(media, bytes); assert.equal(requests, 1); await session.close();
  for (const key of [legacy({role: "service_role", ref: "fixture"}), legacy({role: "authenticated", ref: "fixture"}),
    legacy({role: "anon", ref: "different"}), legacy({role: "anon"}), "sb_secret_fixture", "invalid-key"]) {
    assert.throws(() => createWriterStorageSession({expected: {...base, STORAGE_API_KEY: key}, read: async () => assert.fail(), guard: () => {}, refresh: async () => assert.fail()}), /STORAGE_SESSION_INPUT_INVALID/);
  }
});

test("parallel immutable uploads renew once and use the persisted token", async () => {
  const now = Date.now(); let current = { ...expected, STORAGE_WRITE_TOKEN: jwt(now / 1000 + 60) }, refreshes = 0, requests = 0;
  const session = createWriterStorageSession({ expected, read: async () => current, guard: () => {}, refresh: async () => {
    refreshes++; current = { ...current, STORAGE_WRITE_TOKEN: jwt(now / 1000 + 3600) }; return { serverValidated: true };
  } });
  const storage = createSupabaseStorage({ url: expected.STORAGE_URL, bucket: expected.STORAGE_BUCKET, apiKey: expected.STORAGE_API_KEY,
    role: "writer", token: session.token, fetch: async (_url, init) => {
      requests++; assert.equal((init?.headers as Record<string,string>).Authorization, `Bearer ${current.STORAGE_WRITE_TOKEN}`);
      assert.equal((init?.headers as Record<string,string>)["x-upsert"], "false"); return new Response(null, { status: 200 });
    } });
  await Promise.all(Array.from({ length: 16 }, () => storage.put(media, bytes)));
  assert.equal(refreshes, 1); assert.equal(requests, 16); await session.close();
});

test("a long operation observes subsequent expiration and an already refreshed file", async () => {
  let now = Date.now(), refreshes = 0, current = { ...expected, STORAGE_WRITE_TOKEN: jwt(now / 1000 + 300) };
  const session = createWriterStorageSession({ expected, read: async () => current, now: () => now, guard: () => {}, refresh: async () => {
    refreshes++; current = { ...current, STORAGE_WRITE_TOKEN: jwt(now / 1000 + 3600) }; return { serverValidated: true };
  } });
  assert.equal(await session.token(), current.STORAGE_WRITE_TOKEN); assert.equal(refreshes, 0);
  now += 200000; await session.token(); assert.equal(refreshes, 1);
  current = { ...current, STORAGE_WRITE_TOKEN: jwt(now / 1000 + 7200) };
  assert.equal(await session.token(), current.STORAGE_WRITE_TOKEN); assert.equal(refreshes, 1);
  now += 7100000; await session.token(); assert.equal(refreshes, 2); await session.close();
});

test("target, identity and CA drift fail before Auth or object requests", async () => {
  for (const field of Object.keys(expected)) {
    let refreshes = 0;
    const session = createWriterStorageSession({ expected, read: async () => ({ ...expected, [field]: "changed", STORAGE_WRITE_TOKEN: "expired" }),
      guard: () => {}, refresh: async () => { refreshes++; return { serverValidated: true }; } });
    await assert.rejects(session.token(), { message: "STORAGE_SESSION_BINDING_CHANGED" });
    assert.equal(refreshes, 0); await session.close();
  }
});

test("wrong JWT subject, issuer, SQL role or Storage role cannot trigger refresh", async () => {
  for (const claims of [{ sub: "different-writer" }, { iss: "https://different.example.test/auth/v1" }, { role: "service_role" },
    { app_metadata: { notionblog_storage_role: "reader" } }]) {
    let refreshes = 0;
    const session = createWriterStorageSession({ expected, read: async () => ({ ...expected, STORAGE_WRITE_TOKEN: jwt(1, claims) }), guard: () => {},
      refresh: async () => { refreshes++; return { serverValidated: true }; } });
    await assert.rejects(session.token(), { message: "STORAGE_SESSION_IDENTITY_INVALID" }); assert.equal(refreshes, 0); await session.close();
  }
});

test("post-refresh drift or insufficient token lifetime poisons the session", async () => {
  for (const change of [{ STORAGE_BUCKET: "other-bucket" }, { STORAGE_WRITE_TOKEN: jwt(Date.now() / 1000 + 30) },
    { STORAGE_WRITE_TOKEN: jwt(Date.now() / 1000 + 3600, { sub: "different-writer" }) }]) {
    let refreshes = 0, current = { ...expected, STORAGE_WRITE_TOKEN: jwt(1) };
    const session = createWriterStorageSession({ expected, read: async () => current, guard: () => {}, refresh: async () => {
      refreshes++; current = { ...current, STORAGE_WRITE_TOKEN: jwt(Date.now() / 1000 + 3600), ...change }; return { serverValidated: true };
    } });
    await assert.rejects(session.token()); await assert.rejects(session.token()); assert.equal(refreshes, 1); await session.close();
  }
});

test("unconfirmed or failed refresh never retries or exposes credential-bearing errors", async () => {
  for (const confirmed of [false, true]) {
    let refreshes = 0;
    const session = createWriterStorageSession({ expected, read: async () => ({ ...expected, STORAGE_WRITE_TOKEN: jwt(1) }), guard: () => {},
      refresh: async () => { refreshes++; if (confirmed) throw new Error("fixture-private-token"); return { serverValidated: false }; } });
    const message = confirmed ? "STORAGE_SESSION_REFRESH_FAILED" : "STORAGE_SESSION_REFRESH_UNVERIFIED";
    await assert.rejects(session.token(), { message }); await assert.rejects(session.token(), { message }); assert.equal(refreshes, 1); await session.close();
  }
});

test("cancellation drains credential rotation before close and sends no late object request", async () => {
  const entered = deferred(), finish = deferred(); let cancelled = false, persisted = false, requests = 0;
  const session = createWriterStorageSession({ expected, read: async () => ({ ...expected, STORAGE_WRITE_TOKEN: jwt(1) }),
    guard: () => { if (cancelled) throw new Error("cancelled"); }, refresh: async () => {
      entered.resolve(); await finish.promise; persisted = true; return { serverValidated: true };
    } });
  const storage = createSupabaseStorage({ url: expected.STORAGE_URL, bucket: expected.STORAGE_BUCKET, apiKey: expected.STORAGE_API_KEY,
    role: "writer", token: session.token, fetch: async () => { requests++; return new Response(null, { status: 200 }); } });
  const put = assert.rejects(storage.put(media, bytes)); await entered.promise; cancelled = true;
  let closed = false; const closing = session.close().then(() => { closed = true; });
  await Promise.resolve(); assert.equal(closed, false); finish.resolve(); await Promise.all([put, closing]);
  assert.equal(persisted, true); assert.equal(requests, 0); assert.equal(closed, true);
  await assert.rejects(session.token(), { message: "STORAGE_SESSION_CLOSED" });
});

async function privateFixture(run: (input: { credentialsPath: string; refreshModulePath: string; refreshModuleSha256: string }) => Promise<void>) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "fiction-storage-session-"))); await chmod(dir, 0o700);
  const credentialsPath = join(dir, "writer.env"), refreshModulePath = join(dir, "refresh.mjs");
  const code = `import { appendFile } from "node:fs/promises";
export async function refreshWriterSession(path) {
  await appendFile(path, 'STORAGE_WRITE_TOKEN="${jwt(Date.now() / 1000 + 3600)}"\\n');
  return { serverValidated: true };
}\n`;
  await writeFile(credentialsPath, Object.entries({ ...expected, STORAGE_WRITE_TOKEN: jwt(1) }).map(([key,value]) => `${key}=${JSON.stringify(value)}\n`).join(""), { mode: 0o600 });
  await writeFile(refreshModulePath, code, { mode: 0o600 });
  try { await run({ credentialsPath, refreshModulePath, refreshModuleSha256: createHash("sha256").update(code).digest("hex") }); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

test("private adapter invokes the hash-approved helper and reloads its rotated file", async () => {
  await privateFixture(async input => {
    const session = await openPrivateWriterStorageSession({ ...input, expected, guard: () => {} });
    assert.equal(session.statistics().refreshes, 0); // Opening does not refresh.
    const token = await session.token(); assert.ok((await readFile(input.credentialsPath, "utf8")).includes(token));
    assert.equal(session.statistics().refreshes, 1); await session.close();
  });
});

test("private adapter refuses unreviewed helper bytes before executing them", async () => {
  await privateFixture(async input => {
    const before = await readFile(input.credentialsPath, "utf8");
    const session = await openPrivateWriterStorageSession({ ...input, refreshModuleSha256: "0".repeat(64), expected, guard: () => {} });
    await assert.rejects(session.token()); assert.equal(await readFile(input.credentialsPath, "utf8"), before); await session.close();
  });
});

test("private adapter refuses readable or linked credential files", async () => {
  await privateFixture(async input => {
    await chmod(input.credentialsPath, 0o644);
    await assert.rejects(openPrivateWriterStorageSession({ ...input, expected, guard: () => {} }));
    await chmod(input.credentialsPath, 0o600);
    const link = join(join(input.credentialsPath, ".."), "linked.env"); await symlink(input.credentialsPath, link);
    await assert.rejects(openPrivateWriterStorageSession({ ...input, credentialsPath: link, expected, guard: () => {} }));
  });
});
