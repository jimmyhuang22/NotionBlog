import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { PGlite } from "@electric-sql/pglite";
import type { PageObjectResponse, DataSourceObjectResponse } from "@notionhq/client";
import type { Movie } from "../contracts/content.ts";
import type { RunLease } from "../contracts/sync.ts";
import { WEBSITE_SCHEMA_DIGEST } from "../contracts/website-sync.ts";
import { createWebsiteWriter } from "../src/server/database/website-writer.ts";
import { createWebsiteDatabaseRepository } from "../src/server/database/website-repository.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";
import type { NotionReadClient } from "../src/server/notion/types.ts";
import { parseWebsiteNotionConfig } from "../src/server/notion/website-config.ts";
import { websitePolicy, runWebsiteSync } from "../scripts/website-sync/worker.ts";
import { FULL_COLLECTION_LEASE_SQL, qualifyFullCollectionLease, runFullCollection,
  type FullCollectionExpectation } from "../scripts/website-sync/full-collection.ts";

const id = (n: number) => n.toString(16).padStart(32, "0");
const controlled = (error: unknown) => (error as { code?: string })?.code === "CONTENT_UNAVAILABLE";
const rich = (text: string) => ({ type: "text", plain_text: text, text: { content: text, link: null }, href: null,
  annotations: { bold: false, italic: false, underline: false, strikethrough: false, code: false, color: "default" } });
async function fixture(t: test.TestContext) {
  const db = await PGlite.create(); t.after(() => db.close());
  await db.exec(await readFile(new URL("../database/website-migrations/001_website.sql", import.meta.url), "utf8"));
  await db.query("UPDATE nb_v2.state SET schema_digest=$1", [WEBSITE_SCHEMA_DIGEST]);
  const config = parseWebsiteNotionConfig({ schemaVersion: 2, timeZone: "UTC", sources: [{ key: "fictional-movies", kind: "movie", enabled: true,
    dataSourceId: id(1), fields: { title: "Name", doubanRating: "Score", publicRating: "Score", ratingSource: "Source", rating: "Personal" },
    publication: { mode: "all" } }] });
  const page = { object: "page", id: id(2), parent: { type: "data_source_id", data_source_id: id(1) },
    archived: false, in_trash: false, cover: null, last_edited_time: "2026-10-10T12:00:00Z", properties: {
      Name: { id: "name", type: "title", title: [rich("Fictional film")] },
      Score: { id: "score", type: "number", number: 8.2 }, Personal: { id: "personal", type: "number", number: 4 },
      Source: { id: "source", type: "rich_text", rich_text: [rich("Bangumi")] },
    } } as unknown as PageObjectResponse;
  let sourceCalls = 0, bodyCalls = 0;
  const client: NotionReadClient = {
    getPage: async key => { sourceCalls++; return key === page.id ? structuredClone(page) : null; },
    getDataSource: async () => { sourceCalls++; return { id: id(1), properties: Object.fromEntries(Object.entries(page.properties)
      .map(([name, value]) => [name, { id: value.id, type: value.type }])) } as DataSourceObjectResponse; },
    getBlock: async () => { sourceCalls++; return null; },
    listBlocks: async () => { sourceCalls++; bodyCalls++; return []; },
    listPages: async () => { sourceCalls++; return [structuredClone(page)]; },
  };
  const policy = await websitePolicy(client, config, 600);
  await db.query("SELECT nb_v2_api.configure_policy($1,600,$2::jsonb,$3::jsonb)", [policy.configDigest, JSON.stringify(policy.sources), JSON.stringify(policy.permits)]);
  const role = (name: "nb_writer" | "nb_reader"): SqlExecutor => ({ query: <T>(sql: string, values?: unknown[]) => db.transaction(async tx => {
    await tx.exec(`SET LOCAL ROLE ${name}`); return tx.query<T>(sql, values);
  }) });
  const writer = createWebsiteWriter(role("nb_writer")), reader = createWebsiteDatabaseRepository(role("nb_reader"));
  const storage = { put: async () => assert.fail("No image upload"), read: async () => { assert.fail("No stored image"); return new Uint8Array(); } };
  await runWebsiteSync({ client, config, writer, storage, mode: "publish" });
  sourceCalls = bodyCalls = 0;
  const expected = async (): Promise<FullCollectionExpectation> => ({ ...(await db.query<{ revision: string; epoch: string; currentRun: string | null }>(
    'SELECT revision::text,epoch::text,current_run::text AS "currentRun" FROM nb_v2.state')).rows[0],
    configDigest: policy.configDigest, freshnessSeconds: 600, minimumRemainingSeconds: 60 });
  const state = () => db.query<{ current_run: string | null; lease_run: string | null; revision: string; epoch: string }>(
    "SELECT current_run::text,lease_run::text,revision::text,epoch::text FROM nb_v2.state");
  return { db, config, page, client, policy, writer, reader, storage, expected, state, role,
    calls: () => ({ sourceCalls, bodyCalls }) };
}

