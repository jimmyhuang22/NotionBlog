import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { PoolConfig } from "pg";
import type { DatabaseObjectResponse, PageObjectResponse, BlockObjectResponse } from "@notionhq/client";
import { createDemo, demoId, demoParagraph, DEMO } from "../../scripts/notion-sync/demo.ts";
import { parseWebsiteNotionConfig } from "../../src/server/notion/website-config.ts";
import { configDigest } from "../../src/server/database/website-validation.ts";
import { captureDirectoryMetadata } from "../../scripts/website-incremental-sync/discovery-baseline.ts";
import { collectWebsiteStudyBaseline } from "../../src/server/notion/website-repository.ts";
import { WEBSITE_SCHEMA_DIGEST } from "../../contracts/website-sync.ts";
import type { SqlExecutor } from "../../src/server/database/sql.ts";
import { publicationWriter } from "../../src/server/database/publication.ts";
import { readPublicationState } from "../../src/server/database/incremental-publication.ts";
import { openIncrementalDatabase, type IncrementalDatabasePool } from "../../src/server/database/incremental-connection.ts";
import { installPublication } from "../../scripts/website-sync/publication-migration.ts";
import { installIncrementalPublication } from "../../scripts/website-sync/incremental-migration.ts";
import { installIncrementalReaderIsolation } from "../../scripts/website-sync/incremental-reader-isolation.ts";
import { installIncrementalReader } from "../../scripts/website-sync/incremental-reader-migration.ts";
import { createRuntimeSources } from "../../scripts/website-incremental-sync/runtime-sources.ts";
import { NotionRequestScheduler } from "../../src/server/notion/request-scheduler.ts";
import type { IncrementalHostDependencies, IncrementalHostOptions, IncrementalBaselineArtifact } from "../../scripts/website-incremental-sync/host.ts";
import studyProtocol from "../../database/website-study-protocol.json" with { type: "json" };

