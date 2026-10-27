import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { rootCertificates } from "node:tls";
import { Client, Pool } from "pg";
import type { Transaction } from "@electric-sql/pglite";
import { ownerInstallFixture } from "./helpers/owner-install.ts";
import { installIncrementalReaderIsolation as isolation } from "../scripts/website-sync/incremental-reader-isolation.ts";
import { installIncrementalWithdrawalRecovery as recovery } from "../scripts/website-sync/incremental-withdrawal-recovery.ts";
import { inOwnerInstallSession, withOwnerInstallTransaction, withPGliteOwnerTransaction, OwnerInstallFailure, type OwnerInstallSession } from "../scripts/website-sync/owner-install-session.ts";
import { loadOwnerInstallRecipe, OWNER_INSTALL_RECIPE_DIGEST } from "../scripts/website-sync/owner-install-recipes.ts";
import isolationManifest from "../database/incremental-reader-isolation.json" with { type: "json" };
import recoveryManifest from "../database/incremental-withdrawal-recovery.json" with { type: "json" };

const code = (text: string) => ({ message: text });
const state = async (db: Awaited<ReturnType<typeof ownerInstallFixture>>["db"]) => (await db.query<{ installed: boolean; role: boolean }>(`SELECT
  EXISTS(SELECT FROM pg_attribute WHERE attrelid='nb_delta.state'::regclass AND attname='reader_isolation_digest' AND NOT attisdropped) AS installed,
  EXISTS(SELECT FROM pg_roles WHERE rolname='nb_delta_reader') AS role`)).rows[0];

test("owner recipes preserve old identities and independently verify the exact execution bodies", async () => {
  for (const [name, manifest] of [["reader-isolation", isolationManifest], ["withdrawal-recovery", recoveryManifest]] as const) {
    const recipe = await loadOwnerInstallRecipe(name), original = await readFile(new URL(`../supabase/migrations/${manifest.migration.file}`, import.meta.url), "utf8");
    assert.equal(createHash("sha256").update(original).digest("hex"), manifest.migration.sha256);
    assert.equal(recipe.schemaDigest, manifest.migration.sha256); assert.equal(recipe.recipeDigest, OWNER_INSTALL_RECIPE_DIGEST);
    assert.notEqual(createHash("sha256").update(recipe.body).digest("hex"), recipe.schemaDigest);
    assert.ok(!recipe.body.startsWith("BEGIN;")); assert.ok(!recipe.body.endsWith("COMMIT;\n"));
    if (name === "reader-isolation") assert.ok(!recipe.body.includes("CREATE ROLE"));
  }
});

test("installers reject a Pool, rotating executor and descriptive session marker before querying", async () => {
  let calls = 0;
  const pool = new Pool();
  try {
    for (const candidate of [pool, { query: async () => { calls++; return { rows: [] }; } }, { kind: "verified-pg-client", active: true }]) {
      await assert.rejects(isolation(candidate as unknown as OwnerInstallSession), code("OWNER_INSTALL_SESSION_REQUIRED"));
      await assert.rejects(recovery(candidate as unknown as OwnerInstallSession), code("OWNER_INSTALL_SESSION_REQUIRED"));
    }
    assert.equal(calls, 0);
  } finally { await pool.end(); }
});

test("PGlite test entry requires offline mode and sessions expire after the real transaction", async t => {
  const f = await ownerInstallFixture(); t.after(() => f.close());
  const previous = process.env.NOTIONBLOG_DEVELOPMENT_MODE;
  try { delete process.env.NOTIONBLOG_DEVELOPMENT_MODE; await assert.rejects(withPGliteOwnerTransaction(f.db, isolation), code("OWNER_INSTALL_OFFLINE_REQUIRED")); }
  finally { process.env.NOTIONBLOG_DEVELOPMENT_MODE = previous; }
  await assert.rejects(withPGliteOwnerTransaction({ transaction: async () => {} } as never, isolation), code("OWNER_INSTALL_TEST_DATABASE"));
  let expired!: OwnerInstallSession;
  await withPGliteOwnerTransaction(f.db, async session => { expired = session; assert.equal(session.kind, "pglite-test"); });
  await assert.rejects(isolation(expired), code("OWNER_INSTALL_SESSION_REQUIRED"));
  assert.deepEqual(await state(f.db), { installed: false, role: false });
});

