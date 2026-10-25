import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { registerHooks } from "node:module";
import { PGlite } from "@electric-sql/pglite";
import type { SqlExecutor } from "../src/server/database/sql.ts";
import { publicCacheKey } from "../src/server/public-cache/policy.ts";
import { planWithdrawal, planCompactWithdrawal, executeWithdrawal, executeCompactWithdrawal, withdrawalDatabaseHash, validateWithdrawalJournalVersion, type WithdrawalJournal } from "../scripts/public-cache/withdraw.ts";
import { validateCompactWithdrawalPlan, validateCompactWithdrawalJournal, withdrawalPlanIdentity, sameWithdrawalPlan, compactWithdrawalCheckPaths, type CompactWithdrawalJournal, type CompactWithdrawalPlan } from "../scripts/public-cache/withdraw-compact.ts";
import { loadCompactWithdrawalProtocol } from "../scripts/public-cache/compact-withdrawal-protocol.ts";
import cache from "../database/public-cache-protocol.json" with { type: "json" };

const config = { siteKey: "fixture-site", origin: "https://site.example", secret: Buffer.alloc(32).toString("hex") };
const databaseHash = withdrawalDatabaseHash(["postgresql:", "//operator:placeholder@localhost/fixture"].join(""));
const sample = "a1." + "a".repeat(64);
const target = config.origin + "/status#a";
// Only top-level fixed RPC statements are calls. Catalog VALUES may contain the
// same signatures as data and must never trigger a simulated lost write ACK.
const withdrawalRpc = (sql: string) => /^\s*SELECT\s+nb_cache_api\.(plan_withdraw_compact|plan_withdraw|withdraw_compact|withdraw|read_withdraw|read_event|complete_event)\(/.exec(sql)?.[1];
const isPlanOrWriteRpc = (sql: string) => {
  const name = withdrawalRpc(sql);
  return name === "plan_withdraw" || name === "plan_withdraw_compact" || name === "withdraw" || name === "withdraw_compact";
};
const compactPlan = (): CompactWithdrawalPlan => ({ version: 2, target: "a", runId: randomUUID(), revision: "1", epoch: "1",
  pages: [{ id: "a", href: "/status#a", kind: "status", slug: "a" }], assetSummary: { algorithm: "nb-withdraw-assets-sha256-v1", count: 1, digest: "b".repeat(64), sample }, sharedOwnerUrl: false, leaseActive: false });
const compactJournal = (): CompactWithdrawalJournal => ({ version: 2, id: randomUUID(), siteKey: config.siteKey, origin: config.origin, databaseHash, phase: "PLANNED", plan: compactPlan() });
const goodFetch: typeof fetch = async (input, init) => {
  if (String(input).endsWith("/api/internal/cache/purge")) {
    const request = JSON.parse(String(init?.body));
    return Response.json({ version: 1, siteKey: config.siteKey, id: request.id, generation: request.generation, purged: true });
  }
  return new Response(null, { status: 404 });
};

/** Real isolated SQL/catalog and original read/ACK functions; HTTP remains an explicit fake port. */
async function fixture(installCompact = true) {
  const db = await PGlite.create(), calls: string[] = [];
  try {
    await db.exec(await readFile(new URL("../database/website-migrations/001_website.sql", import.meta.url), "utf8"));
    await db.exec(await readFile(new URL("../" + cache.migration.file, import.meta.url), "utf8"));
    if (installCompact) {
      const protocol = await loadCompactWithdrawalProtocol();
      await db.exec(await readFile(new URL("../supabase/migrations/" + protocol.migration.file, import.meta.url), "utf8"));
    }
    const run = randomUUID();
    await db.exec("INSERT INTO nb_v2.sources(key,kind,mode,data_source_id) VALUES('status','status','all','fixture-status')");
    await db.query("INSERT INTO nb_v2.runs(id,fence,revision,epoch,config_digest,valid_until,status) VALUES($1,1,1,1,$2,clock_timestamp()+interval '1 hour','published')", [run, "a".repeat(64)]);
    await db.query("UPDATE nb_v2.state SET current_run=$1,revision=1,epoch=1,config_digest=$2,schema_digest=$2", [run, "a".repeat(64)]);
    for (const id of ["a", "b"]) await db.query("INSERT INTO nb_v2.records(run_id,id,kind,source_key,ordinal,item,document) VALUES($1,$2,'status','status',1,$3::jsonb,'{}')", [run, id, JSON.stringify({ id, href: "/status#" + id, kind: "status", slug: id })]);
    for (const asset of [sample, "a1." + "c".repeat(64)]) await db.query("INSERT INTO nb_v2.media VALUES($1,$2,'a','{}')", [run, asset]);
    const operator: SqlExecutor = { query: async <T>(sql: string, values?: unknown[]) => {
      calls.push(sql); return db.transaction(async tx => { await tx.exec("SET LOCAL ROLE nb_cache_operator"); return tx.query<T>(sql, values); });
    } };
    return { db, operator, calls, run, close: () => db.close() };
  } catch (error) { await db.close(); throw error; }
}
async function ownedFixture(t: TestContext, installCompact = true) { const value = await fixture(installCompact); t.after(() => value.close()); return value; }

if (process.argv[2] === "--compact-client-cli-fixture") {
  // A child-only facade substitutes local configuration/journal ports. The real
  // CLI, validators, capability catalog, planner, mutation and read proof execute.
  const f = await fixture(), version = Number(process.argv[3]), journalPath = process.argv[4]; let saved: WithdrawalJournal | CompactWithdrawalJournal | undefined;
  const order: string[] = [], output: unknown[] = []; let connects = 0, closes = 0, releases = 0, locks = 0;
  const localUrl = new URL("../scripts/public-cache/local.ts", import.meta.url).href;
  const originalFetch = globalThis.fetch, log = console.log;
  const url = ["postgresql:", "//operator:placeholder@localhost/fixture"].join("");
  const state = { cacheClientConfig() { order.push("config"); return config; }, async cacheOperatorConnection() { order.push("connect"); connects++; return { db: f.operator, url, close: async () => { closes++; } }; },
    async saveCacheJournal(_path: string, value: WithdrawalJournal | CompactWithdrawalJournal) { saved = structuredClone(value); },
    async readCacheJournal() { order.push("read"); return structuredClone(saved); }, async acquireWithdrawalLocks() { locks++; return async () => { releases++; }; } };
  Reflect.set(globalThis, "__compactWithdrawalCli", state);
  const facade = "data:text/javascript," + encodeURIComponent("const s=globalThis.__compactWithdrawalCli;export const cacheClientConfig=s.cacheClientConfig,cacheOperatorConnection=s.cacheOperatorConnection,saveCacheJournal=s.saveCacheJournal,readCacheJournal=s.readCacheJournal,acquireWithdrawalLocks=s.acquireWithdrawalLocks;");
  const hooks = registerHooks({ resolve(specifier, context, next) { const resolved = next(specifier, context); return resolved.url === localUrl ? { url: facade, shortCircuit: true } : resolved; } });
  try {
    globalThis.fetch = goodFetch; console.log = value => output.push(JSON.parse(String(value)));
    const { runWithdrawalCli } = await import("../scripts/public-cache/withdraw-cli.ts");
    await runWithdrawalCli([...(version === 2 ? ["--compact"] : []), target, "--plan", journalPath]);
    assert.equal(saved!.version, version); const planned = structuredClone(saved!);
    await runWithdrawalCli(["--execute", journalPath]); assert.equal(saved!.phase, "COMPLETE");
    // Recreate an actual post-purge local phase, without replanning the denied target.
    saved = { ...saved!, phase: "PURGED_VERIFY_PENDING" }; delete saved.checkedPaths;
    f.calls.length = 0; order.length = 0;
    await runWithdrawalCli(["--resume", journalPath]);
    assert.equal(saved!.phase, "COMPLETE"); assert.ok(!f.calls.some(isPlanOrWriteRpc));
    assert.deepEqual(order.slice(0, 3), ["read", "config", "connect"]);
    const before = connects; saved = { ...planned, version: 3 } as unknown as CompactWithdrawalJournal;
    await assert.rejects(runWithdrawalCli(["--execute", journalPath])); assert.equal(connects, before);
    log(JSON.stringify({ version, plannedVersion: planned.version, finished: output.some(value => (value as { phase?: string }).phase === "COMPLETE"), connects, closes, locks, releases, localValidationBeforeConnect: true, resumeNeverReplans: true }));
  } finally { console.log = log; globalThis.fetch = originalFetch; hooks.deregister(); await f.close(); }
} else {
  test("v2 plan and journal admission rejects mixed or unknown shapes and enforces fixed summary boundaries", async () => {
    const plan = compactPlan();
    for (const count of [0, 400000]) {
      const value = { ...plan, assetSummary: { ...plan.assetSummary, count, sample: count === 0 ? null : sample } };
      assert.equal(validateCompactWithdrawalPlan(value).assetSummary.count, count);
    }
    for (const value of [
      { ...plan, version: 1 }, { ...plan, assets: [] }, { ...plan, extra: true }, { ...plan, pages: [{ ...plan.pages[0], extra: true }] },
      ...[{ count: -1 }, { count: 400001 }, { count: 1.5 }, { count: 0, sample }, { count: 1, sample: null }, { digest: "A".repeat(64) }, { algorithm: "unknown" }, { extra: true }].map(change => ({ ...plan, assetSummary: { ...plan.assetSummary, ...change } })),
    ]) assert.throws(() => validateCompactWithdrawalPlan(value));
    const journal = compactJournal();
    for (const value of [{ ...journal, version: 1 }, { ...journal, plan: { ...journal.plan, version: 1, assets: [] } }, { ...journal, phase: "COMPLETE" }, { ...journal, arbitrarySql: "withdraw" }, { ...journal, event: { id: journal.id, scope: "withdraw", generation: "1", status: "pending" } }]) assert.throws(() => validateCompactWithdrawalJournal(value));
    const complete = { ...journal, phase: "COMPLETE", event: { id: journal.id, scope: "withdraw", generation: "1", status: "pending" }, checkedPaths: compactWithdrawalCheckPaths(journal.plan) };
    assert.equal(validateCompactWithdrawalJournal(complete).phase, "COMPLETE");
    assert.throws(() => validateCompactWithdrawalJournal({ ...complete, checkedPaths: [] }));
    assert.throws(() => validateWithdrawalJournalVersion({ ...journal, version: 3 }));
  });

  test("withdrawal identity compares all fields within its own 8 MiB, depth and JSON limits", () => {
    const plan = compactPlan(), reordered = Object.fromEntries(Object.entries(plan).reverse());
    assert.equal(sameWithdrawalPlan(plan, reordered), true);
    assert.equal(sameWithdrawalPlan({ ...plan, unknown: { a: 1 } }, { ...plan, unknown: { a: 2 } }), false);
    assert.equal(sameWithdrawalPlan({ ...plan, unknown: [1, 2] }, { ...plan, unknown: [2, 1] }), false);
    const boundary = { payload: "" }, overhead = Buffer.byteLength(JSON.stringify(boundary)); boundary.payload = "x".repeat(8 * 1024 * 1024 - overhead);
    assert.doesNotThrow(() => withdrawalPlanIdentity(boundary)); boundary.payload += "x"; assert.throws(() => withdrawalPlanIdentity(boundary), { message: "WITHDRAW_PLAN_LIMIT" });
    let deep: unknown = null; for (let i = 0; i < 14; i++) deep = { nested: deep };
    for (const invalid of [deep, { extra: undefined }, { extra: NaN }, { extra: new Date() }]) assert.throws(() => withdrawalPlanIdentity(invalid), { message: "WITHDRAW_PLAN_LIMIT" });
    const cycle: { cycle?: unknown } = {}; cycle.cycle = cycle; assert.throws(() => withdrawalPlanIdentity(cycle), { message: "WITHDRAW_PLAN_LIMIT" });
  });

  test("invalid journals stop before capability or database work and a missing extension never falls back", async t => {
    let queries = 0;
    const db: SqlExecutor = { query: async <T>() => { queries++; return { rows: [] as T[] }; } };
    await assert.rejects(executeCompactWithdrawal({ ...compactJournal(), plan: { ...compactPlan(), assets: [] } } as never, config, databaseHash, { db, save: async () => {} }));
    await assert.rejects(planCompactWithdrawal(db, "https://unknown.example/page", config, databaseHash)); assert.equal(queries, 0);
    const f = await ownedFixture(t, false);
    await assert.rejects(planCompactWithdrawal(f.operator, target, config, databaseHash), { message: "COMPACT_WITHDRAWAL_UNAVAILABLE" });
    assert.ok(!f.calls.some(isPlanOrWriteRpc));
    assert.equal((await planWithdrawal(f.operator, target, config, databaseHash)).version, 1);
  });

  test("an unknown compact mutation resumes from its committed payload without a second write or plan", async t => {
    const f = await ownedFixture(t), journal = await planCompactWithdrawal(f.operator, target, config, databaseHash), saved: CompactWithdrawalJournal[] = [];
    let lose = true; const first = Error("Synthetic lost write acknowledgement");
    const db: SqlExecutor = { query: async <T>(sql: string, values?: unknown[]) => {
      const result = await f.operator.query<T>(sql, values);
      if (withdrawalRpc(sql) === "withdraw_compact" && lose) { lose = false; throw first; } return result;
    } };
    await assert.rejects(executeCompactWithdrawal(journal, config, databaseHash, { db, save: async value => { saved.push(structuredClone(value)); }, fetch: goodFetch }), error => error === first);
    assert.equal(saved.at(-1)!.phase, "DENY_OUTCOME_UNKNOWN");
    assert.equal((await f.db.query<{ count: number }>("SELECT count(*)::int AS count FROM nb_cache.events")).rows[0].count, 1);
    await assert.rejects(executeCompactWithdrawal({ ...journal, phase: "COMPLETE", event: { id: journal.id, scope: "withdraw", generation: "1", status: "pending" }, checkedPaths: compactWithdrawalCheckPaths(journal.plan) }, config, databaseHash, { db, save: async () => {}, fetch: goodFetch }), { message: "WITHDRAW_OUTCOME_UNKNOWN" });
    f.calls.length = 0;
    const complete = await executeCompactWithdrawal(saved.at(-1)!, config, databaseHash, { db, save: async value => { saved.push(structuredClone(value)); }, fetch: goodFetch });
    assert.equal(complete.phase, "COMPLETE"); assert.equal(complete.checkedPaths!.length, 5);
    assert.ok(!f.calls.some(isPlanOrWriteRpc));
    const before = f.calls.filter(sql => withdrawalRpc(sql) === "read_withdraw").length;
    await assert.rejects(executeCompactWithdrawal({ ...complete, plan: { ...complete.plan, assetSummary: { ...complete.plan.assetSummary, digest: "e".repeat(64) } } }, config, databaseHash, { db, save: async () => {}, fetch: goodFetch }), { message: "WITHDRAW_OUTCOME_UNKNOWN" });
    assert.equal(f.calls.filter(sql => withdrawalRpc(sql) === "read_withdraw").length, before + 1, "COMPLETE still requires a database committed-intent proof");
  });

  test("the server rejects a structurally valid forged digest or non-first sample before denying", async t => {
    const f = await ownedFixture(t), journal = await planCompactWithdrawal(f.operator, target, config, databaseHash);
    for (const change of [{ digest: "e".repeat(64) }, { sample: "a1." + "f".repeat(64) }]) {
      const altered = { ...journal, plan: { ...journal.plan, assetSummary: { ...journal.plan.assetSummary, ...change } } };
      assert.doesNotThrow(() => validateCompactWithdrawalJournal(altered));
      await assert.rejects(executeCompactWithdrawal(altered, config, databaseHash, { db: f.operator, save: async () => {}, fetch: goodFetch }), /NB_CACHE_PLAN_CHANGED/);
    }
    assert.deepEqual((await f.db.query("SELECT (SELECT count(*)::int FROM nb_v2.denied) AS denied,(SELECT count(*)::int FROM nb_cache.events) AS events")).rows, [{ denied: 0, events: 0 }]);
  });

  test("a completed purge ACK followed by failed verification keeps the local verify-pending journal", async t => {
    const f = await ownedFixture(t), journal = await planCompactWithdrawal(f.operator, target, config, databaseHash), saved: CompactWithdrawalJournal[] = [];
    const bad: typeof fetch = (input, init) => String(input).endsWith("/purge") ? goodFetch(input, init) : Promise.resolve(new Response(null, { status: 200 }));
    await assert.rejects(executeCompactWithdrawal(journal, config, databaseHash, { db: f.operator, save: async value => { saved.push(structuredClone(value)); }, fetch: bad }), { message: "WITHDRAW_VERIFY_PENDING" });
    assert.equal(saved.at(-1)!.phase, "PURGED_VERIFY_PENDING");
    assert.equal((await f.db.query<{ status: string }>("SELECT status FROM nb_cache.events WHERE id=$1", [journal.id])).rows[0].status, "complete");
    f.calls.length = 0; let purges = 0;
    const resumed = await executeCompactWithdrawal(saved.at(-1)!, config, databaseHash, { db: f.operator, save: async () => {}, fetch: (input, init) => { if (String(input).endsWith("/purge")) purges++; return goodFetch(input, init); } });
    assert.equal(resumed.phase, "COMPLETE"); assert.equal(purges, 0);
    assert.ok(!f.calls.some(isPlanOrWriteRpc));
  });

  test("both legacy and compact plans larger than 16 KiB resume an already committed intent", async t => {
    for (const version of [1, 2] as const) await t.test(`version ${version}`, async t => {
      const f = await ownedFixture(t);
      await f.db.query("INSERT INTO nb_v2.records(run_id,id,kind,source_key,parent_id,ordinal,item,document) SELECT $1,'child-'||n,'status','status','a',n,jsonb_build_object('id','child-'||n,'href','/status#child-'||n,'kind','status','slug','child-'||n),'{}' FROM generate_series(1,250) n", [f.run]);
      const journal = version === 2 ? await planCompactWithdrawal(f.operator, target, config, databaseHash) : await planWithdrawal(f.operator, target, config, databaseHash);
      assert.ok(Buffer.byteLength(JSON.stringify(journal.plan)) > 16384); assert.throws(() => publicCacheKey(journal.plan));
      await f.operator.query(version === 2 ? "SELECT nb_cache_api.withdraw_compact($1,$2::jsonb)" : "SELECT nb_cache_api.withdraw($1,$2::jsonb)", [journal.id, JSON.stringify(journal.plan)]);
      journal.phase = "DENY_OUTCOME_UNKNOWN"; f.calls.length = 0;
      const ports = { db: f.operator, save: async () => {}, fetch: goodFetch };
      const result = journal.version === 2 ? await executeCompactWithdrawal(journal, config, databaseHash, ports) : await executeWithdrawal(journal, config, databaseHash, ports);
      assert.equal(result.phase, "COMPLETE"); assert.ok(!f.calls.some(isPlanOrWriteRpc));
    });
  });

  test("actual CLI defaults to v1 and opts into v2 while execute/resume dispatch only by a validated journal", async t => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "compact-client-cli-"))); t.after(() => rm(root, { recursive: true, force: true }));
    for (const version of [1, 2]) {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--compact-client-cli-fixture", String(version), join(root, ".local", "journal.json")], {
        env: { PATH: process.env.PATH, NODE_ENV: "test", NOTIONBLOG_DEVELOPMENT_MODE: "offline", NODE_OPTIONS: `--require=${fileURLToPath(new URL("../scripts/development/offline-network.cjs", import.meta.url))}` }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = ""; child.stdout.setEncoding("utf8").on("data", text => { stdout += text; }); child.stderr.setEncoding("utf8").on("data", text => { stderr += text; });
      const timer = setTimeout(() => child.kill("SIGKILL"), 20000);
      const status = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal })); }).finally(() => clearTimeout(timer));
      assert.deepEqual(status, { code: 0, signal: null }, stderr);
      const result = JSON.parse(stdout); assert.equal(result.version, version); assert.equal(result.plannedVersion, version); assert.equal(result.finished, true);
      assert.equal(result.connects, result.closes); assert.equal(result.locks, result.releases); assert.equal(result.localValidationBeforeConnect, true); assert.equal(result.resumeNeverReplans, true);
    }
  });
}