export async function hostFixture(timeZone?: string) {
  const demo = createDemo(1), ownedDb = demoId(200);
  for (const id of [DEMO.child, DEMO.grandchild, DEMO.private]) { demo.pages.delete(id); demo.blocks.delete(id); }
  const week = demo.pages.get(DEMO.week)!;
  if (week.parent.type !== "data_source_id") throw Error("Synthetic note owner"); week.parent.database_id = ownedDb;
  demo.schemas.get(DEMO.notes)!.parent = { type: "database_id", database_id: ownedDb };
  demo.blocks.set(DEMO.week, [demoParagraph(demoId(300), DEMO.week, "Synthetic note body")]);
  const childDb = { ...demoParagraph(ownedDb, DEMO.course, ""), type: "child_database", child_database: { title: "Owned notes" } };
  demo.blocks.set(DEMO.course, [childDb as typeof demo.blocks extends Map<string, (infer T)[]> ? T : never]);
  const database = { object: "database", id: ownedDb, title: [], parent: { type: "page_id", page_id: DEMO.course },
    data_sources: [{ id: DEMO.notes, name: "Notes" }], archived: false, in_trash: false } as unknown as DatabaseObjectResponse;
  const client = { ...demo.client, getDatabase: async () => structuredClone(database) };
  const config = parseWebsiteNotionConfig({ schemaVersion: 2, ...(timeZone === undefined ? {} : { timeZone }), sources: [
    { ...demo.config.sources[0] },
    { ...demo.config.sources[1], publication: { mode: "all" } },
    { key: "notes", kind: "study-note", enabled: true, dataSourceId: DEMO.courses, fields: { title: "Name" }, publication: { mode: "course-descendants" } },
  ] });
  const capture = captureDirectoryMetadata(client, config), collection = await collectWebsiteStudyBaseline({ client: capture.client, config }), directory = capture.seal(collection.records);
  const root = await realpath(await mkdtemp(join(tmpdir(), "incremental-host-"))), runtimeDirectory = join(root, "runtime"), lockDirectory = join(root, "canonical");
  const db = await PGlite.create(), digest = configDigest(config);
  await db.exec(await readFile(new URL("../../database/website-migrations/001_website.sql", import.meta.url), "utf8"));
  await db.query("UPDATE nb_v2.state SET schema_digest=$1", [WEBSITE_SCHEMA_DIGEST]);
  await db.exec(await readFile(new URL("../../database/website-study-migrations/001_automatic_study.sql", import.meta.url), "utf8"));
  await db.query("UPDATE nb_v2.migrations SET digest=$1 WHERE version=$2", [studyProtocol.migration.sha256, studyProtocol.migration.version]);
  const owner: SqlExecutor = { query: async <T>(sql: string, values?: unknown[]) => { if (sql.startsWith("--")) { await db.exec(sql); return { rows: [] as T[] }; } return db.query<T>(sql, values); } };
  await installPublication(owner); await installIncrementalPublication(owner); await installIncrementalReader(owner); await installIncrementalReaderIsolation(owner);
  await db.exec("CREATE ROLE fixture_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT; CREATE ROLE fixture_writer LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT; GRANT nb_delta_reader TO fixture_reader; GRANT nb_writer TO fixture_writer;");
  await db.query("SELECT nb_v2_api.configure_policy($1,600,$2::jsonb,'[]')", [digest, JSON.stringify(config.sources.map(s => ({ key: s.key, kind: s.kind,
    mode: s.publication.mode, dataSourceId: s.dataSourceId, databaseParentId: null, pageId: s.pageId })))]);
  const fullRunId = randomUUID(), writer = publicationWriter(owner, "published"), lease = await writer.begin(fullRunId, digest);
  await writer.stage(lease, collection.records); await writer.promote(lease, { records: collection.records.length, media: 0, complete: true });
  const state = await readPublicationState(owner), artifact: IncrementalBaselineArtifact = { format: "incremental-baseline-v1", state, fullRunId,
    collection, media: [], deniedPageIds: [], directory };
  const artifactPath = join(root, "baseline.json"); await writeFile(artifactPath, JSON.stringify(artifact), { mode: 0o600 });
  await writeFile(join(root, "config.json"), JSON.stringify(config), { mode: 0o600 });
  const counts = { pools: 0, closed: 0, factories: 0, sourceCalls: 0, submits: 0, pageReads: 0 };
  let loseCommit = false, failPageRead = 0;
  const open = (settings: PoolConfig): IncrementalDatabasePool => {
    counts.pools++; const actor = new URL(settings.connectionString!).username;
    if (!["fixture_reader", "fixture_writer"].includes(actor)) throw Error("Synthetic actor only");
    return { query: async <T>(sql: string, values?: unknown[]) => {
      if (sql.includes("nb_delta_api.read_page")) { counts.pageReads++; if (counts.pageReads === failPageRead) throw Error("Synthetic read failure"); }
      const result = await db.transaction(async tx => { await tx.exec(`SET SESSION AUTHORIZATION ${actor}`);
        try { return await tx.query<T>(sql, values); } finally { await tx.exec("SET SESSION AUTHORIZATION postgres"); } });
      if (sql.includes("nb_delta_api.apply_delta")) { counts.submits++; if (loseCommit) { loseCommit = false; throw Error("Synthetic lost private reply"); } }
      return result;
    }, close: async () => { counts.closed++; } };
  };
  const fetcher: typeof fetch = async (input, init) => {
    counts.sourceCalls++; const path = new URL(String(input)).pathname.split("/").filter(Boolean), id = (path[2] ?? "").replaceAll("-", "");
    const body = init?.body ? JSON.parse(String(init.body)) : {}; let value: unknown;
    if (path[1] === "pages") value = demo.pages.get(id);
    else if (path[1] === "data_sources" && path[3] !== "query") value = demo.schemas.get(id);
    else if (path[1] === "databases") value = database;
    else if (path[1] === "blocks" && path[3] !== "children") value = [...demo.blocks.values()].flat().find(b => b.id === id);
    else {
      let all: (PageObjectResponse | BlockObjectResponse)[] = path[1] === "blocks" ? demo.blocks.get(id) ?? [] : [...demo.pages.values()].filter(p => p.parent.type === "data_source_id" && p.parent.data_source_id === id);
      if (body.filter?.and) for (const filter of body.filter.and) {
        const range = filter.last_edited_time; if (range?.on_or_after) all = all.filter(p => Date.parse(p.last_edited_time) >= Date.parse(range.on_or_after));
        if (range?.on_or_before) all = all.filter(p => Date.parse(p.last_edited_time) <= Date.parse(range.on_or_before));
      }
      value = { object: "list", results: all, has_more: false, next_cursor: null, request_status: { type: "complete" } };
    }
    return value ? Response.json(value) : Response.json({ object: "error", status: 404, code: "object_not_found", message: "Synthetic missing" }, { status: 404 });
  };
  const options: IncrementalHostOptions = { command: "initialize", config, lockDirectory, runtimeDirectory, artifactPath,
    // These tests exercise SQL/cache recovery, not throughput. Use the normal
    // run budget so a busy CI host does not turn a successful fixture into a
    // deadline test. Short-deadline behavior is covered in host-transport tests.
    database: { readerUrl: "postgresql://fixture_reader:synthetic@db.example.test:5432/postgres", writerUrl: "postgresql://fixture_writer:synthetic@db.example.test:5432/postgres", tls: "verify" }, durationMs: 120000 };
  const deps: IncrementalHostDependencies = { database: (settings, signal) => openIncrementalDatabase(settings, { open }, signal), sources: async input => {
    counts.factories++; return createRuntimeSources({ ...input, token: "synthetic-host", fetch: fetcher, scheduler: new NotionRequestScheduler({ intervalMs: 0 }),
      storage: { put: async () => { throw Error("Unexpected image upload"); }, read: async () => { throw Error("Unexpected image read"); } } });
  } };
  return { demo, db, config, digest, state, artifact, artifactPath, root, options, deps, counts, open, fetcher,
    setLoseCommit() { loseCommit = true; }, setFailPageRead(n: number) { failPageRead = n; },
    close: async () => { await db.close(); await rm(root, { recursive: true, force: true }); } };
}