test("transaction-control and arbitrary scripts cannot escape the registered session", async t => {
  const f = await ownerInstallFixture(); t.after(() => f.close());
  for (const mode of ["query", "script"] as const) {
    await assert.rejects(withPGliteOwnerTransaction(f.db, session => inOwnerInstallSession(session, async (db, script) => {
      if (mode === "query") await db.query("COMMIT"); else await script("COMMIT; CREATE TABLE public.escape(value integer)");
    })), code(mode === "query" ? "OWNER_INSTALL_QUERY_DENIED" : "OWNER_INSTALL_SCRIPT_DENIED"));
  }
  assert.deepEqual(await state(f.db), { installed: false, role: false });
  assert.equal((await f.db.query<{ name: string | null }>("SELECT to_regclass('public.escape') AS name")).rows[0].name, null);
});

test("an actual early-ended transaction cannot run installation DDL", async t => {
  const f = await ownerInstallFixture(); t.after(() => f.close());
  const transaction = f.db.transaction.bind(f.db); let actual!: Transaction;
  t.mock.method(f.db, "transaction", async (work: Parameters<typeof f.db.transaction>[0]) => transaction(async tx => { actual = tx; return work(tx); }));
  await assert.rejects(withPGliteOwnerTransaction(f.db, async session => {
    await actual.exec("COMMIT");
    await isolation(session);
  }), code("OWNER_INSTALL_TRANSACTION_ENDED"));
  assert.deepEqual(await state(f.db), { installed: false, role: false });
});

test("caught installer failures still prevent the surrounding transaction from committing", async t => {
  const f = await ownerInstallFixture(); t.after(() => f.close());
  await assert.rejects(withPGliteOwnerTransaction(f.db, async session => {
    await inOwnerInstallSession(session, async db => { await db.query("COMMIT"); }).catch(() => {});
  }), code("OWNER_INSTALL_TRANSACTION_FAILED"));
  assert.deepEqual(await state(f.db), { installed: false, role: false });
});

test("both extension orders are atomic, repeatable and preserve existing LOGIN members", async t => {
  for (const order of [[isolation, recovery], [recovery, isolation]]) await t.test(order[0] === isolation ? "isolation first" : "recovery first", async t => {
    const f = await ownerInstallFixture(); t.after(() => f.close());
    await f.db.exec("CREATE ROLE nb_delta_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; CREATE ROLE fixture_existing_login LOGIN; GRANT nb_delta_reader TO fixture_existing_login");
    const members = (await f.db.query("SELECT roleid,member,grantor,admin_option FROM pg_auth_members ORDER BY roleid,member")).rows;
    const installed = await withPGliteOwnerTransaction(f.db, async session => [await order[0](session), await order[1](session)]);
    assert.deepEqual(installed.map(r => r.outcome), ["installed", "installed"]);
    const repeated = await withPGliteOwnerTransaction(f.db, async session => [await order[0](session), await order[1](session)]);
    assert.deepEqual(repeated.map(r => r.outcome), ["verified-existing", "verified-existing"]);
    assert.ok(repeated.every(r => r.recipeDigest === OWNER_INSTALL_RECIPE_DIGEST));
    assert.deepEqual((await f.db.query("SELECT roleid,member,grantor,admin_option FROM pg_auth_members ORDER BY roleid,member")).rows, members);
  });
});

test("partial or mismatched legacy installs reject without filling a digest or repairing grants", async t => {
  for (const [installer, manifest, column] of [[isolation, isolationManifest, "reader_isolation_digest"], [recovery, recoveryManifest, "withdrawal_recovery_digest"]] as const) await t.test(column, async t => {
    const f = await ownerInstallFixture(); t.after(() => f.close());
    await f.db.exec(await readFile(new URL(`../supabase/migrations/${manifest.migration.file}`, import.meta.url), "utf8"));
    for (const digest of [null, "f".repeat(64)]) {
      await f.db.query(`UPDATE nb_delta.state SET ${column}=$1`, [digest]);
      await assert.rejects(withPGliteOwnerTransaction(f.db, installer), /OWNER_INSTALL_(READER|RECOVERY)_DIFFERENT/);
      assert.equal((await f.db.query<{ digest: string | null }>(`SELECT ${column} AS digest FROM nb_delta.state`)).rows[0].digest, digest);
    }
  });
});

