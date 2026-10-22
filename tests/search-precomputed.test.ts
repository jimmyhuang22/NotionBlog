import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import type { ContentDocument } from "../contracts/content.ts";
import { mediaIdentity } from "../src/server/database/website-validation.ts";
import { readProjectionMode, readSearchProjectionMode, scopedReader, SCOPED_SEARCH_SQL } from "../src/server/database/scoped-reads.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";
import { setupSearchProjection, status, body } from "./helpers/search-precomputed.ts";
import protocol from "../database/search-precomputed-protocol.json" with { type: "json" };

const batchSQL = "SELECT nb_search.generate_batch($1,$2,$3,$4,$5,$6,$7) AS result";
const countSQL = "SELECT count(*)::integer AS n FROM nb_search.parts";

test("precomputed search is opt-in and unavailable capability fails closed without breaking the old reader", async () => {
  assert.equal(readSearchProjectionMode(undefined, "legacy"), "on-demand");
  assert.equal(readSearchProjectionMode(undefined, "scoped"), "on-demand");
  assert.equal(readSearchProjectionMode("on-demand", "scoped"), "on-demand");
  assert.equal(readSearchProjectionMode("precomputed", "scoped"), "precomputed");
  for (const value of ["unknown", "", "precomputed"])
    assert.throws(() => readSearchProjectionMode(value, "legacy"), { code: "MISCONFIGURED" });
  const f = await setupSearchProjection(false);
  try {
    await f.publish([status(0)]);
    assert.equal((await f.repo("published", false).search!({ q: "needle" })).total, 1);
    await assert.rejects(f.repo("published").search!({ q: "needle" }), { code: "CONTENT_UNAVAILABLE" });
    // Exercise the exact unchanged runtime call signatures, including environment opt-in.
    const previous = process.env.DATABASE_SEARCH_PROJECTION;
    try {
      delete process.env.DATABASE_SEARCH_PROJECTION;
      assert.equal(readProjectionMode("scoped"), "scoped");
      assert.equal((await scopedReader(f.reader, "published").query(SCOPED_SEARCH_SQL, [["status"]])).rows.length, 1);
      process.env.DATABASE_SEARCH_PROJECTION = "precomputed";
      assert.throws(() => readProjectionMode("legacy"), { code: "MISCONFIGURED" });
      assert.equal(readProjectionMode("scoped"), "scoped");
      await assert.rejects(scopedReader(f.reader, "published").query(SCOPED_SEARCH_SQL, [["status"]]), { code: "CONTENT_UNAVAILABLE" });
    } finally {
      if (previous === undefined) delete process.env.DATABASE_SEARCH_PROJECTION;
      else process.env.DATABASE_SEARCH_PROJECTION = previous;
    }
  } finally { await f.db.close(); }
});

