import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { createMockRepository } from "../adapters/mock-repository.ts";
import { contentFeatures } from "../config/features.ts";
import { WEBSITE_SCHEMA_DIGEST } from "../contracts/website-sync.ts";
import { fixtureItems } from "../fixtures/content.ts";
import { psnRows } from "../scripts/game-sync/model.ts";
import { planPsnWebsiteTrophies, psnWebsiteTrophySnapshot, writePsnWebsiteTrophies } from "../scripts/game-sync/website-trophies.ts";
import { installPublication } from "../scripts/website-sync/publication-migration.ts";
import { contentDetailResponse, contentListResponse } from "../src/lib/content/http.ts";
import { createGameTrophyReader } from "../src/server/database/game-trophies.ts";
import { publicationWriter } from "../src/server/database/publication.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";
import { configDigest } from "../src/server/database/website-validation.ts";

const owner = "fixture-account";
const item = { ...fixtureItems.game[0], id: "e".repeat(32), cover: null };
const privateGameId = "f".repeat(32);
const earnedZero = { platinum: 0, gold: 0, silver: 0, bronze: 0 };
const ps4 = { npCommunicationId: "fixture-set-a", trophyTitlePlatform: "PS4", hiddenFlag: false, progress: 37,
  earnedTrophies: { platinum: 0, gold: 1, silver: 2, bronze: 4 },
  definedTrophies: { platinum: 1, gold: 2, silver: 4, bronze: 8 } };
const ps5 = { ...ps4, npCommunicationId: "fixture-set-b", trophyTitlePlatform: "PS5", progress: 0, earnedTrophies: earnedZero };
const titles = [
  { titleId: "fixture-product-a", name: "Fixture PS4", category: "ps4_game" },
  { titleId: "fixture-product-b", name: "Fixture PS5", category: "ps5_native_game" },
  { titleId: "fixture-private-product", name: "Fixture unpublished game", category: "ps5_native_game" },
];
const bindings = { "PSN:PS4:fixture-product-a": item.id, "PSN:PS5:fixture-product-b": item.id,
  "PSN:PS5:fixture-private-product": privateGameId };

function snapshot(observedAt: string, first: Record<string, unknown>[], second: Record<string, unknown>[]) {
  const sets = new Map([
    [titles[0].titleId, first], [titles[1].titleId, second],
    [titles[2].titleId, [{ ...ps5, npCommunicationId: "fixture-set-c" }]],
  ]);
  return psnWebsiteTrophySnapshot(owner, observedAt, psnRows(titles, "fixture", observedAt, sets), sets);
}

test("PSN plans keep per-set grades and zero, and reject private, missing or ambiguous associations", () => {
  const observedAt = new Date().toISOString();
  const config = { bindings, excluded: [] as string[] };
  const input = snapshot(observedAt, [ps4], [ps5]);
  const plan = planPsnWebsiteTrophies(input, owner, config);
  const sets = plan.sets.filter(set => set.gameId === item.id);
  assert.deepEqual(sets.map(set => [set.platform, set.earned, set.total, set.progressPercent]), [
    ["PS4", 7, 15, 37], ["PS5", 0, 15, 0],
  ]);
  assert.deepEqual(sets[0].grades.gold, { earned: 1, total: 2 });
  assert.doesNotMatch(JSON.stringify(plan), /fixture-set|fixture-product|fixture-account/);
  assert.throws(() => planPsnWebsiteTrophies(input, "other-account", config), /INVALID_TROPHY_SNAPSHOT/);
  assert.throws(() => planPsnWebsiteTrophies(input, owner, config, Date.parse(observedAt) + 3600001), /INVALID_TROPHY_SNAPSHOT/);

  const shared = { ...ps4, trophyTitlePlatform: "PS4,PS5" };
  const sharedInput = snapshot(observedAt, [shared], [shared]);
  const forGame = (value: typeof input, policy = config) => planPsnWebsiteTrophies(value, owner, policy).sets
    .filter(set => set.gameId === item.id);
  assert.deepEqual(forGame(sharedInput).map(set => set.platform), ["PS4 / PS5"]);
  assert.deepEqual(forGame(sharedInput, { bindings, excluded: [Object.keys(bindings)[1]] }), []);
  assert.deepEqual(forGame(sharedInput, { ...config, bindings: { ...bindings, "PSN:PS5:fixture-product-b": privateGameId } }), []);
  assert.deepEqual(forGame(snapshot(observedAt, [shared], [{ ...shared, hiddenFlag: true }])), []);
  assert.deepEqual(forGame(snapshot(observedAt, [shared], [{ ...shared, hiddenFlag: undefined }])), []);
  assert.deepEqual(forGame(snapshot(observedAt, [], [{ ...ps5, earnedTrophies: undefined }])), []);
  assert.equal(forGame(snapshot(observedAt, [], [{ ...ps5, progress: undefined }]))[0].progressPercent, null);
});