test("a core isolation grant without the digest column is rejected as a partial target install", async t => {
  const f = await ownerInstallFixture(); t.after(() => f.close());
  await f.db.exec("CREATE ROLE nb_delta_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; GRANT EXECUTE ON FUNCTION nb_delta_api.check_reader(text) TO nb_delta_reader");
  await assert.rejects(withPGliteOwnerTransaction(f.db, isolation), code("OWNER_INSTALL_READER_PARTIAL"));
  assert.equal((await state(f.db)).installed, false);
});

test("inaccessible PUBLIC view grants do not conflict, while usable or direct access still does", async t => {
  const f = await ownerInstallFixture(); t.after(() => f.close());
  await f.db.exec("CREATE SCHEMA fixture_catalog; REVOKE ALL ON SCHEMA fixture_catalog FROM PUBLIC; CREATE VIEW fixture_catalog.stats AS SELECT 1 AS value; GRANT SELECT ON fixture_catalog.stats TO PUBLIC");
  await withPGliteOwnerTransaction(f.db, isolation);
  await assert.rejects(f.db.transaction(async tx => {
    await tx.exec("SET LOCAL ROLE nb_delta_reader");
    await tx.query("SELECT * FROM fixture_catalog.stats");
  }), /permission denied/);
  for (const [grant, revoke] of [
    ["GRANT USAGE ON SCHEMA fixture_catalog TO PUBLIC", "REVOKE USAGE ON SCHEMA fixture_catalog FROM PUBLIC"],
    ["GRANT SELECT ON fixture_catalog.stats TO nb_delta_reader", "REVOKE SELECT ON fixture_catalog.stats FROM nb_delta_reader"],
    ["GRANT SELECT(value) ON fixture_catalog.stats TO nb_delta_reader", "REVOKE SELECT(value) ON fixture_catalog.stats FROM nb_delta_reader"],
  ]) {
    await f.db.exec(grant);
    try { await assert.rejects(withPGliteOwnerTransaction(f.db, isolation), code("OWNER_INSTALL_READER_ROLE_CONFLICT")); }
    finally { await f.db.exec(revoke); }
  }
  await withPGliteOwnerTransaction(f.db, isolation);
});

test("verified installs reject missing schema/API capability or reopened private APIs without repairing", async t => {
  const f = await ownerInstallFixture(); t.after(() => f.close());
  await withPGliteOwnerTransaction(f.db, async session => { await isolation(session); await recovery(session); });
  for (const [installer, grant, undo, expected] of [
    [isolation, "REVOKE USAGE ON SCHEMA nb_delta_api FROM nb_delta_reader", "GRANT USAGE ON SCHEMA nb_delta_api TO nb_delta_reader", "OWNER_INSTALL_READER_CAPABILITY"],
    [isolation, "REVOKE EXECUTE ON FUNCTION nb_delta_api.check_withdrawal_recovery(text) FROM nb_delta_reader", "GRANT EXECUTE ON FUNCTION nb_delta_api.check_withdrawal_recovery(text) TO nb_delta_reader", "OWNER_INSTALL_READER_CAPABILITY"],
    [isolation, "GRANT EXECUTE ON FUNCTION nb_delta_api.read_page(text,text,text) TO nb_writer", "REVOKE EXECUTE ON FUNCTION nb_delta_api.read_page(text,text,text) FROM nb_writer", "OWNER_INSTALL_READER_CAPABILITY"],
    [recovery, "REVOKE EXECUTE ON FUNCTION nb_delta_api.check_withdrawal_recovery(text) FROM nb_writer", "GRANT EXECUTE ON FUNCTION nb_delta_api.check_withdrawal_recovery(text) TO nb_writer", "OWNER_INSTALL_RECOVERY_CAPABILITY"],
    [recovery, "GRANT EXECUTE ON FUNCTION nb_delta_api.check_withdrawal_recovery(text) TO PUBLIC", "REVOKE EXECUTE ON FUNCTION nb_delta_api.check_withdrawal_recovery(text) FROM PUBLIC", "OWNER_INSTALL_RECOVERY_CAPABILITY"],
  ] as const) {
    await f.db.exec(grant); await assert.rejects(withPGliteOwnerTransaction(f.db, installer), code(expected)); await f.db.exec(undo);
  }
});

