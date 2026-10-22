import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { automaticVideoTarget, classifyDiscoveredVideo } from "../scripts/social-sync/bilibili-discovery.ts";
import { hash, publicationKey } from "../scripts/social-sync/model.ts";
import { collectionKey } from "../scripts/social-sync/collection.ts";
import type { CollectionSnapshot } from "../scripts/social-sync/collection.ts";
import type { Observation } from "../scripts/social-sync/model.ts";
import { exampleCollectionSnapshot } from "./helpers/social-collection-samples.ts";
import { readRetainedSocialSnapshot } from "../src/server/social/retained-repository.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";

const at = () => new Date(Date.now() - 1000).toISOString();
function publication() {
  const target = automaticVideoTarget("10001", "BV0000000001"), value = classifyDiscoveredVideo(`<script>window.__INITIAL_STATE__=${JSON.stringify({ videoData: {
    bvid: target.publicationId, owner: { mid: 10001 }, state: 0, videos: 1, pages: [{ cid: 1000 }], title: "Example publication", pubdate: 1700000000, stat: {} } })};</script>`, target, at());
  assert.equal(value.type, "publication"); if (value.type !== "publication") throw Error("fixture"); return value.value;
}
async function engine(t: { after: (fn: () => Promise<void>) => void }) {
  const db = await PGlite.create(); t.after(() => db.close());
  await db.exec("CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;CREATE ROLE nb_reader;");
  for (const file of ["20261012005001_social_sync_v1.sql", "20261012015408_social_reader_v1.sql", "20261012020551_social_reader_binding_index.sql", "20261012054647_social_collections_v1.sql", "20261012213401_social_retained_projections.sql", "20261013214552_social_collection_follow_members.sql", "20261013225210_social_bilibili_account_discovery.sql"])
    await db.exec(await readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), "utf8"));
  const role = (name: string): SqlExecutor => ({ query: async <T>(sql: string, values?: unknown[]) => {
    await db.exec(`SET SESSION AUTHORIZATION ${name}`); try { return await db.query<T>(sql, values); } finally { await db.exec("SET SESSION AUTHORIZATION postgres"); }
  } });
  const worker = role("nb_social_worker"), reader = role("nb_social_reader");
  const ingest = (kind: "publication" | "collection", value: Observation | CollectionSnapshot) => worker.query("SELECT key,sha256 FROM social_sync.ingest_bilibili_account($1,$2,$3,$4)",
    [kind, kind === "publication" ? publicationKey(value as Observation) : collectionKey((value as CollectionSnapshot).target), hash(JSON.stringify(value)), JSON.stringify(value)]);
  const enable = () => db.exec("INSERT INTO social_sync.bilibili_accounts(account_id,enabled) VALUES('10001',true)");
  return { db, worker, reader, role, ingest, enable };
}

test("account enrollment defaults off, is author-bound, and leaves policy/approval tables unwritable", async t => {
  const e = await engine(t), p = publication();
  await assert.rejects(e.ingest("publication", p), /UNAUTHORIZED/);
  await e.enable(); const other = { ...p, accountId: "10002", workId: automaticVideoTarget("10002", p.publicationId).workId };
  await assert.rejects(e.ingest("publication", other), /UNAUTHORIZED/);
  await assert.rejects(e.ingest("publication", { ...p, workId: "other-work" }), /ACCOUNT_WORK/);
  await assert.rejects(e.worker.query("UPDATE social_sync.bilibili_accounts SET enabled=true"), /permission denied/);
  await assert.rejects(e.worker.query("INSERT INTO social_sync.works(work_id,title,approved) VALUES('other','Example',true)"), /permission denied/);
  const rows = (await e.db.query<{ granted: boolean }>("SELECT has_function_privilege('nb_social_reader','social_sync.ingest_bilibili_account(text,text,text,text)','EXECUTE') AS granted")).rows;
  assert.equal(rows[0]!.granted, false);
  assert.equal((await readRetainedSocialSnapshot(e.reader)).items.length, 0);
});

test("an owned new public video registers and projects atomically; replay keeps one card", async t => {
  const e = await engine(t); await e.enable(); const p = publication(), key = publicationKey(p);
  assert.deepEqual((await e.ingest("publication", p)).rows, [{ key, sha256: hash(JSON.stringify(p)) }]);
  const first = await readRetainedSocialSnapshot(e.reader); assert.equal(first.items.length, 1); assert.equal(first.items[0]!.id, p.workId);
  assert.equal(first.items[0]!.publications[0]!.originalUrl, p.originalUrl);
  await e.ingest("publication", p); assert.equal((await readRetainedSocialSnapshot(e.reader)).items.length, 1);
  const bad = { ...p, publicationId: "BV0000000002" }; await assert.rejects(e.ingest("publication", bad), /PAYLOAD/);
  assert.equal((await e.db.query<{ n: number }>("SELECT count(*)::int n FROM social_sync.bilibili_auto_bindings")).rows[0]!.n, 1);
});

