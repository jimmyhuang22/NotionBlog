import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { Pool, type PoolClient, type QueryConfig } from "pg";
import { SYNC_SCHEMA_DIGEST } from "../../contracts/sync.ts";
import { WEBSITE_SCHEMA_DIGEST } from "../../contracts/website-sync.ts";
import { WEBSITE_READER_ISOLATION_SQL } from "../../src/server/database/website-reader-isolation.ts";
import { mediaIdentity } from "../../src/server/database/validation.ts";

const version = process.argv[2];
assert.ok(version === "1" || version === "2");
const delivery = process.argv[3];
assert.ok(delivery === undefined || delivery === "legacy");
const bytes = Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
const sha256 = createHash("sha256").update(bytes).digest("hex"), owner = "0".repeat(31) + "1";
const assetId = mediaIdentity(owner, "cover", sha256);
const media = { assetId, ownerPageId: owner, sha256, objectKey: "sha256/" + sha256,
  byteSize: bytes.length, mime: "image/png", width: null, height: null };
const projection = { rows: [{ result: { schemaDigest: version === "1" ? SYNC_SCHEMA_DIGEST : WEBSITE_SCHEMA_DIGEST, media } }] };
const context = { params: Promise.resolve({ assetId }) }, path = `https://example.test/media/${version === "2" ? "v2/" : ""}${assetId}`;
let queries = 0, objects = 0, connects = 0;
let holdSql = false, holdObject = false, completeSql!: () => void, completeObject!: () => void;
let started!: () => void;
const releases: boolean[] = [];
const originalConnect = Pool.prototype.connect, originalQuery = Pool.prototype.query, originalFetch = globalThis.fetch;
try {
  if (delivery === undefined) delete process.env.MEDIA_DELIVERY_MODE;
  else process.env.MEDIA_DELIVERY_MODE = delivery;
  Object.assign(process.env, {DATABASE_READER_ISOLATION: "enforce",  CONTENT_PROVIDER: "database", DATABASE_CONTENT_VERSION: version,
    DATABASE_PUBLICATION_MODE: "qualified", DATABASE_READ_PROJECTION: "legacy", DATABASE_SEARCH_CONTEXT: "off",
    DATABASE_READER_URL: "postgres://fixture:fixture@localhost/db", DATABASE_TLS: "disable",
    MEDIA_PROVIDER: "storage", MEDIA_THUMBNAILS: "disabled", PUBLIC_CONTENT_CACHE: "disabled",
    STORAGE_PROVIDER: "cos", COS_BUCKET: "fiction-media-1250000000", COS_REGION: "ap-shanghai",
    COS_PREFIX: "notionblog", COS_SECRET_ID: "fixtureSecretId123", COS_SECRET_KEY: "fixtureSecretKeyForCos123" });
  for (const key of ["DATABASE_MEDIA_DIRECTORY", "NOTION_TOKEN", "NOTION_SOURCES_JSON", "COS_SECURITY_TOKEN", "COS_CREDENTIALS_EXPIRES_AT"]) delete process.env[key];
  Pool.prototype.query = (() => { throw Error("Route bypassed its request-scoped SQL checkout"); }) as typeof Pool.prototype.query;
  Pool.prototype.connect = function (callback: (error: Error | null, client: PoolClient) => void) {
    connects++;
    const client = Object.assign(new EventEmitter(), {
      query: async (config: QueryConfig & { query_timeout: number }) => {
        assert.ok(config.query_timeout > 0 && config.query_timeout <= 8000);
        queries++;
        if (config.text === WEBSITE_READER_ISOLATION_SQL) return { rows: [{ isolated: true }] };
        assert.equal(config.text, `SELECT ${version === "1" ? "nb_api" : "nb_v2_api"}.read_media($1) AS result`);
        if (holdSql) { started(); await new Promise<void>(resolve => { completeSql = resolve; }); }
        return structuredClone(projection);
      },
      release: (destroy = false) => { releases.push(destroy); },
    });
    callback(null, client as unknown as PoolClient);
  } as typeof Pool.prototype.connect;
  globalThis.fetch = async input => {
    assert.equal(new URL(String(input)).hostname, "fiction-media-1250000000.cos.ap-shanghai.myqcloud.com");
    objects++;
    if (holdObject) { started(); await new Promise<void>(resolve => { completeObject = resolve; }); }
    return new Response(bytes);
  };
  const { GET } = version === "1" ? await import("../../src/app/media/[assetId]/route.ts") : await import("../../src/app/media/v2/[assetId]/route.ts");
  assert.equal(connects, 0, "importing a media route does not connect to the database");
  assert.equal(objects, 0, "importing a media route does not read Storage");
  process.env.DATABASE_CONTENT_VERSION = version === "1" ? "2" : "1";
  const mismatch = await GET(new Request(path), context);
  assert.equal(mismatch.status, 404); assert.match(mismatch.headers.get("Cache-Control")!, /no-store/);
  assert.equal(connects, 0); assert.equal(objects, 0);
  process.env.DATABASE_CONTENT_VERSION = version;
  const preCancelled = AbortSignal.abort();
  assert.equal((await GET(new Request(path, { signal: preCancelled }), context)).status, 503);
  assert.equal(connects, 0);
  holdSql = true;
  let began = new Promise<void>(resolve => { started = resolve; });
  const controller = new AbortController();
  const pending = GET(new Request(path, { signal: controller.signal }), context);
  await Promise.race([began, pending.then(response => { throw Error(`SQL did not start: ${response.status}`); })]); controller.abort();
  const cancelled = await pending;
  assert.equal(cancelled.status, 503); assert.match(cancelled.headers.get("Cache-Control")!, /no-store/);
  assert.equal(releases.at(-1), true); assert.equal(objects, 0);
  holdSql = false; completeSql(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(objects, 0);

  holdObject = true; began = new Promise<void>(resolve => { started = resolve; });
  const objectController = new AbortController();
  const objectPending = GET(new Request(path, { signal: objectController.signal }), context);
  await began; const before = queries; objectController.abort();
  assert.equal((await objectPending).status, 503);
  holdObject = false; completeObject(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(queries, before, "a late object cannot start another SQL qualification after cancellation");

  holdSql = true; began = new Promise<void>(resolve => { started = resolve; });
  const deadlinePending = GET(new Request(path), context);
  await began;
  // Keep the isolated process alive while the real unref'ed eight-second timer runs.
  const keepAlive = setInterval(() => {}, 1000);
  try { assert.equal((await deadlinePending).status, 503); }
  finally { clearInterval(keepAlive); }
  assert.equal(releases.at(-1), true);
  holdSql = false; completeSql(); await new Promise(resolve => setImmediate(resolve));
  if (version === "1") delete process.env.DATABASE_CONTENT_VERSION; // Preserve the existing v1 default.
  const good = await GET(new Request(path), context);
  assert.equal(good.status, 200); assert.deepEqual(Buffer.from(await good.arrayBuffer()), bytes);
  console.log(JSON.stringify({ version, versionBlocked: true, abortedSqlDestroyed: true,
    lateObjectCannotRequery: true, deadlineStopped: true, subsequentRequestSucceeded: true }));
} finally { Pool.prototype.connect = originalConnect; Pool.prototype.query = originalQuery; globalThis.fetch = originalFetch; }
