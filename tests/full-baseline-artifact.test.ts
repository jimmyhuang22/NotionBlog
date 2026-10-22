import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, realpath, readFile, rm, stat, chmod, link, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { PageObjectResponse, BlockObjectResponse, DataSourceObjectResponse, DatabaseObjectResponse } from "@notionhq/client";
import type { NotionReadClient } from "../src/server/notion/types.ts";
import type { WebsiteWriter } from "../contracts/website-sync.ts";
import { WEBSITE_SCHEMA_DIGEST } from "../contracts/website-sync.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";
import { parseWebsiteNotionConfig } from "../src/server/notion/website-config.ts";
import studyProtocol from "../database/website-study-protocol.json" with { type: "json" };
import { publicationWriter } from "../src/server/database/publication.ts";
import { readPublicationState } from "../src/server/database/incremental-publication.ts";
import { installPublication } from "../scripts/website-sync/publication-migration.ts";
import { installIncrementalPublication } from "../scripts/website-sync/incremental-migration.ts";
import { installIncrementalReader } from "../scripts/website-sync/incremental-reader-migration.ts";
import { runWebsiteSync, websitePolicy } from "../scripts/website-sync/worker.ts";
import { DEMO_PNG } from "../scripts/notion-sync/demo.ts";
import { openContentCache } from "../scripts/website-incremental-sync/content-cache.ts";
import { openStudyCheckpoint } from "../scripts/website-incremental-sync/study-checkpoint.ts";
import { openIncrementalQueue } from "../scripts/website-incremental-sync/queue.ts";
import { createDatabaseContentBaselineReader } from "../scripts/website-incremental-sync/content-baseline.ts";
import { initializeStudyAndContentBaseline } from "../scripts/website-incremental-sync/study-shared-baseline.ts";
import { initializeDirectoryBaseline } from "../scripts/website-incremental-sync/discovery-baseline.ts";
import { savePreparedFullBaseline, sealFullBaselineArtifact, type PreparedFullBaseline, type AcceptedFullBaseline } from "../scripts/website-incremental-sync/full-baseline-artifact.ts";
import { hostFixture } from "./helpers/incremental-host.ts";
import { runIncrementalHost } from "../scripts/website-incremental-sync/host.ts";
import { openIncrementalDatabase } from "../src/server/database/incremental-connection.ts";
import { DEMO, demoId } from "../scripts/notion-sync/demo.ts";

