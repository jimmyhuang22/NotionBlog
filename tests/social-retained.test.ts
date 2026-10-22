import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { SqlExecutor } from "../src/server/database/sql.ts";
import { config, hash, publicationKey } from "../scripts/social-sync/model.ts";
import type { Observation } from "../scripts/social-sync/model.ts";
import { observation } from "../scripts/social-sync/bilibili.ts";
import { snapshotObservation } from "../scripts/social-sync/xiaohongshu.ts";
import { collectionKey } from "../scripts/social-sync/collection.ts";
import type { CollectionSnapshot } from "../scripts/social-sync/collection.ts";
import { exampleCollectionSnapshot } from "./helpers/social-collection-samples.ts";
import { createRetainedSocialRepository, readRetainedSocialSnapshot, retainedTimelineSql, socialDisplayMode } from "../src/server/social/retained-repository.ts";
import { readSocialTimelineSnapshot } from "../src/server/social/timeline-repository.ts";
import { socialSampleStatus } from "../src/lib/content/social-sample-status.ts";
import { ContentServiceError } from "../contracts/repository.ts";
import { createHomeFeedV2Repository } from "../src/lib/content/home-feed-v2-core.ts";
import { homeFeedResponse } from "../src/lib/content/home-feed-http.ts";

const stamp=(hours:number)=>new Date(Date.now()+hours*3600000).toISOString();
const target=config({version:1,publications:[{platform:"bilibili",workId:"example-work",accountId:"10001",url:"https://www.bilibili.com/video/BV0000000003/"}]})[0]!;
const note=config({version:1,publications:[{platform:"xiaohongshu",workId:"example-note",accountId:"000000000000000000000001",url:"https://www.xiaohongshu.com/explore/000000000000000000000002"}]})[0]!;
const video=(at:string)=>observation(`<script>window.__INITIAL_STATE__=${JSON.stringify({videoData:{bvid:target.publicationId,owner:{mid:10001},title:"Example video",stat:{like:0,reply:3}}})};</script>`,target,at);
const xhs=(at:string)=>snapshotObservation({version:1,source:"browser-note-state",observedAt:at,pageUrl:note.url,note:{noteId:note.publicationId,userId:note.accountId,type:"normal",title:"Example note",time:null,lastUpdateTime:null,coverUrl:null,
 interactInfo:{likedCount:"1.2万",commentCount:"0",shareCount:null,collectedCount:"4"}}},note,at);
