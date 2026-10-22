import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, chmod, realpath, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import sharp from "sharp";
import type { SqlExecutor } from "../src/server/database/sql.ts";
import type { StoredMedia } from "../contracts/sync.ts";
import { config, hash, publicationKey } from "../scripts/social-sync/model.ts";
import { observation } from "../scripts/social-sync/bilibili.ts";
import { snapshotObservation } from "../scripts/social-sync/xiaohongshu.ts";
import { collectionKey } from "../scripts/social-sync/collection.ts";
import { exampleCollectionSnapshot } from "./helpers/social-collection-samples.ts";
import { publicationCoverSource, collectionCoverSource, sourceDigest, validateCoverSource, type CoverSource } from "../scripts/social-media/sources.ts";
import { prepareCover, syncCovers, sourcePlan, downloadCover } from "../scripts/social-media/worker.ts";
import { createCoverCache } from "../scripts/social-media/cache.ts";
import { createCoverWriter } from "../scripts/social-media/cloud.ts";
import { thumbnailEncodingRecipe } from "../scripts/media-thumbnails/encode.ts";
import { withSocialCovers, coverAssetId, socialMediaEnabled, validateCoverFiles, type CoverFiles } from "../src/server/social/covers.ts";
import { readRetainedSocialSnapshot } from "../src/server/social/retained-repository.ts";
import { readSocialSnapshot, createPagedSocialRepository } from "../src/server/social/repository.ts";
import { readSocialTimelineSnapshot } from "../src/server/social/timeline-repository.ts";
import { createHomeFeedV2Repository } from "../src/lib/content/home-feed-v2-core.ts";
import { socialMediaResponse, socialThumbnailWidth } from "../src/server/social/media.ts";
import { imagePreviewSrc } from "../src/lib/content/image-preview.ts";

