import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { fixtureItems } from "../../fixtures/content.ts";
import type { ContentDocument } from "../../contracts/content.ts";
import { WEBSITE_SCHEMA_DIGEST, type WebsiteRecord } from "../../contracts/website-sync.ts";
import type { StoredMedia } from "../../contracts/sync.ts";
import { createWebsiteWriter } from "../../src/server/database/website-writer.ts";
import { createWebsiteDatabaseRepository } from "../../src/server/database/website-repository.ts";
import { scopedReader } from "../../src/server/database/scoped-reads.ts";
import { configDigest } from "../../src/server/database/website-validation.ts";
import type { SqlExecutor } from "../../src/server/database/sql.ts";
import scoped from "../../database/scoped-read-protocol.json" with { type: "json" };
import publication from "../../database/publication-protocol.json" with { type: "json" };
import protocol from "../../database/search-precomputed-protocol.json" with { type: "json" };

export const body = (text: string): ContentDocument => ({ toc: [], completeness: "complete", blocks: [{ id: "p", type: "paragraph", text: [{ text }] }] });
export function status(index: number, document = body("needle")): WebsiteRecord {
  const id = `projection-status-${String(index).padStart(4, "0")}`;
  return { detail: { item: { ...structuredClone(fixtureItems.status[0]), id, slug: id, href: `/status#${id}`,
    title: id, text: [], cover: null, summary: null }, document },
    evidence: { sourceKey: "statuses", dataSourceId: "source-statuses", databaseParentId: null, courseId: null, parentId: null, ordinal: index } };
}

export async function setupSearchProjection(install = true) {
  const db = await PGlite.create();
  await db.exec("CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS; ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO anon,authenticated,service_role; ALTER DEFAULT PRIVILEGES GRANT ALL ON TABLES TO anon,authenticated,service_role;");
  for (const path of ["database/migrations/001_content.sql", "database/website-migrations/001_website.sql"])
    await db.exec(await readFile(new URL("../../" + path, import.meta.url), "utf8"));
  const migrations = [publication.migration, scoped.migration, scoped.searchMigration, scoped.traversalMigration, ...(install ? [protocol.migration] : [])];
  for (const migration of migrations) {
    const sql = await readFile(new URL("../../supabase/migrations/" + migration.file, import.meta.url));
    assert.equal(createHash("sha256").update(sql).digest("hex"), migration.sha256);
    await db.exec(sql.toString());
  }
  await db.query("UPDATE nb_v2.state SET schema_digest=$1", [WEBSITE_SCHEMA_DIGEST]);
  for (const [i, migration] of [scoped.migration, scoped.searchMigration, scoped.traversalMigration].entries())
    await db.query("UPDATE nb_read.migrations SET digest=$1 WHERE version=$2", [migration.sha256, i + 1]);
  await db.query("UPDATE nb_publication.state SET migration_digest=$1", [publication.migration.sha256]);
  const sources = [{ key: "statuses", kind: "status", mode: "all", dataSourceId: "source-statuses", databaseParentId: null, pageId: null }];
  const digest = configDigest(sources);
  await db.query("SELECT nb_v2_api.configure_policy($1,600,$2::jsonb,'[]')", [digest, JSON.stringify(sources)]);
  await db.exec("CREATE ROLE nb_website_reader NOLOGIN IN ROLE nb_reader");
  const role = (name: string): SqlExecutor => ({ query: <T>(sql: string, values?: unknown[]) => db.transaction(async tx => {
    await tx.exec(`SET LOCAL ROLE ${name}`); return tx.query<T>(sql, values);
  }) });
  const reader = role("nb_website_reader"), writer = createWebsiteWriter(role("nb_writer"));
  const repo = (mode: "qualified" | "published", precomputed = true, sql = reader) =>
    createWebsiteDatabaseRepository(scopedReader(sql, mode, precomputed ? "precomputed" : "on-demand"), { scoped: true });
  const register = () => db.query("UPDATE nb_search.state SET migration_digest=$1", [protocol.migration.sha256]);
  const publish = async (records: WebsiteRecord[], media: StoredMedia[] = []) => {
    const lease = await writer.begin(randomUUID(), digest);
    for (let i = 0; i < records.length; i += 100) await writer.stage(lease, records.slice(i, i + 100));
    if (media.length) await writer.stage(lease, [], media);
    await writer.promote(lease, { records: records.length, media: media.length, complete: true });
    await db.query("SELECT nb_publication_api.activate($1)", [lease.runId]);
    return lease;
  };
  const pin = async (runId: string) => (await db.query<{ run: string; fence: string; revision: string }>(
    "SELECT r.id::text AS run,r.fence::text AS fence,s.revision::text AS revision FROM nb_v2.runs r CROSS JOIN nb_v2.state s WHERE r.id=$1", [runId])).rows[0];
  const configure = async (runId: string, mode = "published") => {
    const p = await pin(runId);
    await db.query("SELECT nb_search.configure_generation($1,$2,$3,$4,900)", [mode, p.run, p.fence, p.revision]);
    return p;
  };
  const fill = async (runId: string) => {
    const p = await configure(runId); let after: string | null = null;
    for (;;) {
      const { rows }: { rows: { result: { count: number; lastId: string } }[] } = await db.query(
        "SELECT nb_search.generate_batch($1,$2,$3,$4,25,4194304,1000) AS result", [p.run, p.fence, p.revision, after]);
      if (rows[0].result.count < 25) break;
      after = rows[0].result.lastId;
    }
  };
  return { db, writer, reader, digest, role, repo, register, publish, pin, configure, fill };
}
