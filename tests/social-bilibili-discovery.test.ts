import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeJson } from "../scripts/game-sync/private.ts";
import { automaticVideoTarget, classifyDiscoveredVideo, collectAccountPublication, completeDirectory, directoryPage, readClassification } from "../scripts/social-sync/bilibili-discovery.ts";
import { discoveredScope } from "../scripts/social-sync/bilibili-account-scope.ts";
import { readRefreshScope } from "../scripts/social-sync/refresh-scope.ts";
import { handleBilibiliDiscovery } from "../scripts/social-sync/bilibili-discovery-bridge.ts";
import { hash, SocialSyncError } from "../scripts/social-sync/model.ts";
import { collectionKey } from "../scripts/social-sync/collection.ts";
import { refreshConfig } from "../scripts/social-sync/refresh.ts";
import { openStore } from "../scripts/social-sync/store.ts";
import { openCollectionStore } from "../scripts/social-sync/collection-store.ts";
import { acquireLock } from "../scripts/notion-sync/state.ts";

const stamp = () => new Date().toISOString(), id = (n: number) => `BV${String(n).padStart(10, "0")}`;
function pages(total = 83, at = stamp()) {
  return Array.from({ length: Math.ceil(total / 40) }, (_, i) => ({ version: 1, accountId: "10001", observedAt: at, page: i + 1, pageSize:40, pages: Math.ceil(total / 40), total,
    ids: Array.from({ length: Math.min(40, total - i * 40) }, (_, j) => id(i * 40 + j + 1)) }));
}
function source(kind = "single") {
  return { videoData: { bvid: id(1), aid: 100, owner: { mid: 10001 }, title: "Example video", state: 0, pubdate: 1700000000, pic: null, desc: "Example",
    stat: { aid: 100, view: 0, like: 0, reply: 0 }, videos: kind === "multi" ? 2 : 1, pages: kind === "multi" ? [{ cid: 1000 }, { cid: 1001 }] : [{ cid: 1000 }],
    ugc_season: kind !== "season" ? null : { id: 200, mid: 10001, title: "Example season", ep_count: 1, stat: { season_id: 200 }, sections: [{ season_id: 200,
      episodes: [{ bvid: id(1), aid: 100, season_id: 200, pages: [{ cid: 1000 }], arc: { aid: 100, author: { mid: 10001 }, state: 0, videos: 1, pubdate: 1700000000 } }] }] } } };
}
const html = (s = source()) => `<script>window.__INITIAL_STATE__=${JSON.stringify(s)};</script>`;

test("directory traversal requires complete stable pages and never treats a partial list as removal", () => {
  const at = stamp(), values = pages(83, at), result = completeDirectory(values, "10001", at);
  assert.equal(result.ids.length, 83); assert.equal(new Set(result.ids).size, 83);
  for (const mutation of [(p: ReturnType<typeof pages>) => p.pop(), (p: ReturnType<typeof pages>) => p[1]!.ids.splice(0, 1),
    (p: ReturnType<typeof pages>) => { p[1]!.ids[0] = p[0]!.ids[0]!; }, (p: ReturnType<typeof pages>) => { p[1]!.total++; },
    (p: ReturnType<typeof pages>) => { p[1]!.page = 1; }, (p: ReturnType<typeof pages>) => { p[0]!.observedAt = "2026-01-01T00:00:00.000Z"; }]) {
    const changed = structuredClone(values); mutation(changed); assert.throws(() => completeDirectory(changed, "10001", at), SocialSyncError);
  }
  assert.throws(() => directoryPage(values[0], "10002"), SocialSyncError);
});

test("one owned public response chooses singleton, multi-P or season without confusing their metrics", () => {
  const target = automaticVideoTarget("10001", id(1)), at = stamp();
  assert.equal(classifyDiscoveredVideo(html(), target, at).type, "publication");
  const multi = classifyDiscoveredVideo(html(source("multi")), target, at);
  assert.equal(multi.type, "collection"); if (multi.type === "collection") { assert.equal(multi.value.target.kind, "multi-part"); assert.equal(multi.value.members[0]!.parts.length, 2); }
  const season = classifyDiscoveredVideo(html(source("season")), target, at);
  assert.equal(season.type, "collection"); if (season.type === "collection") { assert.equal(season.value.target.kind, "season"); assert.equal(season.value.metrics.views, null); }
  const foreign = source(); foreign.videoData.owner.mid = 10002;
  const paid = { videoData: { ...source().videoData, is_upower_exclusive: true } };
  const incomplete = source(); incomplete.videoData.videos = 2;
  for (const value of [foreign, paid, incomplete]) assert.throws(() => classifyDiscoveredVideo(html(value), target, at), SocialSyncError);
  const foreignMember = source("season"); foreignMember.videoData.ugc_season!.sections[0]!.episodes[0]!.arc.author.mid = 10002;
  assert.throws(() => classifyDiscoveredVideo(html(foreignMember), target, at), SocialSyncError);
});

