import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { SqlExecutor } from "../../src/server/database/sql.ts";
import { createWebsiteWriter } from "../../src/server/database/website-writer.ts";
import { WEBSITE_SCHEMA_DIGEST } from "../../contracts/website-sync.ts";
import { createDemo } from "../../scripts/notion-sync/demo.ts";
import { parseWebsiteNotionConfig } from "../../src/server/notion/website-config.ts";
import { createWebsiteNotionRepository } from "../../src/server/notion/website-repository.ts";
import { configDigest } from "../../src/server/database/website-validation.ts";
import { config, hash, publicationKey } from "../../scripts/social-sync/model.ts";
import { observation } from "../../scripts/social-sync/bilibili.ts";
import protocol from "../../database/public-cache-commit-protocol.json" with { type: "json" };

export const commitSQL = () => readFile(new URL("../../" + protocol.migration.file, import.meta.url), "utf8");
export async function setupCacheCommitFixture(db: SqlExecutor, exec: (sql: string) => Promise<unknown>) {
  await exec("CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;");
  await exec(await readFile(new URL("../../database/website-migrations/001_website.sql", import.meta.url), "utf8"));
  for (const name of ["20261012005001_social_sync_v1.sql", "20261012015408_social_reader_v1.sql", "20261012020551_social_reader_binding_index.sql"])
    await exec(await readFile(new URL("../../supabase/migrations/" + name, import.meta.url), "utf8"));
  // Real media projection trigger shape, without storage or media downloads.
  await exec("CREATE SCHEMA nb_thumbnails;CREATE TABLE nb_thumbnails.media(id text PRIMARY KEY)");
  const demo = createDemo(1), source = demo.config.sources[0];
  const cfg = parseWebsiteNotionConfig({ schemaVersion: 2, sources: [{ ...source }] });
  const collection = { records: await createWebsiteNotionRepository({ client: demo.client, config: cfg }).collectRecords() }, digest = configDigest(cfg);
  await db.query("UPDATE nb_v2.state SET schema_digest=$1", [WEBSITE_SCHEMA_DIGEST]);
  await db.query("SELECT nb_v2_api.configure_policy($1,600,$2::jsonb,'[]')", [digest, JSON.stringify(cfg.sources.map(s => ({ key: s.key, kind: s.kind,
    mode: s.publication.mode, dataSourceId: s.dataSourceId, databaseParentId: null, pageId: s.pageId })))]);
  const writer = createWebsiteWriter(db);
  async function prepare(using: SqlExecutor = db) {
    const w = createWebsiteWriter(using), lease = await w.begin(randomUUID(), digest);
    await w.stage(lease, collection.records);
    return { lease, publish: () => w.promote(lease, { records: collection.records.length, media: 0, complete: true }) };
  }
  const initial = await prepare(); await initial.publish();
  // Register two real independent social bindings before enabling cache observation.
  const samples = [1, 2].map(n => {
    const target = config({ version: 1, publications: [{ platform: "bilibili", workId: `fixture-work-${n}`, accountId: "10001", url: `https://www.bilibili.com/video/BV${String(n).padStart(10, "0")}/` }] })[0];
    const row = observation(`<script>window.__INITIAL_STATE__={"videoData":{"bvid":"${target.publicationId}","owner":{"mid":10001},"title":"Fixture video","stat":{"like":${n},"reply":0}}}</script>`, target, new Date().toISOString());
    return { target, row, key: publicationKey(row), sha: hash(JSON.stringify(row)), payload: JSON.stringify(row) };
  });
  for (const s of samples) await db.query("INSERT INTO social_sync.bindings(platform,account_id,publication_id,work_id,enabled) VALUES($1,$2,$3,$4,true)", [s.target.platform,s.target.accountId,s.target.publicationId,s.target.workId]);
  await exec(await readFile(new URL("../../" + protocol.baseMigration.file, import.meta.url), "utf8"));
  return { prepare, writer, samples, initialRun: initial.lease.runId };
}
export const ingestSample = (db: SqlExecutor, sample: Awaited<ReturnType<typeof setupCacheCommitFixture>>["samples"][number]) =>
  db.query("SELECT * FROM social_sync.ingest($1,$2,$3)", [sample.key,sample.sha,sample.payload]);