const at = () => new Date(Date.now() - 1000).toISOString();
async function image(width = 1200, height = 720) { return sharp({ create: { width, height, channels: 3, background: "#3b7391" } }).png().toBuffer(); }
async function engine(t: { after: (callback: () => Promise<void>) => void }) {
  const db = await PGlite.create(); t.after(() => db.close());
  await db.exec("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE ROLE nb_reader;");
  for (const name of ["20261012005001_social_sync_v1.sql", "20261012015408_social_reader_v1.sql", "20261012020551_social_reader_binding_index.sql",
    "20261012054647_social_collections_v1.sql", "20261012213401_social_retained_projections.sql", "20261013214552_social_collection_follow_members.sql", "20261014014825_social_work_covers.sql"]) {
    await db.exec(await readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8"));
  }
  const role = (name: string): SqlExecutor => ({ query: <T>(sql: string, values?: unknown[]) => db.transaction(async tx => { await tx.exec(`SET LOCAL ROLE ${name}`); return tx.query<T>(sql, values); }) });
  const reader = role("nb_social_reader"), worker = role("nb_social_worker"), media = role("nb_social_media_worker");
  const add = async (id: string, workId: string, cover: string | null = "https://i0.hdslb.com/example.png", published = "2026-01-01T00:00:00.000Z") => {
    const target = config({ version: 1, publications: [{ platform: "bilibili", workId, accountId: "10001", url: `https://www.bilibili.com/video/${id}/` }] })[0]!;
    const row = observation(`<script>window.__INITIAL_STATE__=${JSON.stringify({ videoData: { bvid: id, owner: { mid: 10001 }, title: "Fictional video", pic: cover,
      pubdate: Date.parse(published) / 1000, stat: { view: 10, like: 0 } } })};</script>`, target, at());
    await db.query("INSERT INTO social_sync.bindings(platform,account_id,publication_id,work_id,enabled) VALUES($1,$2,$3,$4,true)", [row.platform, row.accountId, row.publicationId, row.workId]);
    await worker.query("SELECT * FROM social_sync.ingest($1,$2,$3)", [publicationKey(row), hash(JSON.stringify(row)), JSON.stringify(row)]);
    await db.query("INSERT INTO social_sync.works(work_id,title,occurred_at,approved) VALUES($1,'Reviewed work',$2,true)", [workId, published]);
    await db.query(`INSERT INTO social_sync.retained_publications(publication_key,work_id,approved,reviewed_at,reviewed_kind,approved_source_sha256,source_sha256)
      VALUES($1,$2,true,now(),'video',$3,$3)`, [publicationKey(row), workId, hash(JSON.stringify(row))]);
    await db.query("INSERT INTO social_sync.website_visibility(publication_key,work_id,approved,checked_at,valid_until) VALUES($1,$2,true,now(),now()+interval '1 hour')", [publicationKey(row), workId]);
    return row;
  };
  const collection = async (kind: "season" | "multi-part" = "season") => {
    const row = exampleCollectionSnapshot(at(), kind), key = collectionKey(row.target);
    await db.query("INSERT INTO social_sync.collection_bindings(account_id,kind,collection_id,enabled) VALUES($1,$2,$3,true)", [row.target.accountId, kind, row.target.collectionId]);
    await worker.query("SELECT * FROM social_sync.ingest_collection($1,$2,$3)", [key, hash(JSON.stringify(row)), JSON.stringify(row)]);
    await db.query(`INSERT INTO social_sync.retained_collections(collection_key,approved,reviewed_at,title,approved_source_sha256,source_sha256,approved_member_keys)
      SELECT collection_key,true,now(),'Reviewed collection',payload_sha256,payload_sha256,member_review_keys FROM social_sync.collection_states WHERE collection_key=$1`, [key]);
    return row;
  };
  return { db, role, reader, worker, media, add, collection, writer: createCoverWriter(media) };
}
test("cover registration preserves legacy v1, retained works and home v2 cursors; private media uses true bounded variants", async t => {
  const e = await engine(t), a = await e.add("BV0000000003", "work-a"), b = await e.add("BV0000000004", "work-b", null);
  const before = await readRetainedSocialSnapshot(e.reader), legacy = await readSocialSnapshot(e.reader);
  // Real snapshot producers, not a mocked digest.
  const works = createPagedSocialRepository(async () => withSocialCovers(await readRetainedSocialSnapshot(e.reader), e.reader, "retained"));
  const old = await works.listWorks({ limit: 1 }); assert(old.nextCursor);
  const feed = createHomeFeedV2Repository({ content: async () => ({ version: "content-fixture", items: [] }), social: async () => withSocialCovers(await readRetainedSocialSnapshot(e.reader), e.reader, "retained"),
    sources: { content: "mock", social: "database" }, timeZone: "Australia/Melbourne" });
  const oldFeed = await feed.getPage({ limit: 1 }); assert(oldFeed.nextCursor);
  const source = publicationCoverSource(a), prepared = await prepareCover(source, await image());
  await e.writer.register(source, "retained", prepared.files); await e.writer.register(source, "trial", prepared.files);
  const after = await withSocialCovers(await readRetainedSocialSnapshot(e.reader), e.reader, "retained");
  assert.equal(after.version, before.version); assert.equal(after.items[0]!.occurredAt, before.items[0]!.occurredAt);
  assert(after.items.find(x => x.id === "work-a")!.cover); assert.equal(after.items.find(x => x.id === "work-b")!.cover, null);
  assert.equal((await withSocialCovers(await readSocialSnapshot(e.reader), e.reader, "trial")).version, legacy.version);
  assert.equal((await works.listWorks({ limit: 1, cursor: old.nextCursor! })).items.length, 1);
  assert.equal((await feed.getPage({ limit: 1, cursor: oldFeed.nextCursor! })).items.length, 1);
  const cover = after.items.find(x => x.id === "work-a")!.cover!;
  assert.equal(imagePreviewSrc(cover, 400), `${cover.src}?thumbnail=400`);
  const storage = { read: async (m: StoredMedia) => prepared.bodies.get(m.sha256)!, put: async () => {} };
  for (const cap of [null, 400, 800] as const) {
    const response = await socialMediaResponse(cover.id, cap, "retained", e.reader, () => storage);
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "private, max-age=86400, must-revalidate");
    const metadata = await sharp(Buffer.from(await response.arrayBuffer())).metadata(); if (cap) assert(metadata.width! <= cap);
  }
  assert(!JSON.stringify(after).includes("hdslb.com")); assert.equal(sourceDigest(publicationCoverSource(b)), null);
  const replacement = await prepareCover(source, await sharp({ create: { width: 1200, height: 720, channels: 3, background: "#73913b" } }).png().toBuffer());
  await e.writer.register(source, "retained", replacement.files);
  assert.equal((await works.listWorks({ limit: 1, cursor: old.nextCursor! })).items.length, 1);
  assert.equal((await feed.getPage({ limit: 1, cursor: oldFeed.nextCursor! })).items.length, 1);
  assert.equal((await socialMediaResponse(cover.id, 400, "retained", e.reader, () => storage)).status, 404);
});
test("current eligibility and reference changes reject old media, including withdrawals during object reads", async t => {
  const e = await engine(t), row = await e.add("BV0000000003", "work-a"), source = publicationCoverSource(row), prepared = await prepareCover(source, await image());
  await e.writer.register(source, "retained", prepared.files);
  const id = coverAssetId(source.kind, source.key, sourceDigest(source)!, prepared.files.original.sha256); let objectReads = 0;
  const storage = { read: async (m: StoredMedia) => { objectReads++; return prepared.bodies.get(m.sha256)!; }, put: async () => {} };
  await e.db.query("UPDATE social_sync.works SET approved=false WHERE work_id=$1", [row.workId]);
  assert.equal((await socialMediaResponse(id, 400, "retained", e.reader, () => storage)).status, 404); assert.equal(objectReads, 0);
  await e.db.query("UPDATE social_sync.works SET approved=true WHERE work_id=$1", [row.workId]);
  const withdraw = { ...storage, read: async (m: StoredMedia) => { await e.db.query("UPDATE social_sync.works SET approved=false WHERE work_id=$1", [row.workId]); return prepared.bodies.get(m.sha256)!; } };
  assert.equal((await socialMediaResponse(id, 400, "retained", e.reader, () => withdraw)).status, 404);
  await e.db.query("UPDATE social_sync.works SET approved=true WHERE work_id=$1", [row.workId]);
  row.observedAt = new Date().toISOString(); row.coverUrl = "https://i0.hdslb.com/changed.png";
  await e.worker.query("SELECT * FROM social_sync.ingest($1,$2,$3)", [publicationKey(row), hash(JSON.stringify(row)), JSON.stringify(row)]);
  assert.equal((await socialMediaResponse(id, 400, "retained", e.reader, () => storage)).status, 404);
  await assert.rejects(e.writer.register(source, "retained", prepared.files), /row-level security/);
  const changed = publicationCoverSource(row), next = await prepareCover(changed, await image()); await e.writer.register(changed, "retained", next.files);
  assert.equal((await socialMediaResponse(coverAssetId(changed.kind, changed.key, sourceDigest(changed)!, next.files.original.sha256), 800, "retained", e.reader, () => storage)).status, 200);
});
test("collection covers precede latest eligible member; missing members and unknown dates cannot select unrelated images", async t => {
  const e = await engine(t), older = await e.add("BV0000000001", "older-member"), newer = await e.add("BV0000000002", "newer-member", "https://i0.hdslb.com/newer.png", "2026-02-01T00:00:00.000Z");
  const c = await e.collection(), member = publicationCoverSource(newer), prepared = await prepareCover(member, await image()); await e.writer.register(member, "retained", prepared.files);
  const get = async () => (await withSocialCovers(await readRetainedSocialSnapshot(e.reader), e.reader, "retained")).items.find(x => x.collection)!;
  assert.equal((await get()).cover!.id, coverAssetId(member.kind, member.key, sourceDigest(member)!, prepared.files.original.sha256));
  const own: CoverSource = { kind: "collection", key: collectionKey(c.target), platform: "bilibili", url: "https://i0.hdslb.com/season.png", observedAt: c.observedAt };
  await e.writer.collectionSource(own, "retained");
  assert.equal((await get()).cover, null, "An owned cover awaiting registration must not borrow a member image");
  const ownFiles = await prepareCover(own, await image()); await e.writer.register(own, "retained", ownFiles.files);
  assert.equal((await get()).cover!.id, coverAssetId(own.kind, own.key, sourceDigest(own)!, ownFiles.files.original.sha256));
  await e.writer.collectionSource({ ...own, url: null }, "retained"); assert.equal((await get()).cover!.id, coverAssetId(member.kind, member.key, sourceDigest(member)!, prepared.files.original.sha256));
  await e.db.query("UPDATE social_sync.retained_publications SET approved=false WHERE publication_key=$1", [member.key]); assert.equal((await get()).cover, null);
  older.publishedAt = null; older.observedAt = new Date().toISOString();
  await e.worker.query("SELECT * FROM social_sync.ingest($1,$2,$3)", [publicationKey(older), hash(JSON.stringify(older)), JSON.stringify(older)]);
  const unknown = publicationCoverSource(older), unknownFiles = await prepareCover(unknown, await image()); await e.writer.register(unknown, "retained", unknownFiles.files);
  assert.equal((await get()).cover, null);
  await e.db.query("UPDATE social_sync.retained_collections SET approved=false WHERE collection_key=$1", [own.key]); assert.equal((await readRetainedSocialSnapshot(e.reader)).items.some(x => x.collection), false);
});
test("media SQL grants deny public access, statistics changes, arbitrary approvals and publication digest writes", async t => {
  const e = await engine(t); await e.add("BV0000000003", "work-a");
  for (const name of ["anon", "authenticated", "service_role", "nb_reader", "nb_social_worker"]) {
    await assert.rejects(e.role(name).query("SELECT * FROM social_sync.cover_bindings"), /permission denied/);
  }
  for (const sql of ["UPDATE social_sync.works SET approved=true", "UPDATE social_sync.publications SET observed_at='x'", "DELETE FROM social_sync.cover_bindings",
    "SELECT social_sync.sync_cover_source()", "UPDATE social_sync.cover_sources SET source_sha256=NULL WHERE owner_kind='publication'"]) {
    if (sql.includes("cover_sources")) assert.equal((await e.media.query(sql)).rows.length, 0);
    else await assert.rejects(e.media.query(sql), /permission denied/);
  }
  const privileges = (await e.db.query<{ role: string; login: boolean; elevated: boolean }>("SELECT rolname AS role,rolcanlogin AS login,(rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb) AS elevated FROM pg_roles WHERE rolname='nb_social_media_worker'")).rows[0]!;
  assert.equal(privileges.login, false); assert.equal(privileges.elevated, false);
});
test("worker skips unchanged sources and cached re-registration avoids downloads and encoding; failures stop later dispatch", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "social-covers-"))); await chmod(root, 0o700); t.after(() => rm(root, { recursive: true, force: true }));
  const e = await engine(t), row = await e.add("BV0000000003", "work-a"), second = await e.add("BV0000000004", "work-b"), source = publicationCoverSource(row), cache = await createCoverCache(root);
  const objects = new Map<string, Uint8Array>(); let downloads = 0, puts = 0, encodes = 0;
  const ports = { writer: e.writer, cache, storage: { put: async (m: StoredMedia, b: Uint8Array) => { puts++; objects.set(m.sha256, b); }, read: async (m: StoredMedia) => objects.get(m.sha256)! },
    download: async () => { downloads++; return image(); }, prepare: async (s: CoverSource, b: Uint8Array) => { encodes++; return prepareCover(s, b); } };
  assert.equal((await syncCovers([source], "retained", ports)).registered, 1);
  assert.equal((await syncCovers([source], "retained", ports)).unchanged, 1); assert.equal(downloads, 1); assert.equal(encodes, 1);
  row.observedAt = new Date().toISOString(); row.metrics.likes = 8;
  await e.worker.query("SELECT * FROM social_sync.ingest($1,$2,$3)", [publicationKey(row), hash(JSON.stringify(row)), JSON.stringify(row)]);
  assert.equal((await syncCovers([publicationCoverSource(row)], "retained", ports)).unchanged, 1); assert.equal(downloads, 1); assert.equal(encodes, 1);
  await e.db.exec("DELETE FROM social_sync.cover_bindings"); assert.equal((await syncCovers([source], "retained", ports)).registered, 1); assert.equal(downloads, 1); assert.equal(encodes, 1);
  const failed = await syncCovers([publicationCoverSource(second), source], "retained", { ...ports, storage: { ...ports.storage, put: async () => { throw Error("private transport detail"); } } });
  assert.equal(failed.failed, 1); assert.equal(failed.unprocessed, 1); assert(!JSON.stringify(failed).includes("private transport")); assert(puts > 0);
});
test("strict preview paths, source domains, batch bounds and private source HTTP validation", async () => {
  const key = "0".repeat(64), source: CoverSource = { kind: "publication", key, platform: "bilibili", url: "https://i0.hdslb.com/example.png", observedAt: at() };
  for (const url of ["https://i0.hdslb.com.evil.example/x", "https://localhost/x", "https://i0.hdslb.com:8443/x", "https://name@i0.hdslb.com/x"]) assert.throws(() => validateCoverSource({ ...source, url }));
  assert.throws(() => sourcePlan(Array(21).fill(source))); assert.throws(() => sourcePlan([source, source]));
  assert.equal(socialMediaEnabled(undefined), false); assert.equal(socialMediaEnabled("true"), true); assert.throws(() => socialMediaEnabled("yes"));
  assert.equal(socialThumbnailWidth("https://example.invalid/media?thumbnail=400"), 400);
  for (const q of ["thumbnail=400&thumbnail=400", "thumbnail=600", "thumbnail=800&other=1"]) assert.throws(() => socialThumbnailWidth(`https://example.invalid/media?${q}`));
  const fake = { id: `s1.${key}`, src: `/media/social/s1.${key}`, alt: "", width: null, height: null };
  for (const src of [fake.src + "\n", fake.src + "/", `https://example.invalid${fake.src}`]) assert.equal(imagePreviewSrc({ ...fake, src }, 400), src);
  await assert.rejects(downloadCover(source, new AbortController().signal, async () => new Response("<html>blocked</html>", { headers: { "content-type": "text/html" } })), /COVER_DOWNLOAD_FAILED/);
  const small = await prepareCover(source, await image(40, 30)); validateCoverFiles(small.files, source.kind, key);
  assert(small.files.previews["400"].width! <= 400); assert(small.files.previews["800"].width! <= 800);
});
test("collection media sidecars check author and collection identity from the same SSR without changing frozen statistics", () => {
  const episode = (id: string, aid: number, cid: number) => ({ season_id: 200, bvid: id, aid, pages: [{ cid }], arc: { aid, author: { mid: 10001 }, state: 0, videos: 1, pubdate: 1700000000 } });
  const video = { bvid: "BV0000000001", aid: 100, owner: { mid: 10001 }, state: 0, title: "Fictional video", pic: "https://i0.hdslb.com/video.png", season_id: 200,
    pages: [{ cid: 1000 }], videos: 1, pubdate: 1700000000, stat: { aid: 100, like: 0 },
    ugc_season: { id: 200, mid: 10001, cover: "https://i0.hdslb.com/season.png", title: "Fictional season", ep_count: 2,
      stat: { season_id: 200, like: 0 }, sections: [{ season_id: 200, episodes: [episode("BV0000000001", 100, 1000), episode("BV0000000002", 101, 1001)] }] } };
  const target = exampleCollectionSnapshot(at()).target, html = () => `<script>window.__INITIAL_STATE__=${JSON.stringify({ videoData: video })};</script>`;
  const source = collectionCoverSource(html(), target, at()); assert.equal(source.url, video.ugc_season.cover); assert.equal(source.key, collectionKey(target));
  video.ugc_season.cover = "http://archive.biliimg.com/bfs/archive/" + "a".repeat(40) + ".jpg";
  const archive=collectionCoverSource(html(),target,at());assert.equal(archive.url,video.ugc_season.cover.replace("http:","https:"));validateCoverSource(archive);
  for(const url of [archive.url+"?token=private",archive.url+"#fragment",archive.url!.replace("archive.biliimg.com","archive.biliimg.com.evil.example"),archive.url!.replace("/bfs/archive/","/unrelated/"),archive.url!.replace("https://","https://name@"),archive.url!.replace(".com/",".com:8443/")])assert.throws(()=>validateCoverSource({...archive,url}));
  assert.throws(()=>validateCoverSource({...archive,kind:"publication"}));
  video.ugc_season.cover=archive.url!;
  video.owner.mid = 20001; assert.throws(() => collectionCoverSource(html(), target, at()), /IDENTITY_MISMATCH/); video.owner.mid = 10001;
  video.pages.push({ cid: 1002 }); video.videos = 2;
  const multi = { ...target, kind: "multi-part" as const, collectionId: video.bvid };
  assert.equal(collectionCoverSource(html(), multi, at()).url, video.pic);
});
test("cross-platform cover choice never borrows the second platform, and unreviewed note type changes fail before downloading", async t => {
  const e = await engine(t), video = await e.add("BV0000000003", "cross-platform", null);
  const target = config({ version: 1, publications: [{ platform: "xiaohongshu", workId: video.workId, accountId: "000000000000000000000001", url: "https://www.xiaohongshu.com/explore/000000000000000000000002" }] })[0]!;
  const note = snapshotObservation({ version: 1, source: "browser-note-state", observedAt: at(), pageUrl: target.url, note: { noteId: target.publicationId, userId: target.accountId, type: "normal", title: "Fictional note",
    time: null, lastUpdateTime: null, coverUrl: "https://sns-webpic-qc.xhscdn.com/example.png", interactInfo: { likedCount: "1", commentCount: "0", shareCount: null, collectedCount: null } } }, target, at());
  await e.db.query("INSERT INTO social_sync.bindings(platform,account_id,publication_id,work_id,enabled) VALUES($1,$2,$3,$4,true)", [note.platform, note.accountId, note.publicationId, note.workId]);
  await e.worker.query("SELECT * FROM social_sync.ingest($1,$2,$3)", [publicationKey(note), hash(JSON.stringify(note)), JSON.stringify(note)]);
  await e.db.query(`INSERT INTO social_sync.retained_publications(publication_key,work_id,approved,reviewed_at,reviewed_kind,approved_source_sha256,source_sha256) VALUES($1,$2,true,now(),'image-note',$3,$3)`, [publicationKey(note), note.workId, hash(JSON.stringify(note))]);
  const source = publicationCoverSource(note), prepared = await prepareCover(source, await image()); await e.writer.register(source, "retained", prepared.files);
  const items = (await withSocialCovers(await readRetainedSocialSnapshot(e.reader), e.reader, "retained")).items;
  assert.equal(items[0]!.publications[0]!.platform, "bilibili"); assert.equal(items[0]!.cover, null);
  note.kind = "video"; note.observedAt = new Date().toISOString();
  await e.worker.query("SELECT * FROM social_sync.ingest($1,$2,$3)", [publicationKey(note), hash(JSON.stringify(note)), JSON.stringify(note)]);
  assert.equal(await e.writer.source(publicationCoverSource(note), "retained"), null);
  const storage = { read: async () => { throw Error("must not read"); }, put: async () => {} };
  assert.equal((await socialMediaResponse(coverAssetId(source.kind, source.key, sourceDigest(source)!, prepared.files.original.sha256), 400, "retained", e.reader, () => storage)).status, 404);
});
test("multi-part collections use their own video's cover even without a known publication date", async t => {
  const e = await engine(t), video = await e.add("BV0000000001", "multi-video"), collection = await e.collection("multi-part");
  video.publishedAt = null; video.observedAt = new Date().toISOString();
  await e.worker.query("SELECT * FROM social_sync.ingest($1,$2,$3)", [publicationKey(video), hash(JSON.stringify(video)), JSON.stringify(video)]);
  const source = publicationCoverSource(video), prepared = await prepareCover(source, await image()); await e.writer.register(source, "retained", prepared.files);
  const item = (await withSocialCovers(await readRetainedSocialSnapshot(e.reader), e.reader, "retained")).items.find(x => x.collection)!;
  assert.equal(item.collection!.kind, collection.target.kind); assert.equal(item.cover!.id, coverAssetId(source.kind, source.key, sourceDigest(source)!, prepared.files.original.sha256));
  await e.db.exec(await readFile(new URL("../supabase/migrations/20261018010218_social_collection_playback_links.sql",import.meta.url),"utf8"));
  const enabled=(await withSocialCovers(await readRetainedSocialSnapshot(e.reader,true),e.reader,"retained",true)).items.find(x=>x.collection)!;
  assert.equal(enabled.cover!.id,item.cover!.id,"opt-in season playback must preserve multi-part cover fallback");
});

