import test from "node:test";
import assert from "node:assert/strict";
import type { SqlExecutor } from "../src/server/database/sql.ts";
import type { SocialTimelineWork } from "../contracts/social-timeline.ts";
import type { SocialCoverSnapshot } from "../src/server/social/cover-hydration.ts";
import { coverTestEngine, coverTestImage } from "./helpers/social-cover-engine.ts";
import { readRetainedSocialSnapshot } from "../src/server/social/retained-repository.ts";
import { withSocialCovers } from "../src/server/social/covers.ts";
import { createSocialWorksRepository } from "../src/server/social/works-repository.ts";
import { createHomeFeedV2Repository } from "../src/lib/content/home-feed-v2-core.ts";
import { publicationCoverSource } from "../scripts/social-media/sources.ts";
import { prepareCover } from "../scripts/social-media/worker.ts";
import { collectionKey } from "../scripts/social-sync/collection.ts";
import { hash } from "../scripts/social-sync/model.ts";
import { socialMediaResponse } from "../src/server/social/media.ts";
import type { StoredMedia } from "../contracts/sync.ts";
import { readFile } from "node:fs/promises";
import { exampleCollectionSnapshot } from "./helpers/social-collection-samples.ts";

test("real reader SQL hydrates only page owners and preserves the eager page/cursor DTO", async t => {
  const e=await coverTestEngine(t),row=await e.add("BV0000000003","work-a");
  await e.add("BV0000000004","work-b");await e.add("BV0000000005","work-c");
  const source=publicationCoverSource(row),prepared=await prepareCover(source,await coverTestImage());
  for(const mode of ["trial","retained"] as const)await e.writer.register(source,mode,prepared.files);
  for(const mode of ["trial","retained"] as const){
    const selected:string[][]=[];let queries=0;
    const reader:SqlExecutor={query:<T>(text:string,values?:unknown[])=>{
      queries++;if(values?.length===2)selected.push(JSON.parse(String(values[0])).map((w:{id:string})=>w.id));
      return e.reader.query<T>(text,values);
    }};
    const eager=createSocialWorksRepository(async()=>withSocialCovers(await readRetainedSocialSnapshot(e.reader),e.reader,mode));
    const paged=createSocialWorksRepository(async()=>{
      const snapshot=await readRetainedSocialSnapshot(e.reader);
      return {...snapshot,hydrateCovers:async items=>(await withSocialCovers({version:snapshot.version,items},reader,mode)).items};
    });
    const first=await paged.listWorks({limit:1});assert.deepEqual(first,await eager.listWorks({limit:1}));assert(first.items[0].cover);
    const next=await paged.listWorks({limit:1,cursor:first.nextCursor!});
    assert.deepEqual(next,await eager.listWorks({limit:1,cursor:first.nextCursor!}));assert.equal(next.items[0].cover,null);
    assert.deepEqual(selected,[[first.items[0].id],[next.items[0].id]]);assert.equal(queries,4);
    assert(!JSON.stringify(first).includes("hydrateCovers"));
    const feed=createHomeFeedV2Repository({content:async()=>({version:"content",items:[]}),social:async()=>{
      const snapshot=await readRetainedSocialSnapshot(e.reader);
      return {...snapshot,hydrateCovers:async items=>(await withSocialCovers({version:snapshot.version,items},reader,mode)).items};
    },sources:{content:"mock",social:"database"},timeZone:"UTC"});
    const home=await feed.getPage({limit:1});assert.deepEqual(selected.at(-1),home.items.map(i=>i.source==="social"?i.work.id:assert.fail()));
  }
});

test("withdrawal between snapshot and hydration removes the cover and invalidates old paging", async t => {
  const e=await coverTestEngine(t),row=await e.add("BV0000000003","work-a");await e.add("BV0000000004","work-b");
  const source=publicationCoverSource(row),prepared=await prepareCover(source,await coverTestImage());await e.writer.register(source,"retained",prepared.files);
  let withdraw=false,hydrates=0;
  const repo=createSocialWorksRepository(async()=>{
    const snapshot=await readRetainedSocialSnapshot(e.reader);
    return {...snapshot,hydrateCovers:async items=>{
      hydrates++;if(withdraw)await e.db.query("UPDATE social_sync.works SET approved=false WHERE work_id=$1",[items[0].id]);
      return (await withSocialCovers({version:snapshot.version,items},e.reader,"retained")).items;
    }};
  });
  const before=await repo.listWorks({limit:1});assert(before.items[0].cover);assert(before.nextCursor);
  withdraw=true;
  const during=await repo.listWorks({limit:1});assert.equal(during.items[0].cover,null);
  await assert.rejects(repo.listWorks({limit:1,cursor:before.nextCursor!}),{code:"INVALID_QUERY"});
  assert.equal(hydrates,2);
});

