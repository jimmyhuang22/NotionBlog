import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { TransientStorageReadError } from "../src/server/database/storage.ts";
import { createCosStorage } from "../src/server/database/cos-storage.ts";
import { configuredCosStorage, storageProvider, thumbnailStorageProvider } from "../src/server/database/cos-config.ts";
import { createRuntimeStorage } from "../scripts/website-incremental-sync/runtime-storage.ts";
import { createHostBudget } from "../scripts/website-incremental-sync/host-budget.ts";
import { createHostResources } from "../scripts/website-incremental-sync/host-resources.ts";
import { mediaIdentity } from "../src/server/database/validation.ts";
import type { StoredMedia } from "../contracts/sync.ts";

const bytes = Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]), sha = createHash("sha256").update(bytes).digest("hex");
const media: StoredMedia = {assetId: mediaIdentity("fiction-page", "cover", sha), ownerPageId: "fiction-page", objectKey: `sha256/${sha}`,
  sha256: sha, byteSize: bytes.length, mime: "image/png", width: null, height: null};
const credentials = {secretId: "fixtureSecretId123", secretKey: "fixtureSecretKeyForCos123"};
const options = {bucket: "fiction-media-1250000000", region: "ap-shanghai", prefix: "notionblog", role: "reader" as const, credentials};
const env = {STORAGE_PROVIDER: "cos", COS_BUCKET: options.bucket, COS_REGION: options.region, COS_PREFIX: options.prefix,
  COS_SECRET_ID: credentials.secretId, COS_SECRET_KEY: credentials.secretKey};
const disabled = () => new Response("<VersioningConfiguration/>");

test("COS signs the fixed host and namespace using an independently calculated signature", async t => {
  t.mock.timers.enable({apis: ["Date"], now: 1700000000000}); let requests = 0;
  const storage = createCosStorage({...options, fetch: async (url, init) => {
    requests++; assert.equal(url, `https://${options.bucket}.cos.${options.region}.myqcloud.com/${options.prefix}/${media.objectKey}`);
    const h = init?.headers as Record<string,string>;
    assert.equal(h.host, `${options.bucket}.cos.${options.region}.myqcloud.com`);
    assert.equal(h.authorization, "q-sign-algorithm=sha1&q-ak=fixtureSecretId123&q-sign-time=1699999970;1700000120&q-key-time=1699999970;1700000120&q-header-list=host&q-url-param-list=&q-signature=3c2f799e0b0a07269224723417436904c3cb1a4b");
    assert.equal(init?.redirect, "error"); assert.equal(init?.cache, "no-store"); assert.ok(init?.signal);
    return new Response(bytes);
  }});
  assert.deepEqual(Buffer.from(await storage.read(media)), bytes); assert.equal(requests, 1);
  await assert.rejects(storage.put(media, bytes)); await assert.rejects(storage.verifyWritableTarget()); assert.equal(requests, 1);
});

test("COS rejects malformed target, credentials and media before transport", async () => {
  let requests = 0; const fetcher: typeof fetch = async () => {requests++; return new Response(bytes);};
  for (const change of [{bucket: "../private"}, {region: "ap-shanghai.example.test"}, {prefix: "../originals"}, {prefix: ""},
    {prefix: "notionblog//media"}, {credentials: {...credentials, secretKey: "fixture\nkey"}},
    {credentials: {...credentials, securityToken: "fixture-token"}}, {credentials: {...credentials, expiresAt: 1}}]) {
    assert.throws(() => createCosStorage({...options, ...change, fetch: fetcher}));
  }
  const storage = createCosStorage({...options, fetch: fetcher});
  await assert.rejects(storage.read({...media, objectKey: "../private"}));
  await assert.rejects(createCosStorage({...options, role: "writer", fetch: fetcher}).put(media, new Uint8Array(bytes.length)));
  assert.equal(requests, 0);
});

