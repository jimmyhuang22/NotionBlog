import assert from "node:assert/strict";
import { Pool } from "pg";
import { installMediaRouteCheckout } from "./media-route-pool.ts";
import { demoPage } from "../../scripts/notion-sync/demo.ts";
import { WEBSITE_SCHEMA_DIGEST } from "../../contracts/website-sync.ts";
import { WEBSITE_MEDIA_SOURCE_CAPABILITY } from "../../src/server/database/website-media-sources.ts";
import { WEBSITE_READER_ISOLATION_SQL } from "../../src/server/database/website-reader-isolation.ts";
import { thumbnailBatchSql } from "../../src/server/database/thumbnail-query.ts";
import { mediaIdentity } from "../../src/server/database/validation.ts";
import { sourceFingerprint } from "../../src/server/media/notion-source.ts";

// Exercise the exported route with the real client, scheduler and resolver.
// Only SQL and HTTP transport are replaced; no remote sockets or credentials.
const id = (n: number) => n.toString(16).padStart(32, "0");
const sourceId = id(10), url = "https://assets.example.test/fictional-cover.jpg";
const date = "2026-01-01T00:00:00.000Z", sha = "a".repeat(64);
const projections = new Map(Array.from({ length: 29 }, (_, i) => {
  const owner = id(100 + i), asset = mediaIdentity(owner, "cover", sha);
  return [asset, {
    media: { assetId: asset, ownerPageId: owner, sha256: sha, objectKey: `sha256/${sha}`, byteSize: 100, mime: "image/jpeg", width: 400, height: 600 },
    binding: { assetId: asset, ownerPageId: owner, sha256: sha, locator: { kind: "cover" }, delivery: "notion", sourceFingerprint: sourceFingerprint(url, false) },
  }];
}));
const schema = {
  object: "data_source", id: sourceId, title: [], description: [],
  parent: { type: "database_id", database_id: id(900) }, database_parent: { type: "workspace", workspace: true },
  is_inline: false, database_type: null, in_trash: false, archived: false,
  created_time: date, last_edited_time: date, created_by: { object: "user", id: id(999) }, last_edited_by: { object: "user", id: id(999) },
  icon: null, cover: null, url: "https://example.test/fictional-source", public_url: null,
  properties: { Name: { id: "title", name: "Name", description: null, type: "title", title: {} } },
};
Object.assign(process.env, {
  CONTENT_PROVIDER: "database", DATABASE_CONTENT_VERSION: "2", DATABASE_READER_ISOLATION: "enforce",
  DATABASE_PUBLICATION_MODE: "qualified", DATABASE_READ_PROJECTION: "legacy", DATABASE_SEARCH_CONTEXT: "off",
  DATABASE_READER_URL: "postgres://fixture:fixture@localhost/db", DATABASE_TLS: "disable",
  DATABASE_LIBRARY_PAGE: "legacy", MEDIA_DELIVERY_MODE: "legacy", PUBLIC_CONTENT_CACHE: "disabled",
  MEDIA_PROVIDER: "notion", MEDIA_THUMBNAILS: "enabled", MEDIA_THUMBNAIL_QUALIFICATION: "database",
  STORAGE_PROVIDER: "supabase", THUMBNAIL_STORAGE_PROVIDER: "supabase",
  CONTENT_FEATURES_JSON: JSON.stringify({ movie: true }), SITE_CONFIG_JSON: "{}",
  NOTION_TOKEN: "placeholder", NOTION_SOURCES_JSON: JSON.stringify({ schemaVersion: 2, sources: [{
    key: "fictional-movies", kind: "movie", enabled: true, dataSourceId: sourceId, fields: { title: "Name" },
    cover: { strategy: "native-page-cover" }, publication: { mode: "all", allowlistPageIds: [] },
  }] }),
});
for (const name of ["DATABASE_MEDIA_DIRECTORY", "MEDIA_DISPLAY_ROOT", "MEDIA_DISPLAY_MANIFEST", "PRIVATE_MEDIA_ROOT"]) delete process.env[name];
const query = Pool.prototype.query, fetcher = globalThis.fetch, restore = installMediaRouteCheckout();
let originalReads = 0, sourceReads = 0;
const starts: number[] = [], owners = new Set<string>();
try {
  Pool.prototype.query = (async (sql: string, input?: unknown[]) => {
    if (sql === WEBSITE_READER_ISOLATION_SQL) return { rows: [{ isolated: true }] };
    if (sql === thumbnailBatchSql) {
      const wanted = JSON.parse(input![0] as string) as { request_id: number; asset_id: string; width: number }[];
      return { rows: wanted.map(row => {
        assert.equal(row.width, 400); const source = projections.get(row.asset_id); assert.ok(source);
        return { request_id: row.request_id, result: {
          thumbnailCapability: "notionblog-thumbnail-index-v1", schemaDigest: WEBSITE_SCHEMA_DIGEST,
          version: "v2", runId: "11111111-1111-4111-8111-111111111111", source, thumbnail: null,
        } };
      }) };
    }
    assert.equal(sql, "SELECT nb_v2_media_api.read_source($1) AS result");
    originalReads++;
    const source = projections.get(input![0] as string); assert.ok(source);
    return { rows: [{ result: { schemaDigest: WEBSITE_SCHEMA_DIGEST, mediaCapability: WEBSITE_MEDIA_SOURCE_CAPABILITY, ...source } }] };
  }) as typeof Pool.prototype.query;
  globalThis.fetch = async input => {
    const request = new URL(String(input)); assert.equal(request.hostname, "api.notion.com");
    starts.push(performance.now());
    if (request.pathname.includes("/pages/")) {
      const owner = request.pathname.split("/").at(-1)!;
      assert.ok([...projections.values()].some(p => p.media.ownerPageId === owner));
      owners.add(owner);
      const page = demoPage(owner, "Fictional movie", { type: "data_source_id", data_source_id: sourceId, database_id: id(900) });
      page.cover = { type: "external", external: { url } };
      return Response.json(page);
    }
    assert.equal(request.pathname, `/v1/data_sources/${sourceId}`); sourceReads++;
    return Response.json(schema);
  };
  const { GET } = await import("../../src/app/media/v2/[assetId]/route.ts");
  const responses = await Promise.all([...projections.keys()].map(assetId => GET(
    new Request(`https://example.test/media/v2/${assetId}?thumbnail=400`), { params: Promise.resolve({ assetId }) },
  )));
  for (const response of responses) {
    assert.equal(response.status, 302, await response.text());
    assert.equal(response.headers.get("Location"), url);
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  }
  assert.equal(owners.size, 29); assert.equal(sourceReads, 29); assert.equal(originalReads, 58);
  assert.equal(starts.length, 58);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 330, "retain the production 350 ms scheduler interval");
  console.log(JSON.stringify({ redirects: responses.length, sourceReads, originalReads, transportReads: starts.length, externalRequests: 0 }));
} finally { Pool.prototype.query = query; globalThis.fetch = fetcher; restore(); }