test("selected collection retains its latest eligible member fallback and current member denial", async t => {
  const e=await coverTestEngine(t),first=await e.add("BV0000000001","member-a",undefined,"2026-01-01T00:00:00.000Z"),
    latest=await e.add("BV0000000002","member-b",undefined,"2026-02-01T00:00:00.000Z");
  const collection=await e.collection();
  // Keep the exact current member publications used by the fixture collection.
  for(const row of [first,latest]){const source=publicationCoverSource(row),prepared=await prepareCover(source,await coverTestImage());await e.writer.register(source,"retained",prepared.files);}
  const read=async():Promise<SocialCoverSnapshot<SocialTimelineWork>>=>{
    const snapshot=await readRetainedSocialSnapshot(e.reader);
    return {...snapshot,hydrateCovers:async items=>(await withSocialCovers({version:snapshot.version,items},e.reader,"retained")).items};
  };
  const repo=createSocialWorksRepository(read),all=await withSocialCovers(await readRetainedSocialSnapshot(e.reader),e.reader,"retained");
  assert.equal(all.items.length,1);assert(all.items[0].collection);assert(all.items[0].cover);
  assert.deepEqual((await repo.listWorks()).items,all.items);
  const prior=all.items[0].cover;
  await e.db.query("UPDATE social_sync.works SET approved=false WHERE work_id='member-b'");
  const current=await repo.listWorks();assert(current.items[0].cover);assert.notDeepEqual(current.items[0].cover,prior);
  await e.db.query("UPDATE social_sync.retained_collections SET approved=false WHERE collection_key=$1",[collectionKey(collection.target)]);
  assert.equal((await repo.listWorks()).items.some(w=>w.collection!==null),false);
});

test("selected home and works covers keep their rendered URL through registration and respect withdrawal", async t => {
  const e=await coverTestEngine(t),row=await e.add("BV0000000003","selected",undefined,"2026-03-01T00:00:00.000Z");
  await e.add("BV0000000004","not-selected",undefined,"2026-01-01T00:00:00.000Z");
  const source=publicationCoverSource(row),prepared=await prepareCover(source,await coverTestImage());
  await e.writer.register(source,"retained",prepared.files);
  const wanted:string[][]=[];
  const reader:SqlExecutor={query:<T>(text:string,values?:unknown[])=>{
    if(values?.length===2)wanted.push(JSON.parse(String(values[0])).map((w:{id:string})=>w.id));
    return e.reader.query<T>(text,values);
  }};
  const read=async():Promise<SocialCoverSnapshot<SocialTimelineWork>>=>{
    const snapshot=await readRetainedSocialSnapshot(e.reader);
    return {...snapshot,hydrateCovers:async items=>(await withSocialCovers({version:snapshot.version,items},reader,"retained")).items};
  };
  const works=createSocialWorksRepository(read),home=createHomeFeedV2Repository({content:async()=>({version:"content",items:[]}),
    social:read,sources:{content:"mock",social:"database"},timeZone:"UTC"});
  const before=(await works.listWorks({limit:1})).items[0]!,feedBefore=await home.getPage({limit:1});
  assert.equal(before.id,"selected");assert(before.cover);
  assert.match(before.cover.src,new RegExp(`^/media/social/s3\\.publication\\.${source.key}\\.[a-f0-9]{64}$`));
  assert.deepEqual(feedBefore.items.map(i=>i.source==="social"?i.work.cover:assert.fail()),[before.cover]);
  let objectReads=0;
  const storage={put:async()=>{},read:async(m:StoredMedia)=>{objectReads++;return prepared.bodies.get(m.sha256)!;}};
  const reference=before.cover.src.slice("/media/social/".length);
  row.coverUrl="https://i0.hdslb.com/example.png?reference=selected-renewal";
  row.observedAt=new Date(Date.parse(row.observedAt)+1).toISOString();
  await e.worker.query("SELECT * FROM social_sync.ingest($1,$2,$3)",[source.key,hash(JSON.stringify(row)),JSON.stringify(row)]);
  await e.writer.register(publicationCoverSource(row),"retained",prepared.files);
  const after=(await works.listWorks({limit:1})).items[0]!,feedAfter=await home.getPage({limit:1});
  assert(after.cover);assert.notEqual(after.cover.id,before.cover.id);assert.equal(after.cover.src,before.cover.src);
  assert.deepEqual(feedAfter.items.map(i=>i.source==="social"?i.work.cover:assert.fail()),[after.cover]);
  assert.deepEqual(wanted,Array.from({length:4},()=>["selected"]));
  for(const width of [400,800] as const){
    const response=await socialMediaResponse(reference,width,"retained",e.reader,()=>storage);
    assert.equal(response.status,200);assert.equal(response.headers.get("cache-control"),"private, max-age=86400, must-revalidate");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()),Buffer.from(prepared.bodies.get(prepared.files.previews[String(width) as "400"|"800"].sha256)!));
    const etag=response.headers.get("etag");assert(etag);
    const conditional=await socialMediaResponse(reference,width,"retained",e.reader,()=>storage,etag);
    assert.equal(conditional.status,304);assert.equal((await conditional.arrayBuffer()).byteLength,0);
    assert.equal(objectReads,width===400?1:2,"conditional reuse must not read object bytes");
  }
  assert.equal(objectReads,2);
  await e.db.query("UPDATE social_sync.works SET approved=false WHERE work_id='selected'");
  assert.equal((await socialMediaResponse(reference,400,"retained",e.reader,()=>storage)).status,404);
  assert.equal(objectReads,2,"withdrawn owner must not read object bytes");
  assert.deepEqual((await works.listWorks({limit:1})).items.map(i=>i.id),["not-selected"]);
  assert.deepEqual((await home.getPage({limit:1})).items.map(i=>i.source==="social"?i.work.id:assert.fail()),["not-selected"]);
});