test("multi-part playback retains its checked video URL even when no standalone publication is exposed",async t=>{
  const e=await engine(t),c=await e.collection("multi-part"),key=collectionKey(c.target),url=c.target.representativeUrl;
  await e.db.query("UPDATE social_sync.retained_collections SET outbound_url=$1,link_checked_at=$2 WHERE collection_key=$3",[url,c.observedAt,key]);
  const work=(await readRetainedSocialSnapshot(e.reader)).items[0];assert.equal(work.publications.length,0);
  assert.equal(work.collection!.latestMemberUrl,url);assert.equal(work.collection!.latestMemberLinkVerifiedAt,c.observedAt);assert.equal(new URL(url).search,"");
});
test("trial and retained collection media references remain independent", async t => {
  const e = await engine(t), collection = await e.collection(), key = collectionKey(collection.target);
  await e.db.query("INSERT INTO social_sync.collection_visibility(collection_key,title,approved,checked_at,valid_until) VALUES($1,'Trial collection',true,now(),now()+interval '1 hour')", [key]);
  await e.db.query(`INSERT INTO social_sync.collection_member_reviews(collection_key,member_sha,approved,checked_at,valid_until)
    SELECT $1,m.value,true,now(),now()+interval '1 hour' FROM social_sync.collection_states s,LATERAL jsonb_array_elements_text(s.member_review_keys) m WHERE collection_key=$1`, [key]);
  const retained: CoverSource = { kind: "collection", key, platform: "bilibili", observedAt: collection.observedAt, url: "https://i0.hdslb.com/retained.png" };
  const trial = { ...retained, url: "https://i0.hdslb.com/trial.png" }, files = (await prepareCover(retained, await image())).files;
  await e.writer.collectionSource(retained, "retained"); await e.writer.register(retained, "retained", files);
  await e.writer.collectionSource(trial, "trial"); await e.writer.register(trial, "trial", files);
  const read = async () => (await withSocialCovers(await readRetainedSocialSnapshot(e.reader), e.reader, "retained")).items[0]!.cover!;
  assert.equal((await read()).id, coverAssetId(retained.kind, key, sourceDigest(retained)!, files.original.sha256));
  assert.equal((await withSocialCovers(await readSocialTimelineSnapshot(e.reader), e.reader, "trial")).items[0]!.cover!.id, coverAssetId(trial.kind, key, sourceDigest(trial)!, files.original.sha256));
  await e.writer.collectionSource({ ...trial, url: null }, "trial"); assert.equal((await read()).id, coverAssetId(retained.kind, key, sourceDigest(retained)!, files.original.sha256));
});
test("CLI planning reads no credentials and execution requires an explicit flag", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "social-cover-plan-"))); await chmod(root, 0o700); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "sources.json"), JSON.stringify({ version: 1, mode: "retained", sources: [] }), { mode: 0o600 });
  const cli = new URL("../scripts/social-media/cli.ts", import.meta.url);
  const run = (...args: string[]) => spawnSync(process.execPath, [cli.pathname, ...args], { encoding: "utf8" });
  const planned = run("plan", root); assert.equal(planned.status, 0, planned.stderr); assert.equal(JSON.parse(planned.stdout).executed, false);
  assert.equal(JSON.parse(await readFile(join(root, "plan.json"), "utf8")).sources, 0);
  const unflagged = run("sync", root); assert.equal(unflagged.status, 1); assert.equal(JSON.parse(unflagged.stderr).code, "COVER_USAGE");
});
test("small animated covers preserve animation and report frame dimensions when original bytes serve both caps", async () => {
  const frames = Buffer.alloc(3 * 10 * 4, 255);
  for (let pixel = 3 * 5; pixel < 3 * 10; pixel++) frames[pixel * 4] = 0;
  const bytes = await sharp(frames, { raw: { width: 3, height: 10, channels: 4, pageHeight: 5 } }).gif({ delay: [10, 20], loop: 0 }).toBuffer();
  const source: CoverSource = { kind: "publication", key: "0".repeat(64), platform: "bilibili", url: "https://i0.hdslb.com/animation.gif", observedAt: at() };
  const prepared = await prepareCover(source, bytes);
  assert.equal(prepared.files.original.width, 3); assert.equal(prepared.files.original.height, 5);
  assert.equal(prepared.files.previews["400"].sha256, prepared.files.original.sha256);
  assert.equal(prepared.files.previews["800"].sha256, prepared.files.original.sha256);
  assert.deepEqual(prepared.bodies.get(prepared.files.original.sha256), bytes);
});

