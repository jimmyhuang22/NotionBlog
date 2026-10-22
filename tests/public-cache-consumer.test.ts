import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { SqlExecutor } from "../src/server/database/sql.ts";
import { acquireLock } from "../scripts/notion-sync/state.ts";
import { enqueuePublicationRefresh } from "../scripts/public-cache/control.ts";
import { consumeCacheRefresh } from "../scripts/public-cache/consume.ts";
import { runCacheConsumer } from "../scripts/public-cache/consumer.ts";
import { runCacheConsumerCli } from "../scripts/public-cache/consumer-cli.ts";

const config = { siteKey: "fixture-site", origin: "https://site.example", secret: "ab".repeat(32) };
const ok: typeof fetch = async (_url, init) => {
  const body = JSON.parse(String(init?.body));
  return Response.json({ version: 1, siteKey: body.siteKey, id: body.id, generation: body.generation, purged: true });
};
const empty: SqlExecutor = { query: async <T>() => ({ rows: [{ result: [] }] as T[] }) };

test("cache consumer drains real restricted SQL, preserves unknown outcomes and never acknowledges withdrawals", async t => {
  const db = await PGlite.create();
  try {
    await db.exec("CREATE ROLE nb_reader NOLOGIN; CREATE ROLE nb_writer NOLOGIN;");
    await db.exec(await readFile(new URL("../database/website-migrations/001_website.sql", import.meta.url), "utf8"));
    await db.exec(await readFile(new URL("../supabase/migrations/20261020203508_public_content_cache.sql", import.meta.url), "utf8"));
    const publisher: SqlExecutor = { query: <T>(text: string, values?: unknown[]) => db.transaction(async tx => {
      await tx.exec("SET LOCAL ROLE nb_cache_publisher"); return tx.query<T>(text, values);
    }) };
    let version = 0;
    const enqueue = (scope: "content" | "social" | "media" = "content") => enqueuePublicationRefresh(publisher, config,
      { scope, version: (++version).toString(16).padStart(64, "0"), committed: true });
    await t.test("an unavailable purge remains pending and a later retry succeeds without enqueueing", async () => {
      const event = await enqueue();
      const failed = await consumeCacheRefresh(publisher, config, { request: async () => new Response(null, { status: 503 }) });
      assert.equal(failed.status, "failed"); assert.equal(failed.errorCode, "CACHE_PURGE_FAILED");
      assert.equal(failed.remainingAtEnd, null); assert.equal(failed.completed, 0);
      assert.equal((await db.query<{ status: string }>("SELECT status FROM nb_cache.events WHERE id=$1", [event.id])).rows[0].status, "pending");
      const success = await consumeCacheRefresh(publisher, config, { request: ok });
      assert.equal(success.status, "complete"); assert.equal(success.completed, 1); assert.equal(success.remainingAtEnd, 0);
    });
    await t.test("a lost SQL acknowledgement is reconciled by the next queue read, without another purge", async () => {
      await enqueue("social");
      const unknown: SqlExecutor = { query: async <T>(sql: string, values?: unknown[]) => {
        const value = await publisher.query<T>(sql, values);
        if (sql.includes("complete_refresh_event")) throw Error("private-db-driver-detail");
        return value;
      } };
      const failed = await consumeCacheRefresh(unknown, config, { request: ok });
      assert.equal(failed.status, "failed"); assert.equal(failed.errorCode, "CACHE_ACK_UNKNOWN");
      assert.ok(!JSON.stringify(failed).includes("private-db-driver-detail"));
      const resumed = await consumeCacheRefresh(publisher, config, { request: async () => { throw Error("must not send twice"); } });
      assert.equal(resumed.status, "idle"); assert.equal(resumed.purges, 0);
    });
    await t.test("coalescing selects the greatest generation and leaves a concurrent newer event pending", async () => {
      const old = await enqueue(), newer = await enqueue(); let concurrent = "";
      const reversed: SqlExecutor = { query: async <T>(sql: string, values?: unknown[]) => {
        const result = await publisher.query<T>(sql, values);
        if (sql.includes("pending_events")) (result.rows[0] as { result: unknown[] }).result.reverse();
        return result;
      } };
      const result = await consumeCacheRefresh(reversed, config, { request: async (url, init) => {
        assert.equal(JSON.parse(String(init?.body)).id, newer.id);
        concurrent = (await enqueue()).id; return ok(url, init);
      } });
      assert.equal(result.status, "pending"); assert.equal(result.completed, 2); assert.equal(result.remainingAtEnd, 1);
      assert.deepEqual((await db.query<{ id: string }>("SELECT id FROM nb_cache.events WHERE status='pending'")).rows.map(e => e.id), [concurrent]);
      assert.equal((await db.query<{ status: string }>("SELECT status FROM nb_cache.events WHERE id=$1", [old.id])).rows[0].status, "complete");
      await consumeCacheRefresh(publisher, config, { request: ok });
    });
    await t.test("withdrawal intent remains exclusively for its operator resume command", async () => {
      const id = randomUUID();
      await db.query("INSERT INTO nb_cache.events(id,scope,publication_version,payload,generation) VALUES($1,'withdraw',$2,'{}',10000)", [id, "a".repeat(64)]);
      await enqueue("media");
      const result = await consumeCacheRefresh(publisher, config, { request: ok });
      assert.equal(result.status, "operator-required"); assert.equal(result.withdrawals, 1); assert.equal(result.completed, 1);
      assert.equal((await db.query<{ status: string }>("SELECT status FROM nb_cache.events WHERE id=$1", [id])).rows[0].status, "pending");
      await assert.rejects(publisher.query("SELECT nb_cache_api.complete_event($1,10000)", [id]));
      await db.query("DELETE FROM nb_cache.events WHERE id=$1", [id]);
    });
    await t.test("one invocation processes at most the initial 100 events", async () => {
      await db.exec("INSERT INTO nb_cache.events(id,scope,publication_version,payload,generation) SELECT gen_random_uuid(),'content',repeat('b',64),'{}',20000+n FROM generate_series(1,101) n");
      const result = await consumeCacheRefresh(publisher, config, { request: ok });
      assert.equal(result.completed, 100); assert.equal(result.purges, 1); assert.equal(result.pendingAtStart, 100);
      assert.equal(result.remainingAtEnd, 1); assert.equal(result.status, "pending");
      const last = await consumeCacheRefresh(publisher, config, { request: ok });
      assert.equal(last.completed, 1); assert.equal(last.status, "complete");
    });
    await t.test("a deadline after purge leaves the event pending and never starts its acknowledgement", async () => {
      const event = await enqueue(), cancel = new AbortController();
      const result = await consumeCacheRefresh(publisher, config, { signal: cancel.signal, request: async (url, init) => {
        const response = await ok(url, init); cancel.abort(); return response;
      } });
      assert.equal(result.status, "failed"); assert.equal(result.errorCode, "CACHE_CONSUMER_DEADLINE");
      assert.equal(result.completed, 0);
      assert.equal((await db.query<{ status: string }>("SELECT status FROM nb_cache.events WHERE id=$1", [event.id])).rows[0].status, "pending");
    });
  } finally { await db.close(); }
});

