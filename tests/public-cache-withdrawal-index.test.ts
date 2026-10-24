import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import protocol from "../database/public-cache-protocol.json" with { type: "json" };
import { validateWithdrawalPlan, type WithdrawalPlan } from "../scripts/public-cache/withdraw.ts";

test("withdrawal owner index preserves historical URL guards and distinct-resource limits", async t => {
  const db = await PGlite.create();
  t.after(() => db.close());
  await db.exec("CREATE ROLE nb_reader NOLOGIN; CREATE ROLE nb_writer NOLOGIN;");
  await db.exec(await readFile(new URL("../database/website-migrations/001_website.sql", import.meta.url), "utf8"));
  const migration = await readFile(new URL("../" + protocol.migration.file, import.meta.url), "utf8");
  assert.equal(createHash("sha256").update(migration).digest("hex"), protocol.migration.sha256);
  await db.exec(migration);
  const old = randomUUID(), current = randomUUID();
  const oldAsset = "a1." + "a".repeat(64), currentAsset = "a1." + "b".repeat(64);
  await db.exec("INSERT INTO nb_v2.sources(key,kind,mode,data_source_id) VALUES('status','status','all','fixture-status')");
  for (const run of [old, current]) {
    await db.query("INSERT INTO nb_v2.runs(id,fence,revision,epoch,config_digest,valid_until,status) VALUES($1,1,1,1,$2,clock_timestamp()+interval '1 hour','published')", [run, "a".repeat(64)]);
    for (const id of ["target", "other"]) await db.query("INSERT INTO nb_v2.records(run_id,id,kind,source_key,ordinal,item,document) VALUES($1,$2,'status','status',1,$3::jsonb,'{}')", [run, id, JSON.stringify({ id, href: "/status#" + id, kind: "status", slug: id })]);
  }
  await db.query("UPDATE nb_v2.state SET current_run=$1,revision=1,epoch=1,config_digest=$2,schema_digest=$2", [current, "a".repeat(64)]);
  for (const [run, asset] of [[old, oldAsset], [current, currentAsset]]) await db.query("INSERT INTO nb_v2.media VALUES($1,$2,'target','{}')", [run, asset]);
  // Representative sparse-owner distribution. No real project rows or network calls.
  await db.query("INSERT INTO nb_v2.media SELECT $1,'a1.'||lpad(to_hex(n),64,'0'),'other','{}' FROM generate_series(1,45000) n", [old]);
  await db.exec("ANALYZE nb_v2.media");
  const role = async <T>(name: string, sql: string, values: unknown[] = []) => db.transaction(async tx => {
    await tx.exec(`SET LOCAL ROLE ${name}`);
    return tx.query<T>(sql, values);
  });
  const plan = async () => validateWithdrawalPlan((await role<{ result: WithdrawalPlan }>("nb_cache_operator", "SELECT nb_cache_api.plan_withdraw('target') AS result")).rows[0].result);
  const assetQuery = /SELECT DISTINCT asset_id FROM nb_v2\.media[^\n]+/.exec(migration)![0].replace("ANY(ids)", "ANY($1::text[])");
  const explain = async () => JSON.stringify((await db.query("EXPLAIN (FORMAT JSON) " + assetQuery, [["target"]])).rows);
  const before = await plan();
  assert.deepEqual(before.assets, [oldAsset, currentAsset]);
  assert.match(await explain(), /Seq Scan/);
  const ddl = await readFile(new URL("../database/indexes/public-cache-media-owner.sql", import.meta.url), "utf8");
  await db.exec(ddl);
  await t.test("the unforced sparse-owner plan uses the index and preserves the complete plan", async () => {
    assert.match(await explain(), /media_withdraw_owner_asset/);
    assert.deepEqual(await plan(), before);
    const state = (await db.query<{ valid: boolean; ready: boolean; live: boolean; definition: string }>("SELECT indisvalid AS valid,indisready AS ready,indislive AS live,pg_get_indexdef(indexrelid) AS definition FROM pg_index WHERE indexrelid='nb_v2.media_withdraw_owner_asset'::regclass")).rows[0];
    assert.deepEqual(state, { valid: true, ready: true, live: true, definition: "CREATE INDEX media_withdraw_owner_asset ON nb_v2.media USING btree (owner_page_id, asset_id)" });
    await assert.rejects(db.exec(ddl), /already exists/, "a conflicting or incomplete installation must not silently succeed");
  });
  await t.test("another public page referencing a historical owner URL still blocks withdrawal", async () => {
    await db.query("UPDATE nb_v2.records SET document=$1::jsonb WHERE run_id=$2 AND id='other'", [JSON.stringify({ blocks: [{ image: { src: "/media/v2/" + oldAsset + "?thumbnail=800" } }] }), current]);
    const shared = await plan();
    assert.equal(shared.sharedOwnerUrl, true);
    const currentOnly = await db.query("SELECT asset_id FROM nb_v2.media WHERE run_id=$1 AND owner_page_id='target'", [current]);
    assert.deepEqual(currentOnly.rows, [{ asset_id: currentAsset }], "the proposed current-run filter would miss the shared old URL");
    await assert.rejects(role("nb_cache_operator", "SELECT nb_cache_api.withdraw($1,$2::jsonb)", [randomUUID(), JSON.stringify(shared)]), /NB_CACHE_PLAN_CHANGED/);
    await db.query("UPDATE nb_v2.records SET document='{}' WHERE run_id=$1 AND id='other'", [current]);
  });
  await t.test("more than 40000 historical rows do not exhaust the distinct-asset allowance", async () => {
    for (const run of [old, current]) await db.query("INSERT INTO nb_v2.media SELECT $1,'a1.'||lpad(to_hex(n),64,'0'),'target','{}' FROM generate_series(50001,70000) n", [run]);
    assert.equal((await plan()).assets.length, 20002);
  });
  await t.test("40000 distinct assets are accepted; 40001 fails before denying or creating an event", async () => {
    await db.query("INSERT INTO nb_v2.media SELECT $1,'a1.'||lpad(to_hex(n),64,'0'),'target','{}' FROM generate_series(70001,89998) n", [old]);
    assert.equal((await plan()).assets.length, 40000);
    await db.query("INSERT INTO nb_v2.media VALUES($1,$2,'target','{}')", [old, "a1." + "c".repeat(64)]);
    await assert.rejects(plan(), /NB_CACHE_PLAN_LIMIT/);
    assert.deepEqual((await db.query("SELECT (SELECT count(*)::int FROM nb_v2.denied) AS denied,(SELECT count(*)::int FROM nb_cache.events) AS events")).rows, [{ denied: 0, events: 0 }]);
  });
  await t.test("the performance index grants no additional reader or publisher access", async () => {
    for (const name of ["nb_reader", "nb_cache_publisher"]) {
      await assert.rejects(role(name, "SELECT nb_cache_api.plan_withdraw('target')"), /permission denied/);
      await assert.rejects(role(name, "SELECT asset_id FROM nb_v2.media"), /permission denied/);
    }
  });
});
