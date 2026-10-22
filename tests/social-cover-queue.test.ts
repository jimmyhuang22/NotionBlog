import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { hash, config, publicationKey } from "../scripts/social-sync/model.ts";
import { observation } from "../scripts/social-sync/bilibili.ts";
import { collectionKey, collectionFromPage, collectCollection } from "../scripts/social-sync/collection.ts";
import { collectionMemberShas } from "../scripts/social-sync/refresh.ts";
import type { RefreshConfig } from "../scripts/social-sync/refresh.ts";
import { openStore } from "../scripts/social-sync/store.ts";
import { openCollectionStore } from "../scripts/social-sync/collection-store.ts";
import { openCoverQueue } from "../scripts/social-media/queue.ts";
import { createCoverHandoff } from "../scripts/social-media/handoff.ts";
import { sourceDigest, publicationCoverSource, collectionCoverSource, type CoverSource } from "../scripts/social-media/sources.ts";
import { prepareCover, syncCovers, type CoverWriter } from "../scripts/social-media/worker.ts";
import { createCoverCache } from "../scripts/social-media/cache.ts";
import { refreshQueuedCollections } from "../scripts/social-media/collection-refresh.ts";
import { consumeCoverQueue } from "../scripts/social-media/queue-worker.ts";
import { runCoverQueueCli } from "../scripts/social-media/queue-cli.ts";
import { acquireLock } from "../scripts/notion-sync/state.ts";
import { seedAcknowledgedCovers } from "../scripts/social-media/seed.ts";
import type { CoverFiles } from "../src/server/social/covers.ts";
import type { StoredMedia } from "../contracts/sync.ts";

