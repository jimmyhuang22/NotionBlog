import { installMediaRouteCheckout } from "./media-route-pool.ts";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { thumbnailDatabase, thumbnailSample } from "./published-thumbnails.ts";

const s = await thumbnailDatabase(), f = await thumbnailSample(s);
const originalQuery = Pool.prototype.query, originalFetch = globalThis.fetch;
let queries = 0, objects = 0, sourceRequests = 0;
const restoreCheckout = installMediaRouteCheckout();
try {
  Pool.prototype.query = (async (sql: string, values?: unknown[]) => {queries++; return s.reader.query(sql, values);}) as typeof Pool.prototype.query;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname !== "fiction-media-1250000000.cos.ap-shanghai.myqcloud.com") {sourceRequests++; throw Error("Source network forbidden");}
    assert.equal(init?.method, "GET"); assert.equal(init?.redirect, "error");
    assert.ok((init?.headers as Record<string,string>).authorization.startsWith("q-sign-algorithm=sha1&"));
    assert.ok(url.pathname.startsWith("/notionblog/sha256/")); assert.equal(url.search, "");
    objects++; const bytes = f.bytes.get(url.pathname.slice("/notionblog/".length));
    return bytes ? new Response(bytes) : new Response(null, {status: 404});
  };
  Object.assign(process.env, {DATABASE_READER_ISOLATION: "enforce", CONTENT_PROVIDER: "database", DATABASE_CONTENT_VERSION: "2", DATABASE_PUBLICATION_MODE: "published",
    MEDIA_PROVIDER: "storage", MEDIA_THUMBNAILS: "enabled", DATABASE_TLS: "disable", DATABASE_READER_URL: "postgres://fixture:fixture@localhost/db",
    STORAGE_PROVIDER: "cos", COS_BUCKET: "fiction-media-1250000000", COS_REGION: "ap-shanghai", COS_PREFIX: "notionblog",
    COS_SECRET_ID: "fixtureSecretId123", COS_SECRET_KEY: "fixtureSecretKeyForCos123"});
  for (const key of ["NOTION_TOKEN", "NOTION_SOURCES_JSON", "NOTION_SOURCES_CONFIG", "DATABASE_MEDIA_DIRECTORY", "STORAGE_URL", "STORAGE_API_KEY",
    "STORAGE_READ_TOKEN", "STORAGE_READER_EMAIL", "STORAGE_READER_PASSWORD", "COS_SECURITY_TOKEN", "COS_CREDENTIALS_EXPIRES_AT"]) delete process.env[key];
  const {GET} = await import("../../src/app/media/v2/[assetId]/route.ts");
  const context = {params: Promise.resolve({assetId: f.media.assetId})};
  for (const width of [400, 800]) {
    const before = queries, response = await GET(new Request(`http://localhost/media/v2/${f.media.assetId}?thumbnail=${width}`), context);
    assert.equal(response.status, 200); assert.equal(response.headers.get("Content-Type"), "image/webp");
    assert.equal(response.headers.has("Location"), false);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.bytes.get(f.variants.get(width)!.objectKey)); assert.equal(queries - before, width === 400 ? 3 : 2);
  }
  const original = await GET(new Request(`http://localhost/media/v2/${f.media.assetId}`), context);
  assert.equal(original.status, 200); assert.deepEqual(Buffer.from(await original.arrayBuffer()), f.bytes.get(f.media.objectKey));
  const {GET: list} = await import("../../src/app/api/content/[kind]/route.ts");
  const content = await list(new Request("http://localhost/api/content/status"), {params: Promise.resolve({kind: "status"})});
  assert.equal(content.status, 200); assert.equal((await content.json()).data.total, 1);
  await s.db.query("SELECT nb_v2_api.set_denied($1,true)", [f.media.ownerPageId]);
  const before = objects;
  for (const suffix of ["", "?thumbnail=400"]) {
    const withdrawn = await GET(new Request(`http://localhost/media/v2/${f.media.assetId}${suffix}`), context);
    assert.notEqual(withdrawn.status, 200);
  }
  assert.equal(objects, before); assert.equal(objects, 3); assert.equal(sourceRequests, 0);
  console.log(JSON.stringify({imageRoutes: 5, contentRoutes: 1, sourceRequests, objectReads: objects, independentVariants: 2, withdrawalBlocked: true}));
} finally {restoreCheckout(); Pool.prototype.query = originalQuery; globalThis.fetch = originalFetch; await s.db.close();}
