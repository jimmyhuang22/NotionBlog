import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { collectionCard, collectionConfig, collectionFromPage, collectionKey, collectCollection, nextCollectionState, validateCollectionSnapshot, validateCollectionState } from "../scripts/social-sync/collection.ts";
import type { CollectionSnapshot, CollectionState, CollectionTarget } from "../scripts/social-sync/collection.ts";
import { openCollectionStore } from "../scripts/social-sync/collection-store.ts";
import { collectCollections } from "../scripts/social-sync/collection-worker.ts";
import { planDetailBatches } from "../scripts/social-sync/detail-plan.ts";
import { config, SocialSyncError, validateObservation } from "../scripts/social-sync/model.ts";
import type { Observation } from "../scripts/social-sync/model.ts";
import { collectVideo, MAX_COLLECTION_PAGE_BYTES, MAX_PAGE_BYTES, pageState } from "../scripts/social-sync/bilibili.ts";

const at = "2026-01-02T00:00:00.000Z", later = "2026-01-03T00:00:00.000Z";
const target: CollectionTarget = { platform: "bilibili", kind: "season", accountId: "10001", collectionId: "200", representativeUrl: "https://www.bilibili.com/video/BV0000000001/" };
const error = (code: string) => (e: unknown) => e instanceof SocialSyncError && e.code === code;
function source() {
  const episode = (id: string, aid: number, cid: number) => ({ season_id: 200, bvid: id, aid, pages: [{ cid }],
    arc: { aid, author: { mid: 10001 }, state: 0, videos: 0, pubdate: 1700000000 } });
  return { videoData: { bvid: "BV0000000001", aid: 100, owner: { mid: 10001 }, state: 0, title: "Example video", season_id: 200,
    pages: [{ cid: 1000 }], videos: 1, pubdate: 1700000000, stat: { aid: 100, view: 5, like: 0, reply: 1 },
    ugc_season: { id: 200, mid: 10001, title: "Example season", ep_count: 2, stat: { season_id: 200, view: 999, like: 0, reply: 12, fav: 8 },
      sections: [{ season_id: 200, episodes: [episode("BV0000000001",100,1000), episode("BV0000000002",101,1001)] }] } } };
}
function html(value: unknown = source()) { return `<script>window.__INITIAL_STATE__=${JSON.stringify(value)};</script>`; }
function row(observedAt = at): CollectionSnapshot { return collectionFromPage(html(), target, observedAt); }
function multipart(): CollectionSnapshot {
  const s = source(); s.videoData.pages.push({ cid: 1002 }); s.videoData.videos = 2;
  return collectionFromPage(html(s), { ...target, kind: "multi-part", collectionId: s.videoData.bvid }, at);
}
async function directory(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(),"nb-collections-"))); await chmod(root,0o700);
  t.after(() => rm(root,{recursive:true,force:true})); return root;
}
function add(snapshot: CollectionSnapshot, id = "BV0000000003", publishedAt: string | null = "2026-01-02T12:00:00.000Z") {
  snapshot.members.push({id,publishedAt,parts:["1003"],partsComplete:true}); return snapshot;
}
test("large collection envelopes retain member identity and baseline semantics without enlarging single-video reads", async () => {
  const s = source(), season = s.videoData.ugc_season;
  season.sections[0].episodes = Array.from({ length: 923 }, (_, i) => ({ season_id: 200, bvid: `BV${String(i + 1).padStart(10, "0")}`,
    aid: 100 + i, pages: [{ cid: 1000 + i }], arc: { aid: 100 + i, author: { mid: 10001 }, state: 0, videos: 0, pubdate: 1700000000 } }));
  season.ep_count = season.sections[0].episodes.length;
  const padding = `<!--${"界".repeat(Math.ceil(MAX_PAGE_BYTES / 3))}-->`, body = padding + html(s);
  assert.ok(Buffer.byteLength(body) > MAX_PAGE_BYTES && Buffer.byteLength(body) < MAX_COLLECTION_PAGE_BYTES);
  const request = (async () => new Response(body, { headers: { "content-type": "text/html" } })) as typeof fetch;
  const snapshot = await collectCollection(target, undefined, request);
  assert.equal(snapshot.members.length, 923); assert.equal(snapshot.metrics.views, 999);
  assert.equal(snapshot.members[1].partsComplete, false);
  assert.equal(snapshot.websitePublicationApproved, false);
  const baseline = nextCollectionState(null, snapshot);
  assert.equal(baseline.seenVideos.length, 923); assert.equal(collectionCard(baseline).latestAddition, null);
  assert.throws(() => pageState(body), error("PAGE_TOO_LARGE"));
  await assert.rejects(collectVideo({ platform: "bilibili", accountId: target.accountId, workId: "example_work",
    publicationId: "BV0000000001", url: target.representativeUrl }, undefined, request), error("PAGE_TOO_LARGE"));
  season.sections[0].episodes[1].arc.author.mid = 10002;
  assert.throws(() => collectionFromPage(padding + html(s), target, at), error("IDENTITY_MISMATCH"));
});
test("collection page limits reject declared and decoded oversize bodies and cancel their streams", async () => {
  assert.throws(() => collectionFromPage("x".repeat(MAX_COLLECTION_PAGE_BYTES + 1), target, at), error("PAGE_TOO_LARGE"));
  for (const declared of [true, false]) {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ start(c) {
      if (!declared) { c.enqueue(new Uint8Array(MAX_COLLECTION_PAGE_BYTES)); c.enqueue(new Uint8Array([1])); }
    }, cancel() { cancelled = true; } });
    const headers = { "content-type": "text/html", ...(declared ? { "content-length": String(MAX_COLLECTION_PAGE_BYTES + 1) } : {}) };
    const request = (async () => new Response(stream, { headers })) as typeof fetch;
    await assert.rejects(collectCollection(target, undefined, request), error("PAGE_TOO_LARGE"));
    assert.equal(cancelled, true);
  }
});
test("collection parser uses season counters once and preserves explicit unknown part completeness", () => {
  const r = row(), card = collectionCard(nextCollectionState(null,r));
  assert.equal(r.metrics.views,999); assert.equal(r.metrics.collections,8); assert.equal(r.metrics.likes,0); assert.equal(r.metrics.shares,null);
  assert.equal(r.members.length,2); assert.equal(r.members[0].partsComplete,true); assert.equal(r.members[1].partsComplete,false);
  assert.equal(card.memberCount,2); assert.equal(card.partCount,null); assert.equal(card.firstPublishedAt,null); assert.equal(card.originalUrl,null);
  assert.equal(card.metricsScope,"bilibili-season"); assert.equal(card.latestAddition,null); assert.equal(r.websitePublicationApproved,false);
  for (const key of ["accountId","collectionId","members","responseSha256","description","coverUrl"]) assert.equal(JSON.stringify(card).includes(`"${key}"`),false);
});
test("multi-part counts the BV statistics once and retains the original publication date", () => {
  const r = multipart(), card = collectionCard(nextCollectionState(null,r));
  assert.equal(card.memberCount,2); assert.equal(card.partCount,2); assert.equal(card.metrics.views,5); assert.equal(card.metricsScope,"bilibili-multi-part");
  assert.equal(card.firstPublishedAt,"2023-11-14T22:13:20.000Z"); assert.equal(card.latestAddition,null);
});
test("identity, membership completeness and scope mismatches reject the whole season", () => {
  for (const mutate of [
    (s: ReturnType<typeof source>) => { s.videoData.owner.mid = 10002; },
    (s: ReturnType<typeof source>) => { s.videoData.ugc_season.mid = 10002; },
    (s: ReturnType<typeof source>) => { s.videoData.ugc_season.stat.season_id = 201; },
    (s: ReturnType<typeof source>) => { s.videoData.ugc_season.ep_count = 3; },
    (s: ReturnType<typeof source>) => { s.videoData.ugc_season.sections[0].episodes[1].arc.author.mid = 10002; },
    (s: ReturnType<typeof source>) => { s.videoData.ugc_season.sections[0].episodes[1].arc.state = -1; },
    (s: ReturnType<typeof source>) => { s.videoData.ugc_season.sections[0].episodes[1].bvid = s.videoData.bvid; },
    (s: ReturnType<typeof source>) => { s.videoData.pages.push({cid:1000}); s.videoData.videos = 2; },
  ]) { const s=source(); mutate(s); assert.throws(()=>collectionFromPage(html(s),target,at),SocialSyncError); }
});
test("single-P and unrecognised collection kinds are not accepted as collections", () => {
  assert.throws(()=>collectionFromPage(html(),{...target,kind:"multi-part",collectionId:"BV0000000001"},at),error("NOT_A_COLLECTION"));
  assert.throws(()=>collectionConfig({version:1,collections:[{...target,kind:"series"}]}),error("COLLECTION_KIND_UNSUPPORTED"));
  assert.throws(()=>collectionConfig({version:1,collections:[target,target]}),error("INVALID_CONFIG"));
  assert.throws(()=>collectionConfig({version:1,collections:[{...target,representativeUrl:target.representativeUrl+"?p=2"}]}),error("COLLECTION_INVALID"));
});
test("baseline history and statistics do not manufacture content-update events", () => {
  const baseline=nextCollectionState(null,row()); const changed=row(later);
  changed.title="Renamed season"; changed.metrics.likes=100; changed.members.reverse();
  const state=nextCollectionState(baseline,changed);
  assert.deepEqual(state.activity,baseline.activity); assert.equal(state.latestAddition,null);
  assert.equal(collectionCard(state).id,collectionCard(baseline).id); assert.equal(collectionCard(state).metrics.likes,100);
  validateCollectionState(state);
});
test("three updates retain one stable card and the original baseline instead of new works", () => {
  let state=nextCollectionState(null,row()), id=collectionCard(state).id;
  for (let i=3;i<=5;i++) {
    const snapshot=structuredClone(state.snapshot); snapshot.observedAt=`2026-01-0${i}T00:00:00.000Z`;
    add(snapshot,`BV000000000${i}`,`2026-01-0${i-1}T12:00:00.000Z`);
    state=nextCollectionState(state,snapshot);
    assert.equal(collectionCard(state).id,id); assert.equal(state.latestAddition?.addedVideos,1); assert.equal(state.latestAddition?.addedParts,0);
    assert.equal(state.activity?.basis,"member-published"); validateCollectionState(state);
  }
  assert.equal(collectionCard(state).memberCount,5); assert.equal(state.seenVideos.length,5);
});
test("old or undated videos newly added to a season use detection time explicitly", () => {
  for (const publishedAt of [null,"2023-11-14T22:13:20.000Z"]) {
    const state=nextCollectionState(nextCollectionState(null,row()),add(row(later),undefined,publishedAt));
    assert.equal(state.activity?.basis,"addition-detected"); assert.equal(state.activity?.at,later);
    assert.equal(state.latestAddition?.publishedAt,null); assert.equal(state.snapshot.firstPublishedAt,null);
  }
});
test("removed members re-added later and changed representatives do not create additions", () => {
  const baseline=nextCollectionState(null,row()); const removed=row(later); removed.members.pop();
  const state=nextCollectionState(baseline,removed), restored=row("2026-01-04T00:00:00.000Z");
  restored.target.representativeUrl="https://www.bilibili.com/video/BV0000000002/";
  restored.members[1].partsComplete=true;
  const next=nextCollectionState(state,restored);
  assert.equal(next.latestAddition,null); assert.deepEqual(next.activity,baseline.activity);
  assert.equal(collectionKey(next.snapshot.target),collectionKey(target));
});
test("unknown part lists establish a baseline when complete and only subsequent new CIDs create a P update", () => {
  const baseline=nextCollectionState(null,row()), incomplete=row(later);
  incomplete.members[1].parts.push("1004");
  const first=nextCollectionState(baseline,incomplete); assert.equal(first.latestAddition,null);
  const complete=structuredClone(incomplete); complete.observedAt="2026-01-04T00:00:00.000Z"; complete.members[1].partsComplete=true;
  const second=nextCollectionState(first,complete); assert.equal(second.latestAddition,null);
  const growth=structuredClone(complete); growth.observedAt="2026-01-05T00:00:00.000Z"; growth.members[1].parts.push("1005");
  const third=nextCollectionState(second,growth); assert.equal(third.latestAddition?.addedParts,1); assert.equal(third.latestAddition?.addedVideos,0);
  assert.equal(third.activity?.basis,"addition-detected"); validateCollectionState(third);
});
test("multi-P growth changes one card; removals and later re-additions do not repeat updates", () => {
  const baseline=nextCollectionState(null,multipart()), grow=structuredClone(baseline.snapshot);
  grow.observedAt=later; grow.members[0].parts.push("1004");
  const updated=nextCollectionState(baseline,grow); assert.equal(updated.latestAddition?.addedParts,1); assert.equal(updated.latestAddition?.addedVideos,0);
  const remove=structuredClone(grow); remove.observedAt="2026-01-04T00:00:00.000Z"; remove.members[0].parts.pop();
  const readd=structuredClone(grow); readd.observedAt="2026-01-05T00:00:00.000Z";
  const final=nextCollectionState(nextCollectionState(updated,remove),readd);
  assert.deepEqual(final.latestAddition,updated.latestAddition); assert.equal(collectionCard(final).id,collectionCard(baseline).id);
});
test("unknown dates remain null across metadata refreshes; future dates and oversize membership fail closed", () => {
  const r=row(); r.members.forEach(m=>m.publishedAt=null);
  const base=nextCollectionState(null,r), refresh=row(later);
  const state=nextCollectionState(base,refresh); assert.equal(state.activity,null); assert.equal(state.latestAddition,null);
  const future=row(); future.members[0].publishedAt=later; assert.throws(()=>validateCollectionSnapshot(future),error("INVALID_TIME"));
  const large=row(); large.members=Array(1001).fill(large.members[0]); assert.throws(()=>validateCollectionSnapshot(large),error("COLLECTION_INCOMPLETE"));
});
test("new collection observations and candidate cards cannot enter the old publication uploader", () => {
  for (const value of [row(),collectionCard(nextCollectionState(null,row()))]) assert.throws(()=>validateObservation(value as unknown as Observation),error("INVALID_DATA"));
});
test("collection SQLite persists one card, history and private permissions independently of the old store", async t => {
  const root=await directory(t), store=(await openCollectionStore(root))!;
  assert.deepEqual(store.ingest(row()),{status:"baseline",addedVideos:0,addedParts:0});
  assert.deepEqual(store.ingest(add(row(later))),{status:"updated",addedVideos:1,addedParts:0});
  const stats=row("2026-01-04T00:00:00.000Z"); add(stats); stats.metrics.likes=3;
  assert.equal(store.ingest(stats).addedVideos,0); assert.equal(store.cards().length,1); assert.equal(store.status().samples,3); store.close();
  const reopened=(await openCollectionStore(root,true))!; t.after(async()=>reopened.close());
  assert.equal(reopened.latest(target)?.latestAddition?.detectedAt,later); assert.equal(reopened.cards()[0].memberCount,3);
  assert.equal((await stat(join(root,"social-collections.sqlite"))).mode&0o077,0);
  await assert.rejects(stat(join(root,"social.sqlite")),{code:"ENOENT"});
});
test("duplicate, older and timestamp-conflicting collection observations never overwrite successful state", async t => {
  const store=(await openCollectionStore(await directory(t)))!; t.after(async()=>store.close()); store.ingest(row());
  assert.equal(store.ingest(row()).status,"duplicate"); assert.equal(store.ingest(row("2026-01-01T00:00:00.000Z")).status,"older");
  const conflict=row(); conflict.metrics.likes=99; assert.throws(()=>store.ingest(conflict),error("OBSERVATION_CONFLICT"));
  assert.equal(store.status().samples,1); assert.equal(store.cards()[0].metrics.likes,0);
  const bad=structuredClone(store.latest(target)!) as CollectionState; bad.seenVideos=[];
  assert.throws(()=>validateCollectionState(bad));
});
test("blocked HTTP and wrong adapter identities preserve prior collection state; recovery clears the failure", async t => {
  const store=(await openCollectionStore(await directory(t)))!; t.after(async()=>store.close()); store.ingest(row());
  const request=(async()=>new Response("",{status:412})) as typeof fetch;
  await assert.rejects(collectCollection(target,undefined,request),error("SOURCE_BLOCKED"));
  const failed=await collectCollections([target],store,{collect:()=>collectCollection(target,undefined,request)});
  assert.equal(failed.failed,1); assert.equal(store.status().failedSources,1); assert.equal(store.status().samples,1);
  const wrong=row(later); wrong.target.collectionId="201";
  assert.equal((await collectCollections([target],store,{collect:async()=>wrong})).failed,1);
  const recovered=await collectCollections([target],store,{collect:async()=>row(later)});
  assert.equal(recovered.updated,1); assert.equal(recovered.addedVideos,0); assert.equal(store.status().failedSources,0);
});
test("cancelled collection responses are not persisted after cancellation", async t => {
  const store=(await openCollectionStore(await directory(t)))!; t.after(async()=>store.close());
  const controller=new AbortController();
  const report=await collectCollections([target],store,{signal:controller.signal,collect:async()=>{controller.abort();return row();}});
  assert.equal(report.cancelled,true); assert.equal(store.status().samples,0);
});
test("collection storage rejects unsafe files and does not initialise on read-only status", async t => {
  const root=await directory(t); assert.equal(await openCollectionStore(root,true),null);
  await writeFile(join(root,"other"),"",{mode:0o600}); await symlink(join(root,"other"),join(root,"social-collections.sqlite"));
  await assert.rejects(openCollectionStore(root),error("PRIVATE_STATE_INVALID")); await rm(join(root,"social-collections.sqlite"));
  await writeFile(join(root,"social-collections.sqlite"),"",{mode:0o644}); await assert.rejects(openCollectionStore(root),error("PRIVATE_STATE_INVALID"));
});
function catalog(n=43) {
  return { version:1,capturedAt:at,complete:true,accounts:[{platform:"bilibili",accountId:"10001"},{platform:"xiaohongshu",accountId:"000000000000000000000001"}],
    entries:[{platform:"bilibili",accountId:"10001",publicationId:"BV0000000001",kind:"unresolved-video-card"},
      ...Array.from({length:n},(_,i)=>({platform:"xiaohongshu",accountId:"000000000000000000000001",publicationId:(i+2).toString(16).padStart(24,"0"),kind:"image-note"}))] };
}
const existing=config({version:1,publications:[{platform:"xiaohongshu",accountId:"000000000000000000000001",workId:"example-note",url:"https://www.xiaohongshu.com/explore/000000000000000000000002"}]});
test("offline plan produces executable twenty-item configs, skips configured sources and blocks unresolved video cards", () => {
  const plan=planDetailBatches(catalog(),existing);
  assert.equal(plan.executed,false); assert.equal(plan.skippedConfigured,1); assert.equal(plan.ready,42); assert.equal(plan.blocked.length,1);
  assert.deepEqual(plan.batches.map(b=>config(b.config).length),[20,20,2]); assert.equal(plan.blocked[0].code,"COLLECTION_SCOPE_REQUIRED");
  const reversed=catalog(); reversed.entries.reverse();
  assert.deepEqual(plan.batches,planDetailBatches(reversed,existing).batches);
  assert.equal(new Set(plan.batches.flatMap(b=>config(b.config).map(t=>t.workId))).size,42);
});
test("offline plan rejects incomplete inventory, duplicate cards and foreign accounts", () => {
  const incomplete=catalog(); incomplete.complete=false; assert.throws(()=>planDetailBatches(incomplete,existing),error("CATALOG_INVALID"));
  const duplicate=catalog(); duplicate.entries.push(duplicate.entries[1]); assert.throws(()=>planDetailBatches(duplicate,existing),error("CATALOG_DUPLICATE"));
  const foreign=catalog(); foreign.entries[1].accountId="000000000000000000000099"; assert.throws(()=>planDetailBatches(foreign,existing),error("CATALOG_INVALID"));
});
test("real CLI plans and exports private candidates without creating the old database or acknowledging uploads", async t => {
  const root=await directory(t), cli=fileURLToPath(new URL("../scripts/social-sync/cli.ts",import.meta.url));
  const run=(command:string)=>JSON.parse(execFileSync(process.execPath,[cli,command,root],{encoding:"utf8"}));
  assert.deepEqual(run("collections-status"),{initialized:false});
  await writeFile(join(root,"config.json"),JSON.stringify({version:1,publications:existing.map(({publicationId:_id,...r})=>r)}),{mode:0o600});
  await writeFile(join(root,"catalog.json"),JSON.stringify(catalog()),{mode:0o600});
  assert.equal(run("plan-details").planned,42); assert.equal((await stat(join(root,"detail-plan.json"))).mode&0o077,0);
  const store=(await openCollectionStore(root))!; store.ingest(row()); store.close();
  assert.equal(run("collections-export").exported,1);
  const exported=JSON.parse(await readFile(join(root,"collection-candidates.json"),"utf8"));
  assert.equal(exported.cloudUploadSupported,true); assert.equal(exported.websitePublicationApproved,false);
  for (const file of ["social.sqlite","pending.json","latest-upload.json"]) await assert.rejects(stat(join(root,file)),{code:"ENOENT"});
});
test("invalid collection config and inventory fail before any database is created, with generic CLI errors", async t => {
  const root=await directory(t), cli=fileURLToPath(new URL("../scripts/social-sync/cli.ts",import.meta.url));
  await writeFile(join(root,"collection-config.json"),JSON.stringify({version:1,collections:[{...target,secret:"private"}]}),{mode:0o600});
  const result=spawnSync(process.execPath,[cli,"collect-collections",root],{encoding:"utf8"}); assert.equal(result.status,1);
  assert.deepEqual(JSON.parse(result.stderr.trim().split("\n").at(-1)!),{code:"COLLECTION_INVALID"});
  assert.equal(result.stderr.includes("private"),false);
  await assert.rejects(stat(join(root,"social-collections.sqlite")),{code:"ENOENT"});
});
