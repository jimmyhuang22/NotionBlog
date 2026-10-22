import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import type { Pool, PoolClient } from "pg";
import { sharedContentReaderPool } from "../src/server/database/shared-reader-pool.ts";

const address = (database: string, user = "fiction", password = "fixture") =>
  `postgresql://${user}:${password}@127.0.0.1:5432/${database}`;

test("separate module copies share one reader pool without multiplying lifecycle listeners", async () => {
  const copy = await import(new URL("../src/server/database/shared-reader-pool.ts?fixture-copy", import.meta.url).href);
  const pool = sharedContentReaderPool(address("module_copy"), "disable");
  try {
    const listeners = pool.eventNames().map(name => [name, pool.listenerCount(name)]);
    assert.equal(copy.sharedContentReaderPool(address("module_copy"), "disable"), pool);
    assert.equal(sharedContentReaderPool(address("module_copy"), "disable"), pool);
    assert.deepEqual(pool.eventNames().map(name => [name, pool.listenerCount(name)]), listeners);
    assert.equal(pool.options.max, 2);
    assert.equal(pool.options.idleTimeoutMillis, 10000);
    assert.equal(pool.options.connectionTimeoutMillis, 10000);
    assert.equal(pool.options.statement_timeout, 15000);
    assert.equal(pool.options.query_timeout, 20000);
    assert.equal(pool.totalCount, 0, "Construction and reuse must not connect or prewarm");
  } finally { await pool.end(); }
});

test("reader identity and TLS trust changes cannot reuse a previous pool", async () => {
  const pools = new Set<Pool>();
  const get = (url: string, tls?: string, ca?: string) => {
    const pool = sharedContentReaderPool(url, tls, ca); pools.add(pool); return pool;
  };
  try {
    const first = get(address("identity"), "verify", "fictional-ca-one");
    assert.equal(get(address("identity"), undefined, "fictional-ca-one"), first);
    assert.notEqual(get(address("identity", "another_reader"), "verify", "fictional-ca-one"), first);
    assert.notEqual(get(address("identity", "fiction", "another_fixture"), "verify", "fictional-ca-one"), first);
    assert.notEqual(get(address("other_database"), "verify", "fictional-ca-one"), first);
    assert.notEqual(get(address("identity"), "verify", "fictional-ca-two"), first);
    assert.notEqual(get(address("identity"), "disable", "fictional-ca-one"), first);
    assert.equal(pools.size, 6);
    assert([...pools].every(pool => pool.totalCount === 0));
    assert.throws(() => sharedContentReaderPool(undefined, "verify"));
    assert.throws(() => sharedContentReaderPool(address("identity") + "?sslmode=disable", "verify"));
  } finally { await Promise.all([...pools].map(pool => pool.end())); }
});

test("ending and ended pools are replaced without changing other readers", async () => {
  const original = sharedContentReaderPool(address("ended"), "disable");
  const other = sharedContentReaderPool(address("independent"), "disable");
  const ending = original.end();
  const replacement = sharedContentReaderPool(address("ended"), "disable");
  try {
    assert.notEqual(replacement, original);
    await ending;
    assert.equal(sharedContentReaderPool(address("ended"), "disable"), replacement);
    assert.equal(sharedContentReaderPool(address("independent"), "disable"), other);
  } finally { await Promise.all([replacement.end(), other.end()]); }
});

test("module copies share the real pg pool capacity and return a queued checkout to the same client", async () => {
  class FixtureClient extends EventEmitter {
    _queryable = true;
    _ending = false;
    connect(callback: (error?: Error) => void) { queueMicrotask(() => callback()); }
    end(callback?: () => void) { this._ending = true; queueMicrotask(() => { this.emit("end"); callback?.(); }); }
    ref() {}
    unref() {}
  }
  const copy = await import(new URL("../src/server/database/shared-reader-pool.ts?capacity-copy", import.meta.url).href);
  const pool = sharedContentReaderPool(address("shared_capacity"), "disable");
  // Exercise the installed pool's queue and release logic; replace only its transport.
  (pool as unknown as { Client: typeof FixtureClient }).Client = FixtureClient;
  const peer: Pool = copy.sharedContentReaderPool(address("shared_capacity"), "disable");
  const active = new Set<PoolClient>();
  try {
    const [first, second] = await Promise.all([pool.connect(), peer.connect()]);
    active.add(first); active.add(second);
    const queued = peer.connect();
    assert.equal(pool.totalCount, 2); assert.equal(pool.waitingCount, 1);
    active.delete(first); first.release();
    const reused = await queued; active.add(reused);
    assert.equal(reused, first); assert.equal(pool.totalCount, 2); assert.equal(peer.waitingCount, 0);
  } finally {
    for (const client of active) client.release(true);
    await pool.end();
  }
});
