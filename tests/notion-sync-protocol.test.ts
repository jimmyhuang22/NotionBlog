import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { SYNC_SCHEMA_DIGEST } from "../contracts/sync.ts";
import type { PublicationPolicy } from "../contracts/sync.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";
import { createDatabaseWriter } from "../src/server/database/writer.ts";
import { createDatabaseRepository } from "../src/server/database/repository.ts";
import { configDigest } from "../src/server/database/validation.ts";
import { parseNotionSourcesConfig } from "../src/server/notion/config.ts";
import { createDemo, DEMO } from "../scripts/notion-sync/demo.ts";
import { runSync } from "../scripts/notion-sync/worker.ts";
import { FakeStorage } from "../scripts/notion-sync/fakes.ts";

test("worker uses the frozen writer with actual SQL, roles, media ownership and publication counts", async t => {
  const db = await PGlite.create();
  try {
    await db.exec(await readFile(new URL("../database/migrations/001_content.sql", import.meta.url), "utf8"));
    await db.query("UPDATE nb.state SET schema_digest=$1", [SYNC_SCHEMA_DIGEST]);
    const fixture = createDemo(2), config = parseNotionSourcesConfig(fixture.config);
    const sources: PublicationPolicy["sources"] = config.sources.map(s => ({ key: s.key, kind: s.kind,
      mode: s.publication.mode, dataSourceId: s.dataSourceId, databaseParentId: s.coursePageId }));
    const permits: PublicationPolicy["permits"] = [
      { id: DEMO.course, kind: "course", sourceKey: "course", courseId: null, parentId: null },
      ...[DEMO.week, DEMO.child, DEMO.grandchild].map((id, n) => ({ id, kind: "study-note" as const,
        sourceKey: "notes", courseId: DEMO.course, parentId: [DEMO.course, DEMO.week, DEMO.child][n] })),
    ];
    // Explicit test TTL only; this is not a production freshness decision.
    await db.query("SELECT nb_api.configure_policy($1,$2,$3::jsonb,$4::jsonb)", [configDigest(config), 600, JSON.stringify(sources), JSON.stringify(permits)]);
    const role = (name: "nb_writer" | "nb_reader"): SqlExecutor => ({ query: <T>(sql: string, values?: unknown[]) => db.transaction(async tx => {
      await tx.exec(`SET LOCAL ROLE ${name}`); return tx.query<T>(sql, values);
    }) });
    const writer = createDatabaseWriter(role("nb_writer")), reader = createDatabaseRepository(role("nb_reader"));
    const storage = new FakeStorage();
    const options = { client: fixture.client, config: fixture.config, download: fixture.download, writer, storage, mode: "publish" as const };
    await t.test("DTO/AST, nested tree and stable asset are visible only after complete promote", async () => {
      const report = await runSync(options); assert.equal(report.records, 6); assert.equal(report.media, 1);
      const tree = await reader.getCourseTree(DEMO.course);
      assert.equal(tree!.nodes[0].children![0].children![0].id, DEMO.grandchild);
      const detail = await reader.get("study-note", DEMO.grandchild);
      assert.equal(detail!.document!.blocks.at(-1)!.type, "image");
      assert.equal((await db.query<{ count: number }>("SELECT count(*)::integer AS count FROM nb.media")).rows[0].count, 1);
    });
    await t.test("fresh archive tombstone satisfies full-policy receipt and omits descendant bodies", async () => {
      fixture.pages.get(DEMO.week)!.archived = true;
      const report = await runSync(options); assert.equal(report.confirmedAbsent, 1); assert.equal(report.records, 3);
      assert.equal((await reader.getCourseTree(DEMO.course))!.nodes.length, 0);
      fixture.pages.get(DEMO.week)!.archived = false;
    });
    await t.test("central deny is authoritative in the worker and cannot be undone by it", async () => {
      await db.query("SELECT nb_api.set_denied($1,true)", [DEMO.week]);
      const report = await runSync(options); assert.equal(report.excluded, 3); assert.equal(report.media, 0);
      assert.equal((await reader.getCourseTree(DEMO.course))!.nodes.length, 0);
      assert.equal((await db.query<{ count: number }>("SELECT count(*)::integer AS count FROM nb.denied")).rows[0].count, 1);
    });
    await t.test("configuration mismatch fails before any content reads or stage", async () => {
      const prior = fixture.requests.length, wrong = structuredClone(fixture.config);
      wrong.sources[0].cover.strategy = "native-page-cover";
      await assert.rejects(runSync({ ...options, config: wrong })); assert.equal(fixture.requests.length, prior);
    });
  } finally { await db.close(); }
});