test("versioned parts preserve public search DTOs and current authority in both publication modes", async t => {
  const f = await setupSearchProjection();
  try {
    const first = status(0), target = status(1, body("target"));
    const sha = createHash("sha256").update("fictional-image").digest("hex");
    const assetId = mediaIdentity(first.detail.item.id, "image", sha);
    const runs = (text: string) => [{ text }];
    const doc: ContentDocument = { toc: [], completeness: "complete", blocks: [
      ...body("Unicode ＡＢＣ 中文").blocks,
      { id: "t", type: "toggle", title: runs("toggle"), children: body("child").blocks },
      { id: "c", type: "callout", tone: "info", icon: null, text: runs("callout"), children: body("nested").blocks },
      { id: "l", type: "list", ordered: false, items: [{ id: "li", checked: null, text: runs("first"), children: body("inner").blocks }] },
      { id: "cols", type: "columns", columns: [{ ratio: null, blocks: body("column").blocks }] },
      { id: "table", type: "table", hasColumnHeader: false, hasRowHeader: false, rows: [[runs("cell")]] },
      { id: "code", type: "code", language: "text", code: "codeword", caption: runs("codecaption") },
      { id: "eq", type: "equation", expression: "formula" },
      { id: "bookmark", type: "bookmark", title: "bookmark", description: "description", url: "https://example.test/urlsecret" },
      { id: "image", type: "image", image: { id: assetId, src: `/media/v2/${assetId}`, alt: "altsecret", width: 1, height: 1 }, caption: runs("captionsecret") },
      { id: "links", type: "paragraph", text: [{ text: "linksecret", link: { kind: "internal", href: target.detail.item.href } }, { text: "hiddenrun", link: { kind: "unavailable" } }] },
      { id: "unsupported", type: "unsupported", label: "labelsecret" },
    ] };
    first.detail.document = doc;
    const lease = await f.publish([first, target], [{ assetId, ownerPageId: first.detail.item.id, objectKey: `sha256/${sha}`,
      sha256: sha, byteSize: 15, mime: "image/png", width: 1, height: 1 }]);
    await assert.rejects(f.repo("published").search!({ q: "Unicode" }), { code: "CONTENT_UNAVAILABLE" });
    await f.register();
    assert.equal((await f.repo("published").search!({ q: "Unicode" })).total, 1); // missing entry extracts in the same SQL
    const p = await f.pin(lease.runId);
    await assert.rejects(f.db.query(batchSQL, [p.run, p.fence, p.revision, null, 25, 4194304, 1000]), /NB_SEARCH_DISABLED/);
    await f.fill(lease.runId);
    assert.equal((await f.db.query<{ n: number }>(countSQL)).rows[0].n, 2);
    const originalParts = await f.db.query("SELECT p FROM nb_read.search_parts($1::jsonb) p", [JSON.stringify(doc.blocks)]);
    assert.deepEqual(await f.db.query("SELECT p FROM nb_search.extract_parts($1::jsonb) p", [JSON.stringify(doc.blocks)]), originalParts);
    for (const mode of ["qualified", "published"] as const) await t.test(mode, async () => {
      const cached = f.repo(mode), old = f.repo(mode, false);
      for (const q of ["Unicode", "abc", "中文", "toggle child", "first inner", "column", "cell", "codeword codecaption", "formula", "bookmark description", "captionsecret", "linksecret", "altsecret", "urlsecret", "hiddenrun", "labelsecret"])
        assert.deepEqual(await cached.search!({ q }), await old.search!({ q }), q);
      assert.equal((await cached.search!({ q: "captionsecret" })).total, 1);
      assert.equal((await cached.search!({ q: "linksecret" })).total, 1);
      for (const q of ["altsecret", "hiddenrun", "labelsecret", "urlsecret"]) assert.equal((await cached.search!({ q })).total, 0);
      const page = await cached.search!({ q: "projection-status", limit: 1 }); assert.ok(page.nextCursor);
      assert.deepEqual(await cached.search!({ q: "projection-status", limit: 1, cursor: page.nextCursor! }),
        await old.search!({ q: "projection-status", limit: 1, cursor: page.nextCursor! }));
      let queries = 0;
      const observed: SqlExecutor = { query: <T>(sql: string, values?: unknown[]) => { queries++; return f.reader.query<T>(sql, values); } };
      const observedRepo = f.repo(mode, true, observed);
      await observedRepo.search!({ q: "Unicode" }); assert.equal(queries, 3); // capability + read + final version
      queries = 0; await observedRepo.search!({ q: "Unicode" }); assert.equal(queries, 2);
    });
    const revision = (await f.pin(lease.runId)).revision;
    await f.db.query("DELETE FROM nb_v2.media WHERE asset_id=$1", [assetId]);
    assert.equal((await f.pin(lease.runId)).revision, revision);
    for (const mode of ["qualified", "published"] as const) assert.equal((await f.repo(mode).search!({ q: "captionsecret" })).total, 0);
    await f.db.query("SELECT nb_v2_api.set_denied($1,true)", [target.detail.item.id]);
    for (const mode of ["qualified", "published"] as const) {
      assert.equal((await f.repo(mode).search!({ q: "linksecret" })).total, 0);
      assert.deepEqual(await f.repo(mode).search!({ q: "Unicode" }), await f.repo(mode, false).search!({ q: "Unicode" }));
    }
    let changed = false;
    const raced: SqlExecutor = { async query<T>(sql: string, values?: unknown[]) {
      const result = await f.reader.query<T>(sql, values);
      if (sql.includes("nb_read_api.read_search_precomputed(") && !changed) {
        changed = true; await f.db.query("SELECT nb_v2_api.set_denied($1,true)", [first.detail.item.id]);
      }
      return result;
    } };
    await assert.rejects(f.repo("published", true, raced).search!({ q: "Unicode" }), { code: "INVALID_QUERY" });
  } finally { await f.db.close(); }
});

