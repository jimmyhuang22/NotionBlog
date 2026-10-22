import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, stat, access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";
import { openFullBaselineDatabase } from "../src/server/database/incremental-connection.ts";
import { readPublicationState } from "../src/server/database/incremental-publication.ts";
import { runFullBaselineHost, type FullBaselineHostDependencies } from "../scripts/website-incremental-sync/full-baseline-host.ts";
import { fullBaselineMain, parseFullBaselineArguments } from "../scripts/website-incremental-sync/full-baseline-cli.ts";
import { createFullBaselineSources } from "../scripts/website-incremental-sync/full-baseline-sources.ts";
import { runIncrementalHost } from "../scripts/website-incremental-sync/host.ts";
import { savePreparedFullBaseline } from "../scripts/website-incremental-sync/full-baseline-artifact.ts";
import { NotionRequestScheduler } from "../src/server/notion/request-scheduler.ts";
import { acquireLock } from "../scripts/notion-sync/state.ts";
import { hostFixture } from "./helpers/incremental-host.ts";

function fixturePorts(f: Awaited<ReturnType<typeof hostFixture>>, databaseOpen = f.open) {
  const options = { command: "publish" as const, config: f.config, lockDirectory: f.options.lockDirectory,
    artifactDirectory: join(f.root, "first-full"), database: f.options.database, durationMs: 10000 };
  const deps: FullBaselineHostDependencies = {
    database: (input, signal) => openFullBaselineDatabase(input, { open: databaseOpen }, signal),
    sources: async ({ budget }) => {
      f.counts.factories++;
      return createFullBaselineSources({ token: "synthetic-host", budget, fetch: f.fetcher,
        scheduler: new NotionRequestScheduler({ intervalMs: 0 }), storage: {
          put: async () => { assert.fail("Unexpected image upload"); }, read: async () => { assert.fail("Unexpected image read"); },
        } });
    },
  };
  return { options, deps };
}

test("the fixed full host retains the source-bound collection zone through SDK allocation and the accepted artifact", async t => {
  const f = await hostFixture("Australia/Melbourne"); t.after(() => f.close());
  await f.db.exec("UPDATE nb_v2.state SET current_run=NULL; UPDATE nb_publication.state SET run_id=NULL");
  const { options, deps } = fixturePorts(f), sources = deps.sources;
  deps.sources = async input => {
    assert.equal(input.config.timeZone, "Australia/Melbourne");
    return sources(input);
  };
  const result = await runFullBaselineHost(options, deps);
  assert.equal(result.outcome, "accepted", JSON.stringify(result));
  const artifact = JSON.parse(await readFile(join(options.artifactDirectory, "incremental-baseline.json"), "utf8"));
  assert.equal(artifact.state.configDigest, f.digest);
  assert.equal(f.counts.factories, 1);
});

test("actual SDK full publication seals one durable artifact and the daily host consumes it without a second collection", async t => {
  const f = await hostFixture(); t.after(() => f.close());
  await f.db.exec("UPDATE nb_v2.state SET current_run=NULL; UPDATE nb_publication.state SET run_id=NULL");
  const { options, deps } = fixturePorts(f), published = await runFullBaselineHost(options, deps);
  assert.equal(published.outcome, "accepted", JSON.stringify(published)); assert.equal(published.records, 3);
  assert.equal(published.prepared, true); assert.equal(published.sealed, true); assert.equal(published.promoteRequested, true);
  assert.ok(published.budget.sourceRequests > 0); assert.equal(f.counts.factories, 1);
  const artifactPath = join(options.artifactDirectory, "incremental-baseline.json");
  const saved = await readFile(artifactPath, "utf8"), artifact = JSON.parse(saved);
  assert.equal(Object.keys(artifact).length, 7); assert.notEqual(artifact.fullRunId, f.artifact.fullRunId);
  assert.equal((await stat(artifactPath)).mode & 0o077, 0);
  const before = { ...f.counts };
  const initialized = await runIncrementalHost({ ...f.options, artifactPath }, f.deps);
  assert.equal(initialized.outcome, "initialized", JSON.stringify(initialized));
  assert.equal(f.counts.sourceCalls, before.sourceCalls); assert.equal(f.counts.factories, before.factories);
  assert.equal(f.counts.pageReads - before.pageReads, 3);
  const daily = await runIncrementalHost({ ...f.options, command: "run" }, f.deps);
  assert.equal(daily.outcome, "unchanged", JSON.stringify(daily)); assert.equal(daily.published, 0);
  const recoverBefore = { ...f.counts };
  const sealed = await runFullBaselineHost({ ...options, command: "seal" }, { ...deps, sources: async () => { assert.fail("Source in seal"); } });
  assert.equal(sealed.outcome, "accepted"); assert.equal(sealed.budget.sourceRequests, 0); assert.equal(sealed.budget.mediaBytes, 0);
  assert.equal(f.counts.sourceCalls, recoverBefore.sourceCalls);
  assert.equal(await readFile(artifactPath, "utf8"), saved);
  const rejected = await runFullBaselineHost(options, deps);
  assert.equal(rejected.errorCode, "FULL_BASELINE_ALREADY_PREPARED"); assert.equal(f.counts.factories, recoverBefore.factories);
  assert.equal(f.counts.pools, f.counts.closed);
  await assert.rejects(access(join(options.lockDirectory, "worker.lock")));
  const aggregate = await readFile(join(options.artifactDirectory, "baseline-latest.json"), "utf8");
  for (const privateValue of [artifact.fullRunId, f.digest, f.options.database.writerUrl]) assert.equal(aggregate.includes(privateValue), false);
});

