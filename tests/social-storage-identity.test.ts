import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { createSupabaseStorage } from "../src/server/database/storage.ts";
import { createSocialStorage } from "../src/server/social/media-storage.ts";
import { mediaIdentity } from "../src/server/database/validation.ts";
import type { StoredMedia } from "../contracts/sync.ts";

const origin = "https://storage.example.test", userId = "11111111-1111-4111-8111-111111111111";
const bytes = Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
const sha = createHash("sha256").update(bytes).digest("hex");
const media: StoredMedia = { assetId: mediaIdentity("fiction-social", "cover", sha), ownerPageId: "fiction-social",
  objectKey: `sha256/${sha}`, sha256: sha, byteSize: bytes.length, mime: "image/png", width: null, height: null };
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
function token(metadata: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return `${encode({ alg: "ES256" })}.${encode({ iss: `${origin}/auth/v1`, aud: "authenticated", sub: userId,
    role: "authenticated", exp: Date.now()/1000+300, app_metadata: metadata, ...extra })}.fixture`;
}
const profile = { SOCIAL_MEDIA_STORAGE_URL: `${origin}/storage/v1`, SOCIAL_MEDIA_STORAGE_BUCKET: "notionblog-social-media",
  SOCIAL_MEDIA_STORAGE_API_KEY: "sb_publishable_fixture" };

test("social Storage accepts dedicated reader and writer claims with immutable requests", async () => {
  const calls: string[] = [];
  const request: typeof fetch = async (url, init) => {
    calls.push(String(url));
    const jwt = JSON.parse(Buffer.from((init!.headers as Record<string,string>).Authorization.split(".")[1], "base64url").toString());
    assert.equal(Object.hasOwn(jwt.app_metadata, "notionblog_storage_role"), false);
    assert.equal(init?.redirect, "error");
    if (init?.method === "POST") { assert.equal(jwt.app_metadata.notionblog_social_storage_role, "writer");
      assert.equal((init.headers as Record<string,string>)["x-upsert"], "false"); return new Response(null, { status: 200 }); }
    assert.equal(jwt.app_metadata.notionblog_social_storage_role, "reader"); return new Response(bytes);
  };
  const reader = createSocialStorage({ ...profile, SOCIAL_MEDIA_STORAGE_READ_TOKEN: token({ notionblog_social_storage_role: "reader" }) }, "reader", request);
  const writer = createSocialStorage({ ...profile, SOCIAL_MEDIA_STORAGE_WRITE_TOKEN: token({ notionblog_social_storage_role: "writer" }) }, "writer", request);
  assert.deepEqual(Buffer.from(await reader.read(media)), bytes); await writer.put(media, bytes);
  assert.equal(calls.length, 2); assert.ok(calls.every(url => url.includes("/notionblog-social-media/")));
});

test("social identities refuse legacy, dual, user-owned, wrong-role and broad claims before transport", () => {
  let requests = 0;
  const request: typeof fetch = async () => { requests++; return new Response(bytes); };
  for (const metadata of [{ notionblog_storage_role: "reader" },
    { notionblog_social_storage_role: "reader", notionblog_storage_role: "reader" },
    { notionblog_social_storage_role: "reader", notionblog_storage_role: null },
    { notionblog_social_storage_role: "writer" }, {}]) {
    assert.throws(() => createSocialStorage({ ...profile, SOCIAL_MEDIA_STORAGE_READ_TOKEN: token(metadata,
      { user_metadata: { notionblog_social_storage_role: "reader" } }) }, "reader", request));
  }
  assert.throws(() => createSocialStorage({ ...profile, SOCIAL_MEDIA_STORAGE_READ_TOKEN: token(
    { notionblog_social_storage_role: "reader" }, { role: "service_role" }) }, "reader", request));
  assert.equal(requests, 0);
});

test("legacy Storage profile rejects social and dual credentials while preserving legacy reads", async () => {
  let requests = 0;
  const options = { url: `${origin}/storage/v1`, bucket: "fiction-media", apiKey: "sb_publishable_fixture",
    role: "reader" as const, fetch: async () => { requests++; return new Response(bytes); } };
  for (const metadata of [{ notionblog_social_storage_role: "reader" },
    { notionblog_storage_role: "reader", notionblog_social_storage_role: "reader" }]) {
    assert.throws(() => createSupabaseStorage({ ...options, token: token(metadata) }));
  }
  const storage = createSupabaseStorage({ ...options, token: token({ notionblog_storage_role: "reader" }) });
  assert.deepEqual(Buffer.from(await storage.read(media)), bytes); assert.equal(requests, 1);
});

test("social reader validates Auth user with the dedicated claim and uses the injected Auth transport", async () => {
  const calls: string[] = [], metadata = { notionblog_social_storage_role: "reader" };
  const request: typeof fetch = async (url, init) => {
    calls.push(String(url)); assert.ok(init?.signal);
    if (String(url).includes("/token?")) return Response.json({ token_type: "bearer", access_token: token(metadata) });
    if (String(url).endsWith("/user")) return Response.json({ id: userId, role: "authenticated", is_anonymous: false, app_metadata: metadata });
    return new Response(bytes);
  };
  const reader = createSocialStorage({ ...profile, SOCIAL_MEDIA_STORAGE_READER_EMAIL: "social-reader@example.test",
    SOCIAL_MEDIA_STORAGE_READER_PASSWORD: "fictional-password", SOCIAL_MEDIA_STORAGE_READER_USER_ID: userId }, "reader", request);
  assert.deepEqual(Buffer.from(await reader.read(media)), bytes);
  assert.deepEqual(calls, [`${origin}/auth/v1/token?grant_type=password`, `${origin}/auth/v1/user`,
    `${origin}/storage/v1/object/authenticated/notionblog-social-media/${media.objectKey}`]);
});

