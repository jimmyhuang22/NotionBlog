import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { rootCertificates } from "node:tls";
import { Client, Pool } from "pg";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import cacheProtocol from "../database/public-cache-protocol.json" with { type: "json" };
import { installCompactWithdrawal, withCompactWithdrawalInstallTransaction, withPGliteCompactWithdrawalInstallTransaction,
  type CompactWithdrawalInstallSession } from "../scripts/public-cache/compact-withdrawal-install.ts";
import { verifyCompactWithdrawalCapability } from "../scripts/public-cache/compact-withdrawal-capability.ts";
import { loadCompactWithdrawalProtocol, loadCompactWithdrawalRecipe, COMPACT_WITHDRAWAL_PROTOCOL_SHA256 } from "../scripts/public-cache/compact-withdrawal-protocol.ts";
import { withPGliteOwnerTransaction, OwnerInstallFailure, type OwnerInstallSession } from "../scripts/website-sync/owner-install-session.ts";
import { installIncrementalReaderIsolation } from "../scripts/website-sync/incremental-reader-isolation.ts";

const code = (expected: string) => (error: unknown) => error instanceof Error && error.message === expected;
const hash = (source: string) => createHash("sha256").update(source).digest("hex");
async function fixture(t: TestContext) {
  const db = await PGlite.create(); t.after(() => db.close());
  await db.exec(await readFile(new URL("../database/website-migrations/001_website.sql", import.meta.url), "utf8"));
  const original = await readFile(new URL("../" + cacheProtocol.migration.file, import.meta.url), "utf8");
  assert.equal(hash(original), cacheProtocol.migration.sha256);
  await db.exec(original);
  await db.exec("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role");
  return db;
}
const installed = async (db: PGlite) => (await db.query<{ count: number }>(`SELECT count(*)::integer AS count FROM pg_proc p
  JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='nb_cache_api' AND p.proname IN ('plan_withdraw_compact','withdraw_compact')`)).rows[0].count;

test("the independent recipe pins the complete migration and its unique transaction body", async () => {
  const protocol = await loadCompactWithdrawalProtocol(), recipe = await loadCompactWithdrawalRecipe();
  const source = await readFile(new URL(`../supabase/migrations/${protocol.migration.file}`, import.meta.url), "utf8");
  assert.equal(hash(source), protocol.migration.sha256);
  assert.equal(source.split(protocol.recipe.prefix).length, 2); assert.equal(source.split(protocol.recipe.suffix).length, 2);
  assert.equal(hash(recipe.body), protocol.recipe.bodySha256); assert.notEqual(recipe.recipeSha256, recipe.migrationSha256);
  assert.equal(hash(await readFile(new URL("../database/compact-withdrawal-protocol.json", import.meta.url), "utf8")), COMPACT_WITHDRAWAL_PROTOCOL_SHA256);
});

test("installation and exact repeat verification use a real transaction without altering old functions or members", async t => {
  const db = await fixture(t);
  const old = async () => (await db.query("SELECT oid::regprocedure::text AS signature,prosrc,proacl::text FROM pg_proc WHERE pronamespace='nb_cache_api'::regnamespace AND proname NOT IN ('plan_withdraw_compact','withdraw_compact') ORDER BY oid")).rows;
  const members = async () => (await db.query("SELECT roleid,member,grantor,admin_option FROM pg_auth_members ORDER BY roleid,member")).rows;
  const before = await old(), oldMembers = await members();
  await assert.rejects(verifyCompactWithdrawalCapability(db), code("COMPACT_WITHDRAWAL_UNAVAILABLE"));
  const first = await withPGliteCompactWithdrawalInstallTransaction(db, installCompactWithdrawal);
  assert.equal(first.outcome, "installed"); assert.equal(first.manifestSha256, COMPACT_WITHDRAWAL_PROTOCOL_SHA256);
  const again = await withPGliteCompactWithdrawalInstallTransaction(db, installCompactWithdrawal);
  assert.equal(again.outcome, "verified-existing");
  await db.transaction(async tx => { await tx.exec("SET LOCAL ROLE nb_cache_operator"); await verifyCompactWithdrawalCapability(tx); });
  assert.deepEqual(await old(), before); assert.deepEqual(await members(), oldMembers);
});

