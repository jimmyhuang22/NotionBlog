import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { cleanupAll, closeOwnerPool } from "../scripts/cleanup.ts";
import { IncrementalQueue } from "../scripts/website-incremental-sync/queue.ts";
import { ContentCacheStore } from "../scripts/website-incremental-sync/content-cache.ts";
import { StudyCheckpointStore } from "../scripts/website-incremental-sync/study-checkpoint.ts";
import { publicHttpResponse, withPublicHttp } from "../src/server/public-cache/http.ts";
import { contentListResponse } from "../src/lib/content/http.ts";
import { createMockRepository } from "../adapters/mock-repository.ts";

test("cleanup attempts all resources after synchronous and asynchronous close failures", async () => {
  const calls: string[] = [];
  assert.equal(await cleanupAll([
    () => { calls.push("connection"); throw Error("close"); },
    async () => { calls.push("store"); throw Error("store"); },
    () => { calls.push("lock-a"); throw Error("lock"); },
    () => { calls.push("lock-b"); },
  ]), false);
  assert.deepEqual(calls, ["connection", "store", "lock-a", "lock-b"]);
});

test("owner cleanup destroys failed clients, closes the pool, and preserves the operation error", async () => {
  const original = Error("restore failure"), calls: unknown[] = [];
  await assert.rejects(async () => {
    try { throw original; }
    finally { await closeOwnerPool({ async end() { calls.push("pool"); throw Error("pool"); } },
      { release(destroy) { calls.push(destroy); throw Error("release"); } }, true); }
  }, error => error === original);
  assert.deepEqual(calls, [true, "pool"]);
  await assert.rejects(closeOwnerPool({ async end() { throw Error("pool"); } }, undefined, false), /DATABASE_CLOSE_FAILED/);
  await closeOwnerPool({ async end() { calls.push("closed"); } }, { release(destroy) { assert.equal(destroy, false); } }, false);
});

for (const [name, create, expected] of [
  ["queue", (db: DatabaseSync) => new IncrementalQueue(db, { digest: "a".repeat(64), sourceKeys: ["status"] }, () => 0), "QUEUE_STATE_INVALID"],
  ["content", (db: DatabaseSync) => new ContentCacheStore(db, "a".repeat(64), ["status"]), "CONTENT_CACHE_UNAVAILABLE"],
  ["study", (db: DatabaseSync) => new StudyCheckpointStore(db, "a".repeat(64)), "STUDY_CHECKPOINT_UNAVAILABLE"],
] as const) {
  test(`${name} transaction preserves the original sanitized error when rollback fails`, () => {
    const db = new DatabaseSync(":memory:"), exec = db.exec.bind(db);
    const calls: string[] = [];
    db.exec = (sql: string) => {
      if (sql === "COMMIT") { calls.push("commit"); throw Error("original internal detail"); }
      if (sql === "ROLLBACK") { calls.push("rollback"); throw Error("rollback private detail"); }
      exec(sql);
    };
    try {
      assert.throws(() => create(db), (error: unknown) => error instanceof Error && "code" in error && error.code === expected);
      assert.deepEqual(calls, ["commit", "rollback"]);
    } finally { db.close(); }
  });
}

test("invalid cache configuration returns JSON 503 with no-store for direct and wrapped content responses", async () => {
  const previous = process.env.PUBLIC_CONTENT_CACHE;
  process.env.PUBLIC_CONTENT_CACHE = "invalid";
  try {
    const request = new Request("https://site.example/api/content/status");
    for (const response of [await publicHttpResponse(request, new Response("content"), "content"),
      await withPublicHttp("content", async () => new Response("content"))(request, undefined),
      await contentListResponse(request, "status", createMockRepository())]) {
      assert.equal(response.status, 503); assert.match(response.headers.get("cache-control")!, /no-store/);
      assert.equal(response.headers.get("vercel-cache-tag"), null);
      assert.equal((await response.json()).error.code, "MISCONFIGURED");
    }
    const failed = await withPublicHttp("content", async () => { throw Error("private provider detail"); })(request, undefined);
    assert.equal(failed.status, 503); assert.equal((await failed.text()).includes("private provider detail"), false);
  } finally { if (previous === undefined) delete process.env.PUBLIC_CONTENT_CACHE; else process.env.PUBLIC_CONTENT_CACHE = previous; }
});

test("actual internal cache routes map configuration failures before any database or purge call", () => {
  const result = spawnSync(process.execPath, ["--conditions=react-server", "--require",
    fileURLToPath(new URL("../scripts/development/offline-network.cjs", import.meta.url)),
    fileURLToPath(new URL("./helpers/cache-error-routes.ts", import.meta.url))], { encoding: "utf8", timeout: 15000 });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /cache error routes passed/);
});
