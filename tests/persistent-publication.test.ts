import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { fixtureItems } from "../fixtures/content.ts";
import type { AnyContent, ContentKind } from "../contracts/content.ts";
import type { WebsiteRecord } from "../contracts/website-sync.ts";
import { WEBSITE_SCHEMA_DIGEST } from "../contracts/website-sync.ts";
import protocol from "../database/publication-protocol.json" with { type: "json" };
import { configDigest, mediaIdentity } from "../src/server/database/website-validation.ts";
import { createWebsiteDatabaseRepository } from "../src/server/database/website-repository.ts";
import { websiteMediaResponse } from "../src/server/database/website-media.ts";
import { publicationMode, publicationReader, publicationWriter } from "../src/server/database/publication.ts";
import { installPublication } from "../scripts/website-sync/publication-migration.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";

const controlled = (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === "CONTENT_UNAVAILABLE";

test("publication mode is opt-in and rejects unknown modes", async () => {
  assert.equal(publicationMode(undefined), "qualified");
  assert.equal(publicationMode("published"), "published");
  assert.throws(() => publicationMode("stale"));
  const db: SqlExecutor = { query: async () => { throw new Error("No I/O expected"); } };
  assert.equal(publicationReader(db, "qualified"), db);
  await assert.rejects(publicationReader(db, "published").query("DELETE FROM nb_v2.records"), controlled);
});

test("explicit published content survives sync expiry while preserving withdrawal and roles", async t => {
  const db = await PGlite.create();
  try {
    await db.exec("CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;");
    await db.exec(await readFile(new URL("../database/migrations/001_content.sql", import.meta.url), "utf8"));
    await db.exec(await readFile(new URL("../database/website-migrations/001_website.sql", import.meta.url), "utf8"));
    await db.query("UPDATE nb_v2.state SET schema_digest=$1", [WEBSITE_SCHEMA_DIGEST]);
    await db.exec("ALTER DEFAULT PRIVILEGES GRANT ALL ON TABLES TO anon,authenticated,service_role; ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO anon,authenticated,service_role;");
    const role = (name: string): SqlExecutor => ({ query: <T>(sql: string, values?: unknown[]) => db.transaction(async tx => {
      await tx.exec(`SET LOCAL ROLE ${name}`); return tx.query<T>(sql, values);
    }) });
    const operator: SqlExecutor = { query: async <T>(sql: string, values?: unknown[]) => {
      if (sql.startsWith("-- Opt-in publication pointer.")) { await db.exec(sql); return { rows: [] as T[] }; }
      return db.query<T>(sql, values);
    } };
    await installPublication(operator);
    await installPublication(operator);
    const batch: WebsiteRecord[] = [];
    const kinds: ContentKind[] = ["post", "status", "course", "study-note"];
    for (const kind of kinds) for (const raw of fixtureItems[kind].slice(0, kind === "post" ? 2 : 1)) {
      const item = structuredClone(raw) as AnyContent; item.cover = null;
      const course = fixtureItems.course[0].id;
      if (item.kind === "status") item.href = `/status#${item.id}`;
      if (item.kind === "study-note") { item.courseId = course; item.parentId = null; item.breadcrumbs = []; item.href = `/study/${course}/notes/${item.slug}`; }
      batch.push({ detail: { item, document: { blocks: [{ id: "body", type: "paragraph", text: [{ text: "Stored independent body" }] }], toc: [], completeness: "complete" } },
        evidence: { sourceKey: kind, dataSourceId: `source-${kind}`, databaseParentId: kind === "study-note" ? course : null,
          courseId: kind === "study-note" ? course : null, parentId: kind === "study-note" ? course : null, ordinal: batch.length } });
    }
    const sources = kinds.map(kind => ({ key: kind, kind, mode: kind === "course" || kind === "study-note" ? "allowlist" : "all",
      dataSourceId: `source-${kind}`, databaseParentId: kind === "study-note" ? fixtureItems.course[0].id : null, pageId: null }));
    const permits = batch.filter(r => r.detail.item.kind === "course" || r.detail.item.kind === "study-note").map(r => ({
      id: r.detail.item.id, kind: r.detail.item.kind, sourceKey: r.evidence.sourceKey, courseId: r.evidence.courseId, parentId: r.evidence.parentId,
    }));
    const digest = configDigest([sources, permits]);
    const configure = () => db.query("SELECT nb_v2_api.configure_policy($1,600,$2::jsonb,$3::jsonb)", [digest, JSON.stringify(sources), JSON.stringify(permits)]);
    await configure();
    const reader = role("nb_reader"), qualified = createWebsiteDatabaseRepository(reader);
    const published = createWebsiteDatabaseRepository(publicationReader(reader, "published"));
    const legacyWriter = publicationWriter(role("nb_writer"), "qualified"), writer = publicationWriter(role("nb_writer"), "published");
    const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZL98AAAAASUVORK5CYII=", "base64");
    const sha = createHash("sha256").update(bytes).digest("hex"), owner = batch[0].detail.item.id, assetId = mediaIdentity(owner, "cover", sha);
    const media = { assetId, ownerPageId: owner, objectKey: `sha256/${sha}`, sha256: sha, byteSize: bytes.length, mime: "image/png" as const, width: 1, height: 1 };
    batch[0].detail.item.cover = { id: assetId, src: `/media/v2/${assetId}`, alt: "Stored sample", width: 1, height: 1 };
    const receipt = { records: batch.length, media: 1, complete: true };
    async function publish(usePublished: boolean) {
      const w = usePublished ? writer : legacyWriter, lease = await w.begin(randomUUID(), digest);
      await w.stage(lease, batch, [media]); await w.promote(lease, receipt); return lease;
    }
    await t.test("installing the extension does not activate or resurrect data", async () => {
      await publish(false);
      assert.equal((await qualified.list("post")).items.length, 2);
      await assert.rejects(published.list("post"), controlled);
      assert.equal((await db.query<{run_id: string | null}>("SELECT run_id FROM nb_publication.state")).rows[0].run_id, null);
    });
    const active = await publish(true);
    await t.test("activation and promotion are retry-safe and do not reset publication time", async () => {
      const before = (await db.query("SELECT published_at FROM nb_publication.state")).rows[0];
      await writer.promote(active, receipt);
      assert.deepEqual((await db.query("SELECT published_at FROM nb_publication.state")).rows[0], before);
    });
    await t.test("expired qualification blocks the old reader but leaves explicitly published data readable", async () => {
      await db.query("UPDATE nb_v2.runs SET valid_until=clock_timestamp()-interval '1 second' WHERE id=$1", [active.runId]);
      await assert.rejects(qualified.list("post"), controlled);
      assert.equal((await published.list("post")).items.length, 2);
      assert.equal((await published.get("post", fixtureItems.post[0].slug))?.document?.blocks.length, 1);
      assert.equal((await published.getCourseTree(fixtureItems.course[0].slug))?.nodes.length, 1);
      assert.equal((await published.getStatusYears!()).undatedCount + (await published.getStatusYears!()).years.reduce((n, y) => n + y.count, 0), 1);
      const response = await websiteMediaResponse(assetId, publicationReader(reader, "published"), () => ({ read: async () => bytes, put: async () => assert.fail("Read-only media") }));
      assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
      await writer.promote(active, receipt);
    });
    await t.test("reader, worker and public roles retain separate minimal privileges", async () => {
      await assert.rejects(reader.query("SELECT nb_publication_api.activate($1)", [active.runId]), /permission denied/);
      await assert.rejects(role("nb_writer").query("SELECT nb_publication_api.read_snapshot(ARRAY['post'],true)"), /permission denied/);
      for (const name of ["nb_reader", "nb_writer", "anon", "authenticated", "service_role"]) {
        await assert.rejects(role(name).query("SELECT * FROM nb_publication.state"), /permission denied/);
      }
      await assert.rejects(role("anon").query("SELECT nb_publication_api.read_snapshot(ARRAY['post'],true)"), /permission denied/);
      assert.equal((await reader.query<{result: boolean}>("SELECT nb_publication_api.check_capability($1) AS result", ["0".repeat(64)])).rows[0].result, false);
      await db.exec("GRANT USAGE ON SCHEMA nb_publication,nb_publication_api TO anon,authenticated,service_role");
      for (const name of ["anon", "authenticated", "service_role"]) {
        await assert.rejects(role(name).query("SELECT * FROM nb_publication.state"), /permission denied/);
        await assert.rejects(role(name).query("SELECT nb_publication_api.read_snapshot(ARRAY['post'],true)"), /permission denied/);
      }
    });
    await t.test("central withdrawal still hides ancestors, descendants and stored content", async () => {
      await db.query("SELECT nb_v2_api.set_denied($1,true)", [fixtureItems.course[0].id]);
      assert.equal((await published.list("study-note")).items.length, 0);
      assert.equal(await published.getCourseTree(fixtureItems.course[0].slug), null);
      await db.query("SELECT nb_v2_api.set_denied($1,false)", [fixtureItems.course[0].id]);
      const withdrawn = await websiteMediaResponse(assetId, publicationReader(reader, "published"), () => ({ read: async () => {
        await db.query("SELECT nb_v2_api.set_denied($1,true)", [owner]); return bytes;
      }, put: async () => assert.fail("Read-only media") }));
      assert.equal(withdrawn.status, 404);
      await db.query("SELECT nb_v2_api.set_denied($1,false)", [owner]);
    });
    await t.test("an ordinary new sync does not silently replace independent publication", async () => {
      batch[0].detail.item.title = "New staged title";
      const fresh = await publish(false);
      assert.notEqual((await qualified.get("post", batch[0].detail.item.slug))?.item.title, (await published.get("post", batch[0].detail.item.slug))?.item.title);
      await db.query("UPDATE nb_v2.runs SET valid_until=clock_timestamp()-interval '1 second' WHERE id=$1", [fresh.runId]);
      await assert.rejects(role("nb_writer").query("SELECT nb_publication_api.activate($1)", [fresh.runId]), /NB_PUBLICATION_INVALID/);
      assert.equal((await published.list("post")).items.length, 2);
    });
    await t.test("activation failure atomically rolls back the qualified promotion", async () => {
      const prior = (await db.query("SELECT current_run FROM nb_v2.state")).rows[0];
      const lease = await writer.begin(randomUUID(), digest); await writer.stage(lease, batch, [media]);
      await db.exec("UPDATE nb_publication.state SET migration_digest=NULL");
      await assert.rejects(writer.promote(lease, receipt), controlled);
      assert.deepEqual((await db.query("SELECT current_run FROM nb_v2.state")).rows[0], prior);
      await db.query("UPDATE nb_publication.state SET migration_digest=$1", [protocol.migration.sha256]);
      await writer.fail(lease);
      assert.equal((await published.list("post")).items.length, 2);
    });
    await t.test("partial failed sync preserves the last publication and a later complete run replaces it", async () => {
      const lease = await writer.begin(randomUUID(), digest); await writer.stage(lease, batch.slice(0, 1));
      await assert.rejects(writer.promote(lease, { records: 1, media: 0, complete: true }), controlled);
      await writer.fail(lease);
      const page = await published.list("post", { limit: 1 });
      await publish(true);
      assert.equal((await published.get("post", batch[0].detail.item.slug))?.item.title, "New staged title");
      await assert.rejects(published.list("post", { limit: 1, cursor: page.nextCursor! }));
    });
    await t.test("policy epoch changes remain fail-closed rather than reviving a stale authorization", async () => {
      await configure();
      await assert.rejects(published.list("post"), controlled);
      await publish(true);
      assert.equal((await published.list("post")).items.length, 2);
    });
  } finally { await db.close(); }
});
