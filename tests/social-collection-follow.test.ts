import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PGlite } from "@electric-sql/pglite";
import type { SqlExecutor } from "../src/server/database/sql.ts";
import { collectionKey } from "../scripts/social-sync/collection.ts";
import { collectionMemberShas, collectionReview, planRefresh, refreshConfig, reviewedCollectionSender } from "../scripts/social-sync/refresh.ts";
import { executeRefresh } from "../scripts/social-sync/refresh-executor.ts";
import { openCollectionStore } from "../scripts/social-sync/collection-store.ts";
import { config, hash, publicationKey, SocialSyncError } from "../scripts/social-sync/model.ts";
import { observation } from "../scripts/social-sync/bilibili.ts";
import type { CollectionSnapshot } from "../scripts/social-sync/collection.ts";
import { exampleCollectionSnapshot } from "./helpers/social-collection-samples.ts";
import { readRetainedSocialSnapshot } from "../src/server/social/retained-repository.ts";

const stamp = (hours: number) => new Date(Date.now() + hours * 3600000).toISOString();
const original = () => exampleCollectionSnapshot(stamp(-72));
function scope(follow = false) {
  const c = original();
  return { version: 1, reviewedAt: c.observedAt, cadence: { bilibiliHours: 6, xiaohongshuHours: 24 },
    stateDirectories: { publications: "/private/example/publications", collections: "/private/example/collections" },
    publications: [], collections: [{ target: c.target, memberShas: collectionMemberShas(c), ...(follow ? { membershipMode: "follow-public" } : {}) }] };
}
function added(c = original(), at = stamp(-4)) {
  const result = structuredClone(c); result.observedAt = at;
  result.members.push({ id: "BV0000000003", publishedAt: null, parts: ["1003"], partsComplete: true });
  return result;
}

test("following is explicit per collection; legacy normalized scopes and fixed signatures remain unchanged", async () => {
  const legacy = refreshConfig(scope()), following = refreshConfig(scope(true)), c = added();
  assert(!Object.hasOwn(legacy.collections[0]!, "membershipMode"));
  assert.deepEqual(refreshConfig(following), following);
  assert.deepEqual(collectionReview(legacy, c), { allowed: false, code: "MEMBERSHIP_REVIEW_REQUIRED" });
  assert.deepEqual(collectionReview(following, c), { allowed: true });
  const changed = structuredClone(c); changed.members[0]!.parts.push("1004");
  assert.deepEqual(collectionReview(following, changed), { allowed: true });
  for (const mode of [true, false, null, "all", "fixed"]) {
    const raw = scope(true); raw.collections[0]!.membershipMode = mode as string;
    assert.throws(() => refreshConfig(raw), SocialSyncError);
  }
  const other = structuredClone(c); other.target.collectionId = "201";
  assert.deepEqual(collectionReview(following, other), { allowed: false, code: "TARGET_REVIEW_REQUIRED" });
  const swapped = structuredClone(c); swapped.target.accountId = "10002";
  assert.deepEqual(collectionReview(following, swapped), { allowed: false, code: "TARGET_REVIEW_REQUIRED" });
  const incomplete = structuredClone(c); incomplete.membershipComplete = false as unknown as true;
  assert.throws(() => collectionReview(following, incomplete), SocialSyncError);
  let sent = 0;
  const send = reviewedCollectionSender(following, async p => { sent++; return p; }, () => c.observedAt);
  await send({ key: collectionKey(c.target), sha256: hash(JSON.stringify(c)), snapshot: c });
  assert.equal(sent, 1);
  assert.equal(planRefresh(following, { publication: () => null, collection: () => c }, stamp(0)).summary.reviewRequired, 0);
});

test("an earlier member-review hold is re-evaluated after opt-in and a fresh capture is acknowledged", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nb-follow-"))); await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await openCollectionStore(root); assert(store); t.after(() => store.close());
  const c = original(); store.ingest(c); const initial = store.pendingFor(c.target)!; store.acknowledge(initial);
  const current = added(c, stamp(-1)), raw = scope(true); raw.stateDirectories = { publications: root, collections: root };
  let captures = 0, sent = 0;
  const result = await executeRefresh(raw, { publications: null, collections: store, checkScope: async () => {},
    sendPublication: async p => p, sendCollection: async p => { sent++; return p; }, saveReview: async () => { throw Error("unexpected hold"); }, progress: async () => {} },
    { platform: "bilibili", limit: 1, now: () => current.observedAt, held: [{ type: "collection", key: initial.key, value: added(c, stamp(-5)) }], collectCollection: async () => { captures++; return current; } });
  assert.equal(captures, 1); assert.equal(sent, 1); assert.equal(result.reviewRequired, 0); assert.equal(result.uploaded, 1);
  assert.equal(store.pendingFor(c.target), null); assert.equal(store.latest(c.target)!.snapshot.members.length, 3);
});