const id = (n: number) => n.toString(16).padStart(32, "0");
const coded = (code: string) => (e: unknown) => e instanceof Error && "code" in e && e.code === code;
const signal = () => new AbortController().signal;
function fixture() {
  const config = parseWebsiteNotionConfig({ schemaVersion: 2, sources: [
    { key: "courses", kind: "course", enabled: true, dataSourceId: id(1), fields: { title: "Name" }, publication: { mode: "all" } },
    { key: "notes", kind: "study-note", enabled: true, dataSourceId: id(1), fields: { title: "Name", order: "Sort" }, publication: { mode: "course-descendants" } },
    { key: "status", kind: "status", enabled: true, dataSourceId: id(2), fields: { title: "Name" }, publication: { mode: "all" } },
  ] });
  const rich = (text: string) => ({ type: "text", plain_text: text, text: { content: text, link: null }, href: null,
    annotations: { bold: false, italic: false, underline: false, strikethrough: false, code: false, color: "default" } });
  const pages = new Map<string, PageObjectResponse>();
  for (const [n, kind, parent] of [[10, "course", null], [20, "note", 10], [30, "child", 20], [40, "status", null]] as const) {
    pages.set(id(n), { object: "page", id: id(n), archived: false, in_trash: false, cover: null, last_edited_time: "2026-10-13T00:00:00Z",
      parent: parent === null ? { type: "data_source_id", data_source_id: id(n === 40 ? 2 : 1), database_id: id(n === 40 ? 200 : 100) } : { type: "page_id", page_id: id(parent) },
      properties: { Name: { id: "title", type: "title", title: [rich(`Synthetic ${kind}`)] }, Sort: { id: "sort", type: "number", number: n === 20 ? 0 : null } } } as unknown as PageObjectResponse);
  }
  pages.get(id(20))!.parent = { type: "data_source_id", data_source_id: id(3), database_id: id(5) };
  const child = (n: number, parent: number) => ({ object: "block", id: id(n), parent: { type: "page_id", page_id: id(parent) }, type: "child_page",
    child_page: { title: "Owned child" }, has_children: false, archived: false, in_trash: false } as unknown as BlockObjectResponse);
  const blocks = new Map<string, BlockObjectResponse[]>([[id(10), [{ object: "block", id: id(5), parent: { type: "page_id", page_id: id(10) },
    type: "child_database", child_database: { title: "Owned notes" }, archived: false, in_trash: false, has_children: false } as unknown as BlockObjectResponse]], [id(20), [child(30, 20), {
    object: "block", id: id(70), parent: { type: "page_id", page_id: id(20) }, type: "image",
    image: { type: "external", external: { url: "https://assets.example.test/synthetic.png" }, caption: [] }, archived: false, in_trash: false, has_children: false,
  } as unknown as BlockObjectResponse]]]);
  const calls: string[] = []; let downloads = 0, puts = 0;
  const client: NotionReadClient = {
    getPage: async key => { calls.push(`page:${key}`); return structuredClone(pages.get(key) ?? null); },
    getDataSource: async key => { calls.push(`schema:${key}`); return { id: key, parent: { type: "database_id", database_id: id(key === id(3) ? 5 : key === id(1) ? 100 : 200) }, database_parent: { type: "page_id", page_id: id(key === id(3) ? 10 : 900) }, properties: { Name: { id: "title", type: "title" }, Sort: { id: "sort", type: "number" } } } as unknown as DataSourceObjectResponse; },
    getDatabase: async key => ({ id: key, parent: { type: "page_id", page_id: id(key === id(5) ? 10 : 900) }, data_sources: [{ id: id(key === id(5) ? 3 : key === id(100) ? 1 : 2), name: "Synthetic" }], archived: false, in_trash: false }) as DatabaseObjectResponse,
    getBlock: async key => structuredClone([...blocks.values()].flat().find(b => b.id === key) ?? null),
    listPages: async key => { calls.push(`rows:${key}`); return structuredClone([...pages.values()].filter(p => p.parent.type === "data_source_id" && p.parent.data_source_id === key)); },
    listBlocks: async key => { calls.push(`blocks:${key}`); return structuredClone(blocks.get(key) ?? []); },
  };
  const storage = { read: async () => DEMO_PNG, put: async () => { puts++; } };
  const download = async () => { downloads++; return { bytes: DEMO_PNG, mime: "image/png" as const }; };
  return { config, client, calls, pages, storage, download, counts: () => ({ downloads, puts }) };
}

