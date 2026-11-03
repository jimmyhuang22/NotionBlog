import test from "node:test";
import assert from "node:assert/strict";
import { createThumbnailSql, thumbnailReadSql, thumbnailBatchSql } from "../src/server/database/thumbnail-query.ts";
import { contentReadBudgetIdentity } from "../src/server/content-read-budget.ts";
import { withMediaReadBudget } from "../src/server/media/read-budget.ts";
import { EventEmitter } from "node:events";
import type { Pool, PoolClient, QueryConfig } from "pg";
import { readerSqlExecutor } from "../src/server/database/connection.ts";
import { readerControlResponse } from "./helpers/reader-controls.ts";

const values = (n = 1) => ["v2", `a1.${n.toString(16).padStart(64, "0")}`, 400];
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function rows(text: string, input?: unknown[]) {
  if (text === thumbnailReadSql) return [{ result: input![1] }];
  assert.equal(text, thumbnailBatchSql);
  return (JSON.parse(input![0] as string) as { request_id: number; asset_id: string }[])
    .map(item => ({ request_id: item.request_id, result: item.asset_id }));
}

test("48 thumbnail qualifications use bounded statements and every later recheck reads anew", async () => {
  const sizes: number[] = [];
  const sql = createThumbnailSql({ query: async <T>(text: string, input?: unknown[]) => {
    const result = rows(text, input); sizes.push(result.length); return { rows: result as T[] };
  } });
  const read = (n: number) => sql.query<{ result: string }>(thumbnailReadSql, values(n));
  const result = await Promise.all(Array.from({ length: 48 }, (_, i) => read(i + 1)));
  assert.deepEqual(sizes, [32, 16]);
  result.forEach((row, i) => assert.equal(row.rows[0]!.result, values(i + 1)[1]));
  await read(1); assert.deepEqual(sizes, [32, 16, 1]);
});

test("one cancelled image cannot own a peer's SQL budget or abort its qualification", async () => {
  const started = deferred<AbortSignal>(), release = deferred<void>();
  const sql = createThumbnailSql({ query: async <T>(text: string, input?: unknown[]) => {
    started.resolve(contentReadBudgetIdentity()!.signal); await release.promise;
    return { rows: rows(text, input) as T[] };
  } });
  const first = new AbortController(), second = new AbortController();
  const a = withMediaReadBudget(first.signal, () => sql.query(thumbnailReadSql, values(1)));
  const rejected = assert.rejects(a, { code: "CONTENT_UNAVAILABLE" });
  const b = withMediaReadBudget(second.signal, () => sql.query(thumbnailReadSql, values(2)));
  const batch = await started.promise; first.abort(); await rejected;
  assert.equal(batch.aborted, false); release.resolve(); await b;
});

test("all cancelled images stop the batch and do not poison the next request", async () => {
  const started = deferred<void>(), stopped = deferred<void>(); let calls = 0;
  const sql = createThumbnailSql({ query: async <T>(text: string, input?: unknown[]) => {
    if (++calls === 1) {
      const signal = contentReadBudgetIdentity()!.signal; started.resolve();
      await new Promise((_resolve, reject) => signal.addEventListener("abort", () => { stopped.resolve(); reject(Error("cancelled")); }, { once: true }));
    }
    return { rows: rows(text, input) as T[] };
  } });
  const controller = new AbortController();
  const result = withMediaReadBudget(controller.signal, () => sql.query(thumbnailReadSql, values()));
  const rejected = assert.rejects(result, { code: "CONTENT_UNAVAILABLE" });
  await started.promise; controller.abort(); await rejected; await stopped.promise;
  assert.equal((await sql.query(thumbnailReadSql, values())).rows.length, 1);
});

test("missing, duplicate, oversized or wrongly indexed batch responses fail closed and recover", async () => {
  let change = (input: ReturnType<typeof rows>): unknown[] => input;
  const sql = createThumbnailSql({ query: async <T>(text: string, input?: unknown[]) => ({ rows: change(rows(text, input)) as T[] }) });
  for (const mutate of [
    () => [], (r: ReturnType<typeof rows>) => [r[0], r[0]],
    (r: ReturnType<typeof rows>) => r.map(row => ({ ...row, request_id: 99 })),
    (r: ReturnType<typeof rows>) => r.map(row => ({ ...row, result: "x".repeat(2 * 1024 * 1024) })),
  ]) {
    change = mutate;
    const result = await Promise.allSettled([1, 2].map(n => sql.query(thumbnailReadSql, values(n))));
    assert.ok(result.every(r => r.status === "rejected"));
  }
  change = r => r;
  await sql.query(thumbnailReadSql, values());
});

