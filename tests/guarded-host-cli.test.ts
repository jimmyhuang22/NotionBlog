import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile, access } from "node:fs/promises";
import { Pool } from "pg";
import { guardedHostMain, parseGuardedArguments } from "../scripts/website-incremental-sync/guarded-cli.ts";
import { hostFixture } from "./helpers/incremental-host.ts";

const http = ["--http-notion-requests", "100", "--http-storage-requests", "10", "--http-image-requests", "10", "--http-total-requests", "120"];
test("guarded entry rejects missing/duplicate/oversized budgets and recovery HTTP overrides", () => {
  for (const args of [[], ["publish", "--duration-ms", "100"], ["run", ...http, "--duration-ms", "0"],
    ["publish", ...http, "--duration-ms", "5400001"], ["run", ...http, "--duration-ms", "100", "--http-total-requests", "200"],
    ["seal", "--http-notion-requests", "1", "--duration-ms", "100"], ["publish", ...http.map(v => v === "120" ? "20001" : v), "--duration-ms", "100"]]) {
    assert.throws(() => parseGuardedArguments(args), { code: "HTTP_BUDGET_INPUT_INVALID" });
  }
  assert.deepEqual(parseGuardedArguments(["initialize", "--duration-ms", "899000"]).limits, { notion: 0, storage: 0, imageOrigin: 0, total: 0 });
});
test("help and actual status entries have zero HTTP; unsupported source storage fails before module work", async () => {
  const log = console.log, fetcher = globalThis.fetch; let calls = 0;
  console.log = () => {}; globalThis.fetch = async () => { calls++; throw Error("Unexpected HTTP"); };
  const f = await hostFixture();
  try {
    assert.equal(await guardedHostMain(["--help"], { NODE_ENV: "test" }), 0);
    assert.equal(await guardedHostMain(["full-status", "--artifact-dir", join(f.root, "missing-full")], { NODE_ENV: "test" }), 0);
    assert.equal(await guardedHostMain(["incremental-status", "--runtime-dir", join(f.root, "missing-runtime")], { NODE_ENV: "test" }), 0);
    await assert.rejects(guardedHostMain(["publish", ...http, "--duration-ms", "100"], { NODE_ENV: "test" }), { code: "HTTP_BUDGET_INPUT_INVALID" });
    assert.equal(calls, 0); assert.equal(f.counts.pools, 0);
  } finally { console.log = log; globalThis.fetch = fetcher; await f.close(); }
});

test("actual guarded full CLI publishes once; lost reply seals and initializes the same artifact without HTTP/re-promotion", async () => {
  const f = await hostFixture(), output: string[] = [];
  const original = { query: Pool.prototype.query, end: Pool.prototype.end, log: console.log, fetch: globalThis.fetch };
  let promotions = 0, loseReply = true, httpCalls = 0, storageCalls = 0;
  await f.db.exec("UPDATE nb_v2.state SET current_run=NULL; UPDATE nb_publication.state SET run_id=NULL");
  Pool.prototype.query = function(this: Pool & { options: import("pg").PoolConfig }, sql: string, values?: unknown[]) {
    return f.open(this.options).query(sql, values).then(result => {
      if (sql.includes("nb_publication_api.promote_run")) { promotions++; if (loseReply) { loseReply = false; throw Error("Synthetic lost reply"); } }
      return result;
    });
  } as typeof original.query;
  Pool.prototype.end = async () => {}; console.log = value => output.push(String(value));
  globalThis.fetch = async (input, init) => {
    httpCalls++; assert.equal(init?.redirect, "error");
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.hostname === "fiction-12345.cos.ap-shanghai.myqcloud.com") {
      storageCalls++; assert.equal(url.search, "?versioning"); return new Response("<VersioningConfiguration/>");
    }
    return f.fetcher(input, init);
  };
  const env = { NODE_ENV: "test" as const, SYNC_PUBLICATION_MODE: "published", SYNC_MEDIA_PROVIDER: "storage",
    SYNC_READER_DATABASE_URL: f.options.database.readerUrl, SYNC_DATABASE_URL: f.options.database.writerUrl,
    STORAGE_PROVIDER: "cos", COS_BUCKET: "fiction-12345", COS_REGION: "ap-shanghai", COS_PREFIX: "fiction",
    COS_SECRET_ID: "fictionkey", COS_SECRET_KEY: "fiction-secret", NOTION_TOKEN: "synthetic-guarded-host" };
  const artifactDirectory = join(f.root, "guarded-full"), artifactPath = join(artifactDirectory, "incremental-baseline.json");
  const common = ["--config", join(f.root, "config.json"), "--lock-dir", f.options.lockDirectory, "--duration-ms", "30000"];
  try {
    assert.equal(await guardedHostMain(["publish", ...http, ...common, "--artifact-dir", artifactDirectory], env), 1);
    assert.equal(JSON.parse(output.at(-2)!).outcome, "unconfirmed", output.at(-2) ?? "Missing report"); assert.equal(promotions, 1); assert.equal(storageCalls, 1);
    const spent = JSON.parse(output.at(-1)!); assert.equal(spent.total, httpCalls); assert.equal(spent.storage, 1); assert.ok(spent.notion > 0);
    const before = httpCalls;
    assert.equal(await guardedHostMain(["publish", ...http, ...common, "--artifact-dir", artifactDirectory], env), 1);
    assert.equal(JSON.parse(output.at(-2)!).errorCode, "FULL_BASELINE_ALREADY_PREPARED"); assert.equal(httpCalls, before);
    for (const command of ["seal", "initialize", "recover"] as const) {
      const args = command === "seal" ? ["--artifact-dir", artifactDirectory] : ["--runtime-dir", f.options.runtimeDirectory,
        ...(command === "initialize" ? ["--artifact", artifactPath] : [])];
      assert.equal(await guardedHostMain([command, ...common, ...args], env), 0, output.at(-2) ?? "Missing report");
      assert.equal(JSON.parse(output.at(-1)!).total, 0); assert.equal(httpCalls, before); assert.equal(promotions, 1);
    }
    const artifact = JSON.parse(await readFile(artifactPath, "utf8")); assert.equal(artifact.collection.records.length, 3);
    const currentState = await f.db.query("SELECT * FROM nb_publication.state"), sourceCalls = f.counts.sourceCalls;
    const tiny = ["--http-notion-requests", "0", "--http-storage-requests", "1", "--http-image-requests", "0", "--http-total-requests", "1"];
    assert.equal(await guardedHostMain(["publish", ...tiny, ...common, "--artifact-dir", join(f.root, "limited-full")], env), 1);
    assert.equal(JSON.parse(output.at(-1)!).failure, "HTTP_BUDGET_REQUEST_LIMIT"); assert.equal(JSON.parse(output.at(-1)!).total, 1);
    assert.equal(JSON.parse(output.at(-2)!).outcome, "cancelled");
    assert.equal(f.counts.sourceCalls, sourceCalls); assert.equal(promotions, 1);
    assert.deepEqual((await f.db.query("SELECT * FROM nb_publication.state")).rows, currentState.rows);
    await assert.rejects(access(join(f.options.lockDirectory, "worker.lock")));
    for (const privateValue of [env.COS_SECRET_KEY, env.SYNC_DATABASE_URL, artifact.fullRunId, f.root]) assert.equal(output.join("\n").includes(privateValue), false);
  } finally { Pool.prototype.query = original.query; Pool.prototype.end = original.end; console.log = original.log; globalThis.fetch = original.fetch; await f.close(); }
});
