import assert from "node:assert/strict";
import test from "node:test";
import { scopedReader, SCOPED_FILTERED_SEARCH_SQL, SCOPED_SEARCH_SQL, SCOPED_VERSION_SQL } from "../src/server/database/scoped-reads.ts";
import type { SearchProjectionMode } from "../src/server/database/scoped-reads.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function driver(check: (optional: boolean) => Promise<boolean>) {
  const checks: boolean[] = [], reads: string[] = [];
  const db: SqlExecutor = { async query<T>(sql: string) {
    let result: unknown;
    if (sql.includes("nb_read_api.check_capability(")) {
      const optional = /check_search_(filtered|precomputed)\(/.test(sql);
      checks.push(optional); result = await check(optional);
    } else { reads.push(sql); result = reads.length; }
    return { rows: [{ result } as T] };
  } };
  return { db, checks, reads };
}
const modes: SearchProjectionMode[] = ["filtered", "precomputed"];
const searchSQL = (mode: SearchProjectionMode) => mode === "filtered" ? SCOPED_FILTERED_SEARCH_SQL : SCOPED_SEARCH_SQL;

for (const mode of modes) {
  test(`${mode}: ordinary reads never require the optional extension or cache content`, async () => {
    const f = driver(async optional => !optional), reader = scopedReader(f.db, "published", mode);
    assert.deepEqual((await reader.query(SCOPED_VERSION_SQL)).rows, [{ result: 1 }]);
    assert.deepEqual((await reader.query(SCOPED_VERSION_SQL)).rows, [{ result: 2 }]);
    assert.deepEqual(f.checks, [false]);
    await assert.rejects(reader.query(searchSQL(mode)), { code: "CONTENT_UNAVAILABLE" });
    assert.equal(f.reads.length, 2, "An incompatible search must not issue its content query");
    assert.deepEqual((await reader.query(SCOPED_VERSION_SQL)).rows, [{ result: 3 }]);
  });

  test(`${mode}: cold concurrent searches share one combined check and later ordinary reads reuse it`, async () => {
    const gate = deferred<boolean>(), entered = deferred<void>();
    const f = driver(async () => { entered.resolve(); return gate.promise; });
    const reader = scopedReader(f.db, "qualified", mode);
    const reads = [reader.query(searchSQL(mode)), reader.query(searchSQL(mode))];
    await entered.promise;
    assert.deepEqual(f.checks, [true]); assert.equal(f.reads.length, 0);
    gate.resolve(true); await Promise.all(reads);
    await reader.query(SCOPED_VERSION_SQL); await reader.query(searchSQL(mode));
    assert.deepEqual(f.checks, [true]); assert.equal(f.reads.length, 4);
  });

  test(`${mode}: a pending/failing search cannot hold ordinary reads; failed checks can retry`, { timeout: 3000 }, async () => {
    const gate = deferred<boolean>(), entered = deferred<void>();
    let compatible = false;
    const f = driver(async optional => {
      if (!optional || compatible) return true;
      entered.resolve(); return gate.promise;
    });
    const reader = scopedReader(f.db, "published", mode);
    const failed = assert.rejects(reader.query(searchSQL(mode)), { code: "CONTENT_UNAVAILABLE" });
    await entered.promise;
    try {
      await Promise.all([reader.query(SCOPED_VERSION_SQL), reader.query(SCOPED_VERSION_SQL)]);
      assert.deepEqual(f.checks, [true, false]);
      assert.equal(f.reads.length, 2, "Ordinary reads finish while optional readiness remains pending");
    } finally { gate.resolve(false); await failed; }
    compatible = true;
    await Promise.all([reader.query(searchSQL(mode)), reader.query(searchSQL(mode))]);
    await reader.query(SCOPED_VERSION_SQL);
    assert.deepEqual(f.checks, [true, false, true]); assert.equal(f.reads.length, 5);
  });

  test(`${mode}: a failed base check retries independently of optional search readiness`, async () => {
    let compatible = false;
    const f = driver(async () => compatible), reader = scopedReader(f.db, "qualified", mode);
    await assert.rejects(reader.query(SCOPED_VERSION_SQL), { code: "CONTENT_UNAVAILABLE" });
    assert.equal(f.reads.length, 0);
    compatible = true;
    await reader.query(SCOPED_VERSION_SQL); await reader.query(searchSQL(mode));
    assert.deepEqual(f.checks, [false, false, true]);
  });
}