const at="2026-01-02T00:00:00.000Z",later="2026-01-02T01:00:00.000Z";
const target=(n=1)=>config({version:1,publications:[{platform:"bilibili",accountId:"10001",workId:`example-${n}`,url:`https://www.bilibili.com/video/BV${String(n).padStart(10,"0")}/`}]})[0]!;
const row=(n=1,time=at)=>observation(`<script>window.__INITIAL_STATE__=${JSON.stringify({videoData:{bvid:target(n).publicationId,owner:{mid:10001},title:"Example",pic:"https://i0.hdslb.com/example.png",stat:{like:0}}})};</script>`,target(n),time);
function collectionPage() {
  return `<script>window.__INITIAL_STATE__=${JSON.stringify({videoData:{bvid:"BV0000000001",aid:100,owner:{mid:10001},state:0,title:"Example",pic:"https://i0.hdslb.com/video.png",videos:2,pages:[{cid:1000},{cid:1001}],pubdate:1700000000,stat:{aid:100,like:0}}})};</script>`;
}
const collectionTarget={platform:"bilibili" as const,kind:"multi-part" as const,accountId:"10001",collectionId:"BV0000000001",representativeUrl:"https://www.bilibili.com/video/BV0000000001/"};
async function fixture(t:{after:(f:()=>Promise<void>)=>void}) {
  const root=await realpath(await mkdtemp(join(tmpdir(),"nb-cover-queue-")));await chmod(root,0o700);
  t.after(()=>rm(root,{recursive:true,force:true}));return root;
}
async function policy(root:string) { await writeFile(join(root,"social-cover-policy.json"),JSON.stringify({version:1,enabled:true,mode:"retained"}),{mode:0o600}); }
async function media(root:string) {
  const stored=new Map<string,Uint8Array>(),bindings=new Map<string,{sourceSha256:string;files:CoverFiles}>();
  const counts={gets:0,puts:0,reads:0,registers:0,collectionSources:0};
  const bytes=await sharp({create:{width:32,height:24,channels:3,background:"#817293"}}).png().toBuffer();
  const writer:CoverWriter={source:async s=>({sha256:sourceDigest(s)}),collectionSource:async()=>{counts.collectionSources++;},read:async s=>bindings.get(s.key)??null,
    register:async(s,_m,files)=>{counts.registers++;bindings.set(s.key,{sourceSha256:sourceDigest(s)!,files});}};
  const storage={put:async(m:StoredMedia,b:Uint8Array)=>{counts.puts++;stored.set(m.sha256,b);},read:async(m:StoredMedia)=>{counts.reads++;return stored.get(m.sha256)!;}};
  const cache=await createCoverCache(join(root,"cache"));
  const ports={writer,storage,cache,download:async()=>{counts.gets++;return bytes;}};
  return {ports,counts,bindings,bytes};
}
test("private queue survives reopen, replaces only newer references and rejects a stale consumer ACK",async t=>{
  const root=await fixture(t),a=publicationCoverSource(row());let q=(await openCoverQueue(root))!;
  q.offer(a,"retained");const old=q.pending("retained")[0]!;
  const next={...a,url:"https://i0.hdslb.com/new.png",observedAt:later};q.offer(next,"retained");
  assert.equal(q.finish(old,"complete"),false);q.offer(a,"retained");q.close();
  q=(await openCoverQueue(root))!;
  try { assert.equal(q.pending("retained")[0]!.source.url,next.url);assert.equal(q.summary(later).pending,1); }
  finally {q.close();}
  assert.equal((await stat(join(root,"social-cover-queue","social.sqlite"))).mode&0o077,0);
});
test("completed publication statistics with the same full URL cause no new media work; modes remain isolated",async t=>{
  const root=await fixture(t),q=(await openCoverQueue(root))!;t.after(async()=>q.close());
  const source=publicationCoverSource(row());q.offer(source,"retained");q.finish(q.pending("retained")[0]!,"complete");
  q.offer({...source,observedAt:later},"retained");assert.equal(q.pending("retained").length,0);
  q.offer(source,"trial");assert.equal(q.pending("trial").length,1);
  q.offer({...source,url:null,observedAt:"2026-01-02T02:00:00.000Z"},"retained");
  const e=await media(root),r=await consumeCoverQueue(q,"retained",e.ports);assert.equal(r.missing,1);assert.equal(e.counts.gets,0);
});
test("same-response collection sidecar is not queued until the exact accepted snapshot, and unchanged URL needs a timestamp refresh",async t=>{
  const root=await fixture(t);await policy(root);const h=createCoverHandoff(root),snapshot=collectionFromPage(collectionPage(),collectionTarget,at);
  await h.stageCollection(collectionPage(),snapshot);let q=(await openCoverQueue(root,true))!;
  assert.equal(q.pending("retained").length,0);q.close();
  await h.acknowledged({key:collectionKey(snapshot.target),sha256:hash(JSON.stringify(snapshot)),snapshot});
  q=(await openCoverQueue(root))!;q.finish(q.pending("retained")[0]!,"complete");q.close();
  const next=collectionFromPage(collectionPage(),collectionTarget,later);await h.stageCollection(collectionPage(),next);
  await h.acknowledged({key:collectionKey(next.target),sha256:hash(JSON.stringify(next)),snapshot:next});
  q=(await openCoverQueue(root,true))!;
  try {assert.equal(q.pending("retained").length,1);assert.equal(q.pending("retained")[0]!.source.observedAt,later);}finally{q.close();}
});
test("a missing or mismatched collection sidecar records a gap without guessing an image",async t=>{
  const root=await fixture(t),q=(await openCoverQueue(root))!;t.after(async()=>q.close());
  const snapshot=collectionFromPage(collectionPage(),collectionTarget,at),source=collectionCoverSource(collectionPage(),collectionTarget,at);
  q.stage(source,hash(JSON.stringify(snapshot)));
  assert.equal(q.acknowledgeCollection(source.key,"0".repeat(64),at,"retained"),false);
  assert.equal(q.summary(at).missingCollectionSources,1);assert.equal(q.pending("retained").length,0);
  assert.equal(q.acknowledgeCollection(source.key,hash(JSON.stringify(snapshot)),at,"retained"),true);
  assert.equal(q.summary(at).missingCollectionSources,0);
});
test("normal collection capture supplies its sidecar using the same single HTML request",async t=>{
  const root=await fixture(t);await policy(root);let requests=0;
  const snapshot=await collectCollection(collectionTarget,undefined,async()=>{requests++;return new Response(collectionPage(),{headers:{"content-type":"text/html"}});},createCoverHandoff(root).stageCollection);
  assert.equal(requests,1);const q=(await openCoverQueue(root,true))!;
  try {assert.equal(q.summary(at).stagedCollections,1);assert.equal(q.pending("retained").length,0);assert(snapshot.responseSha256);}finally{q.close();}
});
test("worker failure stops its batch, keeps pending siblings and retries only after an explicit local reset",async t=>{
  const root=await fixture(t),q=(await openCoverQueue(root))!;t.after(async()=>q.close());
  q.offer(publicationCoverSource(row(1)),"retained");q.offer(publicationCoverSource(row(2)),"retained");
  const e=await media(root);let attempts=0;e.ports.download=async()=>{attempts++;throw Error("private error must not escape");};
  const report=await consumeCoverQueue(q,"retained",e.ports);
  assert.equal(report.failed,1);assert.equal(attempts,1);assert.equal(q.summary(at).failed,1);assert.equal(q.summary(at).pending,1);
  assert(!JSON.stringify(q.summary(at)).includes("private error"));
  assert.equal(Number(q.retry("retained")),1);assert.equal(q.summary(at).pending,2);
});
test("concurrent producer cannot lose its new source when an older media registration finishes",async t=>{
  const root=await fixture(t),q=(await openCoverQueue(root))!;t.after(async()=>q.close());
  const source=publicationCoverSource(row());q.offer(source,"retained");const e=await media(root),register=e.ports.writer.register;
  e.ports.writer.register=async(...args)=>{q.offer({...source,observedAt:later,url:"https://i0.hdslb.com/replaced.png"},"retained");await register(...args);};
  const result=await consumeCoverQueue(q,"retained",e.ports);assert.equal(result.superseded,1);assert.equal(q.summary(later).pending,1);
  assert.equal(q.pending("retained")[0]!.source.observedAt,later);
});
test("unchanged registered objects and metadata-only collection refresh consume zero source GET, encoding, PUT or object read",async t=>{
  const root=await fixture(t),q=(await openCoverQueue(root))!;t.after(async()=>q.close());
  const source=collectionCoverSource(collectionPage(),collectionTarget,at);q.offer(source,"retained");const e=await media(root);
  const prepared=await prepareCover(source,e.bytes);e.bindings.set(source.key,{sourceSha256:sourceDigest(source)!,files:prepared.files});
  const r=await consumeCoverQueue(q,"retained",e.ports);
  assert.equal(r.unchanged,1);assert.equal(e.counts.collectionSources,1);assert.equal(r.sourceRequests+r.encoded+r.uploads+r.objectReads,0);
});
test("one consumer is bounded to twenty and its deadline spans the whole batch",async t=>{
  const root=await fixture(t),q=(await openCoverQueue(root))!;t.after(async()=>q.close());
  for(let n=1;n<=21;n++)q.offer(publicationCoverSource(row(n)),"retained");
  assert.equal(q.pending("retained").length,20);const e=await media(root);let ms=Date.parse(at),runs=0;
  const r=await consumeCoverQueue(q,"retained",e.ports,()=>{if(++runs===4)ms+=180001;return ms;});
  assert.equal(r.selected,20);assert.equal(r.completed,1);assert.equal(r.code,"COVER_BATCH_BUDGET");assert.equal(q.summary(later).pending,20);
  await assert.rejects(syncCovers([],"retained",{...e.ports,limits:{maxSourceBytes:80*1024*1024+1,maxDurationMs:180000,maxObjectOperations:120}}),/COVER_BATCH_INVALID/);
});
test("source reference change with identical bytes reuses encodings and registered objects",async t=>{
  const root=await fixture(t),q=(await openCoverQueue(root))!;t.after(async()=>q.close());
  const source=publicationCoverSource(row()),e=await media(root);q.offer(source,"retained");
  assert.equal((await consumeCoverQueue(q,"retained",e.ports)).completed,1);
  q.offer({...source,url:"https://i0.hdslb.com/refreshed.png",observedAt:later},"retained");
  const r=await consumeCoverQueue(q,"retained",e.ports);assert.equal(r.sourceRequests,1);assert.equal(r.reusedEncodings,1);assert.equal(r.encoded,0);assert.equal(r.uploads,0);assert(r.objectReads>0);
});
test("a short remaining dispatch window yields pending siblings without a failed attempt",async t=>{
  const root=await fixture(t),q=(await openCoverQueue(root))!;t.after(async()=>q.close());
  for(let n=1;n<=3;n++)q.offer(publicationCoverSource(row(n)),"retained");
  const e=await media(root);let ms=Date.parse(at);const register=e.ports.writer.register;
  e.ports.writer.register=async(...args)=>{await register(...args);ms+=151000;};
  const r=await consumeCoverQueue(q,"retained",e.ports,()=>ms);
  assert.equal(r.completed,1);assert.equal(r.deferred,2);assert.equal(r.failed,0);assert.equal(r.code,null);
  assert.equal(q.summary(later).pending,2);assert.equal(q.summary(later).failed,0);
  assert.equal(e.counts.gets,1);
});
test("source rejection for a superseded generation leaves the new input pending without reporting a media failure",async t=>{
  const root=await fixture(t),q=(await openCoverQueue(root))!;t.after(async()=>q.close());
  const source=publicationCoverSource(row());q.offer(source,"retained");const e=await media(root);
  e.ports.writer.source=async()=>{q.offer({...source,url:"https://i0.hdslb.com/new-generation.png",observedAt:later},"retained");return null;};
  const r=await consumeCoverQueue(q,"retained",e.ports);
  assert.equal(r.superseded,1);assert.equal(r.failed,0);assert.equal(r.code,null);assert.equal(q.summary(later).failed,0);
  assert.equal(q.pending("retained")[0]!.source.observedAt,later);assert.equal(e.counts.gets,0);
});
test("default-disabled hook does not create a queue; malformed policy is a separate error, not an upload failure",async t=>{
  const root=await fixture(t),value=row(),item={key:publicationKey(value),sha256:hash(JSON.stringify(value)),observation:value};
  await createCoverHandoff(root).acknowledged(item);await assert.rejects(stat(join(root,"social-cover-queue")));
  await writeFile(join(root,"social-cover-policy.json"),'{"enabled":true,"url":"https://example.invalid/private"}',{mode:0o600});
  await createCoverHandoff(root).acknowledged(item);
  const error=JSON.parse(await readFile(join(root,"social-cover-queue","hook-error.json"),"utf8"));assert.equal(error.code,"COVER_QUEUE_POLICY_INVALID");assert(!JSON.stringify(error).includes("http"));
  await policy(root);const invalid={...value,title:""};
  await createCoverHandoff(root).acknowledged({key:publicationKey(value),sha256:hash(JSON.stringify(invalid)),observation:invalid});
  const invalidReceipt=JSON.parse(await readFile(join(root,"social-cover-queue","hook-error.json"),"utf8"));assert.equal(invalidReceipt.code,"COVER_HANDOFF_INVALID_DATA");
});
test("seed uses only the exact latest local ACK and never accepts an unsent observation",async t=>{
  const root=await fixture(t),store=(await openStore(root))!,cols=(await openCollectionStore(root))!;
  const a=row(1),b=row(2),c=collectionFromPage(collectionPage(),collectionTarget,at);
  store.ingest(a);store.acknowledge(publicationKey(a),hash(JSON.stringify(a)));store.ingest(b);cols.ingest(c);cols.acknowledge(cols.pendingFor(c.target)!);store.close();cols.close();
  const scope:RefreshConfig={version:1,reviewedAt:at,cadence:{bilibiliHours:6,xiaohongshuHours:1},stateDirectories:{publications:root,collections:root},publications:[a,b].map(r=>({target:target(r===a?1:2),kind:"video"})),collections:[{target:c.target,memberShas:collectionMemberShas(c)}]};
  const report=await seedAcknowledgedCovers(root,async()=>scope,"retained");assert.deepEqual(report,{publications:1,collections:0,missingCollectionSources:1,skipped:1});
  const q=(await openCoverQueue(root,true))!;try{assert.equal(q.pending("retained").length,1);}finally{q.close();}
});
test("queue plan and empty sync do not read media credentials or start a network session",async t=>{
  const root=await fixture(t);await policy(root);const q=(await openCoverQueue(root))!;q.close();
  await runCoverQueueCli(["status",root]);await runCoverQueueCli(["plan",root]);
  await runCoverQueueCli(["sync",root,join(root,"no-media-credentials"),"--execute"]);
  await assert.rejects(runCoverQueueCli(["sync",root,join(root,"no-media-credentials")]),/COVER_USAGE/);
});
test("consumer lock is queue-wide across media directories and does not prevent the statistics producer",async t=>{
  const root=await fixture(t);await policy(root);const q=(await openCoverQueue(root))!;
  const release=await acquireLock(join(root,"social-cover-queue"),"example-consumer");
  try {
    q.offer(publicationCoverSource(row()),"retained");assert.equal(q.summary(at).pending,1);
    await assert.rejects(runCoverQueueCli(["sync",root,join(root,"media-a"),"--execute"]),{code:"BUSY"});
    await assert.rejects(runCoverQueueCli(["sync",root,join(root,"media-b"),"--execute"]),{code:"BUSY"});
    await assert.rejects(runCoverQueueCli(["sync",root,root,"--execute"]),/COVER_USAGE/);
  } finally {q.close();await release();}
});
test("a valid collection identity with a different snapshot cannot turn a staged cover into accepted media",async t=>{
  const root=await fixture(t);await policy(root);const snapshot=collectionFromPage(collectionPage(),collectionTarget,at);
  snapshot.title="Different accepted payload";
  await createCoverHandoff(root).stageCollection(collectionPage(),snapshot);
  await createCoverHandoff(root).acknowledged({key:collectionKey(snapshot.target),sha256:hash(JSON.stringify(snapshot)),snapshot});
  const q=(await openCoverQueue(root,true))!;
  try{assert.equal(q.pending("retained").length,0);assert.equal(q.summary(at).missingCollectionSources,1);}finally{q.close();}
  const error=JSON.parse(await readFile(join(root,"social-cover-queue","hook-error.json"),"utf8"));assert.equal(error.code,"COVER_COLLECTION_SOURCE_MISMATCH");
});

