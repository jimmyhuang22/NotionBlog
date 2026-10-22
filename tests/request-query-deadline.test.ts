import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { Pool, type PoolClient } from "pg";
import { createServer, type Socket } from "node:net";
import { sqlExecutor } from "../src/server/database/connection.ts";
import { withContentReadBudget } from "../src/server/content-read-budget.ts";

class Client extends EventEmitter {
  releases: boolean[] = [];
  queries = 0;
  run: (config: { query_timeout: number }) => Promise<{ rows: unknown[] }> = async () => ({ rows: [] });
  release(destroy = false) { this.releases.push(destroy); }
  async query(config: { query_timeout: number }) { this.queries++; return this.run(config); }
}
function pool(connect: (callback: (error: Error | null, client?: PoolClient) => void) => void) {
  return { connect, options: { query_timeout: 20_000 }, totalCount: 1, idleCount: 0, waitingCount: 0 } as unknown as Pool;
}
const signal = () => new AbortController().signal;

test("expired pool checkout returns late clients once without starting SQL", async () => {
  const client = new Client();
  let finish!: () => void;
  const sql = sqlExecutor(pool(callback => { finish = () => callback(null, client as unknown as PoolClient); }));
  await assert.rejects(withContentReadBudget(signal(), () => sql.query("never sent"), { timeoutMs: 15 }), { code: "CONTENT_UNAVAILABLE" });
  finish(); await Promise.resolve();
  assert.equal(client.queries, 0); assert.deepEqual(client.releases, [false]);
});

test("cancelling active SQL destroys only that client and drains the original rejection", async () => {
  const client = new Client(), controller = new AbortController();
  let began!: () => void, fail!: (error: Error) => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  client.run = () => { began(); return new Promise((_resolve, reject) => { fail = reject; }); };
  client.release = destroy => { client.releases.push(!!destroy); if (destroy) fail(new Error("Connection terminated")); };
  const sql = sqlExecutor(pool(callback => callback(null, client as unknown as PoolClient)));
  const pending = withContentReadBudget(controller.signal, async () => { await sql.query("one"); await sql.query("never"); });
  const checked = assert.rejects(pending); await started; controller.abort(); await checked;
  assert.equal(client.queries, 1); assert.deepEqual(client.releases, [true]);
});

test("successive SQL uses the remaining deadline without changing shared pool options", async () => {
  let now = 0; const limits: number[] = [], clients: Client[] = [];
  const p = pool(callback => {
    const client = new Client(); clients.push(client);
    client.run = async config => { limits.push(config.query_timeout); now += 40; return { rows: [1] }; };
    callback(null, client as unknown as PoolClient);
  });
  const sql = sqlExecutor(p);
  await withContentReadBudget(signal(), async () => { await sql.query("first"); await sql.query("second"); }, { timeoutMs: 100, now: () => now });
  assert.deepEqual(limits, [100, 60]); assert.equal(p.options.query_timeout, 20_000);
  assert.deepEqual(clients.map(c => c.releases), [[false], [false]]);
});

test("a rejected provider is not retried and diagnostics never contain SQL or values", async t => {
  const logs: unknown[][] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => { logs.push(args); });
  const client = new Client(); const error = Object.assign(new Error("private connection detail"), { code: "53300" });
  client.run = async () => { throw error; };
  const sql = sqlExecutor(pool(callback => callback(null, client as unknown as PoolClient)));
  await assert.rejects(withContentReadBudget(signal(), () => sql.query("private SQL", ["private parameter"])), e => e === error);
  assert.equal(client.queries, 1); assert.deepEqual(client.releases, [true]);
  const output = JSON.stringify(logs); assert.match(output, /53300/); assert.match(output, /query/);
  for (const secret of ["private connection", "private SQL", "private parameter"]) assert.ok(!output.includes(secret));
});

test("unbudgeted frozen callers retain the original pool.query path", async () => {
  let calls = 0;
  const p = { query: async (text: string, values: unknown[]) => { calls++; assert.equal(text, "original"); assert.deepEqual(values, [1]); return { rows: [2] }; } } as unknown as Pool;
  assert.deepEqual(await sqlExecutor(p).query("original", [1]), { rows: [2] }); assert.equal(calls, 1);
});

async function wireServer() {
  const sockets = new Set<Socket>(); let queries = 0;
  const server = createServer(socket => {
    sockets.add(socket); socket.on("error", () => {}); socket.on("close", () => sockets.delete(socket));
    let started = false, buffer = Buffer.alloc(0);
    socket.on("data", data => {
      buffer = Buffer.concat([buffer, typeof data === "string" ? Buffer.from(data) : data]);
      if (!started) {
        if (buffer.length < 4 || buffer.length < buffer.readInt32BE(0)) return;
        buffer = buffer.subarray(buffer.readInt32BE(0)); started = true;
        // A local synthetic PostgreSQL handshake; every later query intentionally stalls.
        socket.write(Buffer.from([82,0,0,0,8,0,0,0,0,90,0,0,0,5,73]));
      }
      while (buffer.length >= 5 && buffer.length >= 1 + buffer.readInt32BE(1)) {
        if (buffer[0] === 81) queries++;
        buffer = buffer.subarray(1 + buffer.readInt32BE(1));
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const p = new Pool({ host: "127.0.0.1", port: address.port, user: "fixture", password: "example", database: "fixture", ssl: false,
    max: 1, connectionTimeoutMillis: 500, query_timeout: 1000, idleTimeoutMillis: 20 });
  p.on("error", () => {});
  return { pool: p, queryCount: () => queries, async close() { await p.end(); for (const s of sockets) s.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

test("actual pg timeout closes a stalled query socket and allows the next client", async () => {
  const fixture = await wireServer();
  try {
    // Warm only the synthetic local handshake; no real database or cloud request.
    (await fixture.pool.connect()).release();
    await assert.rejects(withContentReadBudget(signal(), () => sqlExecutor(fixture.pool).query("SELECT fixture"), { timeoutMs: 40 }));
    assert.equal(fixture.queryCount(), 1); assert.equal(fixture.pool.totalCount, 0);
    const next = await fixture.pool.connect(); next.release();
    assert.equal(fixture.pool.totalCount, 1);
  } finally { await fixture.close(); }
});

test("actual pg queued checkout cannot issue SQL after its request has expired", async () => {
  const fixture = await wireServer();
  let held: PoolClient | undefined;
  try {
    held = await fixture.pool.connect();
    await assert.rejects(withContentReadBudget(signal(), () => sqlExecutor(fixture.pool).query("never on wire"), { timeoutMs: 20 }), { code: "CONTENT_UNAVAILABLE" });
    held.release(); held = undefined;
    for (let n = 0; n < 30 && fixture.pool.waitingCount; n++) await sleep(2);
    assert.equal(fixture.pool.waitingCount, 0); assert.equal(fixture.queryCount(), 0);
  } finally { held?.release(); await fixture.close(); }
});