test("Pool, rotating executor, forged, expired and N08-purpose sessions never become compact installers", async t => {
  let calls = 0; const pool = new Pool();
  try {
    for (const candidate of [pool, { query: async () => { calls++; return { rows: [] }; } }, { purpose: "compact-withdrawal-v1", kind: "verified-pg-client" }]) {
      await assert.rejects(installCompactWithdrawal(candidate as never), code("COMPACT_WITHDRAWAL_SESSION_REQUIRED"));
    }
    assert.equal(calls, 0);
  } finally { await pool.end(); }
  const db = await fixture(t); let expired!: CompactWithdrawalInstallSession;
  await withPGliteCompactWithdrawalInstallTransaction(db, async session => { expired = session; });
  await assert.rejects(installCompactWithdrawal(expired), code("COMPACT_WITHDRAWAL_SESSION_REQUIRED"));
  await assert.rejects(withPGliteOwnerTransaction(db, session => installCompactWithdrawal(session as unknown as CompactWithdrawalInstallSession)), code("COMPACT_WITHDRAWAL_SESSION_REQUIRED"));
  await assert.rejects(withPGliteCompactWithdrawalInstallTransaction(db, session => installIncrementalReaderIsolation(session as unknown as OwnerInstallSession)), code("OWNER_INSTALL_SESSION_REQUIRED"));
  assert.equal(await installed(db), 0);
});

test("the PGlite adapter requires offline mode and an actual engine", async t => {
  const db = await fixture(t), previous = process.env.NOTIONBLOG_DEVELOPMENT_MODE;
  try { delete process.env.NOTIONBLOG_DEVELOPMENT_MODE; await assert.rejects(withPGliteCompactWithdrawalInstallTransaction(db, installCompactWithdrawal), code("OWNER_INSTALL_OFFLINE_REQUIRED")); }
  finally { process.env.NOTIONBLOG_DEVELOPMENT_MODE = previous; }
  await assert.rejects(withPGliteCompactWithdrawalInstallTransaction({ transaction: async () => {} } as never, installCompactWithdrawal), code("OWNER_INSTALL_TEST_DATABASE"));
});

test("partial, altered and same-name overload installations are conflicts rather than repair opportunities", async t => {
  const db = await fixture(t), recipe = await loadCompactWithdrawalRecipe();
  const reset = async () => { await db.exec("DROP FUNCTION IF EXISTS nb_cache_api.plan_withdraw_compact(text); DROP FUNCTION IF EXISTS nb_cache_api.withdraw_compact(uuid,jsonb)"); await db.exec(recipe.body); };
  await reset(); await db.exec("DROP FUNCTION nb_cache_api.withdraw_compact(uuid,jsonb)");
  await assert.rejects(withPGliteCompactWithdrawalInstallTransaction(db, installCompactWithdrawal), code("COMPACT_WITHDRAWAL_INSTALL_CONFLICT"));
  assert.equal(await installed(db), 1);
  for (const mutate of [
    "CREATE OR REPLACE FUNCTION nb_cache_api.plan_withdraw_compact(p_id text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN RETURN NULL; END $$",
    "ALTER FUNCTION nb_cache_api.plan_withdraw_compact(text) SET search_path=public",
    "ALTER FUNCTION nb_cache_api.plan_withdraw_compact(text) OWNER TO nb_reader",
    "GRANT EXECUTE ON FUNCTION nb_cache_api.withdraw_compact(uuid,jsonb) TO PUBLIC",
    "GRANT EXECUTE ON FUNCTION nb_cache_api.withdraw_compact(uuid,jsonb) TO anon",
    "GRANT EXECUTE ON FUNCTION nb_cache_api.withdraw_compact(uuid,jsonb) TO nb_cache_operator WITH GRANT OPTION",
  ]) {
    await reset(); await db.exec(mutate);
    await assert.rejects(verifyCompactWithdrawalCapability(db), code("COMPACT_WITHDRAWAL_UNAVAILABLE"));
    await assert.rejects(withPGliteCompactWithdrawalInstallTransaction(db, installCompactWithdrawal), code("COMPACT_WITHDRAWAL_INSTALL_CONFLICT"));
  }
  await reset(); await db.exec("CREATE FUNCTION nb_cache_api.plan_withdraw_compact(integer) RETURNS jsonb LANGUAGE sql AS 'SELECT NULL::jsonb'");
  await assert.rejects(withPGliteCompactWithdrawalInstallTransaction(db, installCompactWithdrawal), code("COMPACT_WITHDRAWAL_INSTALL_CONFLICT"));
  assert.equal(await installed(db), 3);
});

