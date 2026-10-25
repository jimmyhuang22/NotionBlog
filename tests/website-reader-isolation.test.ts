import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { hostFixture } from "./helpers/incremental-host.ts";
import { isolatedWebsiteReader, websiteReaderIsolationMode } from "../src/server/database/website-reader-isolation.ts";
import { installIncrementalReaderIsolation } from "../scripts/website-sync/incremental-reader-isolation.ts";
import { installIncrementalWithdrawalRecovery } from "../scripts/website-sync/incremental-withdrawal-recovery.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";
import { createWebsiteDatabaseRepository } from "../src/server/database/website-repository.ts";
import { publicationReader } from "../src/server/database/publication.ts";

test("separate groups keep private preparation out of website credentials without removing public content", async t => {
  const f = await hostFixture(); t.after(() => f.close());
  const owner: SqlExecutor = { query: async <T>(sql: string, values?: unknown[]) => {
    if (sql.startsWith("--")) { await f.db.exec(sql); return { rows: [] as T[] }; }
    return f.db.query<T>(sql, values);
  } };
  await installIncrementalReaderIsolation(owner); // idempotent, never grant a LOGIN
  await installIncrementalWithdrawalRecovery(owner); // either extension installation order
  const role = (name: string): SqlExecutor => ({ query: <T>(sql: string, values?: unknown[]) => f.db.transaction(async tx => {
    await tx.exec(`SET LOCAL ROLE ${name}`); return tx.query<T>(sql, values);
  }) });
  const website = isolatedWebsiteReader(role("nb_reader"));
  const repo = createWebsiteDatabaseRepository(publicationReader(website, "published"));
  assert.ok(((await repo.list("status")).total ?? 0) > 0);
  for (const name of ["nb_reader", "nb_writer"]) {
    await assert.rejects(role(name).query("SELECT nb_delta_api.read_page('page','source','revision')"), /permission denied/);
    await assert.rejects(role(name).query("SELECT nb_delta_api.verify_operation($1,$2,$3)", [randomUUID(), "a".repeat(64), "revision"]), /permission denied/);
  }
  await assert.rejects(role("nb_delta_reader").query("SELECT * FROM nb_v2.records"), /permission denied/);
  await assert.rejects(role("nb_delta_reader").query("SELECT nb_delta_api.apply_delta($1,$2,$3,$4,'[]','[]','[]')",
    [randomUUID(), "a".repeat(64), "revision", "b".repeat(64)]), /permission denied/);
  await assert.rejects(isolatedWebsiteReader(role("nb_delta_reader")).query("SELECT 1"), { code: "CONTENT_UNAVAILABLE" });
  await assert.rejects(isolatedWebsiteReader(owner).query("SELECT 1"), { code: "CONTENT_UNAVAILABLE" });
  await f.db.exec("CREATE ROLE fixture_website LOGIN NOINHERIT; GRANT nb_reader TO fixture_website; GRANT nb_delta_reader TO fixture_website");
  await assert.rejects(isolatedWebsiteReader(role("fixture_website")).query("SELECT 1"), { code: "CONTENT_UNAVAILABLE" });
  await f.db.exec("REVOKE nb_delta_reader FROM fixture_website");
  await isolatedWebsiteReader(role("fixture_website")).query("SELECT 1");
  await f.db.exec("GRANT EXECUTE ON FUNCTION nb_delta_api.read_page(text,text,text) TO nb_reader");
  const guarded = isolatedWebsiteReader(role("nb_reader"));
  await assert.rejects(guarded.query("SELECT 1"), { code: "CONTENT_UNAVAILABLE" });
  await f.db.exec("REVOKE EXECUTE ON FUNCTION nb_delta_api.read_page(text,text,text) FROM nb_reader");
  await guarded.query("SELECT 1");
});

test("website permission checks coalesce concurrent starts and sanitize failed inspection", async () => {
  let inspections = 0, calls = 0, release!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  const guarded = isolatedWebsiteReader({ query: async <T>(sql: string) => {
    if (sql.startsWith("WITH RECURSIVE")) { inspections++; await gate; return { rows: [{ isolated: true }] as T[] }; }
    calls++; return { rows: [] as T[] };
  } });
  const pending = Promise.all([guarded.query("SELECT 1"), guarded.query("SELECT 2")]);
  assert.equal(inspections, 1); assert.equal(calls, 0); release(); await pending;
  assert.equal(calls, 2);
  const failed = isolatedWebsiteReader({ query: async () => { throw new Error("private transport details"); } });
  await assert.rejects(failed.query("SELECT 1"), e => e instanceof Error && !e.message.includes("private transport details") && "code" in e && e.code === "CONTENT_UNAVAILABLE");
});

test("deferred website reads preserve old public access, do no inspection and report once", async () => {
  assert.equal(websiteReaderIsolationMode(undefined), "off");
  assert.equal(websiteReaderIsolationMode("off"), "off");
  assert.equal(websiteReaderIsolationMode("enforce"), "enforce");
  for (const value of ["", "OFF", "Enforce", " off", "enforce ", null, false, 0]) {
    assert.throws(() => websiteReaderIsolationMode(value), { code: "MISCONFIGURED" });
  }
  let warnings = 0; const calls: unknown[][] = [];
  const db: SqlExecutor = {query: async <T>(text: string, values?: unknown[]) => {
    assert.equal(text.startsWith("WITH RECURSIVE"), false); calls.push([text, values]); return {rows:[{public:true}] as T[]};
  }};
  const reader = isolatedWebsiteReader(db, "off", () => { warnings++; });
  assert.equal(warnings, 0);
  await Promise.all(Array.from({length:8}, () => reader.query("SELECT public", [1])));
  assert.equal(warnings, 1); assert.equal(calls.length, 8); assert.deepEqual(calls[0], ["SELECT public", [1]]);
  const failure = new Error("private driver failure");
  const broken = isolatedWebsiteReader({query:async()=>{throw failure;}}, "off", () => {throw Error("broken diagnostic sink");});
  await assert.rejects(broken.query("SELECT public"), error => error === failure);
});

test("deferred mode leaves actual grants unchanged while strict library callers still reject them", async t => {
  const f = await hostFixture(); t.after(() => f.close());
  await f.db.exec("GRANT EXECUTE ON FUNCTION nb_delta_api.read_page(text,text,text) TO nb_reader");
  const reader:SqlExecutor={query:<T>(sql:string,values?:unknown[])=>f.db.transaction(async tx=>{
    await tx.exec("SET LOCAL ROLE nb_reader");return tx.query<T>(sql,values);
  })};
  const repository = createWebsiteDatabaseRepository(publicationReader(isolatedWebsiteReader(reader,"off",()=>{}),"published"));
  assert.ok((await repository.list("status")).items.length>0);
  await assert.rejects(isolatedWebsiteReader(reader).query("SELECT 1"),{code:"CONTENT_UNAVAILABLE"});
  const grants=(await f.db.query<{allowed:boolean}>("SELECT has_function_privilege('nb_reader','nb_delta_api.read_page(text,text,text)','EXECUTE') AS allowed")).rows;
  assert.equal(grants[0].allowed,true);
});