test("selected collection covers preserve optional daily totals and the site day on both page readers", async t => {
  const e=await coverTestEngine(t);
  await e.db.exec(await readFile(new URL("../supabase/migrations/20261019065657_social_collection_day_additions.sql",import.meta.url),"utf8"));
  await e.add("BV0000000009","not-selected",undefined,"2026-01-01T00:00:00.000Z");
  const collection=exampleCollectionSnapshot("2026-10-03T13:00:00.000Z"),key=collectionKey(collection.target);
  await e.db.query("INSERT INTO social_sync.collection_bindings(account_id,kind,collection_id,enabled) VALUES($1,$2,$3,true)",
    [collection.target.accountId,collection.target.kind,collection.target.collectionId]);
  const ingest=()=>e.worker.query("SELECT * FROM social_sync.ingest_collection($1,$2,$3)",[key,hash(JSON.stringify(collection)),JSON.stringify(collection)]);
  await ingest();
  await e.db.query(`INSERT INTO social_sync.retained_collections(collection_key,approved,reviewed_at,title,approved_source_sha256,source_sha256,approved_member_keys)
    SELECT collection_key,true,now(),'Reviewed collection',payload_sha256,payload_sha256,member_review_keys FROM social_sync.collection_states WHERE collection_key=$1`,[key]);
  await e.db.query("UPDATE social_sync.retained_collections SET follow_public_members=true WHERE collection_key=$1",[key]);
  for(const [id,at] of [["BV0000000003","2026-10-03T14:30:00.000Z"],["BV0000000004","2026-10-03T16:30:00.000Z"]]){
    collection.observedAt=at!;collection.members.push({id:id!,publishedAt:null,parts:[String(1000+collection.members.length)],partsComplete:true});
    await ingest();
  }
  const source={kind:"collection" as const,key,platform:"bilibili" as const,url:"https://i0.hdslb.com/season.png",observedAt:collection.observedAt};
  await e.writer.collectionSource(source,"retained");
  const prepared=await prepareCover(source,await coverTestImage());await e.writer.register(source,"retained",prepared.files);
  const wanted:string[][]=[];
  const reader:SqlExecutor={query:<T>(sql:string,values?:unknown[])=>{
    if(values?.length===2)wanted.push(JSON.parse(String(values[0])).map((w:{id:string})=>w.id));
    return e.reader.query<T>(sql,values);
  }};
  let selectedId:string|undefined;
  for(const timeZone of ["Australia/Melbourne","UTC"])for(const enabled of [false,true]){
    const read=async():Promise<SocialCoverSnapshot<SocialTimelineWork>>=>{
      const snapshot=await readRetainedSocialSnapshot(e.reader,false,{enabled,timeZone});
      return {...snapshot,hydrateCovers:async items=>(await withSocialCovers({version:snapshot.version,items},reader,"retained")).items};
    };
    const works=createSocialWorksRepository(read),home=createHomeFeedV2Repository({content:async()=>({version:"content",items:[]}),
      social:read,sources:{content:"mock",social:"database"},timeZone});
    const page=await works.listWorks({limit:1}),item=page.items[0]!;
    selectedId??=item.id;assert.equal(item.id,selectedId);assert(item.collection);assert(item.cover);
    assert.match(item.cover.src,new RegExp(`^/media/social/s3\\.collection\\.${key}\\.[a-f0-9]{64}$`));
    assert.equal(item.collection.latestAddition?.addedVideos,1);
    assert.deepEqual(item.collection.dayAddition,enabled?{day:timeZone==="UTC"?"2026-10-03":"2026-10-04",addedVideos:2,addedParts:0,basis:"addition-detected"}:null);
    const feed=(await home.getPage({limit:1})).items[0]!;assert.equal(feed.source,"social");
    if(feed.source==="social")assert.deepEqual(feed.work,item);
    assert.deepEqual((await works.listWorks({limit:1,cursor:page.nextCursor!})).items.map(i=>i.id),["not-selected"]);
  }
  assert.deepEqual(wanted,Array.from({length:4},()=>[[selectedId],[selectedId],["not-selected"]]).flat());
});