async function runtime(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nb-account-"))); await chmod(root, 0o700); t.after(() => rm(root, { recursive: true, force: true }));
  const pubDir = join(root, "publications"), colDir = join(root, "collections");
  const pub = await openStore(pubDir), col = await openCollectionStore(colDir); pub!.close(); col!.close();
  const base = refreshConfig({ version: 1, reviewedAt: stamp(), cadence: { bilibiliHours: 6, xiaohongshuHours: 24 }, stateDirectories: { publications: pubDir, collections: colDir },
    publications: [{ target: automaticVideoTarget("10001", id(1)), kind: "video" }], collections: [] });
  const policy = { version: 1 as const, baseScopeDigest: hash(JSON.stringify(base)), accountId: "10001", enabled: true };
  await writeJson(join(root, "refresh-config.json"), base); await writeJson(join(root, "bilibili-account.json"), policy);
  return { root, base, policy };
}

test("B-only discovered targets do not change Xiaohongshu or grant another account", async t => {
  const { root, base, policy } = await runtime(t), target = automaticVideoTarget("10001", id(2));
  await writeJson(join(root, "bilibili-discovered.json"), { version: 1, policyDigest: hash(JSON.stringify(policy)), publications: [{ target, kind: "video" }], collections: [] });
  assert.equal((await readRefreshScope(root, "bilibili")).publications.length, 2);
  assert.deepEqual(await readRefreshScope(root, "xiaohongshu"), base);
  for (const value of [{ ...target, accountId: "10002" }, { ...target, workId: "other-work" }]) {
    assert.throws(() => discoveredScope({ version: 1, policyDigest: hash(JSON.stringify(policy)), publications: [{ target: value, kind: "video" }], collections: [] }, base, policy), SocialSyncError);
  }
});

test("initial known directory completes with no source requests or uploads and lost reply does not recapture", async t => {
  const { root } = await runtime(t), started = await handleBilibiliDiscovery(root, { op: "bilibili-start", manual: false });
  assert("job" in started); let captures = 0, sends = 0;
  const ports = { capture: async () => { captures++; throw Error("unexpected capture"); }, execute: async () => { sends++; throw Error("unexpected upload"); } };
  const message = { op: "bilibili-submit", jobId: started.job!.id, pages: pages(1) };
  const completed = await handleBilibiliDiscovery(root, message, ports); assert.equal(completed.status, "complete"); assert.equal(captures, 0); assert.equal(sends, 0);
  assert.deepEqual(await handleBilibiliDiscovery(root, message, ports), completed);
  assert.equal((await handleBilibiliDiscovery(root, { op: "bilibili-start", manual: false }, ports)).status, "complete");
  assert.throws(() => completeDirectory([], "10001", stamp()), SocialSyncError);
});

test("a new owned singleton is durably registered before its pending upload, with old configuration unchanged", async t => {
  const { root, base } = await runtime(t), before = await readFile(join(root, "refresh-config.json"), "utf8"), started = await handleBilibiliDiscovery(root, { op: "bilibili-start", manual: false });
  assert("job" in started);
  let captures = 0, sent = 0;
  const result = await handleBilibiliDiscovery(root, { op: "bilibili-submit", jobId: started.job!.id, pages: pages(2) }, {
    capture: async (account, video) => { captures++; const s = source(); s.videoData.bvid = video; return classifyDiscoveredVideo(html(s), automaticVideoTarget(account, video), stamp()); },
    execute: async (_root, options) => {
      const scope = await readRefreshScope(root, "bilibili"); assert.equal(scope.publications.length, 2); assert.equal(options.uploadOnly, true);
      const store = await openStore(base.stateDirectories.publications); const target = scope.publications.find(p => p.target.publicationId === id(2))!.target;
      const p = store!.pendingFor(target); assert(p); sent++; store!.acknowledge(p.key, p.sha256); store!.close();
      return { uploaded: 1, failed: 0, paused: false, cancelled: false, superseded: 0 } as Awaited<ReturnType<typeof import("../scripts/social-sync/execute-cli.ts").executeAtRoot>>;
    },
  });
  assert.equal(result.status, "complete"); assert.equal(captures, 1); assert.equal(sent, 1); assert.equal(await readFile(join(root, "refresh-config.json"), "utf8"), before);
});

test("a representative belonging to an existing collection never creates another card", () => {
  const at = stamp(), first = classifyDiscoveredVideo(html(source("season")), automaticVideoTarget("10001", id(1)), at);
  assert.equal(first.type, "collection"); if (first.type !== "collection") return;
  const changed = structuredClone(first.value.target); changed.representativeUrl = `https://www.bilibili.com/video/${id(2)}/`;
  assert.equal(collectionKey(changed), collectionKey(first.value.target));
});