test("complete new collection binds server metadata before every source read and publishes current movie fields", async t => {
  const f = await fixture(t), expected = await f.expected(), old = (await f.reader.list("movie")).items[0] as Movie;
  assert.equal(old.publicRating, 8.2);
  (f.page.properties.Score as { number: number }).number = 0;
  let qualified = false, ownerQueries = 0;
  const observed = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) => async (...args: A) => {
    assert.equal(qualified, true, "Qualification must precede source access"); return fn(...args);
  };
  const client: NotionReadClient = { getPage: observed(f.client.getPage), getDataSource: observed(f.client.getDataSource),
    getBlock: observed(f.client.getBlock), listBlocks: observed(f.client.listBlocks), listPages: observed(f.client.listPages!) };
  const owner: SqlExecutor = { async query<T>(sql: string, values?: unknown[]) {
    assert.equal(sql, FULL_COLLECTION_LEASE_SQL); ownerQueries++; return f.db.query<T>(sql, values);
  } };
  const result = await runFullCollection({ client, config: f.config, writer: f.writer, storage: f.storage, mode: "publish", publicationMode: "qualified",
    owner, expectation: expected, async onQualified(receipt) {
      assert.equal(receipt.currentRun, expected.currentRun); assert.equal(receipt.qualification, "full-collection");
      assert.equal(Object.isFrozen(receipt), true); assert.notEqual(receipt.runId, expected.currentRun);
      assert.equal((await f.reader.list("movie")).items.length, 1); qualified = true;
    } });
  assert.equal(result.outcome, "publish"); assert.equal(result.resume, undefined); assert.equal(ownerQueries, 1);
  assert.equal(f.calls().bodyCalls, 1);
  const current = (await f.reader.list("movie")).items[0] as Movie;
  assert.equal(current.publicRating, 0); assert.equal(current.ratingSource, "bangumi"); assert.equal(current.rating?.value, 4);
  assert.equal((await f.state()).rows[0].current_run, result.fullCollectionQualification.runId);
});

test("qualification rejects all state, lease, payload and deadline mismatches without changing a run", async t => {
  const f = await fixture(t), expected = await f.expected(), lease = await f.writer.begin(randomUUID(), f.policy.configDigest);
  const original = (await f.db.query<Record<string, unknown>>(FULL_COLLECTION_LEASE_SQL, [lease.runId])).rows[0];
  const before = await f.state();
  const variants: Record<string, unknown>[] = [
    { protocol: "wrong" }, { schema_digest: "wrong" }, { config_digest: "a".repeat(64) }, { state_revision: "0" }, { state_epoch: "0" },
    { current_run: null }, { lease_run: null }, { state_fence: "0" }, { freshness_seconds: 601 },
    { run_id: randomUUID() }, { run_status: "published" }, { run_fence: "0" }, { run_revision: "0" },
    { run_epoch: "0" }, { run_digest: "b".repeat(64) }, { finished_at: original.server_now }, { has_payload: true },
    { lease_until: "invalid" }, { lease_until: "2000-01-01T00:00:00Z" }, { valid_until: "invalid" },
    { server_now: "invalid" }, { started_at: "2100-01-01T00:00:00Z" }, { valid_until: "2100-01-01T00:00:00Z" },
    { valid_until: original.server_now },
  ];
  for (const change of variants) {
    const owner: SqlExecutor = { query: async <T>() => ({ rows: [{ ...original, ...change } as T] }) };
    await assert.rejects(qualifyFullCollectionLease(owner, lease, expected), controlled);
  }
  for (const rows of [[], [original, original]]) {
    await assert.rejects(qualifyFullCollectionLease({ query: async <T>() => ({ rows: rows as T[] }) }, lease, expected), controlled);
  }
  assert.deepEqual(await f.state(), before); await f.writer.fail(lease);
});

test("owner query uses actual table permissions and leaks no driver details", async t => {
  const f = await fixture(t), lease = await f.writer.begin(randomUUID(), f.policy.configDigest), expected = await f.expected();
  for (const role of ["nb_reader", "nb_writer"] as const) await assert.rejects(qualifyFullCollectionLease(f.role(role), lease, expected), controlled);
  await assert.rejects(qualifyFullCollectionLease({ query: async () => { throw Error("private-driver-detail"); } }, lease, expected),
    error => controlled(error) && !(String(error).includes("private-driver-detail")) && !("cause" in (error as object)));
  assert.equal((await qualifyFullCollectionLease(f.db, lease, expected)).receipt.runId, lease.runId);
  await f.writer.fail(lease);
});