test("accelerated COS reads sign the accelerated host and retain byte validation", async t => {
  t.mock.timers.enable({apis: ["Date"], now: 1700000000000}); let requests = 0;
  const host = `${options.bucket}.cos.accelerate.myqcloud.com`;
  const storage = configuredCosStorage({...env, COS_READ_ENDPOINT: "accelerate", COS_READ_TRANSPORT: "native-https"}, "reader", {
    fetch: async (url, init) => {
      requests++; assert.equal(url, `https://${host}/${options.prefix}/${media.objectKey}`);
      const headers = init?.headers as Record<string,string>;
      assert.equal(headers.host, host);
      assert.equal(headers.authorization, "q-sign-algorithm=sha1&q-ak=fixtureSecretId123&q-sign-time=1699999970;1700000120&q-key-time=1699999970;1700000120&q-header-list=host&q-url-param-list=&q-signature=0c9ea8c922c2a7f4a4933ce4c42d8da78885c87b");
      return new Response(requests === 1 ? bytes : new Uint8Array(bytes.length));
    },
  });
  assert.deepEqual(Buffer.from(await storage.read(media)), bytes);
  await assert.rejects(storage.read(media)); assert.equal(requests, 2);
});

test("the accelerated reader option leaves writer preflight, upload and conflict read regional", async () => {
  const methods: string[] = [];
  const writer = configuredCosStorage({...env, COS_READ_ENDPOINT: "accelerate", COS_READ_TRANSPORT: "native-https"}, "writer", {
    fetch: async (url, init) => {
      const target = new URL(String(url)), host = `${options.bucket}.cos.${options.region}.myqcloud.com`;
      assert.equal(target.hostname, host); assert.equal((init?.headers as Record<string,string>).host, host);
      methods.push(init!.method!);
      return target.search === "?versioning" ? disabled() : init?.method === "PUT" ? new Response(null, {status: 409}) : new Response(bytes);
    },
  });
  await writer.put(media, bytes); assert.deepEqual(methods, ["GET", "PUT", "GET"]);
});

test("COS rejects unrecognized endpoint configuration without sending a request", () => {
  for (const value of ["", "custom", "https://private.example.test", "accelerate.myqcloud.com"]) {
    assert.throws(() => configuredCosStorage({...env, COS_READ_ENDPOINT: value}, "reader"));
    assert.throws(() => createCosStorage({...options, readEndpoint: value as "regional"}));
  }
});

test("COS checks every refreshed credential and signs the temporary security token", async () => {
  let requests = 0, current = {...credentials, securityToken: "fixture+/token=", expiresAt: Math.floor(Date.now()/1000)+600};
  const storage = createCosStorage({...options, credentials: async () => current, fetch: async (_url, init) => {
    requests++; const h = init?.headers as Record<string,string>;
    assert.equal(h["x-cos-security-token"], current.securityToken); assert.ok(h.authorization.includes("q-header-list=host;x-cos-security-token"));
    return new Response(bytes);
  }});
  await storage.read(media); current = {...current, expiresAt: 1}; await assert.rejects(storage.read(media)); assert.equal(requests, 1);
});

test("COS reads reject redirects, partial, oversized, corrupt and failed responses", async () => {
  for (const response of [() => new Response(null, {status: 302}), () => new Response(bytes, {status: 206}),
    () => new Response(bytes, {headers: {"Content-Length": "20971521"}}), () => new Response(bytes.subarray(0, 8)),
    () => new Response(new Uint8Array(bytes.length+1)), () => new Response(new Uint8Array(bytes.length)),
    () => new Response("private provider error", {status: 403})]) {
    const storage = createCosStorage({...options, fetch: async () => response()});
    await assert.rejects(storage.read(media), {message: "Media is temporarily unavailable."});
  }
});

test("COS immutable uploads share the real versioning check and verify existing conflicts", async () => {
  let checks = 0, puts = 0, reads = 0;
  const storage = createCosStorage({...options, role: "writer", fetch: async (url, init) => {
    const h = init?.headers as Record<string,string>;
    if (String(url).endsWith("?versioning")) {
      checks++; assert.ok(h.authorization.includes("q-url-param-list=versioning")); return disabled();
    }
    if (init?.method === "PUT") {
      puts++; assert.equal(h["x-cos-forbid-overwrite"], "true"); assert.equal(h["content-length"], String(bytes.length));
      assert.equal(h["content-md5"], createHash("md5").update(bytes).digest("base64"));
      assert.ok(h.authorization.includes("q-header-list=content-length;content-md5;content-type;host;x-cos-forbid-overwrite"));
      assert.deepEqual(Buffer.from(init.body as Uint8Array), bytes); return new Response(null, {status: 409});
    }
    reads++; return new Response(bytes);
  }});
  await Promise.all(Array.from({length: 8}, () => storage.put(media, bytes)));
  assert.equal(checks, 1); assert.equal(puts, 8); assert.equal(reads, 8);
});

