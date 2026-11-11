import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { socialTimelineSql, socialPlaybackTimelineSql, mapSocialTimelineRows } from "../src/server/social/timeline-repository.ts";
import { retainedTimelineSql, retainedPlaybackTimelineSql } from "../src/server/social/retained-repository.ts";
import { collectionDayProjectionSql } from "../src/server/social/collection-day-additions.ts";
import { collectionKey } from "../scripts/social-sync/collection.ts";
import { hash, publicationKey } from "../scripts/social-sync/model.ts";
import { coverTestEngine } from "./helpers/social-cover-engine.ts";
import { baselineSocialTimelineSql } from "./helpers/social-timeline-baseline.ts";
import { createSyntheticTimelineDatabase, seedSyntheticTimeline } from "./helpers/social-timeline-synthetic.ts";

function oldSql(retained: boolean, playback: boolean) {
  let sql = baselineSocialTimelineSql(playback);
  if (retained) for (const name of ["collections", "publications", "collection_members", "collection_playbacks"])
    sql = sql.replaceAll(`social_sync.website_${name}`, `social_sync.retained_website_${name}`);
  return sql;
}

test("grouped timeline matches the former SQL under real RLS, playback, daily additions and current withdrawals", async t => {
  const e = await coverTestEngine(t, false);
  for (const name of ["20261018010218_social_collection_playback_links.sql", "20261019065657_social_collection_day_additions.sql"])
    await e.db.exec(await readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8"));
  const member = await e.add("BV0000000001", "folded-member");
  await e.add("BV0000000004", "standalone");
  const missing = await e.add("BV0000000007", "missing-source");
  await e.db.query("DELETE FROM social_sync.publications WHERE publication_key=$1", [publicationKey(missing)]);
  const hidden = await e.add("BV0000000006", "unapproved-work");
  await e.db.query("UPDATE social_sync.works SET approved=false WHERE work_id=$1", [hidden.workId]);
  await e.db.exec("UPDATE social_sync.works SET occurred_at=NULL WHERE work_id='standalone'");
  const initial = await e.collection(), key = collectionKey(initial.target);
  const grown = structuredClone(initial);
  grown.observedAt = new Date(Date.parse(initial.observedAt) + 100).toISOString();
  grown.members.push({ id: "BV0000000003", publishedAt: grown.observedAt, parts: ["1003"], partsComplete: true });
  await e.worker.query("SELECT * FROM social_sync.ingest_collection($1,$2,$3)", [key, hash(JSON.stringify(grown)), JSON.stringify(grown)]);
  await e.db.query(`UPDATE social_sync.retained_collections r SET approved_member_keys=s.member_review_keys,
    approved_source_sha256=s.payload_sha256,source_sha256=s.payload_sha256
    FROM social_sync.collection_states s WHERE s.collection_key=r.collection_key AND r.collection_key=$1`, [key]);
  const emptyCollection = await e.collection("multi-part");
  for (const c of [grown, emptyCollection]) {
    await e.db.query(`INSERT INTO social_sync.collection_visibility(collection_key,title,approved,checked_at,valid_until)
      VALUES($1,'Reviewed collection',true,now(),now()+interval '1 hour')`, [collectionKey(c.target)]);
    for (const m of c.members) await e.db.query(`INSERT INTO social_sync.collection_member_reviews
      VALUES($1,social_sync.collection_member_digest($2::jsonb),true,now(),now()+interval '1 hour')`, [collectionKey(c.target), JSON.stringify(m)]);
  }
  await e.db.query(`INSERT INTO social_sync.collection_playback_links
    VALUES($1,'BV0000000003','https://www.bilibili.com/video/BV0000000003/',now(),null)`, [key]);
  const latest = await e.add("BV0000000003", "latest-member");
  // A publication outside a collection's membership can share its work card.
  const collectionId = (await e.db.query<{ id: string }>("SELECT card->>'id' AS id FROM social_sync.collection_states WHERE collection_key=$1", [key])).rows[0]!.id;
  await e.add("BV0000000005", collectionId);

  const compare = async () => {
    for (const retained of [false, true]) for (const playback of [false, true]) for (const day of [false, true]) {
      let current = retained ? playback ? retainedPlaybackTimelineSql : retainedTimelineSql : playback ? socialPlaybackTimelineSql : socialTimelineSql;
      let baseline = oldSql(retained, playback);
      if (day) { current = collectionDayProjectionSql(current, retained); baseline = collectionDayProjectionSql(baseline, retained); }
      const values = day ? ["Australia/Melbourne"] : undefined;
      const before = (await e.reader.query<{ work: unknown }>(baseline, values)).rows;
      const after = (await e.reader.query<{ work: unknown }>(current, values)).rows;
      assert.deepEqual(after, before, JSON.stringify({ retained, playback, day }));
      const options = { enabled: day, timeZone: "Australia/Melbourne" };
      const mapped = mapSocialTimelineRows(after, "comparison", options);
      assert.deepEqual(mapped, mapSocialTimelineRows(before, "comparison", options));
      assert(!mapped.items.some(w => ["missing-source", "unapproved-work"].includes(w.id)));
    }
  };
  await compare();
  const present = mapSocialTimelineRows((await e.reader.query<{ work: unknown }>(
    collectionDayProjectionSql(retainedPlaybackTimelineSql, true), ["Australia/Melbourne"])).rows, "comparison", { enabled: true, timeZone: "Australia/Melbourne" });
  assert(!present.items.some(w => w.id === member.workId));
  assert.equal(present.items.find(w => w.id === collectionId)!.collection!.latestMemberUrl, "https://www.bilibili.com/video/BV0000000003/");
  assert.equal(present.items.find(w => w.id === collectionId)!.collection!.dayAddition!.addedVideos, 1);
  assert(present.items.some(w => w.collection !== null && w.publications.length === 0));

  await e.db.query("INSERT INTO social_sync.collection_standalone_overrides VALUES($1,true)", [publicationKey(member)]);
  await compare();
  assert((await e.reader.query<{ work: { id: string } }>(socialTimelineSql)).rows.some(r => r.work.id === member.workId));
  await e.db.query("UPDATE social_sync.bindings SET enabled=false WHERE publication_key=$1", [publicationKey(latest)]);
  await compare();
  const denied = mapSocialTimelineRows((await e.reader.query<{ work: unknown }>(retainedPlaybackTimelineSql)).rows, "comparison");
  assert.equal(denied.items.find(w => w.id === collectionId)!.collection!.latestMemberUrl, null);
  await e.db.exec("UPDATE social_sync.collection_visibility SET approved=false; UPDATE social_sync.retained_collections SET approved=false;");
  await compare();
  assert((await e.reader.query<{ work: { collection: unknown } }>(socialTimelineSql)).rows.every(r => r.work.collection === null));

  for (const role of ["anon", "authenticated", "service_role", "nb_reader", "nb_social_worker"])
    for (const sql of [socialTimelineSql, retainedPlaybackTimelineSql, oldSql(false, false), oldSql(true, true)])
      await assert.rejects(e.role(role).query(sql), /permission denied/);
  await assert.rejects(e.reader.query("UPDATE social_sync.works SET approved=true"), /permission denied/);
});

test("grouping preserves 20/500 limits, extra-row sentinels, missing rows and duplicate rejection", async t => {
  const db = await createSyntheticTimelineDatabase(); t.after(() => db.close());
  const compare = async () => {
    const before = (await db.query<{ work: unknown }>(baselineSocialTimelineSql())).rows;
    const after = (await db.query<{ work: unknown }>(socialTimelineSql)).rows;
    assert.deepEqual(after, before); return after;
  };
  assert.deepEqual(mapSocialTimelineRows(await compare(), "comparison").items, []);
  await seedSyntheticTimeline(db, 1, 20);
  assert.equal(mapSocialTimelineRows(await compare(), "comparison").items[0]!.publications.length, 20);
  await seedSyntheticTimeline(db, 1, 22);
  let rows = await compare();
  assert.equal((rows[0]!.work as { publications: unknown[] }).publications.length, 21);
  assert.throws(() => mapSocialTimelineRows(rows, "comparison"), { code: "CONTENT_UNAVAILABLE" });
  await seedSyntheticTimeline(db, 500, 1);
  assert.equal(mapSocialTimelineRows(await compare(), "comparison").items.length, 500);
  await seedSyntheticTimeline(db, 502, 1);
  rows = await compare(); assert.equal(rows.length, 501);
  assert.throws(() => mapSocialTimelineRows(rows, "comparison"), { code: "CONTENT_UNAVAILABLE" });
  await seedSyntheticTimeline(db, 1, 1);
  await db.exec("INSERT INTO social_sync.website_publications SELECT * FROM social_sync.website_publications");
  rows = await compare();
  assert.throws(() => mapSocialTimelineRows(rows, "comparison"), { code: "CONTENT_UNAVAILABLE" });
});
