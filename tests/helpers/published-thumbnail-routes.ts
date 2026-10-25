import { installMediaRouteCheckout } from "./media-route-pool.ts";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { thumbnailDatabase, thumbnailSample } from "./published-thumbnails.ts";
import { createLocalMediaStorage } from "../../src/server/database/local-storage.ts";

// The transport seam is test-local; production keeps its real pg driver and TLS.
const s = await thumbnailDatabase(), f = await thumbnailSample(s);
const directory = await realpath(await mkdtemp(join(tmpdir(), "published-thumbnail-routes-")));
const url = new URL("postgres://localhost/fixture"); url.username = "fixture-reader"; url.password = "fixture-password";
const originalQuery = Pool.prototype.query, originalFetch = globalThis.fetch; let queries = 0, fetches = 0;
const restoreCheckout = installMediaRouteCheckout();
try {
  const storage = createLocalMediaStorage(directory, url.href, "writer");
  await storage.put(f.media, f.bytes.get(f.media.objectKey)!);
  for (const m of f.variants.values()) await storage.put(m, f.bytes.get(m.objectKey)!);
  Pool.prototype.query = (async (sql: string, values?: unknown[]) => {queries++; return s.reader.query(sql, values);}) as typeof Pool.prototype.query;
  globalThis.fetch = async () => {fetches++; throw Error("Unexpected network request");};
  Object.assign(process.env, {DATABASE_READER_ISOLATION: "enforce", CONTENT_PROVIDER: "database", DATABASE_CONTENT_VERSION: "2", DATABASE_PUBLICATION_MODE: "published",
    MEDIA_PROVIDER: "storage", MEDIA_THUMBNAILS: "enabled", DATABASE_TLS: "disable", DATABASE_READER_URL: url.href, DATABASE_MEDIA_DIRECTORY: directory});
  delete process.env.NOTION_TOKEN; delete process.env.NOTION_SOURCES_JSON; delete process.env.NOTION_SOURCES_CONFIG;
  const {GET} = await import("../../src/app/media/v2/[assetId]/route.ts");
  const context = {params: Promise.resolve({assetId: f.media.assetId})};
  for (const width of [400, 800]) {
    const before = queries, response = await GET(new Request(`http://localhost/media/v2/${f.media.assetId}?thumbnail=${width}`), context);
    assert.equal(response.status, 200); assert.equal(response.headers.get("Content-Type"), "image/webp");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.bytes.get(f.variants.get(width)!.objectKey)); assert.equal(queries - before, width === 400 ? 3 : 2);
  }
  const original = await GET(new Request(`http://localhost/media/v2/${f.media.assetId}`), context);
  assert.equal(original.status, 200); assert.equal(original.headers.get("Content-Type"), "image/png");
  assert.deepEqual(Buffer.from(await original.arrayBuffer()), f.bytes.get(f.media.objectKey));
  for (const suffix of ["?thumbnail=200", "?thumbnail=400&thumbnail=800"]) {
    const invalid = await GET(new Request(`http://localhost/media/v2/${f.media.assetId}${suffix}`), context); assert.equal(invalid.status, 400);
  }
  const {GET: list} = await import("../../src/app/api/content/[kind]/route.ts");
  const content = await list(new Request("http://localhost/api/content/status"), {params: Promise.resolve({kind: "status"})});
  assert.equal(content.status, 200); assert.equal((await content.json()).data.total, 1);
  assert.equal(fetches, 0);
  console.log(JSON.stringify({imageRoutes: 5, contentRoutes: 1, sourceRequests: fetches, independentVariants: 2, original: true}));
} finally {restoreCheckout(); Pool.prototype.query = originalQuery; globalThis.fetch = originalFetch; await s.db.close(); await rm(directory, {recursive: true, force: true});}
