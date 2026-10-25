import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, realpath, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { PGlite } from "@electric-sql/pglite";
import { Pool } from "pg";
import sharp from "sharp";
import { fixtureItems } from "../../fixtures/content.ts";
import { WEBSITE_SCHEMA_DIGEST } from "../../contracts/website-sync.ts";
import { configDigest, mediaIdentity } from "../../src/server/database/website-validation.ts";
import { createWebsiteWriter } from "../../src/server/database/website-writer.ts";
import { createWebsiteMediaSourceWriter } from "../../src/server/database/website-media-sources.ts";
import { readThumbnail } from "../../src/server/database/thumbnail-index.ts";
import { buildDisplayBundle } from "../../scripts/self-hosted-media/bundle.ts";
import type { SqlExecutor } from "../../src/server/database/sql.ts";
import { installMediaRouteCheckout } from "./media-route-pool.ts";
const require = createRequire(import.meta.url);
const context = require("../../scripts/self-hosted/context.cjs");
const profile = require("../../scripts/self-hosted/profile.cjs");
const root = await realpath(await mkdtemp(join(tmpdir(), "self-hosted-http-")));
const database = await PGlite.create(), originalQuery = Pool.prototype.query, clientFetch = globalThis.fetch;
let server: ReturnType<typeof createServer> | undefined, undo: (() => void) | undefined, queries = 0, remoteCalls = 0;
try {
  await database.exec("CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE ROLE nb_website_reader LOGIN INHERIT;");
  for (const file of ["database/website-migrations/001_website.sql", "database/website-media-migrations/001_website_media_sources.sql", "supabase/migrations/20261011123536_media_thumbnails.sql"])
    await database.exec(await readFile(new URL("../../" + file, import.meta.url), "utf8"));
  await database.exec("GRANT nb_reader TO nb_website_reader");
  await database.query("UPDATE nb_v2.state SET schema_digest=$1", [WEBSITE_SCHEMA_DIGEST]);
  const reader: SqlExecutor = { query: <T>(text: string, values?: unknown[]) => database.transaction(async tx => {
    await tx.exec("SET LOCAL ROLE nb_website_reader"); return tx.query<T>(text, values);
  }) };
  const input = await sharp({ create: { width: 1000, height: 700, channels: 4, background: { r: 10, g: 140, b: 80, alpha: 0.4 } } }).png().toBuffer();
  const hash = createHash("sha256").update(input).digest("hex"), item = structuredClone(fixtureItems.status[0]);
  item.href = "/status#" + item.id;
  const media = { assetId: mediaIdentity(item.id, "cover", hash), ownerPageId: item.id, sha256: hash, objectKey: "sha256/" + hash, mime: "image/png" as const, byteSize: input.length, width: 1000, height: 700 };
  item.cover = { id: media.assetId, src: "/media/v2/" + media.assetId, alt: "Fictional display", width: 1000, height: 700 };
  const sources = [{ key: "fixture", kind: "status", mode: "all", dataSourceId: "fictional-display-source", databaseParentId: null, pageId: null }];
  const digest = configDigest({ sources, permits: [] });
  await database.query("SELECT nb_v2_api.configure_policy($1,600,$2::jsonb,'[]')", [digest, JSON.stringify(sources)]);
  const writer = createWebsiteWriter(database), lease = await writer.begin(randomUUID(), digest);
  await writer.stage(lease, [{ detail: { item, document: { blocks: [], toc: [], completeness: "complete" } }, evidence: { sourceKey: "fixture", dataSourceId: "fictional-display-source", databaseParentId: null, courseId: null, parentId: null, ordinal: 0 } }], [media]);
  await createWebsiteMediaSourceWriter(database).stage(lease, [{ assetId: media.assetId, ownerPageId: item.id, sha256: hash, locator: { kind: "cover" }, delivery: "notion", sourceFingerprint: "a".repeat(64) }]);
  await writer.promote(lease, { records: 1, media: 1, complete: true });
  const qualified = await readThumbnail(reader, "v2", media.assetId, 400); assert(qualified); assert.equal(qualified.thumbnail, null);
  const displayRoot = join(root, "display"), manifest = await buildDisplayBundle(displayRoot, lease.runId, [{ source: qualified, bytes: input }]);
  const filename = join(root, "reader.json");
  await writeFile(filename, JSON.stringify({ version: 1, environment: { DATABASE_READER_URL: "postgresql://nb_website_reader:fixture@localhost/display", DATABASE_CA_CERT: "-----BEGIN CERTIFICATE-----\nfixture-only\n-----END CERTIFICATE-----\n", SITE_URL: "http://localhost:3100", SELF_HOSTED_MEDIA_MODE: "display-only", SELF_HOSTED_MEDIA_ROOT: displayRoot } }), { mode: 0o600 });
  context.install("runtime", process.cwd(), profile.readProfile(filename, true));
  Pool.prototype.query = (async function (this: Pool, text: string, values?: unknown[]) {
    queries++; const ssl = this.options.ssl;
    assert(ssl && typeof ssl === "object" && ssl.rejectUnauthorized === true);
    return reader.query(text, values);
  }) as typeof Pool.prototype.query;
  undo = installMediaRouteCheckout();
  globalThis.fetch = async () => { remoteCalls++; throw Error("Unexpected original/object transport"); };
  const { GET } = await import("../../src/app/media/v2/[assetId]/route.ts");
  const { getDatabaseRuntime } = await import("../../src/server/database/runtime.ts");
  const page = await getDatabaseRuntime().repository.list("status", { limit: 1 });
  assert.deepEqual(page.items[0].cover?.delivery, { mode: "display-only", maxWidth: 1000, maxHeight: 700 });
  server = createServer((request, response) => {
    void (async () => {
      const result = await GET(new Request("http://localhost" + request.url), { params: Promise.resolve({ assetId: media.assetId }) });
      response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(Buffer.from(await result.arrayBuffer()));
    })().catch(() => { response.writeHead(500).end(); });
  });
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert(address && typeof address !== "string"); const base = "http://127.0.0.1:" + address.port + "/media/v2/" + media.assetId;
  for (const query of ["", "?thumbnail=400", "?thumbnail=800", "?thumbnail=1600"]) {
    const response = await clientFetch(base + query); assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer()), meta = await sharp(bytes).metadata();
    assert(meta.width! <= 1000); assert.equal(meta.hasAlpha, true); assert.equal(response.headers.get("cache-control"), "private, no-store");
  }
  assert.equal((await clientFetch(base + "?thumbnail=400&thumbnail=800")).status, 400);
  const object = join(displayRoot, "objects", manifest.assets[0].base.sha256 + ".webp"), saved = await readFile(object);
  await writeFile(object, Buffer.alloc(saved.length)); assert.equal((await clientFetch(base)).status, 503); await writeFile(object, saved);
  await database.query("SELECT nb_v2_api.set_denied($1,true)", [item.id]);
  assert.equal((await clientFetch(base)).status, 404); assert.equal(remoteCalls, 0);
  await assert.rejects(reader.query("SELECT * FROM nb_v2.records"), /permission denied/);
  console.log(JSON.stringify({ status: "ACTUAL_MEDIA_ROUTE_PGLITE_HTTP_PASS", derivedHTTP: 4, invalidQuery: 400, badBytes: 503, deniedOwner: 404, remoteCalls, sqlQueries: queries, tlsConfigurationVerified: true, nativeTLSHandshakeTested: false, originalFileUploaded: false }));
} finally {
  server?.closeAllConnections(); if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  undo?.(); Pool.prototype.query = originalQuery; globalThis.fetch = clientFetch;
  if (context.isSelfHostedRuntime()) await context.closeSelfHostedPools();
  await database.close(); await rm(root, { recursive: true, force: true });
}