async function renewedReference(t: Parameters<typeof engine>[0]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "social-cover-renewal-")));
  await chmod(root, 0o700); t.after(() => rm(root, { recursive: true, force: true }));
  const e = await engine(t), row = await e.add("BV0000000003", "work-a"), source = publicationCoverSource(row);
  const cache = await createCoverCache(root), bytes = await image(), objects = new Map<string, Uint8Array>();
  const storage = { put: async (m: StoredMedia, b: Uint8Array) => { objects.set(m.sha256, b); }, read: async (m: StoredMedia) => objects.get(m.sha256)! };
  const first = await syncCovers([source], "retained", { writer: e.writer, cache, storage, download: async () => bytes });
  assert.equal(first.registered, 1); assert.equal(first.encoded, 1);
  const prior = (await e.writer.read(source, "retained"))!;
  row.coverUrl = "https://i0.hdslb.com/example.png?reference=renewed"; row.observedAt = new Date().toISOString();
  await e.worker.query("SELECT * FROM social_sync.ingest($1,$2,$3)", [publicationKey(row), hash(JSON.stringify(row)), JSON.stringify(row)]);
  const renewed = publicationCoverSource(row);
  return { ...e, root, row, source, renewed, cache, bytes, objects, storage, prior };
}
test("a renewed source proves identical bytes once, reuses real encoding and verifies registered objects without uploads", async t => {
  const e = await renewedReference(t); let downloads = 0, reads = 0;
  // Readers lose the old binding immediately; the media writer may inspect it solely as a reuse candidate.
  assert.equal((await withSocialCovers(await readRetainedSocialSnapshot(e.reader), e.reader, "retained")).items[0]!.cover, null);
  const report = await syncCovers([e.renewed], "retained", { writer: e.writer, cache: e.cache,
    download: async () => { downloads++; return e.bytes; }, prepare: async () => { throw Error("must not encode identical bytes"); },
    storage: { put: async () => { throw Error("must not upload registered objects"); }, read: async m => { reads++; return e.storage.read(m); } } });
  assert.equal(report.failed, 0); assert.equal(report.registered, 1); assert.equal(downloads, 1);
  assert.equal(report.sourceRequests, 1); assert.equal(report.encoded, 0); assert.equal(report.reusedEncodings, 1);
  assert.equal(report.uploads, 0); assert.equal(report.objectReads, reads); assert.equal(report.objectOperations, reads);
  assert.equal(reads, new Set([e.prior.files.original.sha256, e.prior.files.previews["400"].sha256, e.prior.files.previews["800"].sha256]).size);
  const current = (await e.writer.read(e.renewed, "retained"))!;
  assert.equal(current.sourceSha256, sourceDigest(e.renewed)); assert.deepEqual(current.files, e.prior.files);
  assert.deepEqual(await e.cache.read(e.renewed, thumbnailEncodingRecipe()), e.prior.files);
  const cover = (await withSocialCovers(await readRetainedSocialSnapshot(e.reader), e.reader, "retained")).items[0]!.cover!;
  assert.equal((await socialMediaResponse(cover.id, 400, "retained", e.reader, () => e.storage)).status, 200);
  assert.equal((await socialMediaResponse(coverAssetId(e.source.kind, e.source.key, sourceDigest(e.source)!, e.prior.files.original.sha256), 400, "retained", e.reader, () => e.storage)).status, 404);
  const unchanged = await syncCovers([e.renewed], "retained", { writer: e.writer, cache: e.cache,
    download: async () => { throw Error("must not download unchanged source"); }, prepare: async () => { throw Error("must not encode"); },
    storage: { put: async () => { throw Error("must not upload"); }, read: async () => { throw Error("must not read unchanged objects"); } } });
  assert.equal(unchanged.unchanged, 1); assert.equal(unchanged.sourceRequests + unchanged.encoded + unchanged.uploads + unchanged.objectReads, 0);
});
test("a real image change and an incompatible encoding recipe use the normal encoding path", async t => {
  for (const scenario of ["changed-image", "changed-recipe"] as const) {
    const e = await renewedReference(t);
    if (scenario === "changed-recipe") {
      const path = join(e.root, `publication-${e.source.key}.json`), row = JSON.parse(await readFile(path, "utf8"));
      row.recipe = hash("previous incompatible encoder"); await writeFile(path, JSON.stringify(row), { mode: 0o600 });
    }
    const bytes = scenario === "changed-image" ? await sharp({ create: { width: 1200, height: 720, channels: 3, background: "#73913b" } }).png().toBuffer() : e.bytes;
    const report = await syncCovers([e.renewed], "retained", { writer: e.writer, cache: e.cache, storage: e.storage, download: async () => bytes });
    assert.equal(report.registered, 1); assert.equal(report.encoded, 1); assert.equal(report.reusedEncodings, 0);
    if (scenario === "changed-image") {
      assert(report.uploads > 0); assert.notEqual((await e.writer.read(e.renewed, "retained"))!.files.original.sha256, e.prior.files.original.sha256);
    } else assert.equal(report.uploads, 0); // Re-encoding is required; the resulting same registered bytes need no PUT.
  }
});
test("corrupt prior cache metadata or bytes fail before fetching a renewed source", async t => {
  for (const scenario of ["metadata", "bytes"] as const) {
    const e = await renewedReference(t);
    if (scenario === "metadata") {
      const path = join(e.root, `publication-${e.source.key}.json`), row = JSON.parse(await readFile(path, "utf8"));
      row.sourceSha256 = "invalid"; await writeFile(path, JSON.stringify(row), { mode: 0o600 });
    } else await writeFile(join(e.root, e.prior.files.original.objectKey), Buffer.from("corrupt"), { mode: 0o600 });
    const report = await syncCovers([e.renewed], "retained", { writer: e.writer, cache: e.cache, storage: e.storage,
      download: async () => { throw Error("must not fetch after invalid cache"); } });
    assert.equal(report.failed, 1); assert.equal(report.registered, 0); assert.equal(report.sourceRequests + report.uploads + report.objectReads, 0);
  }
});
test("missing or unreadable registered objects stop renewed-reference registration without a repair upload", async t => {
  for (const scenario of ["missing", "permission", "wrong-bytes"] as const) {
    const e = await renewedReference(t), second = publicationCoverSource(await e.add("BV0000000004", "work-b"));
    const report = await syncCovers([e.renewed, second], "retained", { writer: e.writer, cache: e.cache, download: async () => e.bytes,
      storage: { put: async () => { throw Error("must not repair upload"); }, read: async () => {
        if (scenario === "wrong-bytes") return Buffer.from("not the registered object");
        throw Error(scenario === "missing" ? "404" : "403 private transport detail");
      } } });
    assert.equal(report.failed, 1); assert.equal(report.unprocessed, 1); assert.equal(report.registered, 0);
    assert.equal(report.sourceRequests, 1); assert.equal(report.uploads, 0); assert.equal(report.objectReads, 1);
    assert.equal((await e.writer.read(e.renewed, "retained"))!.sourceSha256, sourceDigest(e.source));
    assert(!JSON.stringify(report).includes("private transport"));
  }
});
test("withdrawal or another reference update during independent object reads cannot register renewed media", async t => {
  for (const scenario of ["withdrawal", "another-reference"] as const) {
    const e = await renewedReference(t); let changed = false;
    const report = await syncCovers([e.renewed], "retained", { writer: e.writer, cache: e.cache, download: async () => e.bytes,
      storage: { put: async () => { throw Error("must not upload"); }, read: async m => {
        if (!changed) {
          changed = true;
          if (scenario === "withdrawal") await e.db.exec("UPDATE social_sync.works SET approved=false");
          else {
            e.row.coverUrl = "https://i0.hdslb.com/another.png"; e.row.observedAt = new Date().toISOString();
            await e.worker.query("SELECT * FROM social_sync.ingest($1,$2,$3)", [publicationKey(e.row), hash(JSON.stringify(e.row)), JSON.stringify(e.row)]);
          }
        }
        return e.storage.read(m);
      } } });
    assert.equal(report.failed, 1); assert.equal(report.registered, 0); assert.equal(report.uploads, 0);
    assert.equal(report.failures[0]!.code, "COVER_SCOPE_CHANGED");
    assert.equal((await e.reader.query("SELECT * FROM social_sync.cover_bindings")).rows.length, 0);
  }
});
test("cancellation stops registered-object reads and a lost registration acknowledgement is resumed without duplicate work", async t => {
  const e = await renewedReference(t), controller = new AbortController();
  const cancelled = await syncCovers([e.renewed], "retained", { writer: e.writer, cache: e.cache, download: async () => e.bytes, signal: controller.signal,
    storage: { put: async () => { throw Error("must not upload"); }, read: async m => { controller.abort(); return e.storage.read(m); } } });
  assert.equal(cancelled.failures[0]!.code, "COVER_CANCELLED"); assert.equal(cancelled.objectReads, 1); assert.equal(cancelled.registered, 0);
  const uncertain = await syncCovers([e.renewed], "retained", { writer: { ...e.writer, register: async (...args) => {
    await e.writer.register(...args); throw Error("acknowledgement lost after commit");
  } }, cache: e.cache, storage: e.storage, download: async () => { throw Error("current-reference cache exists"); } });
  assert.equal(uncertain.failed, 1); assert.equal(uncertain.sourceRequests + uncertain.encoded + uncertain.uploads, 0);
  const resumed = await syncCovers([e.renewed], "retained", { writer: e.writer, cache: e.cache, storage: e.storage,
    download: async () => { throw Error("already registered"); } });
  assert.equal(resumed.unchanged, 1); assert.equal(resumed.sourceRequests + resumed.encoded + resumed.uploads + resumed.objectReads, 0);
});
test("cancellation during cached byte reads cannot dispatch a subsequent storage operation", async t => {
  const e = await renewedReference(t), controller = new AbortController();
  await e.cache.save(e.renewed, thumbnailEncodingRecipe(), e.prior.files, e.objects);
  const report = await syncCovers([e.renewed], "retained", { writer: e.writer, signal: controller.signal,
    cache: { ...e.cache, bytes: async m => { const bytes = await e.cache.bytes(m); controller.abort(); return bytes; } },
    download: async () => { throw Error("current-reference cache exists"); }, storage: {
      put: async () => { throw Error("must not dispatch after cancellation"); }, read: async () => { throw Error("must not dispatch after cancellation"); },
    } });
  assert.equal(report.failures[0]!.code, "COVER_CANCELLED"); assert.equal(report.registered, 0);
  assert.equal(report.sourceRequests + report.objectOperations + report.uploads + report.objectReads, 0);
});