test("new seasons automatically follow and fold members, while missing link evidence remains unknown", async t => {
  const e = await engine(t); await e.enable(); const p = publication(); await e.ingest("publication", p);
  const c = exampleCollectionSnapshot(at()); await e.ingest("collection", c);
  const first = (await readRetainedSocialSnapshot(e.reader)).items; assert.equal(first.length, 1); assert.equal(first[0]!.collection?.memberCount, 2);
  assert.equal(first[0]!.collection?.originalUrl, null);
  const next = structuredClone(c); next.observedAt = new Date(Date.now()).toISOString(); next.members.push({ id: "BV0000000003", publishedAt: null, parts: ["1004"], partsComplete: true });
  await e.ingest("collection", next); const after = (await readRetainedSocialSnapshot(e.reader)).items;
  assert.equal(after.length, 1); assert.equal(after[0]!.id, first[0]!.id); assert.equal(after[0]!.collection?.memberCount, 3);
  assert.equal(after[0]!.collection?.latestAddition?.addedVideos, 1);
});

test("disabled bindings and retained denials cannot be resurrected by account rediscovery", async t => {
  const e = await engine(t); await e.enable(); const p = publication(), key = publicationKey(p); await e.ingest("publication", p);
  await e.db.query("UPDATE social_sync.retained_publications SET approved=false WHERE publication_key=$1", [key]);
  const next = { ...p, observedAt: new Date().toISOString() }; await e.ingest("publication", next);
  assert.equal((await readRetainedSocialSnapshot(e.reader)).items.length, 0);
  await e.db.query("UPDATE social_sync.bindings SET enabled=false WHERE publication_key=$1", [key]);
  await assert.rejects(e.ingest("publication", next), /BINDING/);
  await e.db.exec("UPDATE social_sync.bilibili_accounts SET enabled=false");
  const target = automaticVideoTarget("10001", "BV0000000002"), other = { ...p, publicationId: target.publicationId, originalUrl: target.url, workId: target.workId };
  await assert.rejects(e.ingest("publication", other), /UNAUTHORIZED/);
});

test("a verified season link is limited to its automatically created accepted card and preserves sampling time",async t=>{
  const e=await engine(t);await e.enable();const c=exampleCollectionSnapshot(at()),key=collectionKey(c.target);await e.ingest("collection",c);
  const url=`https://space.bilibili.com/${c.target.accountId}/lists/${c.target.collectionId}?type=season`,checked=new Date().toISOString();
  await assert.rejects(e.worker.query("SELECT social_sync.bind_bilibili_season_link($1,$2,$3)",[key,url.replace("10001","10002"),checked]),/LINK_SCOPE/);
  assert.deepEqual((await e.worker.query("SELECT social_sync.bind_bilibili_season_link($1,$2,$3) accepted",[key,url,checked])).rows,[{accepted:true}]);
  const card=(await readRetainedSocialSnapshot(e.reader)).items[0]!.collection!;assert.equal(card.originalUrl,url);assert.equal(card.linkVerifiedAt,checked);assert.equal(card.observedAt,c.observedAt);
  await e.worker.query("SELECT social_sync.bind_bilibili_season_link($1,$2,$3)",[key,url,checked]);
  await e.db.query("UPDATE social_sync.retained_collections SET approved=false WHERE collection_key=$1",[key]);
  await assert.rejects(e.worker.query("SELECT social_sync.bind_bilibili_season_link($1,$2,$3)",[key,url,checked]),/DENIED/);
});

test("a new season also folds an existing multi-P card, and withdrawing the parent restores that child",async t=>{
  const e=await engine(t);await e.enable();const child=exampleCollectionSnapshot(at(),"multi-part"),parent=exampleCollectionSnapshot(at());
  await e.ingest("collection",child);assert.equal((await readRetainedSocialSnapshot(e.reader)).items.length,1);
  await e.ingest("collection",parent);const grouped=(await readRetainedSocialSnapshot(e.reader)).items;assert.equal(grouped.length,1);assert.equal(grouped[0]!.collection!.kind,"season");
  await e.db.query("UPDATE social_sync.retained_collections SET approved=false WHERE collection_key=$1",[collectionKey(parent.target)]);
  const restored=(await readRetainedSocialSnapshot(e.reader)).items;assert.equal(restored.length,1);assert.equal(restored[0]!.id,`bc_${collectionKey(child.target).slice(0,40)}`);
});
