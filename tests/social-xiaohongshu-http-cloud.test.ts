import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { SqlExecutor } from "../src/server/database/sql.ts";
import { createCloudTransport } from "../scripts/social-sync/cloud.ts";
import { hash, publicationKey } from "../scripts/social-sync/model.ts";
import type { Observation } from "../scripts/social-sync/model.ts";
import { httpNoteObservation } from "../scripts/social-sync/xiaohongshu-http.ts";
import { httpHtml, httpTarget, httpUrl } from "./helpers/social-xiaohongshu-http-samples.ts";
import { readRetainedSocialSnapshot } from "../src/server/social/retained-repository.ts";

const migrations = ["20261012005001_social_sync_v1.sql", "20261012015408_social_reader_v1.sql", "20261012020551_social_reader_binding_index.sql", "20261012054647_social_collections_v1.sql", "20261012213401_social_retained_projections.sql", "20261013214552_social_collection_follow_members.sql", "20261013225210_social_bilibili_account_discovery.sql", "20261014014825_social_work_covers.sql"];
const migration = "20261014022855_social_xiaohongshu_http_source.sql";
test("additive HTTP migration preserves role grants, Bilibili protocol and approval/link dates while updating reviewed statistics", async t => {
  const db = await PGlite.create(); t.after(() => db.close());
  await db.exec("CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;CREATE ROLE nb_reader;");
  for (const f of migrations) await db.exec(await readFile(new URL(`../supabase/migrations/${f}`, import.meta.url), "utf8"));
  const role = (name: string): SqlExecutor => ({ query: async <T>(text: string, values?: unknown[]) => {
    await db.exec(`SET SESSION AUTHORIZATION ${name}`); try { return await db.query<T>(text, values); } finally { await db.exec("SET SESSION AUTHORIZATION postgres"); }
  } });
  const worker = role("nb_social_worker"), reader = role("nb_social_reader"), time = new Date(Date.now() - 72 * 3600000).toISOString();
  const current = httpNoteObservation(httpHtml(), httpTarget(), new Date().toISOString()), old: Observation = { ...current, source: "browser-note-state", observedAt: time };
  const key = publicationKey(old), send = (row: Observation) => worker.query("SELECT key,sha256 FROM social_sync.ingest($1,$2,$3)", [key, hash(JSON.stringify(row)), JSON.stringify(row)]);
  assert.equal((await db.query<{ valid: boolean }>("SELECT social_sync.valid_observation($1::jsonb) valid", [JSON.stringify(current)])).rows[0]!.valid, false);
  await db.query("INSERT INTO social_sync.bindings(platform,account_id,publication_id,work_id,enabled) VALUES($1,$2,$3,$4,true)", [old.platform, old.accountId, old.publicationId, old.workId]);
  await send(old); await db.query("INSERT INTO social_sync.works(work_id,title,approved) VALUES($1,'Example',true)", [old.workId]);
  await db.query("INSERT INTO social_sync.retained_publications(publication_key,work_id,approved,reviewed_at,reviewed_kind,approved_source_sha256,source_sha256,outbound_url,link_checked_at) VALUES($1,$2,true,now(),'image-note',$3,$3,$4,$5)", [key, old.workId, hash(JSON.stringify(old)), httpUrl().replace('/explore/', '/discovery/item/'), time]);
  const before = (await db.query("SELECT reviewed_at,approved_source_sha256,link_checked_at,outbound_url FROM social_sync.retained_publications")).rows;
  const acl = (await db.query("SELECT oid,proacl FROM pg_proc WHERE oid='social_sync.valid_observation(jsonb)'::regprocedure")).rows;
  await assert.rejects(createCloudTransport(worker, undefined, false, true), { code: "XHS_HTTP_PROTOCOL_REQUIRED" });
  await assert.rejects(send(current), /PAYLOAD/);
  await db.exec(await readFile(new URL(`../supabase/migrations/${migration}`, import.meta.url), "utf8"));
  assert.deepEqual((await db.query("SELECT oid,proacl FROM pg_proc WHERE oid='social_sync.valid_observation(jsonb)'::regprocedure")).rows, acl);
  assert.deepEqual((await db.query("SELECT version,http_note_version FROM social_sync.meta")).rows, [{ version: 1, http_note_version: 1 }]);
  const legacy = await createCloudTransport(worker); await legacy({ key, sha256: hash(JSON.stringify(old)), observation: old });
  await assert.rejects(legacy({ key, sha256: hash(JSON.stringify(current)), observation: current }), { code: "XHS_HTTP_PROTOCOL_REQUIRED" });
  const http = await createCloudTransport(worker, undefined, false, true);
  await http({ key, sha256: hash(JSON.stringify(current)), observation: current });
  assert.deepEqual((await db.query("SELECT reviewed_at,approved_source_sha256,link_checked_at,outbound_url FROM social_sync.retained_publications")).rows, before);
  const items = (await readRetainedSocialSnapshot(reader)).items; assert.equal(items.length, 1); assert.equal(items[0]!.publications[0]!.observedAt, current.observedAt);
  assert.equal(items[0]!.publications[0]!.metricDisplay.likes, "1.2万"); assert.equal(items[0]!.publications[0]!.linkVerifiedAt, time);
  for (const changed of [{ ...current, websitePublicationApproved: true }, { ...current, accountId: httpTarget(3).publicationId }, { ...current, description: "unrequested content" }]) await assert.rejects(send(changed as Observation));
  await assert.rejects(worker.query("UPDATE social_sync.meta SET http_note_version=0"), /permission denied/);
  await assert.rejects(worker.query("UPDATE social_sync.retained_publications SET approved=true"), /permission denied/);
  await assert.rejects(reader.query("SELECT social_sync.ingest($1,$2,$3)", [key, hash(JSON.stringify(current)), JSON.stringify(current)]), /permission denied/);
  assert.equal((await reader.query("SELECT publication_key,payload FROM social_sync.publications")).rows.length, 0);
  await db.exec("UPDATE social_sync.meta SET http_note_version=0"); await assert.rejects(createCloudTransport(worker, undefined, false, true), { code: "XHS_HTTP_PROTOCOL_REQUIRED" });
  await createCloudTransport(worker); // Legacy handshake ignores the additive marker.
});
test("HTTP handshake distinguishes missing capability from an unavailable connection and exposes no driver text", async () => {
  for (const [code, expected] of [["42703", "XHS_HTTP_PROTOCOL_REQUIRED"], ["ECONNRESET", "CLOUD_UNAVAILABLE"]]) {
    const sql = { query: async () => { throw Object.assign(Error("private connection detail"), { code }); } } as SqlExecutor;
    await assert.rejects(createCloudTransport(sql, undefined, false, true), { code: expected });
  }
});
test("migration refuses an independently changed validator and rolls back its capability column",async t=>{
  const db=await PGlite.create();t.after(()=>db.close());
  await db.exec("CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;");
  await db.exec(await readFile(new URL(`../supabase/migrations/${migrations[0]}`,import.meta.url),"utf8"));
  await db.exec("CREATE OR REPLACE FUNCTION social_sync.valid_observation(p jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ BEGIN RETURN false; END $$;");
  await assert.rejects(db.exec(await readFile(new URL(`../supabase/migrations/${migration}`,import.meta.url),"utf8")),/BASE_CHANGED/);
  await db.exec("ROLLBACK");
  assert.equal((await db.query("SELECT column_name FROM information_schema.columns WHERE table_schema='social_sync' AND table_name='meta' AND column_name='http_note_version'")).rows.length,0);
});