test("media backpressure stays bounded and accepts work again after draining", async () => {
  const started = deferred<void>(), release = deferred<void>(); let calls = 0;
  const sql = createThumbnailSql({ query: async <T>(text: string, input?: unknown[]) => {
    if (++calls === 1) { started.resolve(); await release.promise; }
    return { rows: rows(text, input) as T[] };
  } });
  const first = sql.query(thumbnailReadSql, values()); await started.promise;
  const waiting = Array.from({ length: 128 }, (_, i) => sql.query(thumbnailReadSql, values(i + 2)));
  await assert.rejects(sql.query(thumbnailReadSql, values(200)), { code: "CONTENT_UNAVAILABLE" });
  release.resolve(); await Promise.all([first, ...waiting]);
  await sql.query(thumbnailReadSql, values(200)); assert.equal(calls, 6);
});

test("only the existing qualified function and supported parameters may enter the queue", async () => {
  const sql = createThumbnailSql({ query: async () => assert.fail("invalid input cannot run SQL") });
  for (const input of [["v3", values()[1], 400], ["v1", values()[1], 1600], ["v2", "bad", 400], ["v2", values()[1], "400"]])
    await assert.rejects(sql.query(thumbnailReadSql, input), { code: "CONTENT_UNAVAILABLE" });
  await assert.rejects(sql.query("SELECT 1", values()), { code: "CONTENT_UNAVAILABLE" });
});

test("a media burst leaves a shared-pool connection for catalogue reads, preserving read-only SQL controls", async () => {
  const started = deferred<void>(), release = deferred<void>();
  let busy = 0, peak = 0, mediaActive = 0, mediaPeak = 0;
  const waiting: (() => void)[] = [], commands: string[] = [];
  const pool = {
    options: { query_timeout: 20000 }, get totalCount() { return busy; }, idleCount: 0,
    get waitingCount() { return waiting.length; },
    connect(callback: (error: null, client: PoolClient) => void) {
      const checkout = () => {
        busy++; peak = Math.max(peak, busy);
        const client = Object.assign(new EventEmitter(), {
          query: async (config: QueryConfig & { query_timeout: number }) => {
            assert.ok(config.query_timeout > 0 && config.query_timeout <= 20000);
            commands.push(config.text);
            const control = readerControlResponse(config.text);
            if (control) return control;
            if (config.text === "SELECT 'catalogue'") return { rows: [{ result: "catalogue" }] };
            mediaActive++; mediaPeak = Math.max(mediaPeak, mediaActive); started.resolve();
            await release.promise; mediaActive--;
            return { rows: rows(config.text, config.values) };
          },
          release: () => { busy--; waiting.shift()?.(); },
        });
        callback(null, client as unknown as PoolClient);
      };
      if (busy < 2) checkout(); else waiting.push(checkout);
    },
  } as unknown as Pool;
  const content = readerSqlExecutor(pool), media = createThumbnailSql(content);
  const images = Array.from({ length: 64 }, (_, i) => media.query(thumbnailReadSql, values(i + 1)));
  await started.promise;
  // This must finish while the first media statement is deliberately still blocked.
  assert.deepEqual((await content.query("SELECT 'catalogue'")).rows, [{ result: "catalogue" }]);
  assert.equal(mediaPeak, 1); assert.equal(peak, 2); assert.equal(waiting.length, 0);
  release.resolve(); await Promise.all(images);
  assert.equal(commands.filter(text => text === "BEGIN READ ONLY").length, 3);
  assert.equal(commands.filter(text => /^SET LOCAL statement_timeout = /.test(text)).length, 3);
  assert.equal(commands.filter(text => text === "COMMIT").length, 3); assert.equal(busy, 0);
});