test("existing group rejects dangerous attributes, inheritance, extra data, functions, ownership and future grants", async t => {
  const f = await ownerInstallFixture(); t.after(() => f.close());
  await f.db.exec("CREATE ROLE nb_delta_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; CREATE ROLE fixture_parent; CREATE SCHEMA fixture_private; REVOKE ALL ON SCHEMA fixture_private FROM PUBLIC; CREATE TABLE fixture_private.secret(value integer); CREATE SEQUENCE fixture_private.serial; CREATE FUNCTION fixture_private.extra() RETURNS integer LANGUAGE sql AS 'SELECT 1'; REVOKE ALL ON FUNCTION fixture_private.extra() FROM PUBLIC");
  for (const [name, grant, undo] of [
    ["LOGIN", "ALTER ROLE nb_delta_reader LOGIN", "ALTER ROLE nb_delta_reader NOLOGIN"],
    ["parent membership", "GRANT fixture_parent TO nb_delta_reader", "REVOKE fixture_parent FROM nb_delta_reader"],
    ["private table", "GRANT SELECT ON fixture_private.secret TO nb_delta_reader", "REVOKE SELECT ON fixture_private.secret FROM nb_delta_reader"],
    ["private column", "GRANT SELECT(value) ON fixture_private.secret TO nb_delta_reader", "REVOKE SELECT(value) ON fixture_private.secret FROM nb_delta_reader"],
    ["private sequence", "GRANT USAGE ON SEQUENCE fixture_private.serial TO nb_delta_reader", "REVOKE USAGE ON SEQUENCE fixture_private.serial FROM nb_delta_reader"],
    ["extra function without schema access", "GRANT EXECUTE ON FUNCTION fixture_private.extra() TO nb_delta_reader", "REVOKE EXECUTE ON FUNCTION fixture_private.extra() FROM nb_delta_reader"],
    ["object ownership", "ALTER TABLE fixture_private.secret OWNER TO nb_delta_reader", "ALTER TABLE fixture_private.secret OWNER TO postgres"],
    ["future grants", "ALTER DEFAULT PRIVILEGES IN SCHEMA fixture_private GRANT SELECT ON TABLES TO nb_delta_reader", "ALTER DEFAULT PRIVILEGES IN SCHEMA fixture_private REVOKE SELECT ON TABLES FROM nb_delta_reader"],
  ]) await t.test(name, async () => {
    await f.db.exec(grant);
    await assert.rejects(withPGliteOwnerTransaction(f.db, isolation), code("OWNER_INSTALL_READER_ROLE_CONFLICT"));
    assert.equal((await state(f.db)).installed, false);
    await f.db.exec(undo);
  });
  await withPGliteOwnerTransaction(f.db, isolation);
});

test("DDL, digest and final capability failures roll back the actual PGlite transaction", async t => {
  for (const stage of ["ddl", "digest", "final"] as const) await t.test(stage, async t => {
    const f = await ownerInstallFixture(); t.after(() => f.close());
    const transaction = f.db.transaction.bind(f.db), first = Error(`fixture-${stage}`);
    t.mock.method(f.db, "transaction", async (work: Parameters<typeof f.db.transaction>[0]) => transaction(async tx => {
      const exec = tx.exec.bind(tx), query = tx.query.bind(tx);
      tx.exec = (async (sql: string) => { if (stage === "ddl" && sql.includes("ALTER TABLE nb_delta.state ADD COLUMN reader_isolation_digest")) throw first; return exec(sql); }) as typeof tx.exec;
      tx.query = (async (sql: string, values?: unknown[]) => {
        if (stage === "digest" && sql.startsWith("UPDATE nb_delta.state SET reader_isolation_digest") || stage === "final" && sql.startsWith("SELECT EXISTS(SELECT FROM pg_catalog.pg_roles")) throw first;
        return query(sql, values);
      }) as typeof tx.query;
      return work(tx);
    }));
    await assert.rejects(withPGliteOwnerTransaction(f.db, isolation), error => error === first);
    assert.deepEqual(await state(f.db), { installed: false, role: false });
  });
});