test("COS enabled, suspended, unavailable and malformed versioning cannot upload", async () => {
  for (const response of [() => new Response("<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>"),
    () => new Response("<VersioningConfiguration><Status>Suspended</Status></VersioningConfiguration>"),
    () => new Response("<VersioningConfiguration><Status>Disabled</Status></VersioningConfiguration>"),
    () => new Response("<!DOCTYPE private><VersioningConfiguration/>"), () => new Response("x".repeat(8193)),
    () => new Response(null, {status: 403})]) {
    let requests = 0;
    const storage = createCosStorage({...options, role: "writer", fetch: async (url, init) => {
      requests++; assert.ok(String(url).endsWith("?versioning")); assert.equal(init?.method, "GET"); return response();
    }});
    await assert.rejects(storage.put(media, bytes)); await assert.rejects(storage.put(media, bytes)); assert.equal(requests, 1);
  }
});

test("COS conflicts require the actual bytes; other write errors never trigger fallback or overwrite", async () => {
  for (const status of [409, 400, 403, 500]) {
    let reads = 0, puts = 0;
    const storage = createCosStorage({...options, role: "writer", fetch: async (url, init) => {
      if (String(url).endsWith("?versioning")) return disabled();
      if (init?.method === "PUT") {puts++; return new Response(null, {status});}
      reads++; return new Response(new Uint8Array(bytes.length));
    }});
    await assert.rejects(storage.put(media, bytes)); assert.equal(puts, 1); assert.equal(reads, status === 409 ? 1 : 0);
  }
});

test("COS keeps caller media and bytes fixed across asynchronous bucket and object requests", async () => {
  let enter!: () => void, resume!: () => void;
  const entered = new Promise<void>(resolve => {enter = resolve;}), waiting = new Promise<void>(resolve => {resume = resolve;});
  const candidate = {...media}, upload = Buffer.from(bytes);
  const storage = createCosStorage({...options, role: "writer", fetch: async (url, init) => {
    if (String(url).endsWith("?versioning")) {enter(); await waiting; return disabled();}
    assert.ok(String(url).endsWith(`/${media.objectKey}`)); assert.deepEqual(Buffer.from(init?.body as Uint8Array), bytes);
    return new Response(null, {status: 200});
  }});
  const publishing = storage.put(candidate, upload); await entered;
  candidate.objectKey = "../private"; candidate.sha256 = "e".repeat(64); upload.fill(0); resume(); await publishing;
  const readerCandidate = {...media}; let returnRead!: (response: Response) => void;
  const response = new Promise<Response>(resolve => {returnRead = resolve;});
  const reader = createCosStorage({...options, fetch: async () => response});
  const reading = reader.read(readerCandidate); readerCandidate.sha256 = "e".repeat(64); returnRead(new Response(bytes));
  assert.deepEqual(Buffer.from(await reading), bytes);
});

test("COS selection is explicit and can construct a reader without Supabase or Notion credentials", async () => {
  assert.equal(storageProvider({}), "supabase"); assert.equal(storageProvider({STORAGE_PROVIDER: "supabase"}), "supabase");
  assert.throws(() => storageProvider({STORAGE_PROVIDER: "unknown"}));
  assert.throws(() => storageProvider({...env, DATABASE_MEDIA_DIRECTORY: "/fiction/local"}));
  const storage = configuredCosStorage({...env, COS_CREDENTIALS_EXPIRES_AT: "", COS_SECURITY_TOKEN: ""}, "reader", {fetch: async () => new Response(bytes)});
  assert.deepEqual(Buffer.from(await storage.read(media)), bytes);
});