test("DDL and final verification failures roll back; catching installer rejection cannot commit", async t => {
  const db = await fixture(t), transaction = db.transaction.bind(db), first = Error("COMPACT_FIXTURE_FAILURE");
  for (const stage of ["ddl", "verify"] as const) {
    const mock = t.mock.method(db, "transaction", async (work: Parameters<typeof db.transaction>[0]) => transaction(async tx => {
      const exec = tx.exec.bind(tx), query = tx.query.bind(tx); let catalogs = 0;
      tx.exec = (async (sql: string) => { const result = await exec(sql); if (stage === "ddl" && sql.includes("CREATE FUNCTION nb_cache_api.plan_withdraw_compact")) throw first; return result; }) as typeof tx.exec;
      tx.query = (async (sql: string, values?: unknown[]) => { const result = await query(sql, values); if (sql.startsWith("WITH expected") && ++catalogs === 2 && stage === "verify") throw first; return result; }) as typeof tx.query;
      return work(tx);
    }));
    await assert.rejects(withPGliteCompactWithdrawalInstallTransaction(db, installCompactWithdrawal), error => error === first);
    mock.mock.restore(); assert.equal(await installed(db), 0);
  }
  await db.exec("CREATE FUNCTION nb_cache_api.plan_withdraw_compact(text) RETURNS jsonb LANGUAGE sql AS 'SELECT NULL::jsonb'");
  await assert.rejects(withPGliteCompactWithdrawalInstallTransaction(db, async session => { await installCompactWithdrawal(session).catch(() => {}); }), code("OWNER_INSTALL_TRANSACTION_FAILED"));
  assert.equal(await installed(db), 1);
});

test("an actual prematurely ended transaction cannot perform compact DDL", async t => {
  const db = await fixture(t), transaction = db.transaction.bind(db); let actual!: Transaction;
  t.mock.method(db, "transaction", async (work: Parameters<typeof db.transaction>[0]) => transaction(async tx => { actual = tx; return work(tx); }));
  await assert.rejects(withPGliteCompactWithdrawalInstallTransaction(db, async session => { await actual.exec("COMMIT"); await installCompactWithdrawal(session); }), code("OWNER_INSTALL_TRANSACTION_ENDED"));
  assert.equal(await installed(db), 0);
});