const migration="20261012213401_social_retained_projections.sql";
async function engine(t:{after:(fn:()=>Promise<void>)=>void}) {
 const db=await PGlite.create();t.after(()=>db.close());
 await db.exec("CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;CREATE ROLE nb_reader;");
 for(const f of ["20261012005001_social_sync_v1.sql","20261012015408_social_reader_v1.sql","20261012020551_social_reader_binding_index.sql","20261012054647_social_collections_v1.sql",migration,"20261013214552_social_collection_follow_members.sql"])await db.exec(await readFile(new URL(`../supabase/migrations/${f}`,import.meta.url),"utf8"));
 const role=(name:string):SqlExecutor=>({query:<T>(sql:string,values?:unknown[])=>db.transaction(async tx=>{await tx.exec(`SET LOCAL ROLE ${name}`);return tx.query<T>(sql,values);})});
 const worker=role("nb_social_worker"),reader=role("nb_social_reader");
 const ingestPub=async(p:Observation)=>worker.query("SELECT * FROM social_sync.ingest($1,$2,$3)",[publicationKey(p),hash(JSON.stringify(p)),JSON.stringify(p)]);
 const registerPub=async(p:Observation)=>{await db.query("INSERT INTO social_sync.bindings(platform,account_id,publication_id,work_id,enabled) VALUES($1,$2,$3,$4,true)",[p.platform,p.accountId,p.publicationId,p.workId]);await ingestPub(p);};
 const approvePub=async(p:Observation,url:string|null=null,checked:string|null=null)=>{
  await db.query("INSERT INTO social_sync.works(work_id,title,approved) VALUES($1,'Reviewed work',true) ON CONFLICT(work_id) DO NOTHING",[p.workId]);
  await db.query("INSERT INTO social_sync.retained_publications(publication_key,work_id,approved,reviewed_at,reviewed_kind,approved_source_sha256,source_sha256,outbound_url,link_checked_at) VALUES($1,$2,true,now(),$3,$4,$4,$5,$6)",[publicationKey(p),p.workId,p.kind,hash(JSON.stringify(p)),url,checked]);
 };
 const ingestCol=async(p:CollectionSnapshot)=>worker.query("SELECT * FROM social_sync.ingest_collection($1,$2,$3)",[collectionKey(p.target),hash(JSON.stringify(p)),JSON.stringify(p)]);
 const registerCol=async(p:CollectionSnapshot)=>{await db.query("INSERT INTO social_sync.collection_bindings(account_id,kind,collection_id,enabled) VALUES($1,$2,$3,true)",[p.target.accountId,p.target.kind,p.target.collectionId]);await ingestCol(p);};
 const approveCol=async(p:CollectionSnapshot)=>db.query(`INSERT INTO social_sync.retained_collections(collection_key,approved,reviewed_at,title,approved_source_sha256,source_sha256,approved_member_keys)
  SELECT collection_key,true,now(),'Reviewed collection',payload_sha256,payload_sha256,member_review_keys FROM social_sync.collection_states WHERE collection_key=$1`,[collectionKey(p.target)]);
 return {db,reader,worker,role,registerPub,ingestPub,approvePub,registerCol,ingestCol,approveCol};
}
test("retained snapshots keep last successful statistics past trial expiry without rewriting dates, zero or rounded counts",async t=>{
 const e=await engine(t),at=stamp(-72),b=video(at),n=xhs(at),c=exampleCollectionSnapshot(at);
 await e.registerPub(b);await e.approvePub(b,target.url,at);await e.registerPub(n);
 const share=`https://www.xiaohongshu.com/discovery/item/${note.publicationId}?source=webshare&xhsshare=pc_web&xsec_token=${"a".repeat(32)}&xsec_source=pc_share`;
 await e.approvePub(n,share,at);await e.registerCol(c);await e.approveCol(c);
 const snapshot=await readRetainedSocialSnapshot(e.reader);assert.equal(snapshot.items.length,3);
 const publication=snapshot.items.find(x=>x.id===b.workId)!.publications[0]!;assert.equal(publication.observedAt,at);assert.equal(publication.metrics.likes,0);assert.equal(publication.linkVerifiedAt,at);
 const actualNote=snapshot.items.find(x=>x.id===n.workId)!.publications[0]!;assert.equal(actualNote.metrics.likes,null);assert.equal(actualNote.metricDisplay.likes,"1.2万");assert.equal(actualNote.metrics.comments,0);
 assert.equal(snapshot.items.find(x=>x.collection)!.collection!.observedAt,at);
 assert.equal((await readSocialTimelineSnapshot(e.reader)).items.length,0);
 assert.equal((await e.reader.query("SELECT publication_key,payload FROM social_sync.publications")).rows.length,0);
 const serialized=JSON.stringify(snapshot.items);assert(!/publicationId|accountId|member_review_keys|payload_sha256/.test(serialized));
});
test("successful source ingestion updates only a reviewed identity and same-member projection, preserving actual sample time and review metadata",async t=>{
 const e=await engine(t),b=video(stamp(-72)),c=exampleCollectionSnapshot(stamp(-72));
 await e.registerPub(b);await e.approvePub(b,target.url,b.observedAt);await e.registerCol(c);await e.approveCol(c);
 const originalActivity=(await readRetainedSocialSnapshot(e.reader)).items.find(x=>x.collection)!.collection!.activity;
 const before=await e.db.query("SELECT reviewed_at,approved_source_sha256,link_checked_at FROM social_sync.retained_publications");
 const changed=video(stamp(-2));changed.metrics.likes=5;await e.ingestPub(changed);
 const collection=structuredClone(c);collection.observedAt=stamp(-2);collection.metrics.likes=8;await e.ingestCol(collection);
 const snapshot=await readRetainedSocialSnapshot(e.reader);assert.equal(snapshot.items.find(x=>x.id===b.workId)!.publications[0]!.metrics.likes,5);
 assert.equal(snapshot.items.find(x=>x.id===b.workId)!.publications[0]!.observedAt,changed.observedAt);
 assert.equal(snapshot.items.find(x=>x.collection)!.collection!.metrics.likes,8);
 assert.deepEqual(snapshot.items.find(x=>x.collection)!.collection!.activity,originalActivity);
 assert.deepEqual((await e.db.query("SELECT reviewed_at,approved_source_sha256,link_checked_at FROM social_sync.retained_publications")).rows,before.rows);
 const unlisted={...changed,workId:"unlisted-work",publicationId:"BV0000000004",originalUrl:"https://www.bilibili.com/video/BV0000000004/"};await e.registerPub(unlisted);
 assert.equal((await readRetainedSocialSnapshot(e.reader)).items.length,2);
});
test("unreviewed additions retain the prior card; later removal cannot smuggle its detection activity into statistics",async t=>{
 const e=await engine(t),original=exampleCollectionSnapshot(stamp(-72));await e.registerCol(original);await e.approveCol(original);
 const before=await readRetainedSocialSnapshot(e.reader),added=structuredClone(original);added.observedAt=stamp(-5);added.metrics.likes=50;
 added.members.push({id:"BV0000000003",publishedAt:null,parts:["1003"],partsComplete:true});await e.ingestCol(added);
 assert.deepEqual(await readRetainedSocialSnapshot(e.reader),before);
 const removed=structuredClone(original);removed.observedAt=stamp(-3);removed.metrics.likes=60;await e.ingestCol(removed);
 const current=(await readRetainedSocialSnapshot(e.reader)).items[0]!.collection!;
 assert.equal(current.memberCount,2);assert.equal(current.metrics.likes,60);assert.deepEqual(current.activity,before.items[0]!.collection!.activity);assert.deepEqual(current.latestAddition,before.items[0]!.collection!.latestAddition);
 const raw=(await e.db.query<{card:{activity:unknown}}>("SELECT card FROM social_sync.collection_states")).rows[0]!;assert.notDeepEqual(raw.card.activity,current.activity);
});
test("member part/completeness changes and note kind changes do not replace the reviewed snapshot",async t=>{
 const e=await engine(t),c=exampleCollectionSnapshot(stamp(-72)),n=xhs(stamp(-72));await e.registerCol(c);await e.approveCol(c);await e.registerPub(n);await e.approvePub(n);
 const before=await readRetainedSocialSnapshot(e.reader),changed=structuredClone(c);changed.observedAt=stamp(-5);changed.members[1]!.partsComplete=true;await e.ingestCol(changed);
 const noteChanged=xhs(stamp(-5));noteChanged.kind="video";await e.ingestPub(noteChanged);
 assert.deepEqual(await readRetainedSocialSnapshot(e.reader),before);
});
test("explicit revocation, binding disable and source deletion withdraw immediately; collection folding uses the reviewed members",async t=>{
 const e=await engine(t),c=exampleCollectionSnapshot(stamp(-72)),b=video(stamp(-72));await e.registerCol(c);await e.approveCol(c);await e.registerPub(b);await e.approvePub(b);
 const member={...b,workId:"member-work",publicationId:"BV0000000001",originalUrl:"https://www.bilibili.com/video/BV0000000001/"};await e.registerPub(member);await e.approvePub(member);
 assert.equal((await readRetainedSocialSnapshot(e.reader)).items.length,2);
 await e.db.query("UPDATE social_sync.retained_collections SET approved=false WHERE collection_key=$1",[collectionKey(c.target)]);
 assert.equal((await readRetainedSocialSnapshot(e.reader)).items.length,2);
 await e.db.query("UPDATE social_sync.bindings SET enabled=false WHERE publication_key=$1",[publicationKey(b)]);assert.equal((await readRetainedSocialSnapshot(e.reader)).items.length,1);
 await e.db.query("UPDATE social_sync.bindings SET enabled=true WHERE publication_key=$1",[publicationKey(b)]);assert.equal((await readRetainedSocialSnapshot(e.reader)).items.length,1);
 await e.db.query("DELETE FROM social_sync.publications WHERE publication_key=$1",[publicationKey(member)]);assert.equal((await readRetainedSocialSnapshot(e.reader)).items.length,0);
});
test("retained RLS and grants deny raw scope details, all writes and trigger execution to worker, reader and public roles",async t=>{
 const e=await engine(t);
 for(const actor of [e.reader,e.worker]){
  for(const query of ["UPDATE social_sync.retained_publications SET approved=true","DELETE FROM social_sync.retained_collections"])await assert.rejects(actor.query(query),/permission denied/);
  const privilege=await actor.query<{allowed:boolean}>("SELECT has_function_privilege(current_user,'social_sync.sync_retained_source()','EXECUTE') AS allowed");assert.equal(privilege.rows[0]!.allowed,false);
  await assert.rejects(actor.query("SELECT social_sync.sync_retained_source()"),/permission denied/);
 }
 for(const query of ["SELECT approved_member_keys FROM social_sync.retained_collections","SELECT approved_source_sha256 FROM social_sync.retained_publications"])
  await assert.rejects(e.reader.query(query),/permission denied/);
 await assert.rejects(e.worker.query("SELECT * FROM social_sync.retained_publications"),/permission denied/);
 for(const name of ["anon","authenticated","service_role","nb_reader"])await assert.rejects(e.role(name).query("SELECT * FROM social_sync.retained_website_collections"),/permission denied/);
 const views=await e.db.query<{reloptions:string[]}>("SELECT reloptions FROM pg_class WHERE oid IN ('social_sync.retained_website_publications'::regclass,'social_sync.retained_website_collections'::regclass,'social_sync.retained_website_collection_members'::regclass)");
 assert(views.rows.every(x=>x.reloptions.includes("security_invoker=true")));
});
test("retained approvals bind the current source digest and exact outbound identity",async t=>{
 const e=await engine(t),b=video(stamp(-72));await e.registerPub(b);
 await e.db.query("INSERT INTO social_sync.works(work_id,title,approved) VALUES($1,'Reviewed work',true)",[b.workId]);
 await assert.rejects(e.db.query("INSERT INTO social_sync.retained_publications(publication_key,work_id,approved,reviewed_at,reviewed_kind,approved_source_sha256,source_sha256) VALUES($1,$2,true,now(),'video',$3,$3)",[publicationKey(b),b.workId,"0".repeat(64)]),/NB_SOCIAL_RETAINED_SOURCE/);
 await assert.rejects(e.approvePub(b,"https://evil.example/",b.observedAt),/NB_SOCIAL_RETAINED_LINK/);
});
test("retained and mixed home paging survive publication/collection statistics refresh and still reject withdrawals",async t=>{
 const e=await engine(t),c=exampleCollectionSnapshot(stamp(-72)),b=video(stamp(-72));await e.registerCol(c);await e.approveCol(c);await e.registerPub(b);await e.approvePub(b,target.url,b.observedAt);
 const feed=createHomeFeedV2Repository({content:async()=>({version:"content-fixture",items:[]}),
  social:()=>readRetainedSocialSnapshot(e.reader),sources:{content:"mock",social:"database"},timeZone:"Australia/Melbourne"});
 const response=await homeFeedResponse(new Request("http://example.test/api/home/feed-v2?limit=1"),feed);
 assert.equal(response.status,200);const first=await response.json();const cursor=first.data.nextCursor;assert(cursor);
 const repo=createRetainedSocialRepository(e.reader),page=await repo.listWorks({limit:1});assert(page.nextCursor);
 const next=await repo.listWorks({limit:1,cursor:page.nextCursor});assert.equal(next.items.length,1);assert.notEqual(next.items[0]!.id,page.items[0]!.id);
 const before=await readRetainedSocialSnapshot(e.reader);
 const changed=video(stamp(-2));changed.metrics.likes=10;await e.ingestPub(changed);
 const changedCollection=structuredClone(c);changedCollection.observedAt=stamp(-2);changedCollection.metrics.views=2000;await e.ingestCol(changedCollection);
 // A link-verification timestamp is another sample time; the checked URL is unchanged.
 await e.db.query("UPDATE social_sync.retained_publications SET link_checked_at=$2 WHERE publication_key=$1 AND outbound_url IS NOT NULL",[publicationKey(b),stamp(-1)]);
 const after=await readRetainedSocialSnapshot(e.reader);assert.equal(after.version,before.version);
 assert.notEqual(after.items.find(w=>w.id===b.workId)!.publications[0]!.linkVerifiedAt,before.items.find(w=>w.id===b.workId)!.publications[0]!.linkVerifiedAt);
 assert.equal(after.items.find(w=>w.collection)!.collection!.metrics.views,2000);
 const refreshed=await repo.listWorks({limit:1,cursor:page.nextCursor});assert.equal(refreshed.items[0]!.publications[0]!.metrics.likes,10);
 assert.equal(refreshed.items[0]!.publications[0]!.observedAt,changed.observedAt);
 const second=await homeFeedResponse(new Request(`http://example.test/api/home/feed-v2?limit=1&cursor=${cursor}`),feed);
 assert.equal(second.status,200);assert.equal(second.headers.get("cache-control"),"private, no-store");
 const data=await second.json();assert.notEqual(data.data.items[0].id,first.data.items[0].id);
 assert.equal(data.data.items[0].work.publications[0].metrics.likes,10);
 await e.db.query("UPDATE social_sync.retained_publications SET approved=false WHERE publication_key=$1",[publicationKey(b)]);
 await assert.rejects(repo.listWorks({limit:1,cursor:page.nextCursor}),e=>e instanceof ContentServiceError&&e.code==="INVALID_QUERY");
 const withdrawn=await homeFeedResponse(new Request(`http://example.test/api/home/feed-v2?limit=1&cursor=${cursor}`),feed);assert.equal(withdrawn.status,400);
});
test("display policy fails explicitly when misconfigured or its migration/query is unavailable",async()=>{
 assert.equal(socialDisplayMode(undefined),"trial");assert.equal(socialDisplayMode("retained"),"retained");assert.throws(()=>socialDisplayMode("unknown"),ContentServiceError);
 for(const version of [0,2])await assert.rejects(readRetainedSocialSnapshot({query:async()=>({rows:[{version}]})} as unknown as SqlExecutor),ContentServiceError);
 await assert.rejects(readRetainedSocialSnapshot({query:async()=>{throw Error("private SQL detail");}}),e=>e instanceof ContentServiceError&&!e.message.includes("private SQL"));
 assert.match(retainedTimelineSql,/publications AS MATERIALIZED/);assert(!retainedTimelineSql.includes("FROM social_sync.website_publications"));
});
test("sample-time metadata marks overdue statistics at the chosen periods without replacing the actual date",()=>{
 const at="2026-01-02T00:00:00.000Z";
 assert.deepEqual(socialSampleStatus("bilibili",at,"2026-01-02T06:00:00.000Z"),{observedAt:at,nextExpectedAt:"2026-01-02T06:00:00.000Z",overdue:true});
 assert.equal(socialSampleStatus("xiaohongshu",at,"2026-01-02T23:59:59.999Z").overdue,false);
 assert.equal(socialSampleStatus("xiaohongshu",at,"2026-01-03T00:00:00.000Z").overdue,true);
 assert.throws(()=>socialSampleStatus("bilibili",at,"2026-01-01T23:59:00.000Z"),ContentServiceError);
});
