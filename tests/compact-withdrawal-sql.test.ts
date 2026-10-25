import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { compactAsset, compactAssetSummary, compactWithdrawalFixture } from "./helpers/compact-withdrawal.ts";

test("compact withdrawal keeps historical identity and the original atomic intent", async t => {
  const f = await compactWithdrawalFixture(); t.after(() => f.db.close());
  const insert = (run: string, asset: string) => f.db.query("INSERT INTO nb_v2.media VALUES($1,$2,'target','{}')", [run, asset]);

  await t.test("SQL matches independent empty and ordered/deduplicated Node byte vectors", async () => {
    assert.deepEqual((await f.plan()).assetSummary, compactAssetSummary([]));
    await insert(f.old, compactAsset(9)); await insert(f.old, compactAsset(2)); await insert(f.current, compactAsset(9));
    const plan = await f.plan();
    assert.deepEqual(plan.assetSummary, compactAssetSummary([compactAsset(9), compactAsset(2), compactAsset(9)]));
    assert.equal("assets" in plan, false);
    assert.ok(Buffer.byteLength(JSON.stringify(plan)) < 2048);
    await f.reset();
  });

  await t.test("a nonsample historical owner URL in another page still blocks execution", async () => {
    await insert(f.current, compactAsset(1)); await insert(f.old, compactAsset(9));
    await f.db.query("UPDATE nb_v2.records SET document=$1::jsonb WHERE run_id=$2 AND id='other'", [JSON.stringify({ blocks: [{ image: { src: "/media/v2/" + compactAsset(9) + "?thumbnail=800" } }] }), f.current]);
    const plan = await f.plan(); assert.equal(plan.assetSummary.sample, compactAsset(1)); assert.equal(plan.sharedOwnerUrl, true);
    await assert.rejects(f.write(plan), /NB_CACHE_PLAN_CHANGED/);
    assert.deepEqual(await f.counts(), { denied: 0, events: 0, generation: "0" });
    await f.reset();
  });

  await t.test("same-count history changes, forged summaries and peer eligibility changes fail before deny", async () => {
    await insert(f.old, compactAsset(2)); await insert(f.current, compactAsset(1));
    const original = await f.plan();
    for (const assetSummary of [{ ...original.assetSummary, sample: compactAsset(2) }, { ...original.assetSummary, digest: "0".repeat(64) }]) {
      await assert.rejects(f.write({ ...original, assetSummary }), /NB_CACHE_PLAN_CHANGED/);
    }
    await f.db.query("UPDATE nb_v2.media SET asset_id=$1 WHERE run_id=$2 AND asset_id=$3", [compactAsset(3), f.old, compactAsset(2)]);
    await assert.rejects(f.write(original), /NB_CACHE_PLAN_CHANGED/);
    const changed = await f.plan(); assert.equal(changed.assetSummary.count, original.assetSummary.count); assert.notEqual(changed.assetSummary.digest, original.assetSummary.digest);
    await f.db.query("UPDATE nb_v2.records SET document=$1::jsonb WHERE run_id=$2 AND id='other'", [JSON.stringify({ cover: { src: "/media/v2/" + compactAsset(3) } }), f.current]);
    await assert.rejects(f.write(changed), /NB_CACHE_PLAN_CHANGED/);
    assert.deepEqual(await f.counts(), { denied: 0, events: 0, generation: "0" });
    await f.reset();
  });

  await t.test("bad stored IDs and malformed/unknown v2 plans are fixed failures with zero writes", async () => {
    const clean = await f.plan();
    for (const asset of ["bad", "a1." + "A".repeat(64), "a1." + "0".repeat(63) + "é"]) {
      await insert(f.old, asset); await assert.rejects(f.plan(), /NB_CACHE_PLAN/); await f.db.exec("DELETE FROM nb_v2.media");
    }
    const invalid = [null, [], { ...clean, version: 1 }, { ...clean, assets: [] }, { ...clean, pages: [null] },
      { ...clean, assetSummary: { ...clean.assetSummary, algorithm: "other" } },
      { ...clean, assetSummary: { ...clean.assetSummary, count: 1, sample: null } },
      { ...clean, assetSummary: { ...clean.assetSummary, count: 0, sample: compactAsset(1) } },
      { ...clean, assetSummary: { ...clean.assetSummary, count: 400001 } }, { ...clean, extra: "x".repeat(8388608) }];
    for (const value of invalid) await assert.rejects(f.write(value), /NB_CACHE_PLAN/);
    assert.deepEqual(await f.counts(), { denied: 0, events: 0, generation: "0" });
  });

  await t.test("any retained lease and changed revision are rejected without canceling a staging owner", async () => {
    const clean = await f.plan(), lease = randomUUID();
    await f.db.query("UPDATE nb_v2.state SET lease_run=$1,lease_until=clock_timestamp()-interval '1 hour'", [lease]);
    assert.equal((await f.plan()).leaseActive, true);
    await assert.rejects(f.write(clean), /NB_CACHE_SYNC_BUSY/);
    assert.equal((await f.db.query<{ lease: string }>("SELECT lease_run AS lease FROM nb_v2.state")).rows[0].lease, lease);
    await f.db.exec("UPDATE nb_v2.state SET lease_run=NULL,lease_until=NULL,revision=2");
    await assert.rejects(f.write(clean), /NB_CACHE_PLAN_CHANGED/);
    assert.deepEqual(await f.counts(), { denied: 0, events: 0, generation: "0" });
    await f.reset();
  });

  await t.test("rollback is atomic and repeated committed intent uses the unchanged read functions", async () => {
    const plan = await f.plan(), id = randomUUID();
    await assert.rejects(f.db.transaction(async tx => {
      await tx.exec("SET LOCAL ROLE nb_cache_operator");
      await tx.query("SELECT nb_cache_api.withdraw_compact($1,$2::jsonb)", [id, JSON.stringify(plan)]);
      throw Error("fixture rollback");
    }), /fixture rollback/);
    assert.deepEqual(await f.counts(), { denied: 0, events: 0, generation: "0" });
    const event = await f.write(plan, id); assert.equal(event.status, "pending");
    assert.deepEqual(await f.write(plan, id), event);
    const proof = (await f.roleQuery<{ result: { event: unknown; plan: unknown; denied: boolean } }>("nb_cache_operator", "SELECT nb_cache_api.read_withdraw($1) AS result", [id])).rows[0].result;
    assert.deepEqual(proof, { event: { ...event, scope: "withdraw" }, plan, denied: true });
    await assert.rejects(f.write({ ...plan, revision: "2" }, id), /NB_CACHE_EVENT_CONFLICT/);
    await assert.rejects(f.roleQuery("nb_cache_operator", "SELECT nb_cache_api.withdraw($1,$2::jsonb)", [id, JSON.stringify({ ...plan, version: 1 })]), /NB_CACHE_EVENT_CONFLICT/);
    assert.deepEqual(await f.counts(), { denied: 1, events: 1, generation: "1" });
    await f.reset();
  });

  await t.test("only the existing operator receives either new function", async () => {
    for (const actor of ["nb_reader", "nb_writer", "nb_cache_publisher", "anon", "authenticated", "service_role"]) {
      await assert.rejects(f.roleQuery(actor, "SELECT nb_cache_api.plan_withdraw_compact('target')"), /permission denied/);
      await assert.rejects(f.roleQuery(actor, "SELECT nb_cache_api.withdraw_compact($1,'{}'::jsonb)", [randomUUID()]), /permission denied/);
    }
    const actual = (await f.db.query<{ name: string; volatility: string; security: boolean; search: string[]; public: boolean }>("SELECT proname AS name,provolatile AS volatility,prosecdef AS security,proconfig AS search,EXISTS(SELECT FROM aclexplode(proacl) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public FROM pg_proc WHERE oid IN ('nb_cache_api.plan_withdraw_compact(text)'::regprocedure,'nb_cache_api.withdraw_compact(uuid,jsonb)'::regprocedure) ORDER BY proname")).rows;
    assert.deepEqual(actual, [{ name: "plan_withdraw_compact", volatility: "s", security: true, search: ["search_path=pg_catalog"], public: false }, { name: "withdraw_compact", volatility: "v", security: true, search: ["search_path=pg_catalog"], public: false }]);
  });

  await t.test("40001 assets use compact v2 while v1 rejects; 400000 works and 400001 cannot mutate", async () => {
    await f.db.query("INSERT INTO nb_v2.media SELECT $1,'a1.'||lpad(to_hex(n),64,'0'),'target','{}' FROM generate_series(1,40001) n", [f.old]);
    const plan = await f.plan(); assert.equal(plan.assetSummary.count, 40001);
    await assert.rejects(f.roleQuery("nb_cache_operator", "SELECT nb_cache_api.plan_withdraw('target')"), /NB_CACHE_PLAN_LIMIT/);
    assert.equal((await f.write(plan)).generation, "1");
    await f.db.exec("DELETE FROM nb_v2.denied; DELETE FROM nb_cache.events; UPDATE nb_cache.state SET generation=0; UPDATE nb_v2.state SET revision=1");
    await f.db.query("INSERT INTO nb_v2.media SELECT $1,'a1.'||lpad(to_hex(n),64,'0'),'target','{}' FROM generate_series(40002,400000) n", [f.old]);
    const maximum = await f.plan(); assert.equal(maximum.assetSummary.count, 400000); assert.equal(maximum.assetSummary.sample, compactAsset(1));
    await insert(f.old, compactAsset(400001));
    await assert.rejects(f.write(maximum), /NB_CACHE_PLAN_LIMIT/);
    assert.deepEqual(await f.counts(), { denied: 0, events: 0, generation: "0" });
  });
});
