import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import type { DataSourceObjectResponse, PageObjectResponse } from "@notionhq/client";
import type { Game } from "../contracts/content.ts";
import { WEBSITE_SCHEMA_DIGEST } from "../contracts/website-sync.ts";
import { parseWebsiteNotionConfig, websiteCollectionTimeZone } from "../src/server/notion/website-config.ts";
import { createWebsiteNotionRepository } from "../src/server/notion/website-repository.ts";
import type { NotionReadClient } from "../src/server/notion/types.ts";
import { configDigest } from "../src/server/database/website-validation.ts";
import { createWebsiteWriter } from "../src/server/database/website-writer.ts";
import { createWebsiteDatabaseRepository } from "../src/server/database/website-repository.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";
import { runWebsiteSync, websitePolicy } from "../scripts/website-sync/worker.ts";
import { runFullBaselineHost } from "../scripts/website-incremental-sync/full-baseline-host.ts";
import { runIncrementalHost } from "../scripts/website-incremental-sync/host.ts";
import { prepareSinglePage } from "../scripts/website-incremental-sync/source.ts";

const zone = "Australia/Melbourne", id = (n: number) => n.toString(16).padStart(32, "0");
function fixture(timeZone?: string) {
  const raw = { schemaVersion: 2, ...(timeZone === undefined ? {} : { timeZone }), sources: [{ key: "fictional-games", kind: "game", enabled: true,
    dataSourceId: id(1), fields: { title: "Name", playedDate: "Date", lastPlayedDate: "Last", firstPlayedDate: "First" }, publication: { mode: "all", allowlistPageIds: [] } }] };
  const manual = { start: "2024-01-02", end: "2024-08-03", time_zone: null };
  const properties = {
    Name: { id: "title", type: "title", title: [{ type: "text", plain_text: "Fictional boundary game", text: { content: "Fictional boundary game", link: null }, href: null,
      annotations: { bold: false, italic: false, underline: false, strikethrough: false, code: false, color: "default" } }] },
    Date: { id: "d", type: "date", date: manual },
    Last: { id: "l", type: "rollup", rollup: { function: "latest_date", type: "date", date: { start: "2025-12-31T15:30:00Z", end: null } } },
    First: { id: "f", type: "rollup", rollup: { function: "earliest_date", type: "date", date: { start: "2025-10-04T14:30:00Z", end: null } } },
  };
  const page = { object: "page", id: id(2), parent: { type: "data_source_id", data_source_id: id(1) }, cover: null,
    last_edited_time: "2026-01-01T03:00:00Z", archived: false, in_trash: false, properties } as unknown as PageObjectResponse;
  let calls = 0;
  const client: NotionReadClient = {
    getPage: async key => { calls++; return key === page.id ? structuredClone(page) : null; },
    getDataSource: async key => { calls++; return { id: key, properties: Object.fromEntries(Object.entries(properties).map(([name, p]) =>
      [name, { id: p.id, type: p.type, ...("rollup" in p ? { rollup: { function: p.rollup.function } } : {}) }])) } as DataSourceObjectResponse; },
    getBlock: async () => null, listBlocks: async () => { calls++; return []; },
    listPages: async key => { calls++; return key === id(1) ? [structuredClone(page)] : []; },
  };
  return { raw, config: parseWebsiteNotionConfig(raw), page, properties, manual, client, calls: () => calls };
}

test("collection zone is validated, digest-bound, and does not add a key to legacy normalized configurations", () => {
  const f = fixture(zone), utc = fixture("UTC");
  assert.equal(f.config.timeZone, zone);
  assert.notEqual(configDigest(f.config), configDigest(utc.config));
  const legacy = fixture().config;
  assert.equal(Object.hasOwn(legacy, "timeZone"), false);
  const { timeZone: _zone, ...withoutZone } = utc.config;
  assert.deepEqual(legacy, withoutZone);
  assert.equal(configDigest(legacy), configDigest(withoutZone));
  for (const value of ["", "Not/AZone", "UTC ", "Australia/Melbourne\n", null, 42]) assert.throws(() => parseWebsiteNotionConfig({ ...f.raw, timeZone: value }));
});

test("mapped platform dates without an explicit collection zone fail before Source, writer or media work", async () => {
  const f = fixture();
  await assert.rejects(runWebsiteSync({ client: f.client, config: f.config, mode: "dry-run" }), e => (e as { code?: string }).code === "MISCONFIGURED");
  await assert.rejects(prepareSinglePage({ client: f.client, config: f.config, expectedConfigDigest: configDigest(f.config), ordinal: 0,
    ticket: { operationId: "test", sourceKey: "fictional-games", pageKey: id(2), generation: 1, reasons: ["content"] },
    signal: new AbortController().signal, prepareImage: async () => { assert.fail("Media was opened"); } }));
  const automatic = parseWebsiteNotionConfig({ ...f.raw, sources: [...f.raw.sources,
    { key: "courses", kind: "course", enabled: true, dataSourceId: id(3), fields: { title: "Name" }, publication: { mode: "all" } },
    { key: "notes", kind: "study-note", enabled: true, dataSourceId: id(3), fields: { title: "Name" }, publication: { mode: "course-descendants" } },
  ] });
  // Intentionally omit all resource options: validation must fail before any
  // budget, local lock, SQL connection, or SDK factory is touched.
  for (const run of [runFullBaselineHost, runIncrementalHost]) {
    await assert.rejects(run({ config: automatic } as never, {} as never), e => (e as { code?: string }).code === "MISCONFIGURED");
  }
  assert.equal(f.calls(), 0);
  const legacy = parseWebsiteNotionConfig({ ...f.raw, sources: [{ ...f.raw.sources[0], fields: { title: "Name", playedDate: "Date" } }] });
  assert.equal(websiteCollectionTimeZone(legacy), "UTC");
});