const credentials = { url: ["postgresql:", "//owner:", "fixture-password", "@db.example.test/install"].join(""), ca: rootCertificates[0] };
function fakeClient(t: TestContext, fault?: "commit" | "ack" | "cleanup" | "close" | "close-event") {
  const calls: string[] = [], clients = new Set<Client>(), first = Error("fixture-first"), cleanup = Error("fixture-cleanup");
  t.mock.method(Client.prototype, "connect", async function (this: Client) {
    clients.add(this);
    Object.assign(this.connection.stream, { encrypted: true, authorized: true, getPeerCertificate: () => ({ subjectaltname: "DNS:db.example.test" }) });
  });
  t.mock.method(Client.prototype, "query", async function (this: Client, sql: string) {
    assert.ok(clients.has(this)); calls.push(sql);
    if (sql === "COMMIT" && fault === "commit") throw first;
    if (sql === "ROLLBACK" && fault === "cleanup") throw cleanup;
    return { rows: sql.includes("pg_backend_pid") ? [{ pid: 71, xid: "91" }] : [], command: sql === "COMMIT" && fault === "ack" ? "ROLLBACK" : sql.split(" ")[0], rowCount: 0 };
  });
  t.mock.method(Client.prototype, "end", async function (this: Client) { assert.ok(clients.has(this)); calls.push("END"); if (fault === "cleanup") throw cleanup; if (fault === "close") throw first; if (fault === "close-event") this.emit("error", first); });
  return { calls, clients, first };
}

test("production validates narrow TLS configuration before creating any connection", async t => {
  let connections = 0;
  t.mock.method(Client.prototype, "connect", async () => { connections++; });
  for (const input of [{ ...credentials, url: credentials.url + "?sslmode=disable" }, { ...credentials, url: credentials.url + "#options" }, { ...credentials, ca: "bad certificate" }, { ...credentials, ssl: false }]) {
    await assert.rejects(withOwnerInstallTransaction(input, async () => {}), code("OWNER_INSTALL_CONFIG"));
  }
  assert.equal(connections, 0);
});

test("production owns one actual Client and commits only after an explicit COMMIT acknowledgement", async t => {
  const f = fakeClient(t);
  let expired!: OwnerInstallSession;
  assert.equal(await withOwnerInstallTransaction(credentials, async session => { expired = session; assert.equal(session.kind, "verified-pg-client"); return 17; }), 17);
  assert.equal(f.clients.size, 1); assert.equal(f.calls.filter(s => s === "BEGIN").length, 1); assert.equal(f.calls.filter(s => s === "COMMIT").length, 1);
  assert.equal(f.calls.at(-1), "END");
  await assert.rejects(isolation(expired), code("OWNER_INSTALL_SESSION_REQUIRED"));
});

test("unknown commit, wrong acknowledgement and close failure never report success or retry", async t => {
  for (const mode of ["commit", "ack", "close", "close-event"] as const) await t.test(mode, async t => {
    const f = fakeClient(t, mode);
    await assert.rejects(withOwnerInstallTransaction(credentials, async () => 17), error => error instanceof OwnerInstallFailure && error.outcome === (mode.startsWith("close") ? "committed-cleanup-failed" : "commit-unknown") && (mode === "ack" ? error.message === "OWNER_INSTALL_COMMIT_UNKNOWN" : error.cause === f.first));
    assert.equal(f.clients.size, 1); assert.equal(f.calls.filter(s => s === "COMMIT").length, 1); assert.equal(f.calls.filter(s => s === "END").length, 1);
    assert.equal(f.calls.filter(s => s === "ROLLBACK").length, mode.startsWith("close") ? 0 : 1);
    assert.ok([...f.clients].every(client => client.connection.stream.closed));
  });
});

test("rollback and close failures preserve the first installation error", async t => {
  const f = fakeClient(t, "cleanup"), first = Error("fixture-install");
  await assert.rejects(withOwnerInstallTransaction(credentials, async () => { throw first; }), error => error instanceof OwnerInstallFailure && error.outcome === "not-committed" && error.cause === first);
  assert.equal(f.calls.filter(s => s === "ROLLBACK").length, 1); assert.equal(f.calls.filter(s => s === "END").length, 1); assert.ok(!f.calls.includes("COMMIT"));
});

test("a falsy rejection remains the first failure even when rollback and close also fail", async t => {
  const f = fakeClient(t, "cleanup");
  await assert.rejects(withOwnerInstallTransaction(credentials, async () => { throw undefined; }), error => error instanceof OwnerInstallFailure && error.outcome === "not-committed" && Object.hasOwn(error, "cause") && error.cause === undefined);
  assert.ok(!f.calls.includes("COMMIT")); assert.equal(f.calls.filter(s => s === "ROLLBACK").length, 1); assert.equal(f.calls.filter(s => s === "END").length, 1);
});
