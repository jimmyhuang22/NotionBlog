import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import type { PoolConfig } from "pg";
import { fixtureItems } from "../fixtures/content.ts";
import { WEBSITE_SCHEMA_DIGEST, type WebsiteRecord } from "../contracts/website-sync.ts";
import { parseWebsiteNotionConfig } from "../src/server/notion/website-config.ts";
import { configDigest } from "../src/server/database/website-validation.ts";
import { publicationWriter } from "../src/server/database/publication.ts";
import { preparePublicationDelta } from "../src/server/database/incremental-publication.ts";
import { openIncrementalDatabase, type IncrementalDatabaseOptions, type IncrementalDatabasePool } from "../src/server/database/incremental-connection.ts";
import { verifyIncrementalDatabase } from "../scripts/verify-incremental-database.ts";
import { installPublication } from "../scripts/website-sync/publication-migration.ts";
import { installIncrementalPublication } from "../scripts/website-sync/incremental-migration.ts";
import { installIncrementalReaderIsolation } from "../scripts/website-sync/incremental-reader-isolation.ts";
import { installIncrementalReader } from "../scripts/website-sync/incremental-reader-migration.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";

const code = (expected: string) => (error: unknown) => error instanceof Error && "code" in error && error.code === expected;
const uri = (role: string, suffix = "") => `postgresql://${role}${suffix}:fixture-password@db.example.test:5432/postgres`;
async function setup() {
  const db = await PGlite.create();
  await db.exec(await readFile(new URL("../database/website-migrations/001_website.sql", import.meta.url), "utf8"));
  await db.query("UPDATE nb_v2.state SET schema_digest=$1", [WEBSITE_SCHEMA_DIGEST]);
  const owner: SqlExecutor = {query: async <T>(sql: string, values?: unknown[]) => {
    if (sql.startsWith("--")) {await db.exec(sql); return {rows: [] as T[]};}
    return db.query<T>(sql, values);
  }};
  await installPublication(owner); await installIncrementalPublication(owner); await installIncrementalReader(owner); await installIncrementalReaderIsolation(owner);
  await db.exec(`CREATE ROLE fixture_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;
    CREATE ROLE fixture_writer LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;
    GRANT nb_delta_reader TO fixture_reader; GRANT nb_writer TO fixture_writer;`);
  const config = parseWebsiteNotionConfig({schemaVersion: 2, sources: [{key: "status", kind: "status", enabled: true,
    dataSourceId: "00000000000000000000000000000050", fields: {title: "Name"}, cover: {strategy: "none"}, publication: {mode: "all", allowlistPageIds: []}}]});
  const digest = configDigest(config), sources = [{key: "status", kind: "status", mode: "all", dataSourceId: config.sources[0].dataSourceId, databaseParentId: null, pageId: null}];
  await db.query("SELECT nb_v2_api.configure_policy($1,600,$2::jsonb,'[]')", [digest, JSON.stringify(sources)]);
  const item = structuredClone(fixtureItems.status[0]); item.cover = null; item.href = `/status#${item.id}`;
  const record: WebsiteRecord = {detail: {item, document: {blocks: [], toc: [], completeness: "complete"}},
    evidence: {sourceKey: "status", dataSourceId: config.sources[0].dataSourceId!, databaseParentId: null, courseId: null, parentId: null, ordinal: 0}};
  const full = publicationWriter(owner, "published"), lease = await full.begin(randomUUID(), digest);
  await full.stage(lease, [record]); await full.promote(lease, {records: 1, media: 0, complete: true});
  const opened: {closed: number; config: PoolConfig; queries: number}[] = [];
  const open = (config: PoolConfig): IncrementalDatabasePool => {
    const actor = decodeURIComponent(new URL(config.connectionString!).username).split(".")[0];
    if (!["fixture_reader", "fixture_writer", "postgres"].includes(actor)) assert.fail("Unexpected fixture actor");
    const state = {closed: 0, config, queries: 0}; opened.push(state);
    return {query: <T>(sql: string, values?: unknown[]) => db.transaction(async tx => {
      state.queries++; await tx.exec(`SET SESSION AUTHORIZATION ${actor}`);
      try {return await tx.query<T>(sql, values);}
      finally {await tx.exec("SET SESSION AUTHORIZATION postgres");}
    }), close: async () => {state.closed++;}};
  };
  const options: IncrementalDatabaseOptions = {readerUrl: uri("fixture_reader"), writerUrl: uri("fixture_writer"), configDigest: digest, tls: "verify"};
  return {db, config, record, options, open, opened};
}
test("actual inherited LOGIN roles bind the separate reader and writer to the accepted publication", async () => {
  const s = await setup();
  try {
    const binding = await openIncrementalDatabase(s.options, {open: s.open});
    assert.equal(s.opened.length, 2);
    for (const pool of s.opened) {assert.equal(pool.config.max, 2); assert.equal((pool.config.ssl as {rejectUnauthorized: boolean}).rejectUnauthorized, true);}
    const state = await binding.publisher.state(), changed = structuredClone(s.record); changed.detail.item.title = "One accepted change";
    const prepared = preparePublicationDelta({expectedRevision: state.publicationRevision, configDigest: state.configDigest, upserts: [changed], media: [], withdrawals: []});
    const receipt = await binding.publisher.publish(randomUUID(), prepared);
    assert.equal(await binding.verify(receipt), true);
    assert.deepEqual((await binding.readPage({pageId: changed.detail.item.id, sourceKey: "status", expectedRevision: receipt.publicationRevision}))?.record, changed);
    assert.deepEqual(await binding.publisher.lookup(receipt.operationId, receipt.payloadDigest), receipt);
    await binding.close(); await binding.close(); assert.ok(s.opened.every(p => p.closed === 1));
    const queries = s.opened.reduce((n, p) => n + p.queries, 0);
    assert.throws(() => binding.readPage({pageId: changed.detail.item.id, sourceKey: "status", expectedRevision: receipt.publicationRevision}), code("DATABASE_BINDING_CLOSED"));
    await assert.rejects(binding.publisher.state()); assert.equal(s.opened.reduce((n, p) => n + p.queries, 0), queries);
  } finally {await s.db.close();}
});
test("permissions are inspected from the real role graph and reject escalated actors", async t => {
  const s = await setup();
  try {
    const cases = [
      ["reader bypassrls", "ALTER ROLE fixture_reader BYPASSRLS", "ALTER ROLE fixture_reader NOBYPASSRLS"],
      ["cross-role membership", "GRANT nb_writer TO fixture_reader", "REVOKE nb_writer FROM fixture_reader"],
      ["extra inherited role", "CREATE ROLE fixture_extra NOLOGIN; GRANT fixture_extra TO fixture_writer", "REVOKE fixture_extra FROM fixture_writer; DROP ROLE fixture_extra"],
      ["direct body column", "GRANT SELECT(document) ON nb_v2.records TO fixture_reader", "REVOKE SELECT(document) ON nb_v2.records FROM fixture_reader"],
      ["direct ledger access", "GRANT SELECT ON nb_delta.operations TO fixture_writer", "REVOKE SELECT ON nb_delta.operations FROM fixture_writer"],
      ["reader mutation grant", "GRANT EXECUTE ON FUNCTION nb_delta_api.apply_delta(uuid,text,text,text,jsonb,jsonb,jsonb) TO fixture_reader", "REVOKE EXECUTE ON FUNCTION nb_delta_api.apply_delta(uuid,text,text,text,jsonb,jsonb,jsonb) FROM fixture_reader"],
      ["writer private reader grant", "GRANT EXECUTE ON FUNCTION nb_delta_api.read_page(text,text,text) TO fixture_writer", "REVOKE EXECUTE ON FUNCTION nb_delta_api.read_page(text,text,text) FROM fixture_writer"],
      ["policy mutation granted to the group", "GRANT EXECUTE ON FUNCTION nb_v2_api.set_denied(text,boolean) TO nb_writer", "REVOKE EXECUTE ON FUNCTION nb_v2_api.set_denied(text,boolean) FROM nb_writer"],
      ["schema ownership without CREATE", "ALTER SCHEMA nb_delta OWNER TO fixture_writer; REVOKE CREATE ON SCHEMA nb_delta FROM fixture_writer", "ALTER SCHEMA nb_delta OWNER TO postgres"],
      ["missing required reader API", "REVOKE EXECUTE ON FUNCTION nb_delta_api.verify_operation(uuid,text,text) FROM nb_delta_reader", "GRANT EXECUTE ON FUNCTION nb_delta_api.verify_operation(uuid,text,text) TO nb_delta_reader"],
      ["membership admin option", "GRANT nb_delta_reader TO fixture_reader WITH ADMIN OPTION", "REVOKE ADMIN OPTION FOR nb_delta_reader FROM fixture_reader"],
      ["unexpected PUBLIC function", "CREATE FUNCTION nb_delta_api.fixture_leak() RETURNS integer LANGUAGE sql AS 'SELECT 1'; GRANT EXECUTE ON FUNCTION nb_delta_api.fixture_leak() TO PUBLIC", "DROP FUNCTION nb_delta_api.fixture_leak()"],
    ];
    for (const [name, grant, revoke] of cases) await t.test(name, async () => {
      await s.db.exec(grant); const start = s.opened.length;
      try {await assert.rejects(openIncrementalDatabase(s.options, {open: s.open}), code("DATABASE_BINDING_ROLE_INVALID"));}
      finally {await s.db.exec(revoke);}
      assert.ok(s.opened.slice(start).every(p => p.closed === 1));
      assert.equal((await s.db.query<{n: number}>("SELECT count(*)::int AS n FROM nb_delta.operations")).rows[0].n, 0);
    });
    await t.test("administrator cannot impersonate the required restricted login", async () => {
      await assert.rejects(openIncrementalDatabase({...s.options, readerUrl: uri("postgres")}, {open: s.open}), code("DATABASE_BINDING_ROLE_INVALID"));
    });
  } finally {await s.db.close();}
});
test("endpoints, tenant identity, scope and reply integrity guard against crossed connections", async () => {
  const s = await setup();
  try {
    for (const options of [
      {...s.options, writerUrl: uri("fixture_writer").replace("db.example.test", "other.example.test")},
      {...s.options, writerUrl: uri("fixture_writer").replace("/postgres", "/other")},
      {...s.options, writerUrl: s.options.readerUrl}, {...s.options, tls: "disable"},
    ]) {const start = s.opened.length; await assert.rejects(openIncrementalDatabase(options, {open: s.open}), code("DATABASE_BINDING_CONFIG_INVALID")); assert.equal(s.opened.length, start);}
    await assert.rejects(openIncrementalDatabase({...s.options, readerUrl: uri("fixture_reader", ".tenant-a"), writerUrl: uri("fixture_writer", ".tenant-b")}, {open: s.open}), code("DATABASE_BINDING_CONFIG_INVALID"));
    await assert.rejects(openIncrementalDatabase({...s.options, configDigest: "f".repeat(64)}, {open: s.open}), code("DATABASE_BINDING_SCOPE_MISMATCH"));
    const binding = await openIncrementalDatabase({...s.options, readerUrl: uri("fixture_reader", ".same-tenant"), writerUrl: uri("fixture_writer", ".same-tenant")}, {open: s.open});
    await binding.close();
    const changing = (config: PoolConfig) => {
      const pool = s.open(config);
      return {...pool, query: async <T>(sql: string, values?: unknown[]) => {
        const result = await pool.query<T>(sql, values);
        if (new URL(config.connectionString!).username === "fixture_writer" && sql.includes("read_state")) {
          (result.rows[0] as {result: {publicationRevision: string}}).result.publicationRevision = `${randomUUID()}:1`;
        }
        return result;
      }};
    };
    await assert.rejects(openIncrementalDatabase(s.options, {open: changing}), code("DATABASE_BINDING_VERSION_CHANGED"));
    assert.ok(s.opened.every(p => p.closed === 1));
  } finally {await s.db.close();}
});
test("partial pool failures and cancellation close both transports without leaking private messages", async () => {
  const s = await setup();
  try {
    await assert.rejects(openIncrementalDatabase(s.options, {open: () => {assert.fail("Cancelled allocation");}}, AbortSignal.abort()), code("DATABASE_BINDING_CANCELLED"));
    let count = 0, closed = 0;
    await assert.rejects(openIncrementalDatabase(s.options, {open: () => {
      if (++count === 2) throw new Error("fixture-password private endpoint");
      return {query: async () => ({rows: []}), close: async () => {closed++;}};
    }}), error => error instanceof Error && error.message === "DATABASE_BINDING_UNAVAILABLE");
    assert.equal(closed, 1);
    const closeFailures = (config: PoolConfig) => {
      const pool = s.open(config); return {...pool, close: async () => {await pool.close(); throw new Error("private transport");}};
    };
    const binding = await openIncrementalDatabase(s.options, {open: closeFailures});
    await assert.rejects(binding.close(), code("DATABASE_BINDING_UNAVAILABLE")); assert.ok(s.opened.every(p => p.closed === 1));
  } finally {await s.db.close();}
});
test("operator verification uses private source configuration and emits only aggregate evidence", async () => {
  const s = await setup();
  try {
    const report = await verifyIncrementalDatabase({SYNC_READER_DATABASE_URL: s.options.readerUrl, SYNC_DATABASE_URL: s.options.writerUrl,
      NOTION_SOURCES_JSON: JSON.stringify(s.config), DATABASE_TLS: "verify"}, {open: s.open});
    assert.deepEqual(report, {verified: true, restrictedReader: true, restrictedWriter: true, publicationScopeMatched: true, sourceRequests: 0, mutations: 0});
    assert.ok(!JSON.stringify(report).includes("fixture-password")); assert.ok(!JSON.stringify(report).includes(s.config.sources[0].dataSourceId!));
    assert.ok(s.opened.every(p => p.closed === 1));
    await assert.rejects(verifyIncrementalDatabase({}));
  } finally {await s.db.close();}
});