test("a bind or receipt-persistence failure cleans its new lease before source access and preserves the previous success", async t => {
  const f = await fixture(t), expected = await f.expected();
  let failed = 0;
  const writer = { ...f.writer, async fail(lease: RunLease) { failed++; await f.writer.fail(lease); } };
  for (const kind of ["owner", "receipt"] as const) {
    await assert.rejects(runFullCollection({ client: f.client, config: f.config, writer, storage: f.storage, mode: "publish", publicationMode: "qualified",
      owner: kind === "owner" ? { query: async () => { throw Error("private-owner-detail"); } } : f.db,
      expectation: expected, onQualified: async () => { if (kind === "receipt") throw Error("private-save-detail"); } }),
    error => controlled(error) && (error as { cleanupFailed?: boolean }).cleanupFailed === false && !String(error).includes("private-"));
    const state = (await f.state()).rows[0]; assert.equal(state.current_run, expected.currentRun); assert.equal(state.lease_run, null);
  }
  assert.equal(failed, 2); assert.deepEqual(f.calls(), { sourceCalls: 0, bodyCalls: 0 });
});

test("failed admission cleanup is explicitly reported and never retried", async t => {
  const f = await fixture(t), expected = await f.expected(); let lease: RunLease | undefined, cleanup = 0;
  const writer = { ...f.writer, async begin(...args: Parameters<typeof f.writer.begin>) { return lease = await f.writer.begin(...args); },
    async fail() { cleanup++; throw Error("private-cleanup-detail"); } };
  await assert.rejects(runFullCollection({ client: f.client, config: f.config, writer, storage: f.storage, mode: "publish", publicationMode: "qualified",
    owner: { query: async () => { throw Error("unknown-owner-outcome"); } }, expectation: expected }),
  error => controlled(error) && (error as { cleanupFailed?: boolean }).cleanupFailed === true && (error as { leaseMayExist?: boolean }).leaseMayExist === true);
  assert.equal(cleanup, 1); assert.equal(f.calls().sourceCalls, 0); assert.equal((await f.state()).rows[0].lease_run, lease!.runId);
  await f.writer.fail(lease!);
});

test("resume inputs, published mode, weakened verification and invalid expectations fail before any resource work", async t => {
  const f = await fixture(t), expected = await f.expected(); let begins = 0, queries = 0;
  const base = { client: f.client, config: f.config, writer: { ...f.writer, async begin(...args: Parameters<typeof f.writer.begin>) { begins++; return f.writer.begin(...args); } },
    storage: f.storage, mode: "publish" as const, publicationMode: "qualified" as const,
    owner: { query: async <T>() => { queries++; return { rows: [] as T[] }; } }, expectation: expected };
  for (const extra of [{ resumeCollection: undefined }, { resumeRunId: randomUUID() }, { resumeProducer: {} },
    { onIncrementalBaseline: () => {} }, { publicationMode: "published" }, { mode: "dry-run" }, { revalidateCollectionOwners: false },
    { expectation: { ...expected, epoch: "00" } }, { expectation: { ...expected, minimumRemainingSeconds: 0 } },
    { expectation: { ...expected, freshnessSeconds: 86401 } }, { expectation: { ...expected, configDigest: "bad" } },
    { owner: undefined }, { onQualified: true }, { writer: {} }]) {
    await assert.rejects(runFullCollection({ ...base, ...extra } as never), error => (error as { code?: string }).code === "MISCONFIGURED");
  }
  assert.equal(begins, 0); assert.equal(queries, 0); assert.equal(f.calls().sourceCalls, 0);
});

test("newly staged records make qualification fail; no saved page may become its admission", async t => {
  const f = await fixture(t), expected = await f.expected(), lease = await f.writer.begin(randomUUID(), f.policy.configDigest);
  await f.db.query("INSERT INTO nb_v2.tombstones(run_id,id,reason) VALUES($1,$2,'deleted')", [lease.runId, id(3)]);
  await assert.rejects(qualifyFullCollectionLease(f.db, lease, expected), controlled); await f.writer.fail(lease);
});

