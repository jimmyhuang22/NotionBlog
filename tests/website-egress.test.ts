import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { fixtureItems } from "../fixtures/content.ts";
import type { WebsiteRecord } from "../contracts/website-sync.ts";
import { WEBSITE_SCHEMA_DIGEST } from "../contracts/website-sync.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";
import { configDigest, mediaIdentity } from "../src/server/database/website-validation.ts";
import { createWebsiteWriter } from "../src/server/database/website-writer.ts";
import { createWebsiteDatabaseRepository } from "../src/server/database/website-repository.ts";
import { statusPreview } from "../src/lib/content/status.ts";
import { compareContent } from "../src/lib/content/website.ts";
import { WEBSITE_CONTENT_SQL, WEBSITE_STATUS_PAGE_SQL } from "../src/server/database/website-projection.ts";

test("v2 returns selected bodies and references with current eligibility and bounded traffic", async t => {
  const db = await PGlite.create();
  try {
    await db.exec(await readFile(new URL("../database/migrations/001_content.sql", import.meta.url), "utf8"));
    await db.exec(await readFile(new URL("../database/website-migrations/001_website.sql", import.meta.url), "utf8"));
    await db.query("UPDATE nb_v2.state SET schema_digest=$1", [WEBSITE_SCHEMA_DIGEST]);
    const role = (name: string): SqlExecutor => ({ query: <T>(sql: string, values?: unknown[]) => db.transaction(async tx => {
      await tx.exec(`SET LOCAL ROLE ${name}`); return tx.query<T>(sql, values);
    }) });
    const reader = role("nb_reader"), writer = createWebsiteWriter(role("nb_writer"));
    const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZL98AAAAASUVORK5CYII=", "base64");
    const sha = createHash("sha256").update(imageBytes).digest("hex"), owner = "egress-status-00";
    const assetId = mediaIdentity(owner, "image", sha), image = { id: assetId, src: `/media/v2/${assetId}`, alt: "Sample", width: 1, height: 1 };
    const records: WebsiteRecord[] = Array.from({ length: 30 }, (_, index) => {
      const item = structuredClone(fixtureItems.status[0]);
      item.id = `egress-status-${String(index).padStart(2, "0")}`; item.slug = item.id; item.href = `/status#${item.id}`;
      item.cover = null; item.text = [{ text: "Visible summary" }];
      return { detail: { item, document: { completeness: "complete", toc: [], blocks: [
        { id: "paragraph", type: "paragraph", text: [{ text: "Synthetic document ".repeat(400) }] },
        { id: "nested", type: "toggle", title: [{ text: "Details" }], children: [
          { id: "link", type: "paragraph", text: [{ text: "Other eligible entry", link: { kind: "internal", href: "/status#egress-status-01" } }] },
          ...(index === 0 ? [{ id: "image", type: "image" as const, image, caption: [] }] : []),
        ] },
      ] } }, evidence: { sourceKey: "status", dataSourceId: "source-status", databaseParentId: null, courseId: null, parentId: null, ordinal: index } };
    });
    const sources = [{ key: "status", kind: "status", mode: "all", dataSourceId: "source-status", databaseParentId: null, pageId: null }];
    const digest = configDigest([sources, []]);
    await db.query("SELECT nb_v2_api.configure_policy($1,600,$2::jsonb,'[]'::jsonb)", [digest, JSON.stringify(sources)]);
    const lease = await writer.begin(randomUUID(), digest);
    await writer.stage(lease, records, [{ assetId, ownerPageId: owner, objectKey: `sha256/${sha}`, sha256: sha, byteSize: imageBytes.length, mime: "image/png", width: 1, height: 1 }]);
    await writer.promote(lease, { records: records.length, media: 1, complete: true });
    const calls: { sql: string; params: unknown[]; bytes: number; records: number; bodies: number }[] = [];
    const measured: SqlExecutor = { async query<T>(sql: string, params: unknown[] = []) {
      const result = await reader.query<{ result: { records: WebsiteRecord["detail"][] } }>(sql, params);
      const value = result.rows[0].result;
      calls.push({ sql, params, bytes: Buffer.byteLength(JSON.stringify(value)), records: value.records.length,
        bodies: value.records.filter(record => record.document !== null).length });
      return result as unknown as { rows: T[] };
    } };
    const repo = createWebsiteDatabaseRepository(measured);
    const raw = (await reader.query<{ result: { records: WebsiteRecord["detail"][] } }>(
      "SELECT nb_v2_api.read_snapshot(ARRAY['status'],true) AS result")).rows[0].result;
    const baselineBytes = Buffer.byteLength(JSON.stringify(raw));

    await t.test("one detail and metadata do not transfer a whole column", async () => {
      calls.length = 0;
      assert.deepEqual(await repo.get("status", owner), records[0].detail);
      assert.equal(calls.length, 1); assert.equal(calls[0].records, 1); assert.equal(calls[0].sql, WEBSITE_CONTENT_SQL);
      assert.ok(calls[0].bytes < baselineBytes / 15);
      calls.length = 0;
      assert.deepEqual(await repo.getContentMetadata!("status", owner), records[0].detail.item);
      assert.equal(calls[0].bodies, 0); assert.equal(calls[0].records, 1);
      assert.ok(calls[0].bytes < baselineBytes / 100);
      assert.equal(await repo.get("status", "missing"), null);
    });
    await t.test("year totals transfer metadata without any Status documents", async () => {
      calls.length = 0;
      const years = await repo.getStatusYears!();
      assert.equal(years.undatedCount + years.years.reduce((sum, year) => sum + year.count, 0), records.length);
      assert.equal(calls.length, 1); assert.equal(calls[0].bodies, 0);
      assert.ok(calls[0].bytes < baselineBytes / 10);
    });
    await t.test("a list transfers only current-page bodies and preserves previews and cursors", async () => {
      const expected = [...records].sort((a, b) => compareContent(a.detail.item, b.detail.item));
      calls.length = 0;
      const page = await repo.list("status", { limit: 3 });
      assert.deepEqual(page.items, expected.slice(0, 3).map(record => statusPreview(record.detail.item as typeof fixtureItems.status[0], record.detail.document)));
      assert.equal(page.total, 30); assert.ok(page.nextCursor);
      assert.equal(calls.length, 2); assert.equal(calls[0].bodies, 0); assert.equal(calls[1].records, 3);
      assert.ok(calls.reduce((sum, call) => sum + call.bytes, 0) < baselineBytes / 5);
      const next = await repo.list("status", { limit: 3, cursor: page.nextCursor! });
      assert.deepEqual(next.items.map(item => item.id), expected.slice(3, 6).map(record => record.detail.item.id));
    });
    await t.test("reference compaction preserves nested links and applies subsequent withdrawals", async () => {
      const snapshot = await repo.readSnapshot!(["status"], true);
      assert.deepEqual(snapshot.records, raw.records);
      assert.deepEqual((await repo.get("status", owner))?.document, records[0].detail.document);
      await db.query("SELECT nb_v2_api.set_denied($1,true)", ["egress-status-01"]);
      const detail = await repo.get("status", owner);
      assert.ok(JSON.stringify(detail).includes('"kind":"unavailable"'));
      assert.ok(JSON.stringify(detail).includes(assetId));
      assert.equal(await repo.get("status", "egress-status-01"), null);
      await db.query("SELECT nb_v2_api.set_denied($1,false)", ["egress-status-01"]);
    });
    await t.test("a withdrawal between metadata and preview queries fails instead of mixing versions", async () => {
      let changed = false;
      const raced = createWebsiteDatabaseRepository({ async query<T>(sql: string, params?: unknown[]) {
        if (sql === WEBSITE_STATUS_PAGE_SQL && !changed) { changed = true; await db.query("SELECT nb_v2_api.set_denied($1,true)", ["egress-status-29"]); }
        return reader.query<T>(sql, params);
      } });
      await assert.rejects(raced.list("status", { limit: 3 }), (e: unknown) => !!e && typeof e === "object" && "code" in e && e.code === "INVALID_QUERY");
      await db.query("SELECT nb_v2_api.set_denied($1,false)", ["egress-status-29"]);
    });
    await t.test("empty generation checks transfer no unrelated links or media IDs", async () => {
      calls.length = 0;
      assert.deepEqual((await repo.readSnapshot!([], false)).records, []);
      assert.equal(calls[0].records, 0); assert.ok(calls[0].bytes < 300);
    });
  } finally { await db.close(); }
});
