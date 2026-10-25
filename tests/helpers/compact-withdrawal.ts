import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import cacheProtocol from "../../database/public-cache-protocol.json" with { type: "json" };

export interface CompactPlan {
  version: 2; target: string; runId: string; revision: string; epoch: string;
  pages: { id: string; href: string; kind: string; slug: string }[];
  assetSummary: { algorithm: "nb-withdraw-assets-sha256-v1"; count: number; digest: string; sample: string | null };
  sharedOwnerUrl: boolean; leaseActive: boolean;
}
export const compactAsset = (value: number) => "a1." + value.toString(16).padStart(64, "0");

/** Independent Node byte encoder: no production SQL/parser/hash helper is imported. */
export function compactAssetSummary(values: string[]): CompactPlan["assetSummary"] {
  const assets = [...new Set(values)].sort();
  let state = createHash("sha256").update("notionblog:withdraw-assets:v2:start", "utf8").digest();
  for (const asset of assets) state = createHash("sha256").update(Buffer.from([1])).update(state).update(asset, "ascii").digest();
  const count = Buffer.alloc(8); count.writeBigInt64BE(BigInt(assets.length));
  return { algorithm: "nb-withdraw-assets-sha256-v1", count: assets.length,
    digest: createHash("sha256").update(Buffer.from([2])).update(state).update(count).digest("hex"), sample: assets[0] ?? null };
}

export async function compactWithdrawalFixture() {
  const db = await PGlite.create();
  try {
    await db.exec("CREATE ROLE nb_reader NOLOGIN; CREATE ROLE nb_writer NOLOGIN; CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN");
    await db.exec(await readFile(new URL("../../database/website-migrations/001_website.sql", import.meta.url), "utf8"));
    const legacy = await readFile(new URL("../../" + cacheProtocol.migration.file, import.meta.url), "utf8");
    assert.equal(createHash("sha256").update(legacy).digest("hex"), cacheProtocol.migration.sha256);
    await db.exec(legacy);
    const manifest = JSON.parse(await readFile(new URL("../../database/compact-withdrawal-protocol.json", import.meta.url), "utf8"));
    const sql = await readFile(new URL("../../supabase/migrations/" + manifest.migration.file, import.meta.url), "utf8");
    assert.equal(createHash("sha256").update(sql).digest("hex"), manifest.migration.sha256);
    await db.exec(sql);
    const old = randomUUID(), current = randomUUID();
    await db.exec("INSERT INTO nb_v2.sources(key,kind,mode,data_source_id) VALUES('status','status','all','fixture-status')");
    for (const run of [old, current]) {
      await db.query("INSERT INTO nb_v2.runs(id,fence,revision,epoch,config_digest,valid_until,status) VALUES($1,1,1,1,$2,clock_timestamp()+interval '1 hour','published')", [run, "a".repeat(64)]);
      for (const id of ["target", "other"]) await db.query("INSERT INTO nb_v2.records(run_id,id,kind,source_key,ordinal,item,document) VALUES($1,$2,'status','status',1,$3::jsonb,'{}')", [run, id, JSON.stringify({ id, href: "/status#" + id, kind: "status", slug: id })]);
    }
    await db.query("UPDATE nb_v2.state SET current_run=$1,revision=1,epoch=1,config_digest=$2,schema_digest=$2", [current, "a".repeat(64)]);
    const roleQuery = <T>(name: string, sql: string, values: unknown[] = []) => db.transaction(async tx => {
      // Callers choose only these fixed test roles, never a production/user identifier.
      assert.ok(["nb_cache_operator", "nb_reader", "nb_writer", "nb_cache_publisher", "anon", "authenticated", "service_role"].includes(name));
      await tx.exec(`SET LOCAL ROLE ${name}`);
      return tx.query<T>(sql, values);
    });
    const plan = async () => (await roleQuery<{ result: CompactPlan }>("nb_cache_operator", "SELECT nb_cache_api.plan_withdraw_compact('target') AS result")).rows[0].result;
    const write = async (value: unknown, id = randomUUID()) => (await roleQuery<{ result: { id: string; generation: string; status: string } }>("nb_cache_operator", "SELECT nb_cache_api.withdraw_compact($1,$2::jsonb) AS result", [id, JSON.stringify(value)])).rows[0].result;
    const counts = async () => (await db.query<{ denied: number; events: number; generation: string }>("SELECT (SELECT count(*)::int FROM nb_v2.denied) AS denied,(SELECT count(*)::int FROM nb_cache.events) AS events,(SELECT generation::text FROM nb_cache.state) AS generation")).rows[0];
    const reset = async () => {
      await db.exec("DELETE FROM nb_v2.media; DELETE FROM nb_v2.denied; DELETE FROM nb_cache.events; UPDATE nb_cache.state SET generation=0; UPDATE nb_v2.state SET revision=1,lease_run=NULL,lease_until=NULL; UPDATE nb_v2.records SET document='{}'");
    };
    return { db, old, current, sql, roleQuery, plan, write, counts, reset };
  } catch (error) { await db.close(); throw error; }
}