async function engine(t: { after: (fn: () => Promise<void>) => void }) {
  const db = await PGlite.create(); t.after(() => db.close());
  await db.exec("CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;CREATE ROLE nb_reader;");
  for (const file of ["20261012005001_social_sync_v1.sql", "20261012015408_social_reader_v1.sql", "20261012020551_social_reader_binding_index.sql", "20261012054647_social_collections_v1.sql", "20261012213401_social_retained_projections.sql", "20261013214552_social_collection_follow_members.sql"])
    await db.exec(await readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), "utf8"));
  const role = (name: string): SqlExecutor => ({ query: <T>(sql: string, values?: unknown[]) => db.transaction(async tx => { await tx.exec(`SET LOCAL ROLE ${name}`); return tx.query<T>(sql, values); }) });
  const worker = role("nb_social_worker"), reader = role("nb_social_reader");
  const ingest = (c: CollectionSnapshot) => worker.query("SELECT * FROM social_sync.ingest_collection($1,$2,$3)", [collectionKey(c.target), hash(JSON.stringify(c)), JSON.stringify(c)]);
  const register = async (c: CollectionSnapshot) => { await db.query("INSERT INTO social_sync.collection_bindings(account_id,kind,collection_id,enabled) VALUES($1,$2,$3,true)", [c.target.accountId, c.target.kind, c.target.collectionId]); await ingest(c); };
  const approve = (c: CollectionSnapshot) => db.query(`INSERT INTO social_sync.retained_collections(collection_key,approved,reviewed_at,title,approved_source_sha256,source_sha256,approved_member_keys)
    SELECT collection_key,true,now(),'Example collection',payload_sha256,payload_sha256,member_review_keys FROM social_sync.collection_states WHERE collection_key=$1`, [collectionKey(c.target)]);
  const follow = (c: CollectionSnapshot) => db.query(`UPDATE social_sync.retained_collections r SET follow_public_members=true,reviewed_at=now(),approved_source_sha256=s.payload_sha256,source_sha256=s.payload_sha256,approved_member_keys=s.member_review_keys
    FROM social_sync.collection_states s WHERE s.collection_key=r.collection_key AND r.collection_key=$1`, [collectionKey(c.target)]);
  return { db, role, reader, worker, ingest, register, approve, follow };
}

test("following still rejects foreign authors, paid episodes and incomplete platform directories before ingestion", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nb-follow-reject-"))); await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await openCollectionStore(root); assert(store); t.after(() => store.close());
  const c = original(); store.ingest(c); store.acknowledge(store.pendingFor(c.target)!);
  const raw = scope(true); raw.stateDirectories = { publications: root, collections: root };
  const episode = (bvid: string, aid: number, cid: number) => ({ season_id: 200, bvid, aid, pages: [{ cid }], arc: { aid, author: { mid: 10001 }, state: 0, videos: 0, pubdate: 1700000000, is_upower_exclusive: false } });
  const source = () => ({ videoData: { bvid: "BV0000000001", aid: 100, owner: { mid: 10001 }, state: 0, title: "Example", season_id: 200,
    pages: [{ cid: 1000 }], videos: 1, pubdate: 1700000000, stat: { aid: 100 },
    ugc_season: { id: 200, mid: 10001, title: "Example", ep_count: 2, stat: { season_id: 200 }, sections: [{ season_id: 200, episodes: [episode("BV0000000001", 100, 1000), episode("BV0000000002", 101, 1001)] }] } } });
  const cases: { mutate: (s: ReturnType<typeof source>) => void; code: string }[] = [
    { mutate: s => { s.videoData.ugc_season.sections[0]!.episodes[1]!.arc.author.mid = 10002; }, code: "IDENTITY_MISMATCH" },
    { mutate: s => { s.videoData.ugc_season.sections[0]!.episodes[1]!.arc.is_upower_exclusive = true; }, code: "SOURCE_BLOCKED" },
    { mutate: s => { s.videoData.ugc_season.ep_count = 3; }, code: "COLLECTION_INCOMPLETE" },
  ];
  let sent = 0;
  for (const item of cases) {
    const state = source(); item.mutate(state);
    const result = await executeRefresh(raw, { publications: null, collections: store, checkScope: async () => {},
      sendPublication: async p => p, sendCollection: async p => { sent++; return p; }, saveReview: async () => {}, progress: async () => {} },
      { platform: "bilibili", limit: 1, request: async () => new Response(`<script>window.__INITIAL_STATE__=${JSON.stringify(state)};</script>`, { headers: { "content-type": "text/html" } }) });
    assert.equal(result.failed, 1); assert.equal(result.uploaded, 0); assert.equal(result.entries[0]!.code, item.code);
    assert.deepEqual(store.latest(c.target)!.snapshot, c); assert.equal(store.pendingFor(c.target), null);
  }
  assert.equal(sent, 0);
});

