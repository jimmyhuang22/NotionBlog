import test from "node:test";
import assert from "node:assert/strict";
import { readFile,mkdtemp,chmod,realpath,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { SqlExecutor } from "../src/server/database/sql.ts";
import { collectionKey,validateCollectionSnapshot } from "../scripts/social-sync/collection.ts";
import type { CollectionSnapshot } from "../scripts/social-sync/collection.ts";
import { hash } from "../scripts/social-sync/model.ts";
import { openCollectionStore } from "../scripts/social-sync/collection-store.ts";
import { applyCollectionDayBackfill } from "../scripts/social-sync/collection-day-backfill.ts";
import { readRetainedSocialSnapshot } from "../src/server/social/retained-repository.ts";
import { readSocialTimelineSnapshot } from "../src/server/social/timeline-repository.ts";
import { createSocialWorksRepository } from "../src/server/social/works-repository.ts";
import { createHomeFeedV2Repository } from "../src/lib/content/home-feed-v2-core.ts";
import { collectionDayAdditionsEnabled,parseCollectionDayAddition } from "../src/server/social/collection-day-additions.ts";
import { exampleCollectionSnapshot } from "./helpers/social-collection-samples.ts";

const migration="20261019065657_social_collection_day_additions.sql";
const anchor=Date.parse(new Date(Date.now()-4*86400000).toISOString().slice(0,10)+"T00:00:00.000Z");
const at=(hours:number)=>new Date(anchor+hours*3600000).toISOString();
const day=(hours:number)=>new Date(anchor+hours*3600000).toISOString().slice(0,10);
async function engine(t:{after:(fn:()=>Promise<void>)=>void},install=true){
 const db=await PGlite.create();t.after(()=>db.close());
 await db.exec("CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;CREATE ROLE nb_reader;");
 for(const name of ["20261012005001_social_sync_v1.sql","20261012015408_social_reader_v1.sql","20261012020551_social_reader_binding_index.sql","20261012054647_social_collections_v1.sql","20261012213401_social_retained_projections.sql","20261013214552_social_collection_follow_members.sql",...(install?[migration]:[])])await db.exec(await readFile(new URL(`../supabase/migrations/${name}`,import.meta.url),"utf8"));
 const role=(name:string):SqlExecutor=>({query:<T>(text:string,values?:unknown[])=>db.transaction(async tx=>{await tx.exec(`SET LOCAL ROLE ${name}`);return tx.query<T>(text,values);})});
 const worker=role("nb_social_worker"),reader=role("nb_social_reader");
 const ingest=(input:CollectionSnapshot)=>{const c=validateCollectionSnapshot(input);return worker.query("SELECT * FROM social_sync.ingest_collection($1,$2,$3)",[collectionKey(c.target),hash(JSON.stringify(c)),JSON.stringify(c)]);};
 const register=async(c:CollectionSnapshot)=>{await db.query("INSERT INTO social_sync.collection_bindings(account_id,kind,collection_id,enabled) VALUES($1,$2,$3,true)",[c.target.accountId,c.target.kind,c.target.collectionId]);await ingest(c);await db.query(`INSERT INTO social_sync.retained_collections(collection_key,approved,reviewed_at,title,approved_source_sha256,source_sha256,approved_member_keys)
 SELECT collection_key,true,now(),'Example collection',payload_sha256,payload_sha256,member_review_keys FROM social_sync.collection_states WHERE collection_key=$1`,[collectionKey(c.target)]);await db.query("UPDATE social_sync.retained_collections SET follow_public_members=true WHERE collection_key=$1",[collectionKey(c.target)]);};
 const snapshot=(zone="Australia/Melbourne",enabled=true)=>readRetainedSocialSnapshot(reader,false,{enabled,timeZone:zone});
 const card=async(zone="Australia/Melbourne")=>(await snapshot(zone)).items[0]!.collection!;
 return {db,reader,worker,ingest,register,snapshot,card};
}
function add(c:CollectionSnapshot,hours:number,id:string,published:number|null=hours-0.1){const next=structuredClone(c);next.observedAt=at(hours);next.members.push({id,publishedAt:published===null?null:at(published),parts:[String(1000+next.members.length)],partsComplete:true});return next;}

test("daily additions accumulate across captures, retain old delta semantics, reset by activity day and survive no-op/re-adds",async t=>{
 const e=await engine(t),baseline=exampleCollectionSnapshot(at(0));await e.register(baseline);assert.equal((await e.card()).dayAddition,null);
 const first=add(baseline,2,"BV0000000003");await e.ingest(first);const second=add(first,4,"BV0000000004");await e.ingest(second);
 let card=await e.card();assert.deepEqual(card.dayAddition,{day:day(0),addedVideos:2,addedParts:0,basis:"member-published"});assert.equal(card.latestAddition?.addedVideos,1);
 const changed=structuredClone(second);changed.observedAt=at(5);changed.title="Renamed";changed.members.reverse();changed.metrics.likes=10;await e.ingest(changed);
 const before=await e.card();await e.ingest(changed);assert.deepEqual((await e.card()).dayAddition,before.dayAddition);
 const removed=structuredClone(changed);removed.observedAt=at(6);removed.members=removed.members.filter(m=>m.id!=="BV0000000003");await e.ingest(removed);
 const returned=structuredClone(changed);returned.observedAt=at(7);await e.ingest(returned);assert.deepEqual((await e.card()).dayAddition,before.dayAddition);
 const tomorrow=add(returned,15,"BV0000000005",14.8);await e.ingest(tomorrow);card=await e.card();assert.deepEqual(card.dayAddition,{day:day(24),addedVideos:1,addedParts:0,basis:"member-published"});
 const later=structuredClone(tomorrow);later.observedAt=at(80);later.metrics.views=1234;await e.ingest(later);assert.deepEqual((await e.card()).dayAddition,card.dayAddition);
 const works=createSocialWorksRepository(()=>e.snapshot());assert.deepEqual((await works.listWorks()).items[0]!.collection!.dayAddition,card.dayAddition);
 const feed=createHomeFeedV2Repository({content:async()=>({version:"content",items:[]}),social:()=>e.snapshot(),sources:{content:"database",social:"database"},timeZone:"Australia/Melbourne"});
 const page=await feed.getPage({limit:1}),item=page.items[0]!;assert.equal(item.source,"social");if(item.source==="social")assert.deepEqual(item.work.collection!.dayAddition,card.dayAddition);
 const other=exampleCollectionSnapshot(at(0));other.target.collectionId="201";await e.register(other);
 const firstPage=await feed.getPage({limit:1});assert(firstPage.nextCursor);
 const nextPage=await feed.getPage({limit:1,cursor:firstPage.nextCursor});assert.equal(nextPage.items.length,1);
 assert.notEqual(firstPage.items[0]!.id,nextPage.items[0]!.id);
 assert.equal(nextPage.items[0]!.source,"social");if(nextPage.items[0]!.source==="social")assert.equal(nextPage.items[0]!.work.collection!.dayAddition,null);
});

test("mixed publication/detection days, multiple new videos and parts follow the existing identity rules",async t=>{
 const e=await engine(t),baseline=exampleCollectionSnapshot(at(10));await e.register(baseline);
 const mixed=add(baseline,15,"BV0000000003",12);mixed.members.push({id:"BV0000000004",publishedAt:null,parts:["1004","1005"],partsComplete:true});mixed.members[0]!.parts.push("1006");await e.ingest(mixed);
 // Known video was published on the preceding Melbourne day; unknown video and P were found today.
 assert.deepEqual((await e.card()).dayAddition,{day:day(24),addedVideos:1,addedParts:1,basis:"addition-detected"});
 const more=add(mixed,16,"BV0000000005",15.5);more.members.push({id:"BV0000000006",publishedAt:at(15.6),parts:["1007","1008"],partsComplete:true});await e.ingest(more);
 assert.deepEqual((await e.card()).dayAddition,{day:day(24),addedVideos:3,addedParts:1,basis:"mixed"});
 assert.equal((await e.card()).latestAddition?.addedVideos,2);assert.equal((await e.card()).latestAddition?.addedParts,0);
 const denied={day:day(0),addedVideos:1,addedParts:0,basis:"member-published"};assert.throws(()=>parseCollectionDayAddition(denied,{at:at(36),basis:"member-published"},"season","UTC"));
 await e.db.query("UPDATE social_sync.retained_collections SET approved=false");assert.equal((await e.snapshot()).items.length,0);
 const hidden=await e.reader.query<{value:unknown}>("SELECT social_sync.collection_day_addition($1,$2,$3,'UTC',true) AS value",[collectionKey(baseline.target),more.observedAt,more.observedAt]);assert.equal(hidden.rows[0]!.value,null);
});

test("DST uses the site day; local full-history replay repairs legacy null counts without changing publication state",async t=>{
 const e=await engine(t,false),base=exampleCollectionSnapshot("2026-10-03T13:00:00.000Z");await e.register(base);
 const first=structuredClone(base);first.observedAt="2026-10-03T14:45:00.000Z";first.members.push({id:"BV0000000003",publishedAt:"2026-10-03T14:30:00.000Z",parts:["1003"],partsComplete:true});await e.ingest(first);
 const second=structuredClone(first);second.observedAt="2026-10-03T16:45:00.000Z";second.members.push({id:"BV0000000004",publishedAt:"2026-10-03T16:30:00.000Z",parts:["1004"],partsComplete:true});await e.ingest(second);
 assert.equal((await e.snapshot("UTC",false)).items[0]!.collection!.dayAddition,null);
 await e.db.exec(await readFile(new URL(`../supabase/migrations/${migration}`,import.meta.url),"utf8"));assert.equal((await e.card()).dayAddition,null);
 const root=await realpath(await mkdtemp(join(tmpdir(),"nb-day-additions-")));await chmod(root,0o700);t.after(()=>rm(root,{recursive:true,force:true}));
 const store=await openCollectionStore(root);assert(store);t.after(()=>store.close());for(const c of [base,first,second])store.ingest(c);
 const plans=store.additionHistoryPlans();assert.equal(plans.length,1);assert(plans[0]!.history);
 const before=(await e.db.query("SELECT observed_at,payload_sha256,card,seen_videos,part_baselines FROM social_sync.collection_states")).rows;
 const versionBefore=(await e.snapshot()).version;
 assert.deepEqual(await applyCollectionDayBackfill(e.db,plans),{applied:1,unknown:0,sourceChanged:0});assert.deepEqual((await e.db.query("SELECT observed_at,payload_sha256,card,seen_videos,part_baselines FROM social_sync.collection_states")).rows,before);
 assert.deepEqual((await e.card()).dayAddition,{day:"2026-10-04",addedVideos:2,addedParts:0,basis:"member-published"});
 assert.equal((await e.snapshot()).version,versionBefore,"derived-count backfill preserves the paging version");
 assert.deepEqual((await e.card("UTC")).dayAddition,{day:"2026-10-03",addedVideos:2,addedParts:0,basis:"member-published"});
 await assert.rejects(applyCollectionDayBackfill(e.worker,plans),/permission denied/);
 const stale=plans.map(p=>({...p,expectedPayloadSHA256:"0".repeat(64)}));assert.deepEqual(await applyCollectionDayBackfill(e.db,stale),{applied:0,unknown:0,sourceChanged:1});
 const refreshed=structuredClone(second);refreshed.observedAt="2026-10-03T18:00:00.000Z";refreshed.metrics.likes=5;await e.ingest(refreshed);assert.equal((await e.card()).dayAddition?.addedVideos,2);
 assert.equal(collectionDayAdditionsEnabled(undefined),false);assert.equal(collectionDayAdditionsEnabled("enabled"),true);assert.throws(()=>collectionDayAdditionsEnabled("yes"));
});

test("frozen approvals never inherit unreviewed additions, including a later removal and statistics refresh",async t=>{
 const e=await engine(t),base=exampleCollectionSnapshot(at(0));await e.register(base);
 const first=add(base,2,"BV0000000003");await e.ingest(first);const approved=await e.card();
 await e.db.exec(`UPDATE social_sync.retained_collections r SET follow_public_members=false,
  approved_member_keys=s.member_review_keys,approved_source_sha256=s.payload_sha256
  FROM social_sync.collection_states s WHERE s.collection_key=r.collection_key`);
 const unknown=add(first,4,"BV0000000004");await e.ingest(unknown);
 assert.deepEqual((await e.card()).dayAddition,approved.dayAddition);
 const removed=structuredClone(first);removed.observedAt=at(5);removed.metrics.views=456;await e.ingest(removed);
 assert.deepEqual((await e.card()).dayAddition,approved.dayAddition);
 assert.equal((await e.card()).latestAddition?.detectedAt,first.observedAt);
 await e.db.query("UPDATE social_sync.collection_bindings SET enabled=false");assert.equal((await e.snapshot()).items.length,0);
});

test("multi-part additions count only new proved parts; incomplete legacy coverage remains null",async t=>{
 const e=await engine(t),base=exampleCollectionSnapshot(at(0),"multi-part");await e.register(base);
 const first=structuredClone(base);first.observedAt=at(2);first.members[0]!.parts.push("1003");await e.ingest(first);
 const second=structuredClone(first);second.observedAt=at(4);second.members[0]!.parts.push("1004");await e.ingest(second);
 assert.deepEqual((await e.card()).dayAddition,{day:day(0),addedVideos:0,addedParts:2,basis:"addition-detected"});
 const {replayCollectionAdditionHistory}=await import("../scripts/social-sync/collection-addition-history.ts");
 const {nextCollectionState}=await import("../scripts/social-sync/collection.ts");
 const expected=nextCollectionState(nextCollectionState(nextCollectionState(null,base),first),second);
 assert.equal(replayCollectionAdditionHistory([base,first],expected),null);
 await e.db.exec("UPDATE social_sync.collection_states SET addition_history=NULL");
 const third=structuredClone(second);third.observedAt=at(5);third.members[0]!.parts.push("1005");await e.ingest(third);
 assert.equal((await e.card()).dayAddition,null,"an incomplete first day must not be reported as a complete daily total");
});

test("trial projection uses the same additive DTO and still requires current visibility and every member review",async t=>{
 const e=await engine(t),stamp=(i:number)=>new Date(Date.now()-(10-i)*60000).toISOString();
 const base=exampleCollectionSnapshot(stamp(0)),key=collectionKey(base.target);
 await e.db.query("INSERT INTO social_sync.collection_bindings(account_id,kind,collection_id,enabled) VALUES($1,$2,$3,true)",[base.target.accountId,base.target.kind,base.target.collectionId]);await e.ingest(base);
 const first=structuredClone(base);first.observedAt=stamp(1);first.members.push({id:"BV0000000003",publishedAt:stamp(0.5),parts:["1003"],partsComplete:true});await e.ingest(first);
 const second=structuredClone(first);second.observedAt=stamp(2);second.members.push({id:"BV0000000004",publishedAt:stamp(1.5),parts:["1004"],partsComplete:true});await e.ingest(second);
 const read=()=>readSocialTimelineSnapshot(e.reader,false,{enabled:true,timeZone:"Australia/Melbourne"});
 assert.equal((await read()).items.length,0);
 await e.db.query("INSERT INTO social_sync.collection_visibility(collection_key,title,approved,checked_at,valid_until) VALUES($1,'Example',true,now(),now()+interval '1 hour')",[key]);
 for(const member of second.members)await e.db.query("INSERT INTO social_sync.collection_member_reviews VALUES($1,social_sync.collection_member_digest($2::jsonb),true,now(),now()+interval '1 hour')",[key,JSON.stringify(member)]);
 assert.equal((await read()).items[0]!.collection!.dayAddition?.addedVideos,2);
 await e.db.query("UPDATE social_sync.collection_member_reviews SET approved=false WHERE collection_key=$1",[key]);assert.equal((await read()).items.length,0);
});