test("normal statistics capture also caches a type change, which discovery applies without recapturing",async t=>{
  const {root,base,policy}=await runtime(t),target=base.publications[0]!.target,policyDigest=hash(JSON.stringify(policy));
  let requests=0;
  const row=await collectAccountPublication(root,policyDigest,target,undefined,async()=>{requests++;return new Response(html(source("multi")),{headers:{"content-type":"text/html"}});});
  assert.equal(row.workId,target.workId);const cached=await readClassification(root,target,policyDigest,stamp());assert.equal(cached?.type,"collection");assert.equal(requests,1);
  const start=await handleBilibiliDiscovery(root,{op:"bilibili-start",manual:false});assert("job" in start);
  let recaptures=0;
  const result=await handleBilibiliDiscovery(root,{op:"bilibili-submit",jobId:start.job!.id,pages:pages(1)},{capture:async()=>{recaptures++;throw Error("unnecessary request");},
    execute:async(_root,o)=>{assert.equal(o.keys?.length,1);const scope=await readRefreshScope(root,"bilibili"),store=await openCollectionStore(base.stateDirectories.collections);
      const p=store!.pendingFor(scope.collections[0]!.target)!;store!.acknowledge(p);store!.close();return {uploaded:1,failed:0,paused:false,cancelled:false,superseded:0} as Awaited<ReturnType<typeof import("../scripts/social-sync/execute-cli.ts").executeAtRoot>>;}});
  assert.equal(result.status,"complete");assert.equal(recaptures,0);assert.equal((await readRefreshScope(root,"bilibili")).collections.length,1);
});

test("adaptive forty-two-item paging still verifies the exact last-page remainder",()=>{
  const at=stamp(),ps=42,total=109,pages=Array.from({length:3},(_,i)=>({version:1,accountId:"10001",observedAt:at,page:i+1,pageSize:ps,pages:3,total,
    ids:Array.from({length:Math.min(ps,total-i*ps)},(_,j)=>id(i*ps+j+1))}));
  assert.equal(completeDirectory(pages,"10001",at).ids.length,109);pages[1]!.pageSize=40;assert.throws(()=>completeDirectory(pages,"10001",at),SocialSyncError);
});

test("a waiting source lock keeps its completed capture and next uploads without another request",async t=>{
  const {root,base}=await runtime(t),start=await handleBilibiliDiscovery(root,{op:"bilibili-start",manual:false});assert("job" in start);
  let captures=0;const release=await acquireLock(base.stateDirectories.publications,"example-lock");
  const ports={capture:async(account:string,video:string)=>{captures++;const s=source();s.videoData.bvid=video;return classifyDiscoveredVideo(html(s),automaticVideoTarget(account,video),stamp());},
    execute:async()=>({uploaded:1,failed:0,paused:false,cancelled:false,superseded:0} as Awaited<ReturnType<typeof import("../scripts/social-sync/execute-cli.ts").executeAtRoot>>)};
  try{const waiting=await handleBilibiliDiscovery(root,{op:"bilibili-submit",jobId:start.job!.id,pages:pages(2)},ports);assert("deferred" in waiting);assert.equal(waiting.deferred,true);}finally{await release();}
  const done=await handleBilibiliDiscovery(root,{op:"bilibili-next"},ports);assert.equal(done.status,"complete");assert.equal(captures,1);
});

test("another visible member of an existing season is known without recapturing that season",async t=>{
  const {root,base}=await runtime(t),s=source("season"),c=classifyDiscoveredVideo(html(s),automaticVideoTarget("10001",id(1)),stamp());assert.equal(c.type,"collection");if(c.type!=="collection")return;
  c.value.members.push({id:id(2),publishedAt:null,parts:["1002"],partsComplete:true});
  const store=await openCollectionStore(base.stateDirectories.collections);store!.ingest(c.value);store!.acknowledge(store!.pendingFor(c.value.target)!);store!.close();
  const raw=refreshConfig({...base,collections:[{target:c.value.target,memberShas:c.value.members.map(m=>hash(JSON.stringify([m.id,m.parts,m.partsComplete]))).sort(),membershipMode:"follow-public"}]});
  const policy={version:1,baseScopeDigest:hash(JSON.stringify(raw)),accountId:"10001",enabled:true};await writeJson(join(root,"refresh-config.json"),raw);await writeJson(join(root,"bilibili-account.json"),policy);
  const start=await handleBilibiliDiscovery(root,{op:"bilibili-start",manual:false});assert("job" in start);
  const done=await handleBilibiliDiscovery(root,{op:"bilibili-submit",jobId:start.job!.id,pages:pages(2)},{capture:async()=>{throw Error("known member must not be recaptured");}});assert.equal(done.status,"complete");
});
