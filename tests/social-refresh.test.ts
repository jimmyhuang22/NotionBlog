import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { config, hash, publicationKey, SocialSyncError } from "../scripts/social-sync/model.ts";
import { snapshotObservation } from "../scripts/social-sync/xiaohongshu.ts";
import { observation } from "../scripts/social-sync/bilibili.ts";
import { collectionKey } from "../scripts/social-sync/collection.ts";
import { collectionMemberShas, collectionReview, planRefresh, publicationReview, refreshConfig, reviewedCollectionSender, reviewedPublicationSender } from "../scripts/social-sync/refresh.ts";
import { openStore } from "../scripts/social-sync/store.ts";
import { openCollectionStore } from "../scripts/social-sync/collection-store.ts";
import { exampleCollectionSnapshot } from "./helpers/social-collection-samples.ts";

const at = "2026-01-02T00:00:00.000Z", now = "2026-01-03T00:00:00.000Z";
const pub = { platform: "bilibili", workId: "example-work", accountId: "10001", url: "https://www.bilibili.com/video/BV0000000001/" };
const note = { platform: "xiaohongshu", workId: "example-note", accountId: "000000000000000000000001", url: "https://www.xiaohongshu.com/explore/000000000000000000000002" };
const collection = () => exampleCollectionSnapshot(at);
function input() { return { version: 1, reviewedAt: at, cadence: { bilibiliHours: 6, xiaohongshuHours: 24 },
  stateDirectories: { publications: "/private/example/publications", collections: "/private/example/collections" },
  publications: [{ target: pub, kind: "video" }, { target: note, kind: "image-note" }], collections: [{ target: collection().target, memberShas: collectionMemberShas(collection()) }] }; }
function video(observedAt = at) {
  const target = config({ version: 1, publications: [pub] })[0]!;
  return observation(`<script>window.__INITIAL_STATE__=${JSON.stringify({ videoData: { bvid: target.publicationId, aid: 100, owner: { mid: 10001 }, title: "Example", desc: "Example",
    pic: "https://i0.hdslb.com/example.jpg", pubdate: 1700000000, stat: { aid: 100, like: 0 } } })};</script>`, target, observedAt);
}
function xhs(observedAt = at) {
  const target = config({ version: 1, publications: [note] })[0]!;
  return snapshotObservation({ version: 1, source: "browser-note-state", observedAt, pageUrl: target.url,
    note: { noteId: target.publicationId, userId: target.accountId, type: "normal", title: "Example note", time: 1700000000000,
      lastUpdateTime: null, coverUrl: null, interactInfo: { likedCount: "1.2万", commentCount: "0", shareCount: null, collectedCount: null } } }, target, observedAt);
}
const error = (code: string) => (e: unknown) => e instanceof SocialSyncError && e.code === code;

