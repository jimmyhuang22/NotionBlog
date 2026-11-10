import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import { Pool, type Client, type PoolClient, type QueryConfig } from "pg";
import { CONTENT_KINDS, defaultContentFeatures } from "../config/features.ts";
import { fixtureItems, fixtureDocuments } from "../fixtures/content.ts";
import { WEBSITE_SCHEMA_DIGEST } from "../contracts/website-sync.ts";
import type { ContentRepository } from "../contracts/repository.ts";
import { readerSqlExecutor } from "../src/server/database/connection.ts";
import { createWebsiteDatabaseRepository } from "../src/server/database/website-repository.ts";
import { withContentReadBudget } from "../src/server/content-read-budget.ts";
import { routeAnswer, routeVerdict } from "../src/lib/route-verdict.ts";
import { contentErrorResponse } from "../src/lib/content/http-error.ts";
import { readerControlResponse } from "./helpers/reader-controls.ts";

const features = Object.fromEntries(CONTENT_KINDS.map(kind => [kind, true])) as typeof defaultContentFeatures;

/** Real pg-pool admission and timeout machinery, with an in-memory wire client.
 * No database connection is opened; readers still use their normal checkout,
 * transaction controls, SQL projection and public error conversion. */
function fixture(connectionTimeoutMillis: number) {
  let reads = 0;
  class WireClient extends EventEmitter {
    _queryable = true;
    _ending = false;
    connect(callback: (error: Error | null) => void) { queueMicrotask(() => callback(null)); }
    end() { this._ending = true; queueMicrotask(() => this.emit("end")); }
    ref() {}
    unref() {}
    async query(config: QueryConfig) {
      const control = readerControlResponse(config.text);
      if (control) return control;
      reads++;
      const [kind, documents, slug] = config.values ?? [];
      const items = fixtureItems[kind as keyof typeof fixtureItems].filter(item => !slug || item.slug === slug);
      return { command: "SELECT", rows: [{ result: {
        runId: "11111111-1111-4111-8111-111111111111", revision: "1", schemaDigest: WEBSITE_SCHEMA_DIGEST,
        records: items.map(item => ({ item, document: documents ? fixtureDocuments[item.id] : null })),
        links: items.map(item => item.href), mediaIds: [], hasMore: false,
      } }] };
    }
  }
  const pool = new Pool({ max: 2, connectionTimeoutMillis, idleTimeoutMillis: 10,
    Client: WireClient as unknown as typeof Client });
  pool.on("error", () => {});
  return { pool, repository: createWebsiteDatabaseRepository(readerSqlExecutor(pool)), reads: () => reads };
}

const budget = <T>(read: () => Promise<T>, timeoutMs = 1000) =>
  withContentReadBudget(new AbortController().signal, read, { timeoutMs });

test("actual pool checkout timeout keeps about/detail qualification unavailable rather than missing or an uncaught error", async () => {
  const f = fixture(30), held = await Promise.all([f.pool.connect(), f.pool.connect()]);
  try {
    for (const path of ["/about", fixtureItems.book[0].href, "/library/books/absent"]) {
      const verdict = await budget(() => routeVerdict(path, features, f.repository));
      assert.deepEqual(routeAnswer(verdict), { standIn: "/content-unavailable", status: 503 });
    }
    assert.equal(f.pool.totalCount, 2);
    assert.equal(f.pool.waitingCount, 0);
    assert.equal(f.reads(), 0);
  } finally { held.forEach(client => client.release()); await f.pool.end(); }
});

test("body reads after a successful precheck still become sanitized no-store 503 errors when the pool fills", async () => {
  const f = fixture(30);
  let held: PoolClient[] = [];
  try {
    assert.equal(await budget(() => routeVerdict("/about", features, f.repository)), "found");
    const before = f.reads();
    held = await Promise.all([f.pool.connect(), f.pool.connect()]);
    for (const read of [() => f.repository.getPage!("about"), () => f.repository.get("book", fixtureItems.book[0].slug)]) {
      const cause = await budget<unknown>(read).then(
        () => assert.fail("An exhausted pool must reject the body read"), error => error);
      const response = contentErrorResponse(cause);
      assert.equal(response.status, 503);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(await response.json(), { error: { code: "CONTENT_UNAVAILABLE", message: "Database content is temporarily unavailable." } });
    }
    assert.equal(f.reads(), before);
  } finally { held.forEach(client => client.release()); await f.pool.end(); }
});

test("a congested two-client pool bounds concurrent qualification and never runs expired reads after release", async () => {
  const f = fixture(2000), held = await Promise.all([f.pool.connect(), f.pool.connect()]);
  try {
    // Qualification owns the error boundary; each underlying read owns its
    // deadline, just as the runtime reader does outside an HTTP budget.
    const repository: ContentRepository = { ...f.repository, getContentMetadata: (kind, slug) =>
      budget(() => f.repository.getContentMetadata!(kind, slug), 150) };
    const pending = Array.from({ length: 20 }, (_, index) =>
      routeVerdict(index % 2 ? "/about" : fixtureItems.book[0].href, features, repository));
    await nextTurn();
    assert.equal(f.pool.totalCount, 2);
    assert.equal(f.pool.waitingCount, 20);
    assert.ok((await Promise.all(pending)).every(verdict => routeAnswer(verdict)?.status === 503));
    held.splice(0).forEach(client => client.release());
    await nextTurn();
    assert.equal(f.pool.waitingCount, 0);
    assert.equal(f.reads(), 0);
    assert.equal(await budget(() => routeVerdict("/about", features, f.repository)), "found");
    assert.deepEqual(routeAnswer(await budget(() => routeVerdict("/library/books/absent", features, f.repository))),
      { standIn: "/content-not-found", status: 404 });
  } finally { held.forEach(client => client.release()); await f.pool.end(); }
});