test("one reader discovers a newly installed extension after the negative capability window", async t => {
  let now = Date.now(), capabilities = 0, available = false;
  t.mock.method(Date, "now", () => now);
  const db: SqlExecutor = { async query<T>(sql: string) {
    if (sql.includes("pg_catalog.pg_proc")) {
      capabilities++;
      return { rows: [{ result: available }] as T[] };
    }
    return { rows: [{ result: [{ id: "fixture-trophy-set" }] }] as T[] };
  } };
  const read = createGameTrophyReader(db, "published");
  assert.deepEqual(await Promise.all([read(item.id, item.slug), read(item.id, item.slug)]), [[], []]);
  available = true;
  now += 29_999;
  assert.deepEqual(await read(item.id, item.slug), []);
  assert.equal(capabilities, 1);
  now += 1;
  const results = await Promise.all([read(item.id, item.slug), read(item.id, item.slug)]);
  assert.deepEqual(results, [[{ id: "fixture-trophy-set" }], [{ id: "fixture-trophy-set" }]]);
  now += 30_000;
  assert.deepEqual(await read(item.id, item.slug), results[0]);
  assert.equal(capabilities, 2);
});

test("local PostgreSQL stores PSN sets atomically and reads only currently eligible games", async t => {
  const db = await PGlite.create();
  t.after(() => db.close());
  const localSql = (path: string) => readFile(new URL(path, import.meta.url), "utf8");
  await db.exec("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;");
  await db.exec(await localSql("../database/website-migrations/001_website.sql"));
  await db.query("UPDATE nb_v2.state SET schema_digest=$1", [WEBSITE_SCHEMA_DIGEST]);
  const operator: SqlExecutor = { async query<T>(sql: string, values?: unknown[]) {
    if (sql.startsWith("--")) { await db.exec(sql); return { rows: [] }; }
    return db.query<T>(sql, values);
  } };
  await installPublication(operator);
  const role = (name: "nb_reader" | "nb_writer" | "anon"): SqlExecutor => ({
    query: <T>(sql: string, values?: unknown[]) => db.transaction(async tx => {
      await tx.exec(`SET LOCAL ROLE ${name}`);
      return tx.query<T>(sql, values);
    }),
  });
  assert.deepEqual(await createGameTrophyReader(role("nb_reader"), "qualified")(item.id, item.slug), []);
  await db.exec(await localSql("../database/game-trophy-migrations/001_psn_trophy_sets.sql"));
  const sources = [{ key: "game", kind: "game", mode: "all", dataSourceId: "fixture-source", databaseParentId: null, pageId: null }];
  const digest = configDigest([sources, []]);
  await db.query("SELECT nb_v2_api.configure_policy($1,600,$2::jsonb,'[]')", [digest, JSON.stringify(sources)]);
  const writer = publicationWriter(role("nb_writer"), "published");
  const lease = await writer.begin(randomUUID(), digest);
  await writer.stage(lease, [{
    detail: { item, document: { blocks: [], toc: [], completeness: "complete" } },
    evidence: { sourceKey: "game", dataSourceId: "fixture-source", databaseParentId: null,
      courseId: null, parentId: null, ordinal: 0 },
  }]);
  await writer.promote(lease, { records: 1, media: 0, complete: true });

  const before = Date.now() - 1000;
  const config = { bindings, excluded: [] };
  const initial = planPsnWebsiteTrophies(snapshot(new Date(before).toISOString(), [ps4], [ps5]), owner, config);
  const write = (plan: typeof initial) => writePsnWebsiteTrophies(role("nb_writer"), plan);
  const read = createGameTrophyReader(role("nb_reader"), "published");
  assert.equal(await write(initial), true);
  assert.equal(await write(initial), false);
  const expected = initial.sets.filter(set => set.gameId === item.id).map(({ gameId: _gameId, ...set }) => set);
  assert.deepEqual(await read(item.id, item.slug), expected);
  assert.deepEqual(await createGameTrophyReader(role("nb_reader"), "qualified")(item.id, item.slug), expected);
  assert.deepEqual(await read(item.id, "wrong-slug"), []);
  assert.deepEqual(await read(privateGameId, item.slug), []);
  await assert.rejects(role("nb_reader").query("SELECT * FROM nb_game_trophies.psn_sets"), /permission denied/);
  await assert.rejects(role("nb_reader").query("SELECT nb_game_trophies_api.replace_psn_snapshot(now(),'[]')"), /permission denied/);
  await assert.rejects(role("nb_writer").query("SELECT nb_game_trophies_api.read_game_sets('x','y','published')"), /permission denied/);
  await assert.rejects(role("anon").query("SELECT nb_game_trophies_api.read_game_sets('x','y','published')"), /permission denied/);

  const later = new Date(before + 500).toISOString();
  await assert.rejects(write({ observedAt: later, sets: [initial.sets[0], initial.sets[0]] }));
  assert.deepEqual(await read(item.id, item.slug), expected);
  const hidden = snapshot(later, [{ ...ps4, hiddenFlag: true }], [ps5]);
  assert.equal(await write(planPsnWebsiteTrophies(hidden, owner, config)), true);
  assert.deepEqual(await read(item.id, item.slug), [expected[1]]);
  assert.equal(await write(initial), false);
  await db.query("SELECT nb_v2_api.set_denied($1,true)", [item.id]);
  assert.deepEqual(await read(item.id, item.slug), []);
});