test("refresh due times use each successful observation, including the exact six/hour and daily boundary", () => {
  const sources = { publication: (t: { platform: string }) => t.platform === "bilibili" ? video() : xhs(), collection: () => collection() };
  const before = planRefresh(input(), sources, "2026-01-02T05:59:59.999Z"); assert.equal(before.summary.due, 0);
  const six = planRefresh(input(), sources, "2026-01-02T06:00:00.000Z"); assert.equal(six.summary.due, 2); assert.equal(six.browserSessionRequired, false);
  const daily = planRefresh(input(), sources, now); assert.equal(daily.summary.due, 3); assert.equal(daily.browserSessionRequired, true);
  assert.equal(daily.executed, false); assert.equal(daily.websiteEligibilityRenewed, false);
  assert.equal(xhs().metrics.likes, null); assert.equal(xhs().metricDisplay.likes, "1.2万");
});
test("missing samples are due; future evidence and a source returning another identity fail", () => {
  assert.equal(planRefresh(input(), { publication: () => null, collection: () => null }, now).summary.due, 3);
  assert.throws(() => planRefresh(input(), { publication: () => video("2026-01-03T00:00:31.000Z"), collection: () => null }, now), error("REFRESH_TIME_INVALID"));
  const wrong = video(); wrong.publicationId = "BV0000000002";
  assert.throws(() => planRefresh(input(), { publication: () => wrong, collection: () => null }, now), error("REFRESH_STATE_INVALID"));
});
test("fixed scope rejects duplicate identities, unexpected fields, expanded cadence and conflicting parsed IDs", () => {
  const raw = input(), parsed = refreshConfig(raw); assert.deepEqual(refreshConfig(parsed), parsed);
  for (const change of [{ ...raw, cookie: "example" }, { ...raw, cadence: { bilibiliHours: 1, xiaohongshuHours: 24 } },
    { ...raw, publications: [...raw.publications, raw.publications[0]] }, { ...raw, collections: [{ ...raw.collections[0], memberShas: [] }] }]) assert.throws(() => refreshConfig(change), error("REFRESH_CONFIG_INVALID"));
  const altered = structuredClone(parsed); altered.publications[0]!.target.publicationId = "BV0000000002";
  assert.throws(() => refreshConfig(altered), error("REFRESH_CONFIG_INVALID"));
});
test("due lists use the existing twenty-target batches without discovering extra account content", () => {
  const raw = input(); raw.collections = [];
  raw.publications = Array.from({ length: 41 }, (_, i) => ({ target: { ...pub, workId: `example-${i}`, url: `https://www.bilibili.com/video/BV${String(i).padStart(10, "0")}/` }, kind: "video" }));
  const plan = planRefresh(raw, { publication: () => null, collection: () => null }, now);
  assert.equal(plan.summary.configured, 41); assert.equal(plan.batches.length, 3);
  assert.deepEqual(plan.batches.map(b => config(b.config).length), [20, 20, 1]);
});
test("member counts and dates may refresh; added, removed, changed parts or completeness require review", () => {
  const scope = refreshConfig(input()), original = collection(), stats = structuredClone(original);
  stats.metrics.likes = 5; stats.members.reverse(); stats.members[0]!.publishedAt = null;
  assert.deepEqual(collectionReview(scope, stats), { allowed: true });
  const added = structuredClone(original); added.members.push({ id: "BV0000000003", publishedAt: null, parts: ["1003"], partsComplete: true });
  const removed = structuredClone(original); removed.members.pop();
  const changed = structuredClone(original); changed.members[0]!.parts.push("1004");
  const complete = structuredClone(original); complete.members[1]!.partsComplete = true;
  for (const snapshot of [added, removed, changed, complete]) assert.deepEqual(collectionReview(scope, snapshot), { allowed: false, code: "MEMBERSHIP_REVIEW_REQUIRED" });
  const plan = planRefresh(input(), { publication: () => null, collection: () => added }, now);
  assert.equal(plan.summary.reviewRequired, 1); assert(!plan.batches.some(b => b.kind === "bilibili-collections"));
});
test("local member signatures match the installed Postgres function", async t => {
  const db = await PGlite.create(); t.after(() => db.close());
  const migration = await readFile(new URL("../supabase/migrations/20261012054647_social_collections_v1.sql", import.meta.url), "utf8");
  const definition = migration.match(/CREATE FUNCTION social_sync\.collection_member_digest\(m jsonb\)[\s\S]*?\$\$;/)![0];
  await db.exec("CREATE SCHEMA social_sync;"); await db.exec(definition);
  const snapshot = collection();
  const actual = await db.query<{ sha: string }>("SELECT social_sync.collection_member_digest(value) AS sha FROM jsonb_array_elements($1::jsonb)", [JSON.stringify(snapshot.members)]);
  assert.deepEqual(actual.rows.map(x => x.sha).sort(), collectionMemberShas(snapshot));
});
test("new work bindings and note kind changes do not inherit fixed publication approval", () => {
  const scope = refreshConfig(input()), row = video(); row.workId = "another-work";
  assert.deepEqual(publicationReview(scope, row), { allowed: false, code: "WORK_BINDING_REVIEW_REQUIRED" });
  const n = xhs(); n.kind = "video";
  assert.deepEqual(publicationReview(scope, n), { allowed: false, code: "KIND_REVIEW_REQUIRED" });
  const unlisted = input(); unlisted.publications = [unlisted.publications[1]!];
  assert.deepEqual(publicationReview(refreshConfig(unlisted), video()), { allowed: false, code: "TARGET_REVIEW_REQUIRED" });
});
test("reviewed senders refuse altered members, bad digest and expired samples before transport", async () => {
  let calls = 0; const transport = async (item: { key: string; sha256: string }) => { calls++; return { key: item.key, sha256: item.sha256 }; };
  const snapshot = collection(); snapshot.observedAt = "2026-01-02T23:00:00.000Z";
  const send = reviewedCollectionSender(input(), transport, () => now), pending = { key: collectionKey(snapshot.target), sha256: hash(JSON.stringify(snapshot)), snapshot };
  await send(pending); assert.equal(calls, 1);
  const changed = structuredClone(pending); changed.snapshot.members[0]!.parts.push("1004"); changed.sha256 = hash(JSON.stringify(changed.snapshot));
  await assert.rejects(send(changed), error("MEMBERSHIP_REVIEW_REQUIRED"));
  await assert.rejects(send({ ...pending, sha256: "0".repeat(64) }), error("LOCAL_DATA_INVALID"));
  const old = collection(); await assert.rejects(send({ key: pending.key, sha256: hash(JSON.stringify(old)), snapshot: old }), error("REFRESH_OBSERVATION_EXPIRED"));
  const future = { ...pending.snapshot, observedAt: "2026-01-03T00:00:31.000Z" };
  await assert.rejects(send({ key: pending.key, sha256: hash(JSON.stringify(future)), snapshot: future }), error("REFRESH_OBSERVATION_EXPIRED"));
  assert.equal(calls, 1);
  const pubSend = reviewedPublicationSender(input(), transport, () => now), observation = video("2026-01-02T23:00:00.000Z");
  await pubSend({ key: publicationKey(observation), sha256: hash(JSON.stringify(observation)), observation });
  assert.equal(calls, 2);
});
test("planning CLI reads existing stores without ingestion, migration, cloud configuration or source requests", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nb-refresh-"))); await chmod(root, 0o700); t.after(() => rm(root, { recursive: true, force: true }));
  const scope = input(); scope.stateDirectories = { publications: root, collections: root };
  const p = await openStore(root), c = await openCollectionStore(root); p!.ingest(video()); p!.ingest(xhs()); c!.ingest(collection());
  const before = { publications: p!.status(), collections: c!.status() }; p!.close(); c!.close();
  await writeFile(join(root, "refresh-config.json"), JSON.stringify(scope), { mode: 0o600 });
  const cli = fileURLToPath(new URL("../scripts/social-sync/refresh-cli.ts", import.meta.url));
  const result = spawnSync(process.execPath, [cli, "plan", root], { encoding: "utf8" }); assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout); assert.equal(summary.configured, 3); assert.equal(summary.executed, false);
  assert(!result.stdout.includes("10001") && !result.stdout.includes("https://"));
  const plan = JSON.parse(await readFile(join(root, "refresh-plan.json"), "utf8")); assert.equal(plan.websiteEligibilityRenewed, false);
  assert.equal((await stat(join(root, "refresh-plan.json"))).mode & 0o077, 0);
  const afterP = await openStore(root, true), afterC = await openCollectionStore(root, true);
  assert.deepEqual({ publications: afterP!.status(), collections: afterC!.status() }, before); afterP!.close(); afterC!.close();
  await writeFile(join(root, "worker.lock"), "{}", { mode: 0o600 });
  const busy = spawnSync(process.execPath, [cli, "plan", root], { encoding: "utf8" }); assert.equal(busy.status, 1); assert.match(busy.stderr, /BUSY/);
});
