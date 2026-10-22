import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { checkReader, READER_PERMISSIONS_SQL } from "../scripts/check-reader.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";
import { SYNC_SCHEMA_DIGEST } from "../contracts/sync.ts";
import readerProtocol from "../database/reader-protocol.json" with { type: "json" };

const now = 2_000_000_000_000;
const userId = "11111111-1111-4111-8111-111111111111";
const storageUrl = "https://storage.example.invalid/storage/v1";
const claims = { iss: "https://storage.example.invalid/auth/v1", aud: "authenticated", sub: userId,
  role: "authenticated", app_metadata: { notionblog_storage_role: "reader" }, exp: now / 1000 + 3600 };
function token(overrides: Record<string, unknown> = {}, alg = "HS256"): string {
  return [JSON.stringify({ alg }), JSON.stringify({ ...claims, ...overrides }), "fictional-signature"]
    .map(value => Buffer.from(value).toString("base64url")).join(".");
}
function env(): NodeJS.ProcessEnv {
  return { NODE_ENV: "test", DATABASE_READER_URL: "postgresql://fixture_reader:fixture-password@db.example.invalid/example",
    DATABASE_TLS: "verify", STORAGE_URL: storageUrl, STORAGE_BUCKET: "fixture_media",
    STORAGE_API_KEY: "sb_publishable_fixture_key", STORAGE_READ_TOKEN: token() };
}
const safe = { safe_login: true, reader_only: true, create_denied: true, private_tables_denied: true, read_allowed: true, write_denied: true };
const authFetch: typeof fetch = async () => Response.json({ id: userId, role: "authenticated",
  app_metadata: { notionblog_storage_role: "reader" } });
function fakeDatabase(content: "ready" | "unavailable" = "ready", permissions = safe) {
  let closed = 0;
  const queries: string[] = [];
  const db: SqlExecutor = { async query<T>(sql: string) {
    queries.push(sql);
    if (sql === READER_PERMISSIONS_SQL) return { rows: [permissions] as T[] };
    if (content === "unavailable") throw new Error("NB_SNAPSHOT_UNAVAILABLE");
    return { rows: [{ result: { years: [], undatedCount: 0, timeZone: "UTC",
      schemaDigest: SYNC_SCHEMA_DIGEST, readerCapability: readerProtocol.capability } }] as T[] };
  } };
  return { db, queries, get closed() { return closed; }, close: async () => { closed++; } };
}

test("reader configuration check makes no SQL, Auth or media requests", async () => {
  const report = await checkReader(env(), "config-only", { now: () => now,
    openDatabase: () => { throw new Error("Unexpected database request"); },
    fetch: async () => { throw new Error("Unexpected network request"); } });
  assert.equal(report.ok, true);
  assert.equal(report.content, "not-checked");
  assert.equal(report.media, "pending");
  assert.equal(report.checks.find(check => check.name === "database_permissions")?.status, "pending");
  assert.equal(report.checks.find(check => check.name === "reader_auth_server_validation")?.status, "pending");
});

test("reader configuration rejects partial renewal credentials even with a valid static token", async () => {
  const configured = env(); configured.STORAGE_READER_EMAIL = "fixture@example.invalid";
  const report = await checkReader(configured, "config-only", { now: () => now });
  assert.equal(report.ok, false);
  assert.equal(report.checks.find(check => check.name === "restricted_media_configuration")?.status, "fail");
});

test("reader configuration rejects unverified TLS, broad keys and invalid reader JWTs", async t => {
  const cases: NodeJS.ProcessEnv[] = [
    { ...env(), DATABASE_TLS: "disable" },
    { ...env(), DATABASE_READER_URL: `${env().DATABASE_READER_URL}?sslmode=disable` },
    { ...env(), STORAGE_URL: `${storageUrl}?redirect=other` },
    { ...env(), STORAGE_BUCKET: "../other" },
    { ...env(), STORAGE_API_KEY: "sb_secret_fixture_key" },
    { ...env(), STORAGE_READ_TOKEN: token({ app_metadata: { notionblog_storage_role: "writer" } }) },
    { ...env(), STORAGE_READ_TOKEN: token({ exp: now / 1000 - 1 }) },
    { ...env(), STORAGE_READ_TOKEN: token({ iss: "https://other.example.invalid/auth/v1" }) },
    { ...env(), STORAGE_READ_TOKEN: token({}, "none") },
  ];
  for (let i = 0; i < cases.length; i++) await t.test(`invalid fixture ${i + 1}`, async () => {
    assert.equal((await checkReader(cases[i], "config-only", { now: () => now })).ok, false);
  });
});

