import assert from "node:assert/strict";
import test from "node:test";
import { createNotionClient } from "../src/server/notion/client.ts";
import { NotionRequestScheduler } from "../src/server/notion/request-scheduler.ts";
import { createRuntimeNotionReader } from "../scripts/website-sync/runtime-reader.ts";
import { createRuntimeWriterSql } from "../scripts/website-sync/runtime-sql.ts";
import { createWebsiteImageDownloader } from "../scripts/website-sync/download.ts";
import { WorkerError } from "../scripts/notion-sync/errors.ts";
import { runWebsiteSync } from "../scripts/website-sync/worker.ts";
import { configDigest } from "../src/server/database/website-validation.ts";
import { parseWebsiteNotionConfig } from "../src/server/notion/website-config.ts";
import type { NotionReadClient } from "../src/server/notion/types.ts";
import { DEMO_PNG } from "../scripts/notion-sync/demo.ts";

// A fictional value; held in a plainly named constant so it is never mistaken for a real credential.
const offlineNotionFixture = "fixture-only";

const id = "11111111-1111-4111-8111-111111111111";
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
const upstream = (status: number) => new Response(JSON.stringify({ object: "error", status,
  code: status === 429 ? "rate_limited" : status === 529 ? "service_overload" : "internal_server_error",
  message: "fictional failure" }), { status, headers: { "Retry-After": "90" } });
const renew = "SELECT nb_v2_api.renew_run($1,$2,$3) AS result";

for (const status of [429, 529, 500, 503]) test(`zero policy disables SDK GET retries after ${status}`, async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  let calls = 0;
  const client = createNotionClient({ token: offlineNotionFixture, retry: false,
    fetch: async () => { calls++; return upstream(status); } });
  await assert.rejects(client.getPage(id));
  t.mock.timers.tick(180_000); await flush();
  assert.equal(calls, 1);
});

for (const failure of [429, 529, 500, 502, 503, 504, "ECONNRESET", "EAI_AGAIN"] as const)
  test(`zero runtime policy stops query after ${failure}`, async () => {
    let calls = 0;
    const reader = createRuntimeNotionReader({ token: offlineNotionFixture, retry: false }, new AbortController().signal, {
      scheduler: new NotionRequestScheduler({ intervalMs: 0 }),
      wait: async () => assert.fail("No outer retry wait"),
      fetch: async () => { calls++; if (typeof failure === "string") throw Object.assign(new Error("fictional"), { code: failure }); return upstream(failure); },
    });
    await assert.rejects(reader.client.listPages(id));
    assert.equal(calls, 1); assert.equal(reader.statistics().requests, 1);
    assert.equal(reader.statistics().retries, 0); assert.equal(reader.failure()?.attempt, 1);
  });

test("zero policy still follows successful distinct pagination cursors", async () => {
  const cursors: unknown[] = [];
  const reader = createRuntimeNotionReader({ token: offlineNotionFixture, retry: false }, new AbortController().signal, {
    scheduler: new NotionRequestScheduler({ intervalMs: 0 }), wait: async () => assert.fail("No retry"),
    fetch: async (_url, init) => {
      cursors.push(JSON.parse(String(init?.body)).start_cursor ?? null);
      return new Response(JSON.stringify({ object: "list", results: [], has_more: cursors.length === 1,
        next_cursor: cursors.length === 1 ? "fictional-cursor" : null }));
    },
  });
  assert.deepEqual(await reader.client.listPages(id), []);
  assert.deepEqual(cursors, [null, "fictional-cursor"]); assert.equal(reader.statistics().retries, 0);
});