test("cloud opt-in follows additions and parts, folds the current members, and does not create extra cards", async t => {
  const e = await engine(t), c = original(); await e.register(c); await e.approve(c);
  const key = collectionKey(c.target), before = (await readRetainedSocialSnapshot(e.reader)).items[0]!;
  const pubTarget = config({ version: 1, publications: [{ platform: "bilibili", workId: "example-member", accountId: "10001", url: "https://www.bilibili.com/video/BV0000000003/" }] })[0]!;
  const p = observation(`<script>window.__INITIAL_STATE__=${JSON.stringify({ videoData: { bvid: pubTarget.publicationId, owner: { mid: 10001 }, title: "Example", stat: {} } })};</script>`, pubTarget, stamp(-6));
  await e.db.query("INSERT INTO social_sync.bindings(platform,account_id,publication_id,work_id,enabled) VALUES('bilibili',$1,$2,$3,true)", [p.accountId, p.publicationId, p.workId]);
  await e.worker.query("SELECT * FROM social_sync.ingest($1,$2,$3)", [publicationKey(p), hash(JSON.stringify(p)), JSON.stringify(p)]);
  await e.db.query("INSERT INTO social_sync.works(work_id,title,approved) VALUES($1,'Example member',true)", [p.workId]);
  await e.db.query("INSERT INTO social_sync.retained_publications(publication_key,work_id,approved,reviewed_at,reviewed_kind,approved_source_sha256,source_sha256) VALUES($1,$2,true,now(),'video',$3,$3)", [publicationKey(p), p.workId, hash(JSON.stringify(p))]);
  assert.equal((await readRetainedSocialSnapshot(e.reader)).items.length, 2);
  await e.follow(c);
  const review = (await e.db.query("SELECT reviewed_at,approved_source_sha256,approved_member_keys FROM social_sync.retained_collections")).rows;
  const a = added(c); await e.ingest(a);
  let snapshot = await readRetainedSocialSnapshot(e.reader);
  assert.equal(snapshot.items.length, 1); assert.equal(snapshot.items[0]!.id, before.id);
  assert.equal(snapshot.items[0]!.collection!.memberCount, 3); assert.equal(snapshot.items[0]!.collection!.latestAddition!.addedVideos, 1);
  assert.equal(snapshot.items[0]!.collection!.observedAt, a.observedAt);
  assert.deepEqual((await e.db.query("SELECT reviewed_at,approved_source_sha256,approved_member_keys FROM social_sync.retained_collections")).rows, review);
  const parts = structuredClone(a); parts.observedAt = stamp(-3); parts.members[0]!.parts.push("1004"); await e.ingest(parts);
  snapshot = await readRetainedSocialSnapshot(e.reader); assert.equal(snapshot.items.length, 1); assert.equal(snapshot.items[0]!.collection!.latestAddition!.addedParts, 1);
  const removed = structuredClone(parts); removed.observedAt = stamp(-2); removed.members.pop(); await e.ingest(removed);
  assert.equal((await readRetainedSocialSnapshot(e.reader)).items.length, 2);
  const returned = structuredClone(parts); returned.observedAt = stamp(-1); await e.ingest(returned);
  snapshot = await readRetainedSocialSnapshot(e.reader); assert.equal(snapshot.items.length, 1);
  assert.deepEqual(snapshot.items[0]!.collection!.latestAddition, (await e.db.query<{ card: { latestAddition: unknown } }>("SELECT card FROM social_sync.collection_states WHERE collection_key=$1", [key])).rows[0]!.card.latestAddition);
  assert.equal(snapshot.items[0]!.collection!.latestAddition!.addedVideos, 0);
  assert.equal(snapshot.items[0]!.collection!.latestAddition!.detectedAt, parts.observedAt);
});