test("game detail HTTP supplies optional summaries beside the document and omits them from lists", async () => {
  const features = { ...contentFeatures, game: true };
  const repository = createMockRepository();
  const readDetail = (slug: string) => contentDetailResponse(
    new Request(`http://localhost/api/content/game/${slug}`), "game", slug, repository, features);
  const response = await readDetail("game-clear");
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.ok(data.document.blocks.length);
  assert.deepEqual(data.trophySets.map((set: { platform: string; earned: number; total: number }) => [set.platform, set.earned, set.total]),
    [["PS4", 15, 30], ["PS5", 0, 20]]);
  assert.deepEqual(data.trophySets[0].grades.silver, { earned: 4, total: 8 });
  const zero = await (await readDetail("game-zero-trophies")).json();
  assert.deepEqual(zero.data.document, { blocks: [], toc: [], completeness: "complete" });
  assert.equal(zero.data.trophySets.length, 1);
  assert.equal(zero.data.trophySets[0].earned, 0);
  assert.equal(zero.data.trophySets[0].total, 8);
  for (const slug of ["game-wishlist", "game-playing"]) {
    const { data } = await (await readDetail(slug)).json();
    assert.equal(Object.hasOwn(data, "trophySets"), false);
  }
  const list = await contentListResponse(new Request("http://localhost/api/content/game"), "game", repository, features);
  assert.equal(list.status, 200);
  assert.doesNotMatch(await list.text(), /trophySets/);
});
