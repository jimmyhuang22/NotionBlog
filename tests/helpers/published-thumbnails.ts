import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import sharp from "sharp";
import { fixtureItems } from "../../fixtures/content.ts";
import { WEBSITE_SCHEMA_DIGEST, type WebsiteRecord } from "../../contracts/website-sync.ts";
import { mediaIdentity, configDigest } from "../../src/server/database/website-validation.ts";
import { publicationWriter } from "../../src/server/database/publication.ts";
import { installPublication } from "../../scripts/website-sync/publication-migration.ts";
import { installIncrementalPublication } from "../../scripts/website-sync/incremental-migration.ts";
import { installIncrementalReader } from "../../scripts/website-sync/incremental-reader-migration.ts";
import { installPublishedThumbnails } from "../../scripts/website-sync/published-thumbnail-migration.ts";
import type { SqlExecutor } from "../../src/server/database/sql.ts";
import core from "../../database/website-protocol.json" with {type: "json"};
import thumbnails from "../../database/thumbnail-protocol.json" with {type: "json"};
import type { StoredMedia } from "../../contracts/sync.ts";
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export async function thumbnailDatabase(extended = true) {
  const db = await PGlite.create();
  await db.exec("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;");
  await db.exec(await readFile(new URL("../../database/website-migrations/001_website.sql", import.meta.url), "utf8"));
  await db.query("UPDATE nb_v2.state SET schema_digest=$1", [WEBSITE_SCHEMA_DIGEST]);
  await db.query("UPDATE nb_v2.migrations SET digest=$1", [core.migration.sha256]);
  const owner: SqlExecutor = {query: async <T>(sql: string, values?: unknown[]) => {
    if (sql.startsWith("--")) {await db.exec(sql); return {rows: [] as T[]};} return db.query<T>(sql, values);
  }};
  await installPublication(owner); await installIncrementalPublication(owner); await installIncrementalReader(owner);
  await db.exec(await readFile(new URL(`../../supabase/migrations/${thumbnails.migrations[0].file}`, import.meta.url), "utf8"));
  await db.query("UPDATE nb_thumbnails.migrations SET digest=$1", [thumbnails.migrations[0].sha256]);
  // Broad owner defaults must not accidentally expose the new API.
  await db.exec("ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO anon,authenticated,service_role;");
  if (extended) await installPublishedThumbnails(owner);
  const role = (name = "nb_reader"): SqlExecutor => ({query: <T>(sql: string, values?: unknown[]) => db.transaction(async tx => {
    await tx.exec(`SET LOCAL ROLE ${name}`); return tx.query<T>(sql, values);
  })});
  return {db, owner, reader: role(), writer: role("nb_writer"), role};
}
export async function thumbnailSample(s: Awaited<ReturnType<typeof thumbnailDatabase>>) {
  const data = Buffer.alloc(128 * 128 * 3); let seed = 73;
  for (let n = 0; n < data.length; n++) {seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; data[n] = seed >>> 24;}
  const image = await sharp(data, {raw: {width: 128, height: 128, channels: 3}}).png().toBuffer();
  const item = structuredClone(fixtureItems.status[0]); Object.assign(item, {id: "thumbnail-status", slug: "thumbnail-status", href: "/status#thumbnail-status"});
  const media = {assetId: mediaIdentity(item.id, "cover", sha(image)), ownerPageId: item.id, sha256: sha(image), objectKey: `sha256/${sha(image)}`,
    byteSize: image.length, mime: "image/png" as const, width: 128, height: 128};
  item.cover = {id: media.assetId, src: `/media/v2/${media.assetId}`, alt: "Fictional image", width: 128, height: 128};
  const record: WebsiteRecord = {detail: {item, document: {blocks: [], toc: [], completeness: "complete"}},
    evidence: {sourceKey: "status", dataSourceId: "fictional-status", databaseParentId: null, courseId: null, parentId: null, ordinal: 0}};
  const sources = [{key: "status", kind: "status", mode: "all", dataSourceId: "fictional-status", databaseParentId: null, pageId: null}], digest = configDigest(sources);
  await s.db.query("SELECT nb_v2_api.configure_policy($1,600,$2::jsonb,'[]')", [digest, JSON.stringify(sources)]);
  const publisher = publicationWriter(s.writer, "published"), lease = await publisher.begin(randomUUID(), digest);
  await publisher.stage(lease, [record], [media]); await publisher.promote(lease, {records: 1, media: 1, complete: true});
  const bytes = new Map([[media.objectKey, image]]), variants = new Map<number, StoredMedia>();
  for (const width of [400, 800]) {
    const buffer = await sharp(image).webp({quality: width === 400 ? 65 : 80}).toBuffer(), hash = sha(buffer);
    const thumbnail = {...media, assetId: mediaIdentity(item.id, `thumbnail:${width}:${media.assetId}`, hash), sha256: hash,
      objectKey: `sha256/${hash}`, byteSize: buffer.length, mime: "image/webp" as const};
    bytes.set(thumbnail.objectKey, buffer); variants.set(width, thumbnail);
    await s.db.query("INSERT INTO nb_thumbnails.media VALUES('v2',$1,$2,$3,$4,$5,$6::jsonb)", [lease.runId, media.assetId, media.sha256, "b".repeat(64), width, JSON.stringify(thumbnail)]);
  }
  return {record, media, bytes, variants, runId: lease.runId, digest};
}
