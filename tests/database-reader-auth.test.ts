import test from "node:test";
import assert from "node:assert/strict";
import { createStorageReaderToken, type ReaderAuthOptions } from "../src/server/database/reader-auth.ts";
import { ContentServiceError } from "../contracts/repository.ts";

const userId = "11111111-1111-4111-8111-111111111111";
const origin = "https://storage.example.test";
const initialTime = 1_800_000_000_000;
const settings = { storageUrl: `${origin}/storage/v1`, apiKey: "sb_publishable_fixture",
  email: "reader@example.test", password: "fictional-reader-password", userId };
function jwt(claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "ES256", typ: "JWT", ...header })}.${encode({
    iss: `${origin}/auth/v1`, aud: "authenticated", sub: userId, role: "authenticated",
    exp: initialTime / 1000 + 300, app_metadata: { notionblog_storage_role: "reader" }, ...claims,
  })}.fixture`;
}
function user(values: Record<string, unknown> = {}) {
  return { id: userId, role: "authenticated", is_anonymous: false,
    app_metadata: { notionblog_storage_role: "reader" }, ...values };
}
function getter(options: ReaderAuthOptions) {
  const result = createStorageReaderToken(options);
  assert.equal(typeof result, "function");
  return result as () => Promise<string>;
}
const safeFailure = (error: unknown) => error instanceof ContentServiceError &&
  error.code === "CONTENT_UNAVAILABLE" && error.message === "Reader media authentication is temporarily unavailable.";

test("reader authentication is single-flight, verifies Auth user, caches and renews before expiry", async () => {
  let time = initialTime;
  let signIns = 0, userReads = 0;
  const tokens: string[] = [];
  const token = getter({ ...settings, now: () => time, fetch: async (input, init) => {
    assert.equal(init?.redirect, "error"); assert.equal(init?.cache, "no-store"); assert.ok(init?.signal);
    assert.equal((init?.headers as Record<string, string>).apikey, settings.apiKey);
    if (String(input) === `${origin}/auth/v1/token?grant_type=password`) {
      signIns++;
      assert.equal(init?.method, "POST");
      assert.deepEqual(JSON.parse(init?.body as string), { email: settings.email, password: settings.password });
      const accessToken = jwt({ exp: time / 1000 + 300 }); tokens.push(accessToken);
      return Response.json({ access_token: accessToken, token_type: "bearer", refresh_token: "unused-fictional-refresh-token" });
    }
    assert.equal(String(input), `${origin}/auth/v1/user`); userReads++;
    assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer ${tokens.at(-1)}`);
    return Response.json(user());
  } });
  assert.deepEqual(await Promise.all(Array.from({ length: 20 }, () => token())), Array(20).fill(tokens[0]));
  assert.equal(signIns, 1); assert.equal(userReads, 1);
  time += 239_000; assert.equal(await token(), tokens[0]); assert.equal(signIns, 1);
  time += 1000;
  const renewed = await Promise.all([token(), token(), token()]);
  assert.deepEqual(renewed, Array(3).fill(tokens[1])); assert.notEqual(tokens[1], tokens[0]);
  assert.equal(signIns, 2); assert.equal(userReads, 2);
  time += 301_000; await token(); assert.equal(signIns, 3);
});

test("optional reader credentials preserve static token and reject partial or unsafe configuration", () => {
  assert.equal(createStorageReaderToken({ storageUrl: "", apiKey: "", staticToken: "fixture" }), "fixture");
  assert.equal(createStorageReaderToken({ storageUrl: "", apiKey: "", email: "", password: "", userId: "", staticToken: "fixture" }), "fixture");
  for (const change of [{ email: undefined }, { password: "" }, { userId: "" }, { userId: "invalid" },
    { email: "invalid" }, { storageUrl: `${origin}/storage/v1?redirect=1` }, { storageUrl: "http://storage.example.test/storage/v1" },
    { apiKey: "sb_secret_fixture" }, { apiKey: jwt({ role: "service_role" }) }]) {
    assert.throws(() => createStorageReaderToken({ ...settings, staticToken: "old-token", ...change }),
      (error: unknown) => error instanceof ContentServiceError && error.code === "MISCONFIGURED");
  }
});