test("the monotonic guard includes response delay, ignores workstation wall time and never extends SQL deadlines", async t => {
  const f = await fixture(t), expected = await f.expected(), lease = await f.writer.begin(randomUUID(), f.policy.configDigest);
  const original = (await f.db.query<Record<string, unknown>>(FULL_COLLECTION_LEASE_SQL, [lease.runId])).rows[0];
  let clock = 1000; t.mock.method(performance, "now", () => clock); t.mock.method(Date, "now", () => 0);
  // PGlite's server clock also uses the host runtime. Pin its real SQL response
  // before mocking the workstation, as a remote PostgreSQL server would behave.
  const pinned: SqlExecutor = { query: async <T>() => ({ rows: [original as T] }) };
  const binding = await qualifyFullCollectionLease(pinned, lease, expected);
  assert.ok(Object.isFrozen(binding.receipt)); binding.check(); clock += 601000; assert.throws(() => binding.check(), controlled);
  clock = 1000;
  const delayed: SqlExecutor = { async query<T>() { clock += 541000; return { rows: [original as T] }; } };
  await assert.rejects(qualifyFullCollectionLease(delayed, lease, expected), controlled);
  t.mock.restoreAll();
  const after = (await f.db.query<Record<string, unknown>>(FULL_COLLECTION_LEASE_SQL, [lease.runId])).rows[0];
  assert.equal(after.valid_until, original.valid_until); await f.writer.fail(lease);
});

test("caller mutation after binding cannot replace the reviewed configuration or policy expectation", async t => {
  const f = await fixture(t), expected = await f.expected();
  const result = await runFullCollection({ client: f.client, config: f.config, writer: f.writer, storage: f.storage,
    mode: "publish", publicationMode: "qualified", owner: f.db, expectation: expected,
    async onQualified() {
      expected.configDigest = "a".repeat(64); expected.revision = "0";
      (f.config.sources[0].fields as Record<string, string>).title = "Unreviewed field";
    } });
  assert.notEqual(result.fullCollectionQualification.configDigest, expected.configDigest);
  assert.equal((await f.reader.list("movie")).items[0].title, "Fictional film");
});

test("an aborted controller fails its own new lease without collecting or reviving old state", async t => {
  const f = await fixture(t), expected = await f.expected(), controller = new AbortController();
  await assert.rejects(runFullCollection({ client: f.client, config: f.config, writer: f.writer, storage: f.storage,
    mode: "publish", publicationMode: "qualified", owner: f.db, expectation: expected, signal: controller.signal,
    async onQualified() { controller.abort(); } }));
  assert.equal(f.calls().sourceCalls, 0); assert.equal((await f.state()).rows[0].lease_run, null);
  assert.equal((await f.state()).rows[0].current_run, expected.currentRun);
});

test("a policy change after qualification is still rejected by the original SQL checks", async t => {
  const f = await fixture(t), expected = await f.expected(); let revoked = false;
  const client = { ...f.client, async listBlocks(key: string) {
    if (!revoked) { revoked = true; await f.db.query("SELECT nb_v2_api.set_denied($1,true)", [id(2)]); }
    return f.client.listBlocks(key);
  } };
  await assert.rejects(runFullCollection({ client, config: f.config, writer: f.writer, storage: f.storage, mode: "publish",
    publicationMode: "qualified", owner: f.db, expectation: expected }), controlled);
  assert.equal((await f.state()).rows[0].current_run, expected.currentRun);
  assert.equal((await f.state()).rows[0].lease_run, null);
  assert.equal((await f.reader.list("movie")).items.length, 0);
});

test("a lost promote response never restores an old pointer or starts another publication", async t => {
  const f = await fixture(t), expected = await f.expected(); let promotions = 0, qualifiedRun: string | undefined;
  const writer = { ...f.writer, async promote(...args: Parameters<typeof f.writer.promote>) {
    promotions++; await f.writer.promote(...args); throw Error("simulated lost promote reply");
  } };
  await assert.rejects(runFullCollection({ client: f.client, config: f.config, writer, storage: f.storage, mode: "publish",
    publicationMode: "qualified", owner: f.db, expectation: expected,
    async onQualified(value) { qualifiedRun = value.runId; } }), /simulated lost promote reply/);
  assert.equal(promotions, 1); assert.notEqual(qualifiedRun, expected.currentRun);
  assert.equal((await f.state()).rows[0].current_run, qualifiedRun);
  assert.equal((await f.db.query<{ status: string }>("SELECT status FROM nb_v2.runs WHERE id=$1", [qualifiedRun])).rows[0].status, "published");
  assert.equal((await f.reader.list("movie")).items.length, 1);
});

test("stage-only completion and central withdrawal retain the original writer semantics", async t => {
  const f = await fixture(t), expected = await f.expected();
  await runFullCollection({ client: f.client, config: f.config, writer: f.writer, storage: f.storage, mode: "stage", publicationMode: "qualified", owner: f.db, expectation: expected });
  assert.equal((await f.state()).rows[0].current_run, expected.currentRun);
  await f.db.query("SELECT nb_v2_api.set_denied($1,true)", [id(2)]);
  const afterDeny = await f.expected();
  await runFullCollection({ client: f.client, config: f.config, writer: f.writer, storage: f.storage, mode: "publish", publicationMode: "qualified", owner: f.db, expectation: afterDeny });
  assert.equal((await f.reader.list("movie")).items.length, 0);
});