test("new cards stay unapproved and default fixed; disabling follows requires freezing the actual current version", async t => {
  const e = await engine(t), c = original(); await e.register(c);
  assert.equal((await readRetainedSocialSnapshot(e.reader)).items.length, 0);
  await e.approve(c);
  assert.equal((await e.db.query<{ follow_public_members: boolean }>("SELECT follow_public_members FROM social_sync.retained_collections")).rows[0]!.follow_public_members, false);
  await e.ingest(added(c)); assert.equal((await readRetainedSocialSnapshot(e.reader)).items[0]!.collection!.memberCount, 2);
  await assert.rejects(e.db.query("UPDATE social_sync.retained_collections SET follow_public_members=true"), /NB_SOCIAL_RETAINED_REVIEW|NB_SOCIAL_RETAINED_SOURCE/);
  await e.follow(c); assert.equal((await readRetainedSocialSnapshot(e.reader)).items[0]!.collection!.memberCount, 3);
  const changed = added(c, stamp(-3)); changed.members[0]!.parts.push("1004"); await e.ingest(changed);
  await assert.rejects(e.db.query("UPDATE social_sync.retained_collections SET follow_public_members=false"), /NB_SOCIAL_RETAINED_SOURCE/);
  await e.db.query(`UPDATE social_sync.retained_collections r SET follow_public_members=false,reviewed_at=now(),approved_source_sha256=s.payload_sha256,source_sha256=s.payload_sha256,approved_member_keys=s.member_review_keys FROM social_sync.collection_states s WHERE s.collection_key=r.collection_key`);
  const frozen = await readRetainedSocialSnapshot(e.reader), next = added(c, stamp(-1)); next.members.push({ id: "BV0000000004", publishedAt: null, parts: ["1005"], partsComplete: true });
  await e.ingest(next); assert.deepEqual(await readRetainedSocialSnapshot(e.reader), frozen);
});

test("multipart follows increase the existing card part count with its original publication date", async t => {
  const e = await engine(t), c = exampleCollectionSnapshot(stamp(-72), "multi-part");
  await e.register(c); await e.approve(c); await e.follow(c);
  const before = (await readRetainedSocialSnapshot(e.reader)).items[0]!;
  const changed = structuredClone(c); changed.observedAt = stamp(-1); changed.members[0]!.parts.push("1004"); await e.ingest(changed);
  const snapshot = await readRetainedSocialSnapshot(e.reader);
  assert.equal(snapshot.items.length, 1); assert.equal(snapshot.items[0]!.id, before.id);
  assert.equal(snapshot.items[0]!.collection!.memberCount, 3);
  assert.equal(snapshot.items[0]!.collection!.latestAddition!.addedParts, 1);
  assert.equal(snapshot.items[0]!.collection!.firstPublishedAt, c.firstPublishedAt);
});

test("binding withdrawal clears follow authorization and re-enabling cannot republish automatically", async t => {
  const e = await engine(t), c = original(); await e.register(c); await e.approve(c); await e.follow(c);
  await e.db.query("UPDATE social_sync.collection_bindings SET enabled=false");
  const row = (await e.db.query<{ approved: boolean; follow_public_members: boolean }>("SELECT approved,follow_public_members FROM social_sync.retained_collections")).rows[0]!;
  assert.equal(row.approved, false); assert.equal(row.follow_public_members, false);
  await e.db.query("UPDATE social_sync.collection_bindings SET enabled=true"); await e.ingest(added(c));
  assert.equal((await readRetainedSocialSnapshot(e.reader)).items.length, 0);
});

test("enabling follow policy alone cannot promote activity from a formerly unreviewed, removed addition", async t => {
  const e = await engine(t), c = original(); await e.register(c); await e.approve(c);
  const before = (await readRetainedSocialSnapshot(e.reader)).items[0]!.collection!;
  await e.ingest(added(c, stamp(-5)));
  const removed = structuredClone(c); removed.observedAt = stamp(-4); await e.ingest(removed);
  await e.follow(c);
  const current = (await readRetainedSocialSnapshot(e.reader)).items[0]!.collection!;
  assert.deepEqual(current.activity, before.activity); assert.deepEqual(current.latestAddition, before.latestAddition);
});

test("worker, reader and public roles cannot enable follows, inspect private policy or call the trigger bridge", async t => {
  const e = await engine(t);
  for (const role of ["nb_social_worker", "nb_social_reader", "anon", "authenticated", "service_role", "nb_reader"]) {
    const actor = e.role(role);
    await assert.rejects(actor.query("UPDATE social_sync.retained_collections SET follow_public_members=true"), /permission denied/);
    await assert.rejects(actor.query("SELECT follow_public_members FROM social_sync.retained_collections"), /permission denied/);
    await assert.rejects(actor.query("SELECT social_sync.sync_retained_source()"), /permission denied/);
  }
});