test("reader rejects malformed, expired, wrong-project, identity, role or audience JWTs before Storage", async () => {
  for (const accessToken of ["invalid", jwt({}, { alg: "none" }), jwt({ exp: initialTime / 1000 }),
    jwt({ exp: initialTime / 1000 + 60 }), jwt({ sub: "22222222-2222-4222-8222-222222222222" }),
    jwt({ iss: "https://other.example.test/auth/v1" }), jwt({ aud: "other" }), jwt({ role: "service_role" }),
    jwt({ app_metadata: { notionblog_storage_role: "writer" } }),
    jwt({ app_metadata: {}, user_metadata: { notionblog_storage_role: "reader" } })]) {
    let requests = 0;
    const token = getter({ ...settings, now: () => initialTime, fetch: async () => {
      requests++; return Response.json({ access_token: accessToken, token_type: "bearer" });
    } });
    await assert.rejects(token(), safeFailure); assert.equal(requests, 1);
  }
});

test("decoded JWT cannot replace server validation of current reader identity and metadata", async () => {
  for (const currentUser of [user({ id: "22222222-2222-4222-8222-222222222222" }),
    user({ app_metadata: { notionblog_storage_role: "writer" } }), user({ role: "service_role" }),
    user({ is_anonymous: true }), user({ app_metadata: {}, user_metadata: { notionblog_storage_role: "reader" } })]) {
    let requests = 0;
    const token = getter({ ...settings, now: () => initialTime, fetch: async () => {
      requests++; return Response.json(requests === 1 ? { access_token: jwt(), token_type: "bearer" } : currentUser);
    } });
    await assert.rejects(token(), safeFailure); assert.equal(requests, 2);
  }
});

test("server rejection of a claimed reader JWT cannot create a cached session", async () => {
  let requests = 0;
  const token = getter({ ...settings, now: () => initialTime, fetch: async input => {
    requests++;
    return String(input).endsWith("/user") ? new Response("private-auth-validation-error", { status: 401 }) :
      Response.json({ access_token: jwt(), token_type: "bearer" });
  } });
  await assert.rejects(token(), safeFailure); await assert.rejects(token(), safeFailure);
  assert.equal(requests, 4);
});

test("reader token expiry is checked again after server validation completes", async () => {
  let time = initialTime;
  const token = getter({ ...settings, now: () => time, fetch: async input => {
    if (String(input).endsWith("/user")) { time += 301_000; return Response.json(user()); }
    return Response.json({ access_token: jwt(), token_type: "bearer" });
  } });
  await assert.rejects(token(), safeFailure);
});

test("Auth network and upstream errors are safe, never cached, and allow a subsequent recovery", async () => {
  for (const failure of [() => { throw new Error("private-password-token-response"); },
    () => new Response("private-password-token-response", { status: 401 }),
    () => new Response("private-password-token-response", { status: 429 }),
    () => new Response(null, { status: 302, headers: { Location: "https://other.example.test" } }),
    () => Response.json({ access_token: jwt(), token_type: "unexpected" })]) {
    let broken = true;
    const token = getter({ ...settings, now: () => initialTime, fetch: async input => {
      if (broken) return failure();
      return Response.json(String(input).endsWith("/user") ? user() : { access_token: jwt(), token_type: "bearer" });
    } });
    await assert.rejects(token(), safeFailure);
    broken = false; assert.equal(await token(), jwt());
  }
});

test("Auth responses enforce declared and streamed body limits", async () => {
  for (const response of [() => new Response("{}", { headers: { "Content-Length": "65537" } }),
    () => new Response("x".repeat(65537)), () => new Response("{}", { headers: { "Content-Length": "invalid" } })]) {
    let requests = 0;
    const token = getter({ ...settings, now: () => initialTime, fetch: async () => { requests++; return response(); } });
    await assert.rejects(token(), safeFailure); assert.equal(requests, 1);
  }
});

test("Auth has a shared bounded timeout, including a stalled response body", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let cancelCalls = 0;
  const token = getter({ ...settings, now: () => initialTime, fetch: async () => new Response(new ReadableStream({
    pull: () => new Promise(() => {}), cancel: () => { cancelCalls++; },
  })) });
  const failed = assert.rejects(token(), safeFailure);
  await Promise.resolve(); await Promise.resolve();
  t.mock.timers.tick(10_001);
  await failed; assert.equal(cancelCalls, 1);
});