test("same-pass full publication produces an immutable private host artifact without a second Source pass", async t => {
  const db = await PGlite.create(); t.after(() => db.close());
  await db.exec("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;");
  await db.exec(await readFile(new URL("../database/website-migrations/001_website.sql", import.meta.url), "utf8"));
  await db.query("UPDATE nb_v2.state SET schema_digest=$1", [WEBSITE_SCHEMA_DIGEST]);
  await db.exec(await readFile(new URL("../database/website-study-migrations/001_automatic_study.sql", import.meta.url), "utf8"));
  await db.query("UPDATE nb_v2.migrations SET digest=$1 WHERE version='001-automatic-study'", [studyProtocol.migration.sha256]);
  const owner: SqlExecutor = { query: async <T>(sql: string, values?: unknown[]) => {
    if (sql.startsWith("--")) { await db.exec(sql); return { rows: [] as T[] }; } return db.query<T>(sql, values);
  } };
  await installPublication(owner); await installIncrementalPublication(owner); await installIncrementalReader(owner);
  const role = (name: "nb_reader" | "nb_writer"): SqlExecutor => ({ query: <T>(sql: string, values?: unknown[]) => db.transaction(async tx => {
    await tx.exec(`SET LOCAL ROLE ${name}`); return tx.query<T>(sql, values);
  }) });
  const readerSql = role("nb_reader"), writer = publicationWriter(role("nb_writer"), "published");
  const base = fixture(), policy = await websitePolicy(base.client, base.config, 600);
  await db.query("SELECT nb_v2_api.configure_policy($1,600,$2::jsonb,'[]')", [policy.configDigest, JSON.stringify(policy.sources)]);
  const reader = createDatabaseContentBaselineReader(readerSql);
  base.calls.length = 0;
  await runWebsiteSync({ ...base, mode: "publish", writer });
  const legacyCalls = [...base.calls];
  async function local() {
    const f = fixture(), directory = await realpath(await mkdtemp(join(tmpdir(), "full-baseline-artifact-")));
    await chmod(directory, 0o700);
    let captured: PreparedFullBaseline | undefined;
    const capture = async (value: PreparedFullBaseline) => {
      captured = structuredClone(value);
      await savePreparedFullBaseline({ directory, config: f.config, capture: value }, signal());
    };
    return { ...f, directory, capture, captured: () => captured!, close: () => rm(directory, { recursive: true, force: true }) };
  }
  await t.test("one collector keeps numeric order, deep pages, media and directory metadata for all three local stores", async () => {
    const s = await local(); try {
      await runWebsiteSync({ ...s, mode: "publish", writer, onIncrementalBaseline: s.capture });
      assert.deepEqual(s.calls, legacyCalls); assert.deepEqual(s.counts(), { downloads: 1, puts: 1 });
      assert.equal(s.captured().collection.records.length, 4); assert.equal(s.captured().media.length, 1);
      assert.equal(s.captured().collection.baseline.entries.find(e => e.record.detail.item.id === id(20))!.override, 0);
      const sourceCalls = [...s.calls], counts = s.counts();
      const accepted = await sealFullBaselineArtifact({ directory: s.directory, config: s.config, reader }, signal());
      const artifact = JSON.parse(await readFile(accepted.path, "utf8")) as AcceptedFullBaseline;
      assert.equal(Object.keys(artifact).length, 7);
      for (const name of ["incremental-prepared.json", "incremental-baseline.json"]) {
        const info = await stat(join(s.directory, name)); assert.equal(info.mode & 0o777, 0o600); assert.equal(info.nlink, 1);
      }
      const cache = await openContentCache(join(s.directory, "content"), policy.configDigest, s.config.sources.map(v => v.key));
      const study = await openStudyCheckpoint(join(s.directory, "study"), policy.configDigest);
      const queue = await openIncrementalQueue(join(s.directory, "queue"), { digest: policy.configDigest, sourceKeys: s.config.sources.map(v => v.key) });
      try {
        const content = { state: artifact.state, records: artifact.collection.records, media: artifact.media };
        const proof = await initializeStudyAndContentBaseline({ content: { baseline: content, fullRunId: artifact.fullRunId, store: cache, reader },
          collection: artifact.collection, config: s.config, deniedPageIds: new Set(artifact.deniedPageIds), studyStore: study }, signal());
        initializeDirectoryBaseline({ queue, config: s.config, capture: artifact.directory, baseline: content,
          proof: { ...artifact.state, ...proof.content, readerVerified: true, complete: true }, currentState: await reader.state(signal()) });
        assert.equal(study.load().entries.length, 3); assert.equal(queue.status().pending, 0);
        assert.equal(proof.databasePageReads, 4); assert.equal(proof.study.reusedPageReads, 3);
      } finally { queue.close(); study.close(); cache.close(); }
      assert.deepEqual(await sealFullBaselineArtifact({ directory: s.directory, config: s.config, reader }, signal()), accepted);
      assert.deepEqual(s.calls, sourceCalls); assert.deepEqual(s.counts(), counts);
    } finally { await s.close(); }
  });
  await t.test("a lost promote reply seals the already accepted run using only persisted input and the independent reader", async () => {
    const s = await local(); try {
      const losing: WebsiteWriter = { ...writer, promote: async (...args) => { await writer.promote(...args); throw Error("Lost local reply"); } };
      await assert.rejects(runWebsiteSync({ ...s, mode: "publish", writer: losing, onIncrementalBaseline: s.capture }), /Lost local reply/);
      const before = [...s.calls], counts = s.counts();
      const result = await sealFullBaselineArtifact({ directory: s.directory, config: s.config, reader }, signal());
      assert.ok(result.publicationRevision.startsWith(`${s.captured().fullRunId}:`));
      assert.deepEqual(s.calls, before); assert.deepEqual(s.counts(), counts);
    } finally { await s.close(); }
  });
  await t.test("failed local capture stops before any stage or promote and preserves the previous publication", async () => {
    const s = await local(); try {
      const before = await readPublicationState(readerSql); let stages = 0, promotes = 0;
      const tracked: WebsiteWriter = { ...writer, stage: async (...a) => { stages++; return writer.stage(...a); }, promote: async (...a) => { promotes++; return writer.promote(...a); } };
      await assert.rejects(runWebsiteSync({ ...s, mode: "publish", writer: tracked, onIncrementalBaseline: async () => { throw Error("Local artifact unavailable"); } }), /Local artifact unavailable/);
      assert.equal(stages, 0); assert.equal(promotes, 0); assert.deepEqual(await readPublicationState(readerSql), before);
    } finally { await s.close(); }
  });
  await t.test("callback mutation cannot change the records actually staged and published", async () => {
    const s = await local(); try {
      await runWebsiteSync({ ...s, mode: "publish", writer, onIncrementalBaseline: async value => {
        await s.capture(value); value.collection.records[0].detail.item.title = "Callback mutation"; value.media[0].byteSize++;
      } });
      const accepted = await sealFullBaselineArtifact({ directory: s.directory, config: s.config, reader }, signal());
      const actual = await reader.read({ pageId: id(10), sourceKey: "courses", expectedRevision: accepted.publicationRevision }, signal());
      assert.equal(actual!.record.detail.item.title, s.captured().collection.records[0].detail.item.title);
    } finally { await s.close(); }
  });
  await t.test("cancellation after saving prepared input prevents publication and cannot seal an unaccepted run", async () => {
    const s = await local(); try {
      const controller = new AbortController();
      await assert.rejects(runWebsiteSync({ ...s, mode: "publish", writer, signal: controller.signal, onIncrementalBaseline: async value => { await s.capture(value); controller.abort(); } }), { name: "AbortError" });
      await assert.rejects(sealFullBaselineArtifact({ directory: s.directory, config: s.config, reader }, signal()), coded("FULL_BASELINE_PUBLICATION_UNCONFIRMED"));
    } finally { await s.close(); }
  });
  await t.test("old study scope, dry-run and hybrid capture are rejected before Source or writer calls", async () => {
    const s = await local(); try {
      for (const mode of ["dry-run", "stage"] as const) await assert.rejects(runWebsiteSync({ ...s, mode, writer, onIncrementalBaseline: s.capture }));
      await assert.rejects(runWebsiteSync({ ...s, mode: "publish", writer, onIncrementalBaseline: s.capture, mediaSources: { stage: async () => {} } }));
      const config = structuredClone(s.config); config.sources[0].publication = { mode: "allowlist", allowlistPageIds: [id(10)] };
      config.sources[1].publication = { mode: "allowlist", allowlistPageIds: [id(20), id(30)] };
      config.sources[1].dataSourceId = id(3); config.sources[1].coursePageId = id(10);
      await assert.rejects(runWebsiteSync({ ...s, config, mode: "publish", writer, onIncrementalBaseline: s.capture }), coded("FULL_BASELINE_SCOPE_MISMATCH"));
      assert.deepEqual(s.calls, []); assert.deepEqual(s.counts(), { downloads: 0, puts: 0 });
    } finally { await s.close(); }
  });
  await t.test("changed policy or global revision during sealing produces no accepted file", async () => {
    const s = await local(); try {
      await runWebsiteSync({ ...s, mode: "publish", writer, onIncrementalBaseline: s.capture });
      for (const field of ["policyEpoch", "publicationRevision"] as const) {
        let calls = 0;
        await assert.rejects(sealFullBaselineArtifact({ directory: s.directory, config: s.config, reader: { ...reader, state: async abort => {
          const actual = await reader.state(abort); if (++calls === 2) actual[field] += "1"; return actual;
        } } }, signal()), coded("FULL_BASELINE_PUBLICATION_CHANGED"));
        await assert.rejects(stat(join(s.directory, "incremental-baseline.json")), { code: "ENOENT" });
      }
    } finally { await s.close(); }
  });
  await t.test("corrupt directory metadata and different configuration fail before reader state calls", async () => {
    const s = await local(); try {
      await runWebsiteSync({ ...s, mode: "publish", writer, onIncrementalBaseline: s.capture });
      const damaged = structuredClone(s.captured()); damaged.directory.recordsDigest = "f".repeat(64);
      await assert.rejects(savePreparedFullBaseline({ directory: s.directory, config: s.config, capture: damaged }, signal()), coded("FULL_BASELINE_INVALID"));
      const config = structuredClone(s.config); config.sources[1].fields = { title: "Other" };
      await assert.rejects(sealFullBaselineArtifact({ directory: s.directory, config, reader: { ...reader, state: async () => assert.fail("No reader call") } }, signal()));
    } finally { await s.close(); }
  });
  await t.test("prepared and accepted files are immutable and reject loose permissions or hard links", async () => {
    const s = await local(); try {
      await runWebsiteSync({ ...s, mode: "publish", writer, onIncrementalBaseline: s.capture });
      await savePreparedFullBaseline({ directory: s.directory, config: s.config, capture: s.captured() }, signal());
      const changed = structuredClone(s.captured()); changed.fullRunId = "00000000-0000-0000-0000-000000000001";
      await assert.rejects(savePreparedFullBaseline({ directory: s.directory, config: s.config, capture: changed }, signal()), coded("FULL_BASELINE_FILE_CONFLICT"));
      const path = join(s.directory, "incremental-prepared.json"); await chmod(path, 0o644);
      await assert.rejects(sealFullBaselineArtifact({ directory: s.directory, config: s.config, reader }, signal()), coded("FULL_BASELINE_PRIVATE_FILE_INVALID"));
      await chmod(path, 0o600); await link(path, join(s.directory, "extra-link"));
      await assert.rejects(sealFullBaselineArtifact({ directory: s.directory, config: s.config, reader }, signal()), coded("FULL_BASELINE_PRIVATE_FILE_INVALID"));
      await unlink(join(s.directory, "extra-link"));
      await sealFullBaselineArtifact({ directory: s.directory, config: s.config, reader }, signal());
    } finally { await s.close(); }
  });
  await t.test("an actual writer connection cannot seal the accepted artifact as independent reader", async () => {
    const s = await local(); try {
      await runWebsiteSync({ ...s, mode: "publish", writer, onIncrementalBaseline: s.capture });
      await assert.rejects(sealFullBaselineArtifact({ directory: s.directory, config: s.config,
        reader: createDatabaseContentBaselineReader(role("nb_writer")) }, signal()));
    } finally { await s.close(); }
  });
});

