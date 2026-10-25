import test from "node:test";
import assert from "node:assert/strict";
import { hostFixture } from "./helpers/incremental-host.ts";
import { syncPublicReaderRole, verifySyncPublicReader } from "../src/server/database/sync-public-reader.ts";
import { createWebsiteDatabaseRepository } from "../src/server/database/website-repository.ts";
import { publicationReader } from "../src/server/database/publication.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";

const login = "nb_sync_public_reader", url = `postgresql://${login}:synthetic@db.example.test/postgres`;
test("public sync reader configuration cannot reuse website, evidence or writer credentials", () => {
  assert.equal(syncPublicReaderRole(url), login);
  assert.equal(syncPublicReaderRole(url.replace(login, login + "_r20260101." + "a".repeat(20))), login + "_r20260101");
  for (const actor of ["nb_website_reader", "nb_sync_reader", "nb_writer", login + "_extra"]) {
    assert.throws(() => syncPublicReaderRole(url.replace(login, actor)), { code: "MISCONFIGURED" });
  }
  for (const value of [undefined, url + "?sslmode=disable", url.replace(":synthetic", ""), url + "#ignored"]) {
    assert.throws(() => syncPublicReaderRole(value), { code: "MISCONFIGURED" });
  }
});

test("separate public sync LOGIN reads public snapshots but cannot read evidence or write", async t => {
  const previousMode = process.env.DATABASE_READER_ISOLATION;
  process.env.DATABASE_READER_ISOLATION = "off";
  t.after(() => { if (previousMode === undefined) delete process.env.DATABASE_READER_ISOLATION; else process.env.DATABASE_READER_ISOLATION = previousMode; });
  const f = await hostFixture(); t.after(() => f.close());
  await f.db.exec(`CREATE ROLE ${login} LOGIN INHERIT; GRANT nb_reader TO ${login}`);
  const db: SqlExecutor = { query: async <T>(sql: string, values?: unknown[]) => {
    try { return await f.db.transaction(async tx => {
      await tx.exec(`SET SESSION AUTHORIZATION ${login}`); return tx.query<T>(sql, values);
    }); } finally { await f.db.exec("SET SESSION AUTHORIZATION postgres"); }
  } };
  await verifySyncPublicReader(db, url);
  const repo = createWebsiteDatabaseRepository(publicationReader(db, "published"));
  assert.ok(((await repo.list("status")).total ?? 0) > 0);
  const qualified = await db.query<{ result: { records: unknown[] } }>("SELECT nb_v2_api.read_snapshot(ARRAY['status']::text[],false) AS result");
  assert.ok(qualified.rows[0].result.records.length > 0);
  await assert.rejects(db.query("SELECT nb_delta_api.read_page('page','source','revision')"), /permission denied/);
  await assert.rejects(db.query("SELECT * FROM nb_v2.records"), /permission denied/);
  await assert.rejects(db.query("DELETE FROM nb_v2.records"), /permission denied/);
  await assert.rejects(verifySyncPublicReader(db, url.replace(login, login + "_r20260101")), { code: "MISCONFIGURED" });

  for (const [grant, undo] of [
    ["GRANT nb_delta_reader TO " + login, "REVOKE nb_delta_reader FROM " + login],
    ["GRANT nb_writer TO " + login, "REVOKE nb_writer FROM " + login],
    [`GRANT nb_reader TO ${login} WITH ADMIN OPTION`, `REVOKE ADMIN OPTION FOR nb_reader FROM ${login}`],
    [`GRANT SELECT ON nb_v2.records TO ${login}`, `REVOKE SELECT ON nb_v2.records FROM ${login}`],
    ["GRANT EXECUTE ON FUNCTION nb_delta_api.read_page(text,text,text) TO nb_reader",
      "REVOKE EXECUTE ON FUNCTION nb_delta_api.read_page(text,text,text) FROM nb_reader"],
    [`CREATE ROLE hidden_reader NOLOGIN; GRANT nb_delta_reader TO hidden_reader; GRANT hidden_reader TO ${login}; ALTER ROLE ${login} NOINHERIT`,
      `ALTER ROLE ${login} INHERIT; REVOKE hidden_reader FROM ${login}; DROP ROLE hidden_reader`],
  ]) {
    try {
      await f.db.exec(grant);
      await assert.rejects(verifySyncPublicReader(db, url), { code: "MISCONFIGURED" });
    } finally { await f.db.exec(undo); }
  }
  await verifySyncPublicReader(db, url);
});

test("public sync admission fails closed before public queries and suppresses transport details", async () => {
  let queries = 0;
  const db: SqlExecutor = { query: async () => { queries++; throw Error("private host and credential details"); } };
  await assert.rejects(verifySyncPublicReader(db, url.replace(login, "nb_website_reader")), { code: "MISCONFIGURED" });
  assert.equal(queries, 0);
  await assert.rejects(verifySyncPublicReader(db, url), e => e instanceof Error && !e.message.includes("private host"));
  assert.equal(queries, 1);
});