test("reader verification distinguishes readable and unavailable published content", async t => {
  for (const content of ["ready", "unavailable"] as const) await t.test(content, async () => {
    const database = fakeDatabase(content);
    const report = await checkReader(env(), "verify-access", { now: () => now,
      openDatabase: () => database, fetch: authFetch });
    assert.equal(report.ok, true); assert.equal(report.content, content); assert.equal(report.media, "pending");
    assert.equal(database.closed, 1); assert.equal(database.queries.length, 2);
    assert.equal(report.checks.find(check => check.name === "reader_auth_server_validation")?.status, "pass");
  });
});

test("reader verification rejects permission denial and never leaks driver errors", async () => {
  const secret = "private-database-password-and-source-identifier";
  let closed = 0;
  const db: SqlExecutor = { query: async () => { throw new Error(secret); } };
  const report = await checkReader(env(), "verify-access", { now: () => now, fetch: authFetch,
    openDatabase: () => ({ db, close: async () => { closed++; } }) });
  assert.equal(report.ok, false); assert.equal(closed, 1);
  assert.equal(report.checks.find(check => check.name === "database_permissions")?.status, "fail");
  assert.equal(JSON.stringify(report).includes(secret), false);
  assert.equal(JSON.stringify(report).includes(userId), false);
  assert.equal(JSON.stringify(report).includes("example.invalid"), false);
});

test("static reader JWT requires fixed same-project Auth verification and current reader metadata", async t => {
  await t.test("server validation request", async () => {
    const database = fakeDatabase(); let requests = 0;
    const report = await checkReader(env(), "verify-access", { now: () => now, openDatabase: () => database,
      fetch: async (url, init) => {
        requests++;
        assert.equal(url, "https://storage.example.invalid/auth/v1/user");
        assert.equal(init?.redirect, "error"); assert.equal(init?.cache, "no-store");
        assert.ok(init?.signal); assert.equal(init?.method, undefined);
        return authFetch(url, init);
      } });
    assert.equal(report.ok, true); assert.equal(requests, 1);
  });
  for (const response of [
    () => Response.json({ id: userId, role: "authenticated", app_metadata: { notionblog_storage_role: "writer" } }),
    () => Response.json({ id: "22222222-2222-4222-8222-222222222222", role: "authenticated", app_metadata: { notionblog_storage_role: "reader" } }),
    () => Response.json({ id: userId, role: "authenticated", is_anonymous: true, app_metadata: { notionblog_storage_role: "reader" } }),
    () => new Response("private Auth details", { status: 401 }),
    () => new Response("x".repeat(64 * 1024 + 1)),
  ]) await t.test("server rejection", async () => {
    const report = await checkReader(env(), "verify-access", { now: () => now,
      openDatabase: () => fakeDatabase(), fetch: async () => response() });
    assert.equal(report.ok, false);
    assert.equal(report.checks.find(check => check.name === "reader_auth_server_validation")?.status, "fail");
    assert.equal(JSON.stringify(report).includes("private Auth details"), false);
  });
});

test("renewable reader credentials use both token acquisition and server user validation", async () => {
  const configured = { ...env(), STORAGE_READ_TOKEN: undefined, STORAGE_READER_EMAIL: "fixture@example.invalid",
    STORAGE_READER_PASSWORD: "fictional-reader-password", STORAGE_READER_USER_ID: userId };
  const requests: string[] = [];
  const report = await checkReader(configured, "verify-access", { now: () => now, openDatabase: () => fakeDatabase(),
    fetch: async (url, init) => {
      requests.push(String(url));
      if (requests.length === 1) {
        assert.equal(init?.method, "POST"); return Response.json({ access_token: token(), token_type: "bearer" });
      }
      return authFetch(url, init);
    } });
  assert.equal(report.ok, true);
  assert.deepEqual(requests, ["https://storage.example.invalid/auth/v1/token?grant_type=password", "https://storage.example.invalid/auth/v1/user"]);
});

test("static reader token expiry is rechecked after server validation", async () => {
  let currentTime = now;
  const configured = { ...env(), STORAGE_READ_TOKEN: token({ exp: now / 1000 + 61 }) };
  const report = await checkReader(configured, "verify-access", { now: () => currentTime,
    openDatabase: () => fakeDatabase(), fetch: async (url, init) => {
      currentTime += 62_000;
      return authFetch(url, init);
    } });
  assert.equal(report.ok, false);
  assert.equal(report.checks.find(check => check.name === "reader_auth_server_validation")?.status, "fail");
});