test("one metadata statement restores an unchanged collection cover after statistics refresh while rejecting replacements, stale ACKs and withdrawal", async t => {
  const e = await engine(t);
  await e.add("BV0000000001", "older-member"); await e.add("BV0000000002", "newer-member");
  const c = await e.collection();
  const source: CoverSource = { kind: "collection", key: collectionKey(c.target), platform: "bilibili", url: "https://i0.hdslb.com/collection.png", observedAt: c.observedAt };
  await e.writer.collectionSource(source,"retained");
  const prepared = await prepareCover(source, await image()); await e.writer.register(source,"retained",prepared.files);
  const visible = async () => (await e.reader.query("SELECT * FROM social_sync.cover_bindings WHERE owner_kind='collection' AND display_mode='retained'")).rows.length;
  assert.equal(await visible(),1);
  const next = {...c,observedAt:new Date(Date.parse(c.observedAt)+1).toISOString()};
  await e.worker.query("SELECT * FROM social_sync.ingest_collection($1,$2,$3)",[source.key,hash(JSON.stringify(next)),JSON.stringify(next)]);
  assert.equal(await visible(),0,"Original policy hides the old observation until its metadata catches up");
  assert.deepEqual(await e.writer.refreshUnchangedCollections!([source],"retained"),[],"stale ACK cannot refresh");
  const current={...source,observedAt:next.observedAt};
  assert.deepEqual(await e.writer.refreshUnchangedCollections!([{...current,url:"https://i0.hdslb.com/replaced.png"}],"retained"),[],"changed reference needs full verification");
  assert.equal(await visible(),0);
  assert.deepEqual(await e.writer.refreshUnchangedCollections!([current],"retained"),[source.key]); assert.equal(await visible(),1);
  const stored=(await e.media.query<{files:CoverFiles}>("SELECT files FROM social_sync.cover_bindings WHERE owner_key=$1 AND display_mode='retained'",[source.key])).rows[0]!.files;
  assert.deepEqual(stored,prepared.files,"No object or binding descriptor is rewritten");
  await e.db.query("UPDATE social_sync.retained_collections SET approved=false WHERE collection_key=$1",[source.key]);
  assert.deepEqual(await e.writer.refreshUnchangedCollections!([current],"retained"),[]); assert.equal(await visible(),0);
});