for (const code of ["ECONNRESET", "08006", "57014", "40001", "42501"])
  test(`zero renewal policy poisons future renewals after ${code} but permits one cleanup`, async () => {
    let renewals = 0, cleanups = 0;
    const failure = Object.assign(new Error("fictional database error"), { code });
    const port = createRuntimeWriterSql({ query: async <T>(text: string) => {
      if (text === renew) { renewals++; throw failure; }
      cleanups++; return { rows: [{ result: true }] as T[] };
    } }, new AbortController().signal, async () => assert.fail("No renewal retry wait"), { retry: false });
    await assert.rejects(port.executor.query(renew, [id, "1", 120]), error => error === failure);
    await assert.rejects(port.executor.query(renew, [id, "1", 120]));
    assert.equal(renewals, 1); assert.equal(port.statistics().renewalRetries, 0);
    await port.executor.query("SELECT nb_v2_api.fail_run($1,$2)", [id, "1"]); assert.equal(cleanups, 1);
  });

for (const failure of [429, 529, 502, 503, 504, "ECONNRESET", "body", "headers"] as const)
  test(`zero image policy does not retry outer loop or second address after ${failure}`, async () => {
    let calls = 0;
    const download = createWebsiteImageDownloader({ retry: false, timeoutMs: 1000, headerTimeoutMs: 10,
      resolve: async () => [{ address: "8.8.8.8", family: 4 }, { address: "1.1.1.1", family: 4 }],
      request: async (_url, _address, signal) => {
        calls++;
        if (failure === "ECONNRESET") throw Object.assign(new Error("fictional"), { code: failure });
        if (failure === "headers") return new Promise((_resolve, reject) => signal.addEventListener("abort",
          () => reject(new WorkerError("IMAGE_UNAVAILABLE")), { once: true }));
        return { status: typeof failure === "number" ? failure : 200,
          headers: { "content-type": "image/png", "retry-after": "90" },
          bytes: (async function* () { if (failure === "body") throw Object.assign(new Error("fictional"), { code: "ECONNRESET" }); yield DEMO_PNG; })(), cancel() {} };
      },
    }, { wait: async () => assert.fail("No image retry wait"), onRetry: () => assert.fail("No image retry event") });
    try { await assert.rejects(download("https://assets.example.test/image.png"));
      assert.equal(calls, 1); assert.equal(download.failure()?.attempt, 1);
    } finally { download.close(); }
  });

test("zero retry switches reject invalid configuration before requests", () => {
  const retry = true as unknown as false;
  assert.throws(() => createNotionClient({ token: offlineNotionFixture, retry }));
  assert.throws(() => createRuntimeNotionReader({ token: offlineNotionFixture, retry }, new AbortController().signal));
  assert.throws(() => createRuntimeWriterSql({ query: async () => assert.fail("No SQL") }, new AbortController().signal, undefined, { retry }));
  assert.throws(() => createWebsiteImageDownloader({ retry }));
});

test("worker stops renewal timer after its first failure while collection drains", async t => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });
  const config = parseWebsiteNotionConfig({ schemaVersion: 2, sources: [{ key: "fictional-games", kind: "game",
    enabled: true, dataSourceId: id, fields: { title: "Name" }, publication: { mode: "all" } }] });
  let release!: () => void, started!: () => void, renewals = 0, cleanups = 0;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const drain = new Promise<void>(resolve => { release = resolve; });
  const client: NotionReadClient = {
    getDataSource: async () => { started(); await drain; throw new Error("fictional stopped collection"); },
    getPage: async () => null, getBlock: async () => null, listPages: async () => [], listBlocks: async () => [],
  };
  const pending = assert.rejects(runWebsiteSync({ client, config, mode: "publish",
    storage: { put: async () => assert.fail("No PUT"), read: async () => assert.fail("No read") },
    writer: { begin: async () => ({ runId: id, fence: "1", revision: "1", configDigest: configDigest(config), deniedPageIds: [] }),
      renew: async () => { renewals++; throw new Error("fictional uncertain renewal"); },
      stage: async () => assert.fail("No stage"), promote: async () => assert.fail("No publish"), fail: async () => { cleanups++; } },
  }));
  await entered; t.mock.timers.tick(30_000); await flush(); assert.equal(renewals, 1);
  t.mock.timers.tick(180_000); await flush(); assert.equal(renewals, 1);
  release(); await pending; assert.equal(cleanups, 1);
});