test("cache consumer records private failures, preserves last success and cannot cross site/lock boundaries", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cache-consumer-"))), directory = join(root, ".local", "consumer"), state = join(directory, "state.json");
  const database = "postgres://fixture:private-db-password@localhost/cache";
  let opens = 0, closes = 0;
  const connect = async () => { opens++; return { db: empty, close: async () => { closes++; } }; };
  try {
    const first = await runCacheConsumer(state, config, database, { connect });
    assert.equal(first.status, "idle"); assert.equal(closes, 1);
    const good = JSON.parse(await readFile(state, "utf8"));
    const failed = await runCacheConsumer(state, config, database, { connect: async () => { throw Error("private-db-password"); } });
    assert.equal(failed.status, "failed"); assert.equal(failed.errorCode, "CACHE_CONNECTION_FAILED");
    const text = await readFile(state, "utf8"), failure = JSON.parse(text);
    assert.deepEqual(failure.lastSuccess, good.lastSuccess); assert.ok(!text.includes("private-db-password"));
    assert.equal(failure.report.remainingAtEnd, null);
    for (const file of await readdir(directory)) if (file.endsWith(".json")) assert.equal((await stat(join(directory, file))).mode & 0o777, 0o600);
    await assert.rejects(runCacheConsumer(state, { ...config, siteKey: "other-site" }, database, { connect }), /CACHE_CONSUMER_IDENTITY/);
    assert.equal(opens, 1); assert.equal(await readFile(state, "utf8"), text);
    const release = await acquireLock(join(directory, "consumer-lock"), randomUUID());
    try { await assert.rejects(runCacheConsumer(state, config, database, { connect })); }
    finally { await release(); }
    assert.equal(opens, 1); assert.equal(await readFile(state, "utf8"), text);
    const last = await runCacheConsumer(state, config, database, { connect });
    assert.equal(last.status, "idle"); assert.equal(opens, 2); assert.equal(closes, 2);
    assert.ok(!JSON.stringify(last).includes(database)); assert.equal(last.sourceRequests, 0); assert.equal(last.uploads, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("cache consumer rejects bad queues, stops before I/O after cancellation, and refuses unsafe CLI input", async () => {
  let reads = 0;
  const db: SqlExecutor = { query: async <T>() => { reads++; return { rows: [{ result: Array(101).fill({}) }] as T[] }; } };
  const bad = await consumeCacheRefresh(db, config);
  assert.equal(bad.errorCode, "CACHE_QUEUE_READ_FAILED"); assert.equal(reads, 1); assert.equal(bad.purges, 0);
  const controller = new AbortController(); controller.abort();
  const expired = await consumeCacheRefresh(db, config, { signal: controller.signal });
  assert.equal(expired.errorCode, "CACHE_CONSUMER_DEADLINE"); assert.equal(reads, 1);
  const journal = await consumeCacheRefresh(db, config, { progress: async () => { throw Error("disk-full-private-path"); } });
  assert.equal(journal.errorCode, "CACHE_RECEIPT_WRITE_FAILED"); assert.equal(reads, 1);
  for (const args of [[], ["--once"], ["--once", "--state", "/tmp/out", "--repeat"]]) await assert.rejects(runCacheConsumerCli(args), /CACHE_CONSUMER_USAGE/);
});
