import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import protocol from "../database/public-cache-commit-protocol.json" with { type: "json" };
import { commitSQL, setupCacheCommitFixture, ingestSample } from "./helpers/cache-commit-fixture.ts";
import { readCommitCatalog, verifyCommitCatalog, classifyCommitCatalog } from "../scripts/public-cache/commit-catalog.ts";

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
test("commit-barrier protocol pins the unchanged base, exact candidate and independently reviewed function/catalog facts", async () => {
  assert.equal(digest(await commitSQL()), protocol.migration.sha256);
  assert.equal(digest(await readFile(new URL("../" + protocol.baseMigration.file, import.meta.url), "utf8")), protocol.baseMigration.sha256);
  assert.equal(protocol.installedByBuild, false); assert.equal(protocol.enabledByDefault, false);
  assert.equal(protocol.functions.length, 14);
  for (const fn of protocol.functions) {
    const actual = protocol.expectedCatalog.functions.find(f => f.signature === fn.signature)!;
    assert.ok(actual); for (const field of ["sourceSha256", "language", "volatility", "securityDefiner", "searchPath"] as const) assert.deepEqual(actual[field], fn[field]);
  }
});
test("actual opt-in extension preserves atomic generation, event and business semantics", async t => {
  const db = await PGlite.create(); t.after(() => db.close());
  const fixture = await setupCacheCommitFixture(db, s => db.exec(s));
  assert.equal(classifyCommitCatalog(await readCommitCatalog(db)),"legacy");
  await db.exec(await commitSQL());
  assert.equal(classifyCommitCatalog(await readCommitCatalog(db)),"installed");
  const generation = async () => BigInt((await db.query<{ generation: string | number }>("SELECT generation FROM nb_cache.state")).rows[0].generation);
  const count = async (table: string) => Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
  let id = 0; const change = () => db.query("INSERT INTO social_sync.works(work_id,title) VALUES($1,'Synthetic work')", [`fixture-${++id}`]);
  await t.test("installation does not enable the new mode or weaken existing roles", async () => {
    assert.deepEqual((await db.query<{result:unknown}>("SELECT nb_cache_api.read_commit_barrier() AS result")).rows[0].result, { version: 1, enabled: false });
    verifyCommitCatalog(await readCommitCatalog(db), protocol.expectedCatalog);
    for (const role of ["nb_reader", "nb_writer", "nb_cache_operator", "nb_cache_publisher", "nb_social_worker", "nb_social_reader", "anon", "authenticated", "service_role"]) {
      for (const sql of ["SELECT * FROM nb_cache.commit_intents", "UPDATE nb_cache.commit_config SET enabled=true", "SELECT nb_cache.stage_commit_refresh(gen_random_uuid(),'social',repeat('a',64))"]) {
        await assert.rejects(db.transaction(async tx => { await tx.exec(`SET LOCAL ROLE ${role}`); return tx.exec(sql); }));
      }
    }
    await db.transaction(async tx => { await tx.exec("SET LOCAL ROLE nb_cache_operator"); assert.deepEqual((await tx.query<{result:unknown}>("SELECT nb_cache_api.read_commit_barrier() AS result")).rows[0].result, { version: 1, enabled: false }); });
  });
  await t.test("cache disabled does not generate new intents or events", async () => {
    await change(); assert.equal(await generation(), 0n); assert.equal(await count("nb_cache.events"), 0); assert.equal(await count("nb_cache.commit_intents"), 0);
  });
  await db.exec("UPDATE nb_cache.state SET enabled=true");
  await t.test("new mode off preserves the legacy immediate path", async () => {
    await db.exec("BEGIN"); await ingestSample(db, fixture.samples[0]); assert.equal(await generation(), 1n); assert.equal(await count("nb_cache.commit_intents"), 0); await db.exec("ROLLBACK"); assert.equal(await generation(), 0n);
  });
  await db.exec("UPDATE nb_cache.commit_config SET enabled=true");
  await t.test("many rows and statements stage once without advancing generation before commit", async () => {
    const before = await generation(); await db.exec("BEGIN"); await change(); await change(); assert.equal(await count("nb_cache.commit_intents"), 1); assert.equal(await generation(), before);
    await db.exec("COMMIT"); assert.equal(await generation(), before + 1n); assert.equal(await count("nb_cache.commit_intents"), 0);
  });
  await t.test("mixed scopes stage separate events in the same atomic commit", async () => {
    const before = await generation(); await db.exec("BEGIN"); await change(); await db.exec("INSERT INTO nb_thumbnails.media VALUES('synthetic-media')"); assert.equal(await count("nb_cache.commit_intents"), 2);
    await db.exec("COMMIT"); assert.equal(await generation(), before + 2n);
  });
  await t.test("full and savepoint rollbacks discard their matching intents and data", async () => {
    const before = await generation(), works = await count("social_sync.works");
    await db.exec("BEGIN"); await change(); await db.exec("ROLLBACK"); assert.equal(await generation(), before); assert.equal(await count("social_sync.works"), works);
    await db.exec("BEGIN;SAVEPOINT part"); await change(); await db.exec("ROLLBACK TO part;COMMIT"); assert.equal(await generation(), before);
    await db.exec("BEGIN"); await change(); await db.exec("SAVEPOINT part"); await db.exec("INSERT INTO nb_thumbnails.media VALUES('rolled-back-media');ROLLBACK TO part;COMMIT");
    assert.equal(await generation(), before + 1n); assert.equal(await count("nb_cache.commit_intents"), 0);
  });
  await t.test("a failed deferred enqueue rolls back the entire business transaction", async () => {
    const before = await generation(), works = await count("social_sync.works");
    await db.exec(`ALTER TABLE nb_cache.events ADD CONSTRAINT fixture_fail_new CHECK(generation<=${before})`);
    await db.exec("BEGIN"); await change(); await assert.rejects(db.exec("COMMIT")); await db.exec("ROLLBACK");
    assert.equal(await generation(), before); assert.equal(await count("social_sync.works"), works); assert.equal(await count("nb_cache.commit_intents"), 0);
    await db.exec("ALTER TABLE nb_cache.events DROP CONSTRAINT fixture_fail_new");
  });
  await t.test("already-staged intent must flush even if its activation flag changes before commit", async () => {
    const before = await generation(); await db.exec("BEGIN"); await change(); await db.exec("UPDATE nb_cache.commit_config SET enabled=false;COMMIT");
    assert.equal(await generation(), before + 1n); await db.exec("UPDATE nb_cache.commit_config SET enabled=true");
  });
  await t.test("forced early constraint execution remains idempotent for later writes and rollback", async () => {
    const before = await generation(); await db.exec("BEGIN"); await change(); await db.exec("SET CONSTRAINTS ALL IMMEDIATE"); assert.equal(await generation(), before + 1n);
    await change(); assert.equal(await generation(), before + 1n); await db.exec("ROLLBACK"); assert.equal(await generation(), before);
  });
  await t.test("no-op writes do not manufacture cache generations", async () => {
    const before = await generation(); await db.exec("UPDATE social_sync.works SET title='No row' WHERE work_id='missing'"); assert.equal(await generation(), before);
  });
  await t.test("missing configuration fails closed rather than guessing a legacy/new mode", async () => {
    await db.exec("DELETE FROM nb_cache.commit_config"); await assert.rejects(change(), /NB_CACHE_COMMIT_CONFIG/);
    await db.exec("INSERT INTO nb_cache.commit_config(singleton,enabled) VALUES(true,true)");
  });
  await t.test("a missing queued intent aborts instead of committing data without an event", async () => {
    const before = await generation(); await db.exec("BEGIN"); await change(); await db.exec("DELETE FROM nb_cache.commit_intents"); await assert.rejects(db.exec("COMMIT"), /NB_CACHE_COMMIT_INTENT/); await db.exec("ROLLBACK"); assert.equal(await generation(), before);
  });
  await t.test("real content promotion emits its event only at the same business commit", async () => {
    const prepared = await fixture.prepare(), before = await generation(); await db.exec("BEGIN"); await prepared.publish(); assert.equal(await generation(), before); assert.equal(await count("nb_cache.commit_intents"), 1);
    await db.exec("COMMIT"); assert.equal(await generation(), before + 1n);
  });
  await t.test("catalog review is read-only and detects constraint, trigger and execution-grant drift", async () => {
    verifyCommitCatalog(await readCommitCatalog(db), protocol.expectedCatalog);
    await db.exec("ALTER TABLE nb_cache.commit_intents DISABLE TRIGGER nb_cache_commit_refresh");
    assert.throws(() => verifyCommitCatalog(null, protocol.expectedCatalog), /CACHE_COMMIT_CATALOG_MISMATCH/);
    assert.throws(() => verifyCommitCatalog({ wrong: true }, protocol.expectedCatalog), /CACHE_COMMIT_CATALOG_MISMATCH/);
    assert.throws(() => verifyCommitCatalog({}, undefined), /CACHE_COMMIT_CATALOG_MISMATCH/);
    assert.throws(() => verifyCommitCatalog({ padding: "x".repeat(32768) }, protocol.expectedCatalog), /CACHE_COMMIT_CATALOG_MISMATCH/);
    const disabled = await readCommitCatalog(db); assert.equal(classifyCommitCatalog(disabled),"mismatch"); assert.throws(() => verifyCommitCatalog(disabled, protocol.expectedCatalog), /CACHE_COMMIT_CATALOG_MISMATCH/);
    await db.exec("ALTER TABLE nb_cache.commit_intents ENABLE TRIGGER nb_cache_commit_refresh;GRANT EXECUTE ON FUNCTION nb_cache.stage_commit_refresh(uuid,text,text) TO PUBLIC");
    const granted = await readCommitCatalog(db); assert.throws(() => verifyCommitCatalog(granted, protocol.expectedCatalog), /CACHE_COMMIT_CATALOG_MISMATCH/);
    await db.exec("REVOKE EXECUTE ON FUNCTION nb_cache.stage_commit_refresh(uuid,text,text) FROM PUBLIC;ALTER TABLE nb_cache.commit_config ADD CONSTRAINT fixture_extra CHECK(enabled)");
    const altered = await readCommitCatalog(db); assert.throws(() => verifyCommitCatalog(altered, protocol.expectedCatalog), /CACHE_COMMIT_CATALOG_MISMATCH/);
    await db.exec("ALTER TABLE nb_cache.commit_config DROP CONSTRAINT fixture_extra;ALTER TABLE nb_cache.commit_config ALTER COLUMN enabled DROP NOT NULL");
    const nullable = await readCommitCatalog(db); assert.throws(() => verifyCommitCatalog(nullable, protocol.expectedCatalog), /CACHE_COMMIT_CATALOG_MISMATCH/);
    await db.exec("ALTER TABLE nb_cache.commit_config ALTER COLUMN enabled SET NOT NULL");
    await db.exec("BEGIN READ ONLY"); verifyCommitCatalog(await readCommitCatalog(db), protocol.expectedCatalog); await db.exec("ROLLBACK");
  });
});
test("partial/colliding installation and changed frozen base refuse without replacing old functions", async () => {
  const db = await PGlite.create();
  try {
    await setupCacheCommitFixture(db, s => db.exec(s));
    await db.exec("ALTER FUNCTION nb_cache_api.read_stamp() IMMUTABLE");
    await assert.rejects(db.exec(await commitSQL()), /NB_CACHE_COMMIT_BASE_MISMATCH/); await db.exec("ROLLBACK");
    assert.equal((await db.query<{name:string|null}>("SELECT to_regclass('nb_cache.commit_intents') AS name")).rows[0].name, null);
    await db.exec("ALTER FUNCTION nb_cache_api.read_stamp() STABLE;CREATE TABLE nb_cache.commit_config(sentinel text);INSERT INTO nb_cache.commit_config VALUES('untouched')");
    await assert.rejects(db.exec(await commitSQL())); await db.exec("ROLLBACK");
    assert.equal((await db.query<{sentinel:string}>("SELECT sentinel FROM nb_cache.commit_config")).rows[0].sentinel, "untouched");
  } finally { await db.close(); }
});
test("a different migration owner cannot create a partially incompatible private barrier", async () => {
  const db=await PGlite.create();try{
    await setupCacheCommitFixture(db,s=>db.exec(s));await db.exec("CREATE ROLE fixture_other_owner SUPERUSER;SET ROLE fixture_other_owner");
    await assert.rejects(db.exec(await commitSQL()),/NB_CACHE_COMMIT_OWNER/);await db.exec("ROLLBACK;RESET ROLE");
    assert.equal((await db.query<{name:string|null}>("SELECT to_regclass('nb_cache.commit_config') AS name")).rows[0].name,null);
  }finally{await db.close();}
});
test("all inherited default grantees are cleared, and an unknown later grant is detected", async () => {
  const db=await PGlite.create();try{
    await setupCacheCommitFixture(db,s=>db.exec(s));await db.exec("CREATE ROLE fixture_unrelated;GRANT USAGE ON SCHEMA nb_cache TO fixture_unrelated;ALTER DEFAULT PRIVILEGES IN SCHEMA nb_cache GRANT ALL ON TABLES TO fixture_unrelated;ALTER DEFAULT PRIVILEGES IN SCHEMA nb_cache GRANT EXECUTE ON FUNCTIONS TO fixture_unrelated");
    await db.exec(await commitSQL());
    assert.equal((await db.query<{allowed:boolean}>("SELECT has_table_privilege('fixture_unrelated','nb_cache.commit_config','UPDATE') AS allowed")).rows[0].allowed,false);
    assert.equal((await db.query<{allowed:boolean}>("SELECT has_function_privilege('fixture_unrelated','nb_cache.stage_commit_refresh(uuid,text,text)','EXECUTE') AS allowed")).rows[0].allowed,false);
    verifyCommitCatalog(await readCommitCatalog(db),protocol.expectedCatalog);
    await db.exec("GRANT EXECUTE ON FUNCTION nb_cache.stage_commit_refresh(uuid,text,text) TO fixture_unrelated");
    assert.equal(classifyCommitCatalog(await readCommitCatalog(db)),"mismatch");
  }finally{await db.close();}
});