test("the merged actual host consumes the worker-produced artifact without a second Source or raw-page pass", async t => {
  const f = await hostFixture(); t.after(() => f.close());
  const binding = await openIncrementalDatabase({ ...f.options.database, configDigest: f.digest }, { open: f.open });
  const directory = join(f.root, "worker-capture");
  let artifactPath: string;
  try {
    const client = { ...f.demo.client, getDatabase: async (key: string) => ({ object: "database", id: key,
      parent: { type: "page_id", page_id: DEMO.course }, data_sources: [{ id: DEMO.notes, name: "Owned notes" }],
      archived: false, in_trash: false }) as unknown as DatabaseObjectResponse };
    await runWebsiteSync({ client, config: f.config, mode: "publish", writer: publicationWriter(binding.writer, "published"),
      storage: { put: async () => assert.fail("No image in this fixture"), read: async () => assert.fail("No object read") },
      download: async () => assert.fail("No image download"), onIncrementalBaseline: async capture => {
        await savePreparedFullBaseline({ directory, config: f.config, capture }, signal());
      } });
    artifactPath = (await sealFullBaselineArtifact({ directory, config: f.config,
      reader: createDatabaseContentBaselineReader(binding.reader) }, signal())).path;
    assert.equal(f.counts.pageReads, 0, "sealing checks membership and state, never raw bodies");
  } finally { await binding.close(); }
  const result = await runIncrementalHost({ ...f.options, artifactPath }, f.deps);
  assert.equal(result.outcome, "initialized", JSON.stringify(result));
  assert.equal(result.baselineRecords, 3); assert.equal(f.counts.pageReads, 3);
  assert.equal(f.counts.factories, 0); assert.equal(f.counts.sourceCalls, 0);
  assert.equal(f.counts.pools, f.counts.closed);
  const study = await openStudyCheckpoint(join(f.options.runtimeDirectory, "study"), f.digest);
  try { assert.equal(study.load().entries.some(e => e.record.detail.item.id === DEMO.week), true); }
  finally { study.close(); }
  const cache = await openContentCache(join(f.options.runtimeDirectory, "content"), f.digest, f.config.sources.map(s => s.key));
  try { const state = await readPublicationState(f.db);
    assert.ok(cache.readPublished({ sourceKey: "status", pageKey: demoId(1000) }, state));
  } finally { cache.close(); }
});