test("reader permission catalog inspection proves restricted login and rejects privilege escalation", async t => {
  const db = await PGlite.create();
  try {
    await db.exec(await readFile(new URL("../database/migrations/001_content.sql", import.meta.url), "utf8"));
    await db.exec(await readFile(new URL("../database/reader-migrations/001_status.sql", import.meta.url), "utf8"));
    await db.exec("CREATE ROLE fixture_reader LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT; GRANT nb_reader TO fixture_reader;");
    async function permissions() {
      await db.exec("SET SESSION AUTHORIZATION fixture_reader");
      try { return (await db.query<Record<string, boolean>>(READER_PERMISSIONS_SQL)).rows[0]; }
      finally { await db.exec("SET SESSION AUTHORIZATION postgres"); }
    }
    assert.deepEqual(await permissions(), safe);
    const name = (await db.query<{ name: string }>("SELECT current_database() AS name")).rows[0].name;
    const databaseName = `"${name.replace(/"/g, '""')}"`;
    const cases = [
      ["ALTER ROLE fixture_reader BYPASSRLS", "ALTER ROLE fixture_reader NOBYPASSRLS", "safe_login"],
      ["CREATE ROLE fixture_extra NOLOGIN; GRANT fixture_extra TO fixture_reader", "REVOKE fixture_extra FROM fixture_reader; DROP ROLE fixture_extra", "reader_only"],
      ["GRANT SELECT ON nb.records TO fixture_reader", "REVOKE SELECT ON nb.records FROM fixture_reader", "private_tables_denied"],
      ["GRANT SELECT(item) ON nb.records TO fixture_reader", "REVOKE SELECT(item) ON nb.records FROM fixture_reader", "private_tables_denied"],
      ["GRANT nb_writer TO fixture_reader", "REVOKE nb_writer FROM fixture_reader", "reader_only"],
      ["GRANT EXECUTE ON FUNCTION nb_api.fail_run(uuid,bigint) TO fixture_reader", "REVOKE EXECUTE ON FUNCTION nb_api.fail_run(uuid,bigint) FROM fixture_reader", "write_denied"],
      ["REVOKE EXECUTE ON FUNCTION nb_api.status_years(text) FROM nb_reader", "GRANT EXECUTE ON FUNCTION nb_api.status_years(text) TO nb_reader", "read_allowed"],
      ["GRANT CREATE ON SCHEMA nb TO fixture_reader", "REVOKE CREATE ON SCHEMA nb FROM fixture_reader", "create_denied"],
      ["GRANT CREATE ON SCHEMA nb_api TO fixture_reader", "REVOKE CREATE ON SCHEMA nb_api FROM fixture_reader", "create_denied"],
      [`GRANT CREATE ON DATABASE ${databaseName} TO fixture_reader`, `REVOKE CREATE ON DATABASE ${databaseName} FROM fixture_reader`, "create_denied"],
      ["ALTER SCHEMA nb OWNER TO fixture_reader; REVOKE CREATE ON SCHEMA nb FROM fixture_reader", "ALTER SCHEMA nb OWNER TO postgres", "create_denied"],
      ["ALTER SCHEMA nb_api OWNER TO fixture_reader; REVOKE CREATE ON SCHEMA nb_api FROM fixture_reader", "ALTER SCHEMA nb_api OWNER TO postgres", "create_denied"],
      [`ALTER DATABASE ${databaseName} OWNER TO fixture_reader; REVOKE CREATE ON DATABASE ${databaseName} FROM fixture_reader`, `ALTER DATABASE ${databaseName} OWNER TO postgres`, "create_denied"],
    ];
    for (const [grant, revoke, key] of cases) await t.test(key, async () => {
      await db.exec(grant);
      try { assert.equal((await permissions())[key], false); }
      finally { await db.exec(revoke); }
    });
    await t.test("missing read schema usage is rejected", async () => {
      await db.exec("REVOKE USAGE ON SCHEMA nb_api FROM nb_reader");
      try { await assert.rejects(permissions(), /permission denied/); }
      finally { await db.exec("GRANT USAGE ON SCHEMA nb_api TO nb_reader"); }
    });
    assert.deepEqual(await permissions(), safe);
  } finally { await db.close(); }
});