test("missing, stale and damaged derived entries fall back, while manifest incompatibility fails closed", async () => {
  const f = await setupSearchProjection();
  try {
    const record = status(0); const lease = await f.publish([record]); await f.register(); await f.fill(lease.runId);
    for (const mutation of ["algorithm='older'", "document_sha256=decode(repeat('00',32),'hex')", "parts='[\"poison\"]'::jsonb", "parts_sha256=decode(repeat('00',32),'hex')"]) {
      await f.fill(lease.runId); await f.db.exec(`UPDATE nb_search.parts SET ${mutation}`);
      for (const mode of ["qualified", "published"] as const) {
        assert.equal((await f.repo(mode).search!({ q: "needle" })).total, 1);
        assert.equal((await f.repo(mode).search!({ q: "poison" })).total, 0);
      }
    }
    await f.fill(lease.runId);
    await f.db.query("UPDATE nb_v2.records SET document=$1::jsonb WHERE run_id=$2", [JSON.stringify(body("freshbody")), lease.runId]);
    for (const mode of ["qualified", "published"] as const) {
      assert.equal((await f.repo(mode).search!({ q: "needle" })).total, 0);
      assert.equal((await f.repo(mode).search!({ q: "freshbody" })).total, 1);
    }
    await f.db.exec("DELETE FROM nb_search.parts");
    assert.equal((await f.repo("published").search!({ q: "freshbody" })).total, 1);
    await f.db.exec("UPDATE nb_search.state SET migration_digest=repeat('0',64)");
    await assert.rejects(f.repo("published").search!({ q: "freshbody" }), { code: "CONTENT_UNAVAILABLE" });
    assert.equal((await f.repo("published", false).search!({ q: "freshbody" })).total, 1);
    assert.equal((await f.reader.query<{ result: boolean }>("SELECT nb_read_api.check_search_precomputed($1,'unknown') AS result", [protocol.migration.sha256])).rows[0].result, false);
  } finally { await f.db.close(); }
});

test("generation is bounded, transactional, fenced and independent of the unchanged producer", async () => {
  const f = await setupSearchProjection();
  try {
    await f.register();
    const lease = await f.writer.begin(randomUUID(), f.digest, 600);
    await f.writer.stage(lease, [status(0), status(1)]); // old producer never needs extension privileges
    const p = await f.configure(lease.runId, "staging"), args = [p.run, p.fence, p.revision, null, 25, 4194304, 1000];
    for (const [index, value] of [[4, 0], [4, 26], [5, 4194305], [6, 1001]] as const) {
      const invalid = [...args]; invalid[index] = value;
      await assert.rejects(f.db.query(batchSQL, invalid), /NB_SEARCH_BUDGET_INVALID/);
    }
    await assert.rejects(f.db.query(batchSQL, [p.run, p.fence, p.revision, null, 25, 1, 1000]), /NB_SEARCH_BUDGET_EXCEEDED/);
    await assert.rejects(f.db.query("SELECT nb_search.configure_generation('staging',$1,$2,$3,901)", [p.run, p.fence, p.revision]), /NB_SEARCH_CONFIGURATION_INVALID/);
    await assert.rejects(f.db.query("SELECT nb_search.configure_generation('staging',$1,$2,$3,900)", [p.run, String(BigInt(p.fence) + 1n), p.revision]), /NB_LEASE_INVALID/);
    await assert.rejects(f.db.transaction(async tx => { await tx.query(batchSQL, args); throw new Error("rollback probe"); }), /rollback probe/);
    assert.equal((await f.db.query<{ n: number }>(countSQL)).rows[0].n, 0);
    // The first row is processed before the second malformed document; failure must undo both.
    let blocks: unknown[] = body("deep").blocks;
    for (let i = 0; i < 33; i++) blocks = [{ type: "toggle", title: [], children: blocks }];
    await f.db.query("UPDATE nb_v2.records SET document=$1 WHERE id=$2", [{ blocks }, status(1).detail.item.id]);
    await assert.rejects(f.db.query(batchSQL, args), /NB_UNAVAILABLE/);
    assert.equal((await f.db.query<{ n: number }>(countSQL)).rows[0].n, 0);
    await f.db.query("UPDATE nb_v2.records SET document=$1 WHERE id=$2", [body("x".repeat(1048576)), status(1).detail.item.id]);
    await assert.rejects(f.db.query(batchSQL, args), /NB_SEARCH_DOCUMENT_TOO_LARGE/);
    assert.equal((await f.db.query<{ n: number }>(countSQL)).rows[0].n, 0);
    await f.db.query("UPDATE nb_v2.records SET document=$1 WHERE id=$2", [body("needle"), status(1).detail.item.id]);
    await f.db.query(batchSQL, args); assert.equal((await f.db.query<{ n: number }>(countSQL)).rows[0].n, 2);
    await f.writer.stage(lease, [status(0, body("updated"))]); // no trigger, cache digest makes update safe
    await f.writer.promote(lease, { records: 2, media: 0, complete: true });
    await assert.rejects(f.db.query(batchSQL, args), /NB_LEASE_INVALID|NB_SEARCH_TARGET_INVALID/);
    await f.db.query("SELECT nb_publication_api.activate($1)", [lease.runId]);
    assert.equal((await f.repo("published").search!({ q: "updated" })).total, 1);
    await f.configure(lease.runId);
    await f.db.exec("UPDATE nb_search.state SET generation_until=clock_timestamp()-interval '1 second'");
    const published = await f.pin(lease.runId);
    await assert.rejects(f.db.query(batchSQL, [published.run, published.fence, published.revision, null, 25, 4194304, 1000]), /NB_SEARCH_DISABLED/);
    await f.db.exec("SELECT nb_search.disable_generation()");
    assert.equal((await f.repo("published").search!({ q: "updated" })).total, 1);
    await f.fill(lease.runId);
    const old = published;
    await f.publish([status(2, body("replacement"))]);
    await assert.rejects(f.db.query(batchSQL, [old.run, old.fence, old.revision, null, 25, 4194304, 1000]), /NB_SEARCH_TARGET_INVALID/);
    await f.db.query("DELETE FROM nb_v2.records WHERE run_id=$1", [lease.runId]);
    assert.equal((await f.db.query<{ n: number }>(countSQL)).rows[0].n, 0);
    await f.db.query("DELETE FROM nb_v2.runs WHERE id=$1", [lease.runId]);
    assert.equal((await f.repo("published").search!({ q: "replacement" })).total, 1);
  } finally { await f.db.close(); }
});