test("an actually accepted full SQL commit with a lost reply recovers by sealing, with no source or promotion replay", async t => {
  const f = await hostFixture(); t.after(() => f.close()); let lost = true, promotions = 0;
  const open: typeof f.open = settings => {
    const db = f.open(settings);
    return { ...db, query: async <T>(sql: string, values?: unknown[]) => {
      const result = await db.query<T>(sql, values);
      if (sql.includes("nb_publication_api.promote_run")) { promotions++; if (lost) { lost = false; throw Error("Synthetic private lost promote reply"); } }
      return result;
    } };
  };
  const { options, deps } = fixturePorts(f, open);
  const report = await runFullBaselineHost(options, deps);
  assert.equal(report.outcome, "unconfirmed", JSON.stringify(report)); assert.equal(report.prepared, true);
  await access(join(options.artifactDirectory, "incremental-prepared.json"));
  await assert.rejects(access(join(options.artifactDirectory, "incremental-baseline.json")));
  const before = { ...f.counts };
  const replay = await runFullBaselineHost(options, deps);
  assert.equal(replay.errorCode, "FULL_BASELINE_ALREADY_PREPARED"); assert.equal(f.counts.factories, before.factories);
  const sealed = await runFullBaselineHost({ ...options, command: "seal" }, { ...deps, sources: async () => { assert.fail("Source in recovery"); } });
  assert.equal(sealed.outcome, "accepted", JSON.stringify(sealed)); assert.equal(promotions, 1);
  assert.equal(f.counts.sourceCalls, before.sourceCalls); assert.equal(f.counts.pools, f.counts.closed);
});

test("unaccepted persisted input and guarded startup never construct source or storage adapters", async t => {
  const f = await hostFixture(); t.after(() => f.close()); const { options, deps } = fixturePorts(f);
  await savePreparedFullBaseline({ directory: options.artifactDirectory, config: f.config,
    capture: { format: "incremental-prepared-baseline-v1", fullRunId: randomUUID(), configDigest: f.digest,
      collection: f.artifact.collection, media: [], deniedPageIds: [], directory: f.artifact.directory } }, new AbortController().signal);
  const rejected = await runFullBaselineHost({ ...options, command: "seal" }, deps);
  assert.equal(rejected.errorCode, "FULL_BASELINE_PUBLICATION_UNCONFIRMED"); assert.equal(f.counts.factories, 0);
  const release = await acquireLock(options.lockDirectory, randomUUID()), pools = f.counts.pools;
  try { const busy = await runFullBaselineHost(options, deps); assert.equal(busy.errorCode, "HOST_BUSY"); assert.equal(f.counts.pools, pools);
    await access(join(options.lockDirectory, "worker.lock")); } finally { await release(); }
  const controller = new AbortController(); controller.abort();
  const cancelled = await runFullBaselineHost({ ...options, signal: controller.signal }, deps);
  assert.equal(cancelled.outcome, "cancelled"); assert.equal(f.counts.pools, pools); assert.equal(f.counts.factories, 0);
});

test("a conflicting prepared file stops before staging and preserves the previous publication", async t => {
  const f = await hostFixture(); t.after(() => f.close()); let stages = 0, promotions = 0;
  const open: typeof f.open = settings => {
    const db = f.open(settings);
    return { ...db, query: <T>(sql: string, values?: unknown[]) => {
      if (sql.includes("nb_v2_api.stage_batch")) stages++;
      if (sql.includes("nb_publication_api.promote_run")) promotions++;
      return db.query<T>(sql, values);
    } };
  };
  const { options, deps } = fixturePorts(f, open), sources = deps.sources;
  deps.sources = async input => {
    await writeFile(join(options.artifactDirectory, "incremental-prepared.json"), "{}", { mode: 0o600 });
    return sources(input);
  };
  const rejected = await runFullBaselineHost(options, deps);
  assert.equal(rejected.errorCode, "FULL_BASELINE_FILE_CONFLICT", JSON.stringify(rejected));
  assert.equal(stages, 0); assert.equal(promotions, 0); assert.deepEqual(await readPublicationState(f.db), f.state);
  assert.equal(f.counts.pools, f.counts.closed);
});