test("the frozen dependency closure rejects changed bodies and permissions before DDL, after DDL and at runtime", async t => {
  const db = await fixture(t), protocol = await loadCompactWithdrawalProtocol();
  const website = await readFile(new URL("../database/website-migrations/001_website.sql", import.meta.url), "utf8");
  const source = website.match(/CREATE FUNCTION nb_v2_api\.set_denied\([\s\S]*?\$\$;/)![0];
  const restoreDenied = source.replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION");
  const noop = "CREATE OR REPLACE FUNCTION nb_v2_api.set_denied(p_id text,p_denied boolean) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,nb_v2,pg_temp AS $$ BEGIN RETURN; END $$";
  const counts = async () => (await db.query("SELECT (SELECT count(*)::integer FROM nb_v2.denied) AS denied,(SELECT count(*)::integer FROM nb_cache.events) AS events,(SELECT generation::text FROM nb_cache.state) AS generation")).rows;
  const before = await counts();
  await db.exec(noop);
  await assert.rejects(withPGliteCompactWithdrawalInstallTransaction(db, installCompactWithdrawal), code("COMPACT_WITHDRAWAL_INSTALL_CONFLICT"));
  assert.equal(await installed(db), 0); assert.deepEqual(await counts(), before);
  await db.exec(restoreDenied);
  const transaction = db.transaction.bind(db);
  const mock = t.mock.method(db, "transaction", async (work: Parameters<typeof db.transaction>[0]) => transaction(async tx => {
    const exec = tx.exec.bind(tx);
    tx.exec = (async (sql: string) => { const value = await exec(sql); if (sql.includes("CREATE FUNCTION nb_cache_api.plan_withdraw_compact")) await exec(noop); return value; }) as typeof tx.exec;
    return work(tx);
  }));
  await assert.rejects(withPGliteCompactWithdrawalInstallTransaction(db, installCompactWithdrawal), code("COMPACT_WITHDRAWAL_INSTALL_VERIFY"));
  mock.mock.restore(); assert.equal(await installed(db), 0); assert.deepEqual(await counts(), before);
  const actual = (await db.query<{ source: string }>("SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') AS source FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='nb_v2_api' AND p.proname='set_denied'")).rows[0].source;
  assert.equal(actual, protocol.dependencies.find(fn => fn.signature === "nb_v2_api.set_denied(text,boolean)")!.sourceSha256);
  await withPGliteCompactWithdrawalInstallTransaction(db, installCompactWithdrawal);
  await db.exec("CREATE OR REPLACE FUNCTION nb_cache_api.read_withdraw(p_event uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT NULL::jsonb $$");
  await assert.rejects(verifyCompactWithdrawalCapability(db), code("COMPACT_WITHDRAWAL_UNAVAILABLE"));
  await assert.rejects(withPGliteCompactWithdrawalInstallTransaction(db, installCompactWithdrawal), code("COMPACT_WITHDRAWAL_INSTALL_CONFLICT"));
  assert.deepEqual(await counts(), before);
  const cache = await readFile(new URL("../" + cacheProtocol.migration.file, import.meta.url), "utf8");
  await db.exec(cache.match(/CREATE FUNCTION nb_cache_api\.read_withdraw\([\s\S]*?\$\$;/)![0].replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION"));
  await db.exec("GRANT EXECUTE ON FUNCTION nb_cache_api.read_withdraw(uuid) TO nb_reader");
  await assert.rejects(verifyCompactWithdrawalCapability(db), code("COMPACT_WITHDRAWAL_UNAVAILABLE"));
  await assert.rejects(withPGliteCompactWithdrawalInstallTransaction(db, installCompactWithdrawal), code("COMPACT_WITHDRAWAL_INSTALL_CONFLICT"));
  assert.deepEqual(await counts(), before);
});

const credentials = { url: ["postgresql:", "//owner:placeholder@db.example.test/fixture"].join(""), ca: rootCertificates[0] };
function fakeClient(t: TestContext, mode: "success" | "commit" | "ack" | "close" | "cleanup") {
  const clients = new Set<Client>(), calls: string[] = [], first = Error("COMPACT_TRANSPORT_FIRST"), cleanup = Error("COMPACT_TRANSPORT_CLEANUP");
  t.mock.method(Client.prototype, "connect", async function (this: Client) { clients.add(this); Object.assign(this.connection.stream, { encrypted: true, authorized: true, getPeerCertificate: () => ({ subjectaltname: "DNS:db.example.test" }) }); });
  t.mock.method(Client.prototype, "query", async function (this: Client, sql: string) {
    assert.ok(clients.has(this)); calls.push(sql);
    if (sql === "COMMIT" && mode === "commit") throw first;
    if (sql === "ROLLBACK" && mode === "cleanup") throw cleanup;
    return { rows: sql.includes("pg_backend_pid") ? [{ pid: 13, xid: "21" }] : [], command: sql === "COMMIT" && mode === "ack" ? "ROLLBACK" : sql.split(" ")[0] };
  });
  t.mock.method(Client.prototype, "end", async function (this: Client) { assert.ok(clients.has(this)); calls.push("END"); if (mode === "close") throw first; if (mode === "cleanup") throw cleanup; });
  return { clients, calls, first };
}

test("the compact production factory owns one Client, keeps TLS strict and preserves uncertain commit outcomes", async t => {
  let connects = 0;
  const invalid = t.mock.method(Client.prototype, "connect", async () => { connects++; });
  await assert.rejects(withCompactWithdrawalInstallTransaction({ ...credentials, url: credentials.url + "?sslmode=disable" }, async () => {}), code("OWNER_INSTALL_CONFIG"));
  assert.equal(connects, 0); invalid.mock.restore();
  for (const mode of ["success", "commit", "ack", "close", "cleanup"] as const) await t.test(mode, async t => {
    const fake = fakeClient(t, mode);
    const run = () => withCompactWithdrawalInstallTransaction(credentials, async () => { if (mode === "cleanup") throw undefined; return 11; });
    if (mode === "success") assert.equal(await run(), 11);
    else await assert.rejects(run(), error => error instanceof OwnerInstallFailure && error.outcome === (mode === "close" ? "committed-cleanup-failed" : mode === "cleanup" ? "not-committed" : "commit-unknown") &&
      (mode === "cleanup" ? error.cause === undefined : mode === "ack" ? error.code === "OWNER_INSTALL_COMMIT_UNKNOWN" : error.cause === fake.first));
    assert.equal(fake.clients.size, 1); assert.equal(fake.calls.filter(value => value === "BEGIN").length, 1);
    assert.equal(fake.calls.filter(value => value === "COMMIT").length, mode === "cleanup" ? 0 : 1); assert.equal(fake.calls.at(-1), "END");
  });
});