test("metadata refresh handles eighty ACKed collections before image work and preserves superseding generations",async t=>{
  const root=await fixture(t),q=(await openCoverQueue(root))!;t.after(async()=>q.close());
  const source=collectionCoverSource(collectionPage(),collectionTarget,at);
  for(let n=0;n<80;n++)q.offer({...source,key:hash(`fiction-collection-${n}`)},"retained");
  assert.equal(q.pending("retained").length,20); assert.equal(q.pendingCollections("retained").length,80);
  let calls=0;
  const report=await refreshQueuedCollections(q,"retained",async sources=>{
    calls++; const first=sources[0]!;
    q.offer({...first,url:"https://i0.hdslb.com/new-generation.png",observedAt:later},"retained");
    return sources.map(s=>s.key);
  });
  assert.equal(calls,1);assert.equal(report.refreshed,79);assert.equal(report.superseded,1);
  assert.equal(q.summary(later).pending,1);assert.equal(q.pending("retained")[0]!.source.observedAt,later);
});
test("unknown metadata acknowledgement leaves jobs pending and cannot fabricate completion",async t=>{
  const root=await fixture(t),q=(await openCoverQueue(root))!;t.after(async()=>q.close());
  q.offer(collectionCoverSource(collectionPage(),collectionTarget,at),"retained");
  await assert.rejects(refreshQueuedCollections(q,"retained",async()=>{throw Error("lost metadata acknowledgement");}));
  assert.equal(q.summary(at).pending,1); assert.equal(q.summary(at).failed,0);
  await assert.rejects(refreshQueuedCollections(q,"retained",async()=>[hash("unrequested-owner")]));
  assert.equal(q.summary(at).complete,0);
});