test("the actual full begin API rejects a different configured policy before any Notion HTTP", async t => {
  const f = await hostFixture(); t.after(() => f.close()); const { options, deps } = fixturePorts(f);
  await f.db.query("UPDATE nb_v2.state SET config_digest=$1", ["f".repeat(64)]);
  const rejected = await runFullBaselineHost(options, deps);
  assert.equal(rejected.outcome, "failed", JSON.stringify(rejected)); assert.equal(f.counts.sourceCalls, 0);
  assert.equal(rejected.prepared, false); assert.equal(rejected.promoteRequested, false);
  assert.equal(f.counts.pools, f.counts.closed);
});

test("a lost successful SQL renewal cancels an in-flight SDK request and preserves the old publication", async t => {
  const f = await hostFixture(); t.after(() => f.close()); t.mock.timers.enable({ apis: ["setInterval"] });
  const open: typeof f.open = settings => {
    const db = f.open(settings);
    return { ...db, query: async <T>(sql: string, values?: unknown[]) => {
      const result = await db.query<T>(sql, values);
      if (sql.includes("nb_v2_api.renew_run")) throw Error("Synthetic private lost renewal reply");
      return result;
    } };
  };
  const { options, deps } = fixturePorts(f, open); let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  deps.sources = async ({ budget }) => createFullBaselineSources({ token: "synthetic-renewal", budget,
    scheduler: new NotionRequestScheduler({ intervalMs: 0 }), fetch: async (_url, init) => {
      f.counts.sourceCalls++; started();
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new DOMException("Synthetic cancellation", "AbortError"));
        if (init?.signal?.aborted) abort(); else init?.signal?.addEventListener("abort", abort, { once: true });
      });
    }, storage: { put: async () => { assert.fail("Storage during cancelled collection"); }, read: async () => { assert.fail("Storage during cancelled collection"); } } });
  const running = runFullBaselineHost(options, deps); await ready; t.mock.timers.tick(30000);
  const report = await running;
  assert.equal(report.errorCode, "FULL_BASELINE_LEASE_UNCONFIRMED", JSON.stringify(report));
  assert.equal(report.outcome, "failed"); assert.equal(report.prepared, false); assert.equal(report.promoteRequested, false);
  assert.equal(f.counts.sourceCalls, 1); assert.deepEqual(await readPublicationState(f.db), f.state);
  assert.equal(f.counts.pools, f.counts.closed); await assert.rejects(access(join(options.lockDirectory, "worker.lock")));
});

test("production sealing CLI uses explicit independent SQL roles and needs no Notion or object credentials", async t => {
  const f = await hostFixture(); t.after(() => f.close()); const { options, deps } = fixturePorts(f);
  assert.equal((await runFullBaselineHost(options, deps)).outcome, "accepted");
  const query = Pool.prototype.query, end = Pool.prototype.end, log = console.log, output: string[] = [];
  Pool.prototype.query = function(this: Pool & { options: import("pg").PoolConfig }, sql: string, values?: unknown[]) { return f.open(this.options).query(sql, values); } as typeof query;
  Pool.prototype.end = async () => {}; console.log = value => output.push(String(value));
  try {
    const args = ["seal", "--config", join(f.root, "config.json"), "--lock-dir", options.lockDirectory, "--artifact-dir", options.artifactDirectory];
    const env = { NODE_ENV: "test" as const, SYNC_PUBLICATION_MODE: "published", SYNC_MEDIA_PROVIDER: "storage", SYNC_READER_DATABASE_URL: f.options.database.readerUrl, SYNC_DATABASE_URL: f.options.database.writerUrl };
    assert.equal(await fullBaselineMain(args, env), 0); assert.equal(JSON.parse(output.at(-1)!).outcome, "accepted");
    const status = ["status", "--artifact-dir", options.artifactDirectory]; assert.equal(await fullBaselineMain(status, { NODE_ENV: "test" }), 0);
    const saved = JSON.parse(await readFile(join(options.artifactDirectory, "baseline-latest.json"), "utf8"));
    await writeFile(join(options.artifactDirectory, "baseline-latest.json"), JSON.stringify({ ...saved, privateBody: "Synthetic private body" }));
    const printed = output.length;
    await assert.rejects(fullBaselineMain(status, { NODE_ENV: "test" }), { code: "HOST_STATE_INVALID" }); assert.equal(output.length, printed);
    await assert.rejects(fullBaselineMain(args, { ...env, SYNC_READER_DATABASE_URL: undefined, DATABASE_URL: env.SYNC_READER_DATABASE_URL }), { code: "HOST_INPUT_INVALID" });
  } finally { Pool.prototype.query = query; Pool.prototype.end = end; console.log = log; }
});

test("first-full CLI rejects guessed paths, duplicate modes and malformed budgets before startup", () => {
  for (const args of [[], ["run"], ["publish", "--artifact-dir", "relative"], ["seal", "--artifact-dir", "/private/run", "--config", "/private/c", "--lock-dir", "/private/l", "--source-requests", "0"],
    ["status", "--artifact-dir", "/private/run", "--artifact-dir", "/private/other"]]) assert.throws(() => parseFullBaselineArguments(args), { code: "HOST_INPUT_INVALID" });
});