test("the actual full collector stores Melbourne days through restricted SQL and the reader retains correct years", async t => {
  const f = fixture(zone), db = await PGlite.create(); t.after(() => db.close());
  await db.exec("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;");
  await db.exec(await readFile(new URL("../database/website-migrations/001_website.sql", import.meta.url), "utf8"));
  await db.query("UPDATE nb_v2.state SET schema_digest=$1", [WEBSITE_SCHEMA_DIGEST]);
  const policy = await websitePolicy(f.client, f.config, 600);
  await db.query("SELECT nb_v2_api.configure_policy($1,600,$2::jsonb,$3::jsonb)", [policy.configDigest, JSON.stringify(policy.sources), JSON.stringify(policy.permits)]);
  const role = (name: string): SqlExecutor => ({ query: <T>(sql: string, values?: unknown[]) => db.transaction(async tx => {
    await tx.exec(`SET LOCAL ROLE ${name}`); return tx.query<T>(sql, values);
  }) });
  const writer = createWebsiteWriter(role("nb_writer")), reader = createWebsiteDatabaseRepository(role("nb_reader"), { timeZone: zone });
  const noStorage = { put: async () => { assert.fail("No images to upload"); }, read: async () => { assert.fail("No images to read"); return new Uint8Array(); } };
  const cases = [
    ["2025-12-31T15:30:00Z", "2025-10-04T14:30:00Z", "2026-01-01", "2025-10-05", 2026],
    ["2026-04-04T14:30:00Z", "2025-10-04T14:30:00Z", "2026-04-05", "2025-10-05", 2026],
    ["2025-12-31", "2025-10-04", "2025-12-31", "2025-10-04", 2025],
  ] as const;
  for (const [last, first, lastDay, firstDay, year] of cases) {
    f.properties.Last.rollup.date.start = last; f.properties.First.rollup.date.start = first;
    const report = await runWebsiteSync({ client: f.client, config: f.config, mode: "publish", writer, storage: noStorage });
    assert.equal(report.records, 1);
    const stored = (await db.query<{ item: Game }>("SELECT r.item FROM nb_v2.records r JOIN nb_v2.state s ON r.run_id=s.current_run WHERE r.id=$1", [id(2)])).rows[0]!.item;
    assert.deepEqual(stored.lastPlayedDate, { start: lastDay, end: null, precision: "date" });
    assert.deepEqual(stored.firstPlayedDate, { start: firstDay, end: null, precision: "date" });
    const detail = await reader.get("game", id(2));
    assert.deepEqual(detail!.item.lastPlayedDate, stored.lastPlayedDate);
    assert.deepEqual(detail!.item.firstPlayedDate, stored.firstPlayedDate);
    assert.deepEqual(detail!.item.playedDate, { start: f.manual.start, end: f.manual.end, precision: "date" });
    assert.deepEqual((await reader.getLibraryYears!("game")).years, [{ year, count: 1 }]);
  }
  // Exercise the real page-level preparation without a source enumeration,
  // then persist its exact record through the same restricted SQL ports.
  f.properties.Last.rollup.date.start = "2025-12-31T15:30:00Z";
  f.properties.First.rollup.date.start = "2025-10-04T14:30:00Z";
  const prepared = await prepareSinglePage({ client: { ...f.client, listPages: async () => { assert.fail("Incremental read enumerated rows"); } }, config: f.config,
    expectedConfigDigest: policy.configDigest, ordinal: 0, ticket: { operationId: "incremental", sourceKey: "fictional-games", pageKey: id(2), generation: 1, reasons: ["content"] },
    signal: new AbortController().signal, prepareImage: async () => { assert.fail("Incremental image work"); } });
  assert.equal(prepared.outcome, "ready"); if (prepared.outcome !== "ready") assert.fail();
  const lease = await writer.begin(randomUUID(), policy.configDigest);
  await writer.stage(lease, [prepared.record]); await writer.promote(lease, { records: 1, media: 0, complete: true });
  const item = (await reader.get("game", id(2)))!.item;
  assert.equal(item.archiveDate!.start, "2026-01-01"); assert.equal(item.firstPlayedDate!.start, "2025-10-05");
  assert.equal((await reader.list("game", { year: 2026 })).total, 1);
  assert.equal((await reader.list("game", { year: 2025 })).total, 0);
});

test("direct collectors inherit the source zone; an incremental timezone change invalidates its expected digest before reads", async () => {
  const f = fixture(zone), rows = await createWebsiteNotionRepository({ client: f.client, config: f.config }).collectRecords(false);
  assert.equal((rows[0]!.detail.item as Game).archiveDate!.start, "2026-01-01");
  const calls = f.calls();
  const result = await prepareSinglePage({ client: f.client, config: { ...f.config, timeZone: "UTC" }, expectedConfigDigest: configDigest(f.config), ordinal: 0,
    ticket: { operationId: "changed-zone", sourceKey: "fictional-games", pageKey: id(2), generation: 1, reasons: ["content"] },
    signal: new AbortController().signal, prepareImage: async () => null });
  assert.deepEqual(result, { outcome: "review", code: "SOURCE_SCOPE_MISMATCH" });
  assert.equal(f.calls(), calls);
});