test("both sync CLIs preflight COS without opening Supabase Auth, and cancellation stops new object requests", async () => {
  const controller = new AbortController(), budget = createHostBudget({durationMs: 10000, signal: controller.signal}), resources = createHostResources();
  let calls = 0;
  try {
    await assert.rejects(createRuntimeStorage({env: {...env, SYNC_STORAGE_WRITER_ENV_FILE: "/fiction/private.env"}, budget, registerCleanup: resources.register}));
    await assert.rejects(createRuntimeStorage({env: {...env, COS_SECURITY_TOKEN: "fixture-token", COS_CREDENTIALS_EXPIRES_AT: String(Math.floor(Date.now()/1000)+60)}, budget,
      registerCleanup: resources.register, fetch: async () => {calls++; return disabled();}}), {message: "HOST_STORAGE_SESSION_WINDOW_INVALID"});
    const storage = await createRuntimeStorage({env, budget, registerCleanup: resources.register, fetch: async (url, init) => {
      calls++; assert.ok(init?.signal); assert.equal(init?.signal?.aborted, false);
      return String(url).endsWith("?versioning") ? disabled() : new Response(null, {status: 200});
    }});
    assert.equal(calls, 1); assert.equal(budget.statistics().mediaBytes, Buffer.byteLength("<VersioningConfiguration/>"));
    await storage.put(media, bytes); assert.equal(calls, 2); controller.abort(); await assert.rejects(storage.put(media, bytes)); assert.equal(calls, 2);
  } finally {budget.close(); await resources.close();}
});


test("thumbnail provider can select COS without changing the original provider", () => {
  assert.equal(thumbnailStorageProvider({}), "supabase");
  assert.equal(thumbnailStorageProvider({STORAGE_PROVIDER:"cos"}), "cos");
  const split={STORAGE_PROVIDER:"supabase",THUMBNAIL_STORAGE_PROVIDER:"cos"};
  assert.equal(storageProvider(split), "supabase"); assert.equal(thumbnailStorageProvider(split), "cos");
  assert.equal(thumbnailStorageProvider({STORAGE_PROVIDER:"cos",THUMBNAIL_STORAGE_PROVIDER:"supabase"}), "supabase");
  for (const value of ["", "unknown"]) assert.throws(()=>thumbnailStorageProvider({THUMBNAIL_STORAGE_PROVIDER:value}));
  assert.throws(()=>thumbnailStorageProvider({THUMBNAIL_STORAGE_PROVIDER:"cos",DATABASE_MEDIA_DIRECTORY:"/tmp/fixture"}));
});


test("COS read diagnostics separate provider, transport and corrupt bytes without private input", async () => {
  const cases = [
    { fetch: async () => new Response("private provider body", {status:403}), expected:{stage:"status",httpStatus:403} },
    { fetch: async () => {throw new Error("https://private.test/signed?credential=secret", {cause:{code:"UND_ERR_CONNECT_TIMEOUT"}});}, expected:{stage:"request",networkCode:"UND_ERR_CONNECT_TIMEOUT"} },
    { fetch: async () => {throw new Error("private", {cause:{code:"private-arbitrary-value"}});}, expected:{stage:"request"} },
    { fetch: async () => new Response(new Uint8Array(bytes.length)), expected:{stage:"verify",httpStatus:200} },
  ];
  for (const entry of cases) {
    const observed: unknown[]=[];
    await assert.rejects(createCosStorage({...options,fetch:entry.fetch,onReadFailure:f=>observed.push(f)}).read(media),{message:"Media is temporarily unavailable."});
    assert.deepEqual(observed,[entry.expected]);
  }
  await assert.rejects(createCosStorage({...options,fetch:async()=>new Response(null,{status:403}),onReadFailure:()=>{throw Error("logger failed");}}).read(media),{message:"Media is temporarily unavailable."});
});


test("only known request transport failures qualify for original fallback",async()=>{
  for(const code of ["UND_ERR_CONNECT_TIMEOUT","ECONNRESET","ETIMEDOUT","EAI_AGAIN","CERT_HAS_EXPIRED","ENOTFOUND","UNKNOWN"]){
    const transient=["UND_ERR_CONNECT_TIMEOUT","ECONNRESET","ETIMEDOUT","EAI_AGAIN"].includes(code);
    await assert.rejects(createCosStorage({...options,fetch:async()=>{throw new Error("private",{cause:{code}});}}).read(media),e=>(e instanceof TransientStorageReadError)===transient);
  }
  for(const status of [403,404,500])await assert.rejects(createCosStorage({...options,fetch:async()=>new Response(null,{status})}).read(media),e=>!(e instanceof TransientStorageReadError));
  await assert.rejects(createCosStorage({...options,fetch:async()=>new Response(new Uint8Array(bytes.length))}).read(media),e=>!(e instanceof TransientStorageReadError));
});
