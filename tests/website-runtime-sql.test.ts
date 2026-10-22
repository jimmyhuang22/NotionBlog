import assert from "node:assert/strict";
import test from "node:test";
import { createRuntimeWriterSql } from "../scripts/website-sync/runtime-sql.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import { Pool } from "pg";
const renew = "SELECT nb_v2_api.renew_run($1,$2,$3) AS result";
const error = (code: string, message = "fixture-private-detail") => Object.assign(new Error(message), { code });

test("runtime recovers one transient renewal without replaying promotion or altering its fence", async () => {
  let calls = 0; const values = ["fixture-run", "42", 300], waits: number[] = [];
  const db = { query: async (text: string, args?: unknown[]) => { calls++; assert.equal(text, renew); assert.deepEqual(args, values);
    if (calls === 1) throw error("ECONNRESET"); return { rows: [{ result: null }] }; } } as SqlExecutor;
  const port = createRuntimeWriterSql(db, new AbortController().signal, async ms => { waits.push(ms); });
  await port.executor.query(renew, values); assert.equal(calls, 2); assert.deepEqual(waits, [2000]);
  assert.equal(port.statistics().recoveredRenewals, 1); assert.equal(JSON.stringify(port.statistics()).includes("fixture"), false);
});
test("runtime stops rejected leases, auth and unknown errors on the first renewal", async () => {
  for (const failure of [error("P0001", "NB_LEASE_INVALID"), error("42501"), error("28P01"), error("UNKNOWN")]) {
    let calls = 0; const port = createRuntimeWriterSql({ query: async () => { calls++; throw failure; } }, new AbortController().signal, async () => assert.fail("Terminal error"));
    await assert.rejects(port.executor.query(renew, [])); assert.equal(calls, 1);
    assert.equal(port.failure()?.leaseRejected, failure.message === "NB_LEASE_INVALID");
  }
});
test("runtime bounds persistent renewal failures and never retries stage or promote", async () => {
  for (const sql of [renew, "SELECT nb_v2_api.stage_batch($1) AS result", "SELECT nb_v2_api.promote_run($1) AS result"]) {
    let calls = 0; const waits: number[] = [];
    const port = createRuntimeWriterSql({ query: async () => { calls++; throw error("08006"); } }, new AbortController().signal, async ms => { waits.push(ms); });
    await assert.rejects(port.executor.query(sql, [])); assert.equal(calls, sql === renew ? 3 : 1);
    assert.deepEqual(waits, sql === renew ? [2000, 5000] : []);
  }
});
test("cancellation during renewal backoff prevents another RPC", async () => {
  let calls = 0; const controller = new AbortController();
  const port = createRuntimeWriterSql({ query: async () => { calls++; throw error("ECONNRESET"); } }, controller.signal, async () => { controller.abort(); });
  await assert.rejects(port.executor.query(renew, [])); assert.equal(calls, 1);
});

test("the installed pg pool connection-timeout error is recoverable for the same renewal", async t => {
  const sockets = new Set<Socket>();
  const server = createServer(socket => { sockets.add(socket); socket.on("error", () => {}); socket.on("close", () => sockets.delete(socket)); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); assert.ok(address && typeof address === "object");
  const pool = new Pool({ host: "127.0.0.1", port: address.port, user: "synthetic", database: "synthetic", ssl: false, connectionTimeoutMillis: 100, max: 1 });
  pool.on("error", () => {});
  t.after(async () => { for (const socket of sockets) socket.destroy(); await pool.end(); await new Promise<void>(resolve => server.close(() => resolve())); });
  let driverFailure: unknown;
  try { await pool.query("SELECT 1"); assert.fail("The local fixture must not complete a database handshake"); }
  catch (failure) { driverFailure = failure; }
  assert.ok(driverFailure instanceof Error);
  assert.equal(driverFailure.message, "Connection terminated due to connection timeout");
  const values = ["synthetic-run", "42", 300], waits: number[] = []; let calls = 0;
  const port = createRuntimeWriterSql({ query: async (sql, args) => {
    assert.equal(sql, renew); assert.deepEqual(args, values);
    if (++calls === 1) throw driverFailure;
    return { rows: [] };
  } }, new AbortController().signal, async ms => { waits.push(ms); });
  await port.executor.query(renew, values);
  assert.equal(calls, 2); assert.deepEqual(waits, [2000]); assert.equal(port.statistics().recoveredRenewals, 1);
});

test("driver timeout recovery stays bounded and records no raw failure details", async () => {
  let calls = 0; const waits: number[] = [];
  const failure = new Error("Connection terminated due to connection timeout", { cause: new Error("synthetic-private-connection-detail") });
  const port = createRuntimeWriterSql({ query: async () => { calls++; throw failure; } }, new AbortController().signal, async ms => { waits.push(ms); });
  await assert.rejects(port.executor.query(renew, []), value => value === failure);
  assert.equal(calls, 3); assert.deepEqual(waits, [2000, 5000]);
  assert.deepEqual(port.failure(), { code: "OTHER", leaseRejected: false, transient: true, reason: "connection-timeout" });
  assert.equal(JSON.stringify(port.failure()).includes("synthetic-private"), false);
});

test("a lease rejection after reconnect still stops the same run without extending qualification", async () => {
  let calls = 0; const values = ["synthetic-run", "42", 300], waits: number[] = [];
  const port = createRuntimeWriterSql({ query: async (_sql, args) => {
    assert.deepEqual(args, values);
    if (++calls === 1) throw new Error("Connection terminated due to connection timeout");
    throw error("P0001", "NB_LEASE_INVALID");
  } }, new AbortController().signal, async ms => { waits.push(ms); });
  await assert.rejects(port.executor.query(renew, values));
  assert.equal(calls, 2); assert.deepEqual(waits, [2000]);
  assert.deepEqual(port.failure(), { code: "P0001", leaseRejected: true, transient: false, reason: "lease-rejected" });
});

test("timeout words cannot override auth, TLS or unknown failures", async () => {
  for (const failure of [
    error("42501", "Connection terminated due to connection timeout"),
    error("28P01", "Connection terminated due to connection timeout"),
    error("ERR_TLS_CERT_ALTNAME_INVALID", "Connection terminated due to connection timeout"),
    new Error("Connection terminated due to connection timeout: synthetic-private-detail"),
    new Error("synthetic-private-detail", { cause: error("ECONNRESET") }),
  ]) {
    let calls = 0;
    const port = createRuntimeWriterSql({ query: async () => { calls++; throw failure; } }, new AbortController().signal, async () => assert.fail("Terminal failure"));
    await assert.rejects(port.executor.query(renew, [])); assert.equal(calls, 1);
    assert.equal(port.failure()?.transient, false);
    assert.equal(JSON.stringify(port.failure()).includes("synthetic-private"), false);
  }
});