test("private derived data and generation are denied to website, writer and Supabase API roles", async () => {
  const f = await setupSearchProjection();
  try {
    const lease = await f.publish([status(0)]); await f.register(); await f.fill(lease.runId);
    for (const name of ["nb_reader", "nb_website_reader", "nb_writer", "anon", "authenticated", "service_role"]) {
      const db = f.role(name);
      for (const sql of ["SELECT * FROM nb_search.parts", "SELECT * FROM nb_search.state", "SELECT nb_search.disable_generation()",
        "SELECT nb_search.generate_batch(NULL,NULL,NULL,NULL,1,1,1)", "SELECT nb_search.configure_generation(NULL,NULL,NULL,NULL,1)", "SELECT nb_search.extract_parts('[]')"])
        await assert.rejects(db.query(sql), /permission denied/);
      if (!["nb_reader", "nb_website_reader"].includes(name))
        for (const sql of ["SELECT nb_read_api.read_search_precomputed('published',ARRAY['status'])", "SELECT nb_read_api.check_search_precomputed(NULL,NULL)"])
          await assert.rejects(db.query(sql), /permission denied/);
    }
    const tables = await f.db.query<{ relrowsecurity: boolean }>("SELECT relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='nb_search' AND c.relkind='r'");
    assert.equal(tables.rows.length, 2); assert.ok(tables.rows.every(row => row.relrowsecurity));
    assert.equal((await f.repo("published").search!({ q: "needle" })).total, 1);
  } finally { await f.db.close(); }
});

test("generation pages exact IDs and rejects malformed or excessive parts without retaining a partial batch", async () => {
  const f = await setupSearchProjection();
  try {
    const lease = await f.publish(Array.from({ length: 26 }, (_, i) => status(i)));
    await f.register(); const p = await f.configure(lease.runId);
    const run = (after: string | null) => f.db.query<{ result: { count: number; lastId: string } }>(batchSQL, [p.run, p.fence, p.revision, after, 25, 4194304, 1000]);
    const first = (await run(null)).rows[0].result;
    assert.equal(first.count, 25); assert.equal(first.lastId, status(24).detail.item.id);
    assert.deepEqual((await run(first.lastId)).rows[0].result.count, 1);
    assert.equal((await run(status(25).detail.item.id)).rows[0].result.count, 0);
    assert.equal((await f.db.query<{ n: number }>(countSQL)).rows[0].n, 26);
    await f.db.exec("DELETE FROM nb_search.parts");
    const badBodies = [
      { blocks: [{ type: "code", code: 123 }] },
      { blocks: [{ type: "paragraph", text: Array.from({ length: 20001 }, () => ({ text: "x" })) }] },
    ];
    for (const document of badBodies) {
      await f.db.query("UPDATE nb_v2.records SET document=$1 WHERE id=$2", [document, status(1).detail.item.id]);
      await assert.rejects(run(null), /NB_SEARCH_PARTS_INVALID/);
      assert.equal((await f.db.query<{ n: number }>(countSQL)).rows[0].n, 0);
    }
    await assert.rejects(f.reader.query("SELECT nb_read_api.read_search_precomputed('published',ARRAY['unknown'])"), /NB_QUERY_INVALID/);
    await assert.rejects(f.reader.query("SELECT nb_read_api.read_search_precomputed('unknown',ARRAY['status'])"), /NB_QUERY_INVALID/);
  } finally { await f.db.close(); }
});