test("social reader rejects a stale claim when current Auth user identity changes before Storage", async () => {
  for (const metadata of [{ notionblog_storage_role: "reader" },
    { notionblog_social_storage_role: "reader", notionblog_storage_role: "reader" }, {}]) {
    let requests = 0;
    const reader = createSocialStorage({ ...profile, SOCIAL_MEDIA_STORAGE_READER_EMAIL: "social-reader@example.test",
      SOCIAL_MEDIA_STORAGE_READER_PASSWORD: "fictional-password", SOCIAL_MEDIA_STORAGE_READER_USER_ID: userId }, "reader", async url => {
      requests++;
      return String(url).endsWith("/user") ? Response.json({ id: userId, role: "authenticated", is_anonymous: false, app_metadata: metadata }) :
        Response.json({ token_type: "bearer", access_token: token({ notionblog_social_storage_role: "reader" }) });
    });
    await assert.rejects(reader.read(media)); assert.equal(requests, 2);
  }
});

test("real social and legacy bucket policies isolate both identities and forbid overwrites", async () => {
  const db = await PGlite.create();
  try {
    await db.exec(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;
      CREATE SCHEMA storage; CREATE SCHEMA auth;
      CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      CREATE TABLE storage.objects(id serial PRIMARY KEY,bucket_id text,name text);
      ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
      CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT COALESCE(NULLIF(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
      GRANT USAGE ON SCHEMA storage,auth TO anon,authenticated;
      GRANT SELECT,INSERT,UPDATE,DELETE ON storage.objects TO anon,authenticated;
      GRANT USAGE ON SEQUENCE storage.objects_id_seq TO anon,authenticated;`);
    await db.exec(await readFile(new URL("../database/storage-policies.sql", import.meta.url), "utf8"));
    const socialSql = await readFile(new URL("../database/social-storage-policies.sql", import.meta.url), "utf8");
    await db.exec(socialSql);
    const name = `sha256/${"1".repeat(64)}`, next = `sha256/${"2".repeat(64)}`;
    await db.query("INSERT INTO storage.objects(bucket_id,name) VALUES('notionblog-media',$1),('notionblog-social-media',$1),('other',$1)", [name]);
    const as = (role: string, claims: object, query: string, params: unknown[] = []) => db.transaction(async tx => {
      await tx.exec(`SET LOCAL ROLE ${role}`);
      await tx.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify(claims)]);
      return tx.query<{ bucket_id: string }>(query, params);
    });
    for (const identity of ["notion", "social"]) for (const role of ["reader", "writer"]) {
      const claim = identity === "social" ? "notionblog_social_storage_role" : "notionblog_storage_role";
      const bucket = identity === "social" ? "notionblog-social-media" : "notionblog-media";
      const claims = { app_metadata: { [claim]: role } };
      assert.deepEqual((await as("authenticated", claims, "SELECT bucket_id FROM storage.objects")).rows, [{ bucket_id: bucket }]);
      for (const other of ["notionblog-media", "notionblog-social-media", "other"].filter(x => x !== bucket))
        await assert.rejects(as("authenticated", claims, "INSERT INTO storage.objects(bucket_id,name) VALUES($1,$2)", [other, next]), /row-level security/);
      if (role === "writer") await as("authenticated", claims, "INSERT INTO storage.objects(bucket_id,name) VALUES($1,$2)", [bucket, next]);
      else await assert.rejects(as("authenticated", claims, "INSERT INTO storage.objects(bucket_id,name) VALUES($1,$2)", [bucket, next]), /row-level security/);
      assert.equal((await as("authenticated", claims, "UPDATE storage.objects SET name='changed' RETURNING bucket_id")).rows.length, 0);
      assert.equal((await as("authenticated", claims, "DELETE FROM storage.objects RETURNING bucket_id")).rows.length, 0);
      // Keep each identity's starting row count stable for the next assertion.
      await db.query("DELETE FROM storage.objects WHERE name=$1", [next]);
    }
    for (const [role, claims] of [["anon", { app_metadata: { notionblog_social_storage_role: "reader" } }],
      ["authenticated", { user_metadata: { notionblog_social_storage_role: "reader" } }],
      ["authenticated", { app_metadata: { notionblog_social_storage_role: "unknown" } }]] as const)
      assert.equal((await as(role, claims, "SELECT bucket_id FROM storage.objects")).rows.length, 0);
    assert.equal((await as("authenticated", { app_metadata: { notionblog_social_storage_role: "reader", notionblog_storage_role: "reader" } },
      "SELECT bucket_id FROM storage.objects WHERE bucket_id='notionblog-social-media'")).rows.length, 0);
    assert.ok((await db.query<{ public: boolean }>("SELECT public FROM storage.buckets")).rows.every(x => x.public === false));
    await db.exec("UPDATE storage.buckets SET public=true WHERE id='notionblog-social-media'");
    await assert.rejects(db.exec(socialSql), /NB_SOCIAL_BUCKET_CONFIGURATION_INVALID/);
    await db.exec("ROLLBACK");
  } finally { await db.close(); }
});
