import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { fixtureItems } from "../fixtures/content.ts";
import type { WebsiteRecord } from "../contracts/website-sync.ts";
import { gamePlayVideoUrl } from "../src/lib/content/game-detail-data.ts";
import { validateWebsiteRecord } from "../src/server/database/website-validation.ts";
import { socialPlayVideoSql } from "../src/server/social/timeline-repository.ts";

const video = "https://www.bilibili.com/video/BV1a234Bc567/";
const collection = "https://space.bilibili.com/123/lists/456?type=season";

test("collects only the public game synopsis, verified company fields and canonical video URL", () => {
  assert.equal(gamePlayVideoUrl("https://bilibili.com/video/BV1a234Bc567?tracking=1"), video);
  assert.equal(gamePlayVideoUrl("https://space.bilibili.com/123/lists/456"), collection);
  assert.equal(gamePlayVideoUrl("https://space.bilibili.com/123/lists/456?type=series"), null);
  assert.equal(gamePlayVideoUrl("https://www.bilibili.com.example.test/video/BV1a234Bc567/"), null);
  assert.equal(gamePlayVideoUrl("https://www.bilibili.com@elsewhere.test/video/BV1a234Bc567/"), null);
  const base = { ...structuredClone(fixtureItems.game[0]), cover: null };
  const record: WebsiteRecord = { detail: { item: { ...base, about: { summary: "An original synopsis.", developers: ["Sample Studio"], publishers: ["Sample Publisher"] },
    playVideo: { url: video, work: null } }, document: null }, evidence: { sourceKey: "games", dataSourceId: null,
    databaseParentId: null, courseId: null, parentId: null, ordinal: 0 } };
  assert.doesNotThrow(() => validateWebsiteRecord(record));
  assert.doesNotThrow(() => validateWebsiteRecord({ ...record, detail: { item: { ...base, estimatedTime: null } as typeof base, document: null } }));
  const item = { ...record.detail.item, playVideo: { url: video, work: { title: "Unqualified work" } } } as typeof base;
  assert.throws(() => validateWebsiteRecord({ ...record, detail: { item, document: null } }));
});

test("a recording resolves to its eligible published collection or an exact standalone work", async t => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`CREATE SCHEMA social_sync;
    CREATE TABLE social_sync.website_publications (work_id text, title text, occurred_at text, publication jsonb);
    CREATE TABLE social_sync.website_collections (collection_key text, account_id text, kind text, collection_id text, collection jsonb);
    CREATE TABLE social_sync.website_collection_members (publication_key text, collection_key text);
    CREATE TABLE social_sync.collection_standalone_overrides (publication_key text, keep_standalone boolean);
    INSERT INTO social_sync.website_collection_members VALUES ('video-one', 'collection-one');
    INSERT INTO social_sync.website_publications VALUES ('first', 'Recording', NULL,
      '{"id":"video-one","platform":"bilibili","originalUrl":"${video}"}');
    INSERT INTO social_sync.website_collections VALUES ('collection-one', '123', 'season', '456',
      '{"id":"collection-id","title":"Published collection","originalUrl":"${collection}"}');
    INSERT INTO social_sync.website_collections VALUES ('other', '123', 'season', '789',
      '{"id":"other-id","title":"Unrelated collection"}');`);
  const lookup = async (url: string) => (await db.query<{ work: { id: string } }>(socialPlayVideoSql(false), [url])).rows.map(({work}) => work.id);
  assert.deepEqual(await lookup(video), ["collection-id"]);
  assert.deepEqual(await lookup(collection), ["collection-id"]);
  assert.deepEqual(await lookup("https://www.bilibili.com/video/BVzzzzzzzzzz/"), []);
  await db.exec("DELETE FROM social_sync.website_collection_members WHERE publication_key = 'video-one'");
  assert.deepEqual(await lookup(video), ["first"]);
});

test("removes only the verified estimate backup and refuses a same-size changed backup", async t => {
  const db = new PGlite();
  t.after(() => db.close());
  const run = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  await db.exec(`CREATE SCHEMA nb_v2;
    CREATE TABLE nb_v2.state(singleton boolean PRIMARY KEY, lease_run uuid, lease_until timestamptz);
    INSERT INTO nb_v2.state VALUES (true, NULL, NULL);
    CREATE TABLE nb_v2.records(run_id uuid, id text, kind text, item jsonb);
    INSERT INTO nb_v2.records VALUES ('${run}','g','game','{"estimatedTime":null,"playedTime":{"value":10,"unit":"hour"}}');
    INSERT INTO nb_v2.records VALUES ('${run}','b','book','{"title":"Untouched"}');`);
  const migration = await readFile(new URL("../database/game-detail-migrations/001_remove_estimated_time.sql",import.meta.url),"utf8");
  const { rows: [{ sha }] } = await db.query<{ sha: string }>(`SELECT encode(sha256(convert_to(jsonb_build_object(
    'run',run_id,'id',id,'value',item->'estimatedTime')::text,'UTF8')),'hex') sha FROM nb_v2.records WHERE kind='game'`);
  const clean = (hash: string) => db.transaction(async tx => {
    await tx.query(`SELECT set_config('notionblog.estimate_run',$1,true),
      set_config('notionblog.estimate_backup_rows','1',true),set_config('notionblog.estimate_backup_sha',$2,true)`, [run,hash]);
    await tx.exec(migration);
  });
  await assert.rejects(clean("f".repeat(64)), /NB_GAME_ESTIMATE_BACKUP_CHANGED/);
  await clean(sha);
  await clean(sha);
  assert.deepEqual((await db.query("SELECT item FROM nb_v2.records ORDER BY kind")).rows, [
    {item:{title:"Untouched"}}, {item:{playedTime:{value:10,unit:"hour"}}},
  ]);
});
