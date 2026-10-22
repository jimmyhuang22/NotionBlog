import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sqlite from "node:sqlite";
import { PGlite } from "@electric-sql/pglite";
import type { SqlExecutor } from "../src/server/database/sql.ts";
import { collectionCard, collectionKey, nextCollectionState } from "../scripts/social-sync/collection.ts";
import type { CollectionSnapshot } from "../scripts/social-sync/collection.ts";
import { openCollectionStore, flushCollectionOutbox } from "../scripts/social-sync/collection-store.ts";
import { collectionPayload, createCollectionTransport } from "../scripts/social-sync/collection-cloud.ts";
import { hash, publicationKey, SocialSyncError } from "../scripts/social-sync/model.ts";
import { observation } from "../scripts/social-sync/bilibili.ts";
import { snapshotObservation } from "../scripts/social-sync/xiaohongshu.ts";
import { createSocialRepository } from "../src/server/social/repository.ts";
import { createSocialTimelineRepository, readSocialTimelineSnapshot } from "../src/server/social/timeline-repository.ts";
import { ContentServiceError } from "../contracts/repository.ts";
import { exampleCollectionSnapshot } from "./helpers/social-collection-samples.ts";

const at=new Date(Date.now()-10*60_000).toISOString(), next=(i:number)=>new Date(Date.parse(at)+i*60_000).toISOString();
const row=()=>exampleCollectionSnapshot(at), error=(code:string)=>(e:unknown)=>e instanceof SocialSyncError && e.code===code;
async function directory(t:{after:(fn:()=>Promise<void>)=>void}) {
  const root=await realpath(await mkdtemp(join(tmpdir(),"nb-collection-cloud-")));await chmod(root,0o700);t.after(()=>rm(root,{recursive:true,force:true}));return root;
}
async function engine(t:{after:(fn:()=>Promise<void>)=>void}) {
  const db=await PGlite.create();t.after(()=>db.close());
  await db.exec("CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;CREATE ROLE nb_reader;CREATE SCHEMA nb;CREATE TABLE nb.private_data(secret text);REVOKE ALL ON SCHEMA nb FROM PUBLIC;");
  for(const f of ["20261012005001_social_sync_v1.sql","20261012015408_social_reader_v1.sql","20261012020551_social_reader_binding_index.sql","20261012054647_social_collections_v1.sql"])await db.exec(await readFile(new URL(`../supabase/migrations/${f}`,import.meta.url),"utf8"));
  const role=(name:string):SqlExecutor=>({query:<T>(sql:string,values?:unknown[])=>db.transaction(async tx=>{await tx.exec(`SET LOCAL ROLE ${name}`);return tx.query<T>(sql,values);})});
  const worker=role("nb_social_worker"),reader=role("nb_social_reader");
  const register=async(r:CollectionSnapshot)=>db.query("INSERT INTO social_sync.collection_bindings(account_id,kind,collection_id,enabled) VALUES($1,$2,$3,true)",[r.target.accountId,r.target.kind,r.target.collectionId]);
  const ingest=async(r:CollectionSnapshot)=>worker.query<{key:string;sha256:string}>("SELECT * FROM social_sync.ingest_collection($1,$2,$3)",[collectionKey(r.target),hash(JSON.stringify(r)),JSON.stringify(r)]);
  const qualify=async(r:CollectionSnapshot,approved=true)=>{
    const key=collectionKey(r.target);
    await db.query(`INSERT INTO social_sync.collection_visibility(collection_key,title,approved,checked_at,valid_until)
      VALUES($1,'Approved collection',$2,now(),now()+interval '1 hour') ON CONFLICT(collection_key) DO UPDATE SET approved=excluded.approved`,[key,approved]);
  };
  const members=async(r:CollectionSnapshot)=>{
    for(const m of r.members)await db.query(`INSERT INTO social_sync.collection_member_reviews(collection_key,member_sha,approved,checked_at,valid_until)
      VALUES($1,social_sync.collection_member_digest($2::jsonb),true,now(),now()+interval '1 hour') ON CONFLICT DO NOTHING`,[collectionKey(r.target),JSON.stringify(m)]);
  };
  return {db,worker,reader,role,register,ingest,qualify,members};
}
test("collection schema computes the same baseline and repeated content transitions as the local state machine",async t=>{
  const e=await engine(t);let snapshot=row();await e.register(snapshot);let local=nextCollectionState(null,snapshot);
  const compare=async()=>{
    const saved=(await e.db.query<{card:unknown}>("SELECT card FROM social_sync.collection_states WHERE collection_key=$1",[collectionKey(snapshot.target)])).rows[0];
    assert.deepEqual(saved.card,collectionCard(local));
  };
  await e.ingest(snapshot);await compare();
  for(let i=1;i<=3;i++){
    snapshot=structuredClone(snapshot);snapshot.observedAt=next(i);
    snapshot.members.push({id:`BV000000000${i+2}`,publishedAt:new Date(Date.parse(next(i))-30_000).toISOString(),parts:[String(2000+i)],partsComplete:true});
    local=nextCollectionState(local,snapshot);await e.ingest(snapshot);await compare();
  }
  const metric=structuredClone(snapshot);metric.observedAt=next(4);metric.title="Renamed source";metric.metrics.likes=3;
  local=nextCollectionState(local,metric);snapshot=metric;await e.ingest(snapshot);await compare();
  assert.equal(local.latestAddition?.addedVideos,1);assert.equal(local.activity?.at,new Date(Date.parse(next(3))-30_000).toISOString());
  const remove=structuredClone(snapshot);remove.observedAt=next(5);remove.members.pop();
  local=nextCollectionState(local,remove);snapshot=remove;await e.ingest(snapshot);await compare();
  const restore=structuredClone(metric);restore.observedAt=next(6);restore.target.representativeUrl="https://www.bilibili.com/video/BV0000000002/";
  local=nextCollectionState(local,restore);snapshot=restore;await e.ingest(snapshot);await compare();
});
test("unknown P completeness and multi-P additions use explicit baselines and detection time in SQL",async t=>{
  const e=await engine(t);
  for(const kind of ["season","multi-part"] as const){
    let snapshot=exampleCollectionSnapshot(at,kind);await e.register(snapshot);let local=nextCollectionState(null,snapshot);await e.ingest(snapshot);
    for(let i=1;i<=3;i++){
      const newer=structuredClone(snapshot);newer.observedAt=next(i);
      const m=newer.members[kind==="season"?1:0];
      if(kind==="season" && i===1)m.parts.push("1004");
      else if(kind==="season" && i===2)m.partsComplete=true;
      else m.parts.push(String(2000+i));
      local=nextCollectionState(local,newer);snapshot=newer;await e.ingest(snapshot);
      assert.deepEqual((await e.db.query<{card:unknown}>("SELECT card FROM social_sync.collection_states WHERE collection_key=$1",[collectionKey(snapshot.target)])).rows[0].card,collectionCard(local));
    }
    assert.equal(local.latestAddition?.addedParts,1);assert.equal(local.activity?.basis,"addition-detected");
  }
});
test("collection ingest serializes duplicates, rejects stale/conflicting/foreign/oversized inputs and preserves the prior snapshot",async t=>{
  const e=await engine(t),r=row(),key=collectionKey(r.target);await e.register(r);
  const first=await e.ingest(r);assert.deepEqual((await e.ingest(r)).rows,first.rows);
  const old=row();old.observedAt=next(-1);await assert.rejects(e.ingest(old),/NB_COLLECTION_STALE/);
  const conflict=row();conflict.metrics.likes=4;await assert.rejects(e.ingest(conflict),/NB_COLLECTION_CONFLICT/);
  for(const bad of [{...r,websitePublicationApproved:true},{...r,secret:"private"},{...r,membershipComplete:false}, {...r,members:[r.members[0],r.members[0]]}]) {
    await assert.rejects(e.worker.query("SELECT * FROM social_sync.ingest_collection($1,$2,$3)",[key,hash(JSON.stringify(bad)),JSON.stringify(bad)]),/NB_COLLECTION_BAD_PAYLOAD/);
  }
  await assert.rejects(e.worker.query("SELECT * FROM social_sync.ingest_collection($1,$2,$3)",[key,"0".repeat(64),JSON.stringify(r)]),/NB_COLLECTION_BAD_DIGEST/);
  const unregistered=row();unregistered.target.collectionId="201";await assert.rejects(e.ingest(unregistered),/NB_COLLECTION_UNREGISTERED/);
  await assert.rejects(e.worker.query("SELECT * FROM social_sync.ingest_collection($1,$2,$3)",[key,"0".repeat(64),"x".repeat(524289)]),/NB_COLLECTION_BAD_DIGEST/);
  assert.deepEqual((await e.db.query<{payload:unknown}>("SELECT payload FROM social_sync.collection_states")).rows[0].payload,r);
});
test("new collection permissions do not let worker or reader approve, forge derived state, delete or read old private content",async t=>{
  const e=await engine(t),r=row();await e.register(r);await e.ingest(r);
  for(const actor of [e.worker,e.reader])for(const sql of ["UPDATE social_sync.collection_bindings SET enabled=true","DELETE FROM social_sync.collection_visibility",
    "INSERT INTO social_sync.collection_member_reviews VALUES('x','x',true,now(),now())","UPDATE social_sync.collection_standalone_overrides SET keep_standalone=true","SELECT * FROM nb.private_data"])
    await assert.rejects(actor.query(sql),/permission denied/);
  for(const sql of ["UPDATE social_sync.collection_states SET card='{}'","UPDATE social_sync.collection_states SET member_review_keys='[]'","DELETE FROM social_sync.collection_states"])
    await assert.rejects(e.worker.query(sql),/permission denied/);
  await assert.rejects(e.reader.query("SELECT payload FROM social_sync.collection_states"),/permission denied/);
  await assert.rejects(e.reader.query("SELECT * FROM social_sync.ingest_collection('x','x','{}')"),/permission denied/);
  for(const role of ["anon","authenticated","service_role","nb_reader"])await assert.rejects(e.role(role).query("SELECT * FROM social_sync.website_collections"),/permission denied/);
  assert.equal((await e.reader.query("SELECT * FROM social_sync.website_collections")).rows.length,0);
  assert.equal((await e.reader.query("SELECT * FROM social_sync.collection_bindings")).rows.length,0);
  const views=(await e.db.query<{reloptions:string[]}>("SELECT reloptions FROM pg_class WHERE oid IN ('social_sync.website_collections'::regclass,'social_sync.website_collection_members'::regclass)")).rows;
  assert.equal(views.every(v=>v.reloptions.includes("security_invoker=true")),true);
});
test("collection and every exact member revision require approval; new members and P changes withdraw the whole collection",async t=>{
  const e=await engine(t),r=row();await e.register(r);await e.ingest(r);
  const count=async()=>(await e.reader.query("SELECT * FROM social_sync.website_collections")).rows.length;
  assert.equal(await count(),0);await e.qualify(r);assert.equal(await count(),0);await e.members(r);assert.equal(await count(),1);
  const grow=structuredClone(r);grow.observedAt=next(1);grow.members.push({id:"BV0000000003",publishedAt:null,parts:["1003"],partsComplete:true});await e.ingest(grow);
  assert.equal(await count(),0);await e.members(grow);assert.equal(await count(),1);
  const parts=structuredClone(grow);parts.observedAt=next(2);parts.members[0].parts.push("1004");await e.ingest(parts);assert.equal(await count(),0);
  await e.members(parts);assert.equal(await count(),1);
  const key=collectionKey(r.target);await e.db.query("UPDATE social_sync.collection_member_reviews SET approved=false WHERE collection_key=$1 AND member_sha=social_sync.collection_member_digest($2::jsonb)",[key,JSON.stringify(parts.members[0])]);
  assert.equal(await count(),0);
});
test("expired/revoked collection qualifications, disabled bindings and stale observations cannot be revived by reviews",async t=>{
  const e=await engine(t),r=row(),key=collectionKey(r.target);await e.register(r);await e.ingest(r);await e.qualify(r);await e.members(r);
  const count=async()=>(await e.reader.query("SELECT * FROM social_sync.website_collections")).rows.length;
  await e.db.query("UPDATE social_sync.collection_visibility SET approved=false WHERE collection_key=$1",[key]);assert.equal(await count(),0);
  await e.qualify(r);assert.equal(await count(),1);
  await e.db.query("UPDATE social_sync.collection_bindings SET enabled=false WHERE collection_key=$1",[key]);assert.equal(await count(),0);
  await e.db.query("UPDATE social_sync.collection_bindings SET enabled=true WHERE collection_key=$1",[key]);
  await e.db.query("UPDATE social_sync.collection_member_reviews SET checked_at=now()-interval '2 hours',valid_until=now()-interval '1 hour' WHERE collection_key=$1",[key]);assert.equal(await count(),0);
  const stale=exampleCollectionSnapshot(new Date(Date.now()-25*3600_000).toISOString());stale.target.collectionId="201";
  await e.register(stale);await e.ingest(stale);await e.qualify(stale);await e.members(stale);assert.equal(await count(),0);
});
test("member signatures are stable compact SHA digests and checked links reject substitutions and extra parameters",async t=>{
  const e=await engine(t),r=row(),key=collectionKey(r.target);await e.register(r);await e.ingest(r);await e.qualify(r);
  for(const m of r.members){const digest=(await e.db.query<{sha:string}>("SELECT social_sync.collection_member_digest($1::jsonb) AS sha",[JSON.stringify(m)])).rows[0].sha;
    assert.equal(digest,hash(JSON.stringify([m.id,m.parts,m.partsComplete])));}
  for(const url of ["https://evil.example/","https://space.bilibili.com/10002/lists/200?type=season","https://space.bilibili.com/10001/lists/201?type=season","https://space.bilibili.com/10001/lists/200?type=season&cookie=private"])
    await assert.rejects(e.db.query("UPDATE social_sync.collection_visibility SET outbound_url=$1,link_checked_at=checked_at WHERE collection_key=$2",[url,key]),/NB_COLLECTION_LINK_INVALID/);
  await assert.rejects(e.db.query("UPDATE social_sync.collection_visibility SET checked_at=now()+interval '1 hour',valid_until=now()+interval '2 hours' WHERE collection_key=$1",[key]),/NB_COLLECTION_REVIEW_FUTURE/);
  await assert.rejects(e.db.query("INSERT INTO social_sync.collection_member_reviews VALUES($1,$2,true,now(),now()+interval '1 hour')",[key,"1".repeat(64)]),/NB_COLLECTION_MEMBER_UNKNOWN/);
});
test("versioned timeline deduplicates eligible member videos, preserves manual exceptions and groups other platforms with a collection",async t=>{
  const e=await engine(t),r=row(),key=collectionKey(r.target),id=collectionCard(nextCollectionState(null,r)).id;
  await e.register(r);await e.ingest(r);
  const targets=[{platform:"bilibili" as const,accountId:"10001",publicationId:"BV0000000001",workId:"member-video",url:r.target.representativeUrl},
    {platform:"xiaohongshu" as const,accountId:"000000000000000000000001",publicationId:"000000000000000000000002",workId:id,url:"https://www.xiaohongshu.com/explore/000000000000000000000002"}];
  for(const target of targets){
    await e.db.query("INSERT INTO social_sync.bindings(platform,account_id,publication_id,work_id,enabled) VALUES($1,$2,$3,$4,true)",[target.platform,target.accountId,target.publicationId,target.workId]);
    const o=target.platform==="bilibili"?observation(`<script>window.__INITIAL_STATE__={"videoData":{"bvid":"${target.publicationId}","owner":{"mid":10001},"title":"Example video","stat":{"view":5}}};</script>`,target,at):
      snapshotObservation({version:1,source:"browser-note-state",observedAt:at,pageUrl:target.url,note:{noteId:target.publicationId,userId:target.accountId,type:"normal",title:"Example note",time:null,lastUpdateTime:null,coverUrl:null,interactInfo:{likedCount:"0",commentCount:"0",shareCount:null,collectedCount:null}}},target,at);
    await e.worker.query("SELECT * FROM social_sync.ingest($1,$2,$3)",[publicationKey(target),hash(JSON.stringify(o)),JSON.stringify(o)]);
    await e.db.query("INSERT INTO social_sync.works VALUES($1,'Original editorial title',$2,true)",[target.workId,"2026-01-01T00:00:00.000Z"]);
    await e.db.query("INSERT INTO social_sync.website_visibility(publication_key,work_id,approved,checked_at,valid_until) VALUES($1,$2,true,now(),now()+interval '1 hour')",[publicationKey(target),target.workId]);
  }
  const old=createSocialRepository(e.reader),repo=createSocialTimelineRepository(e.reader);
  assert.equal((await repo.listWorks()).total,2);await e.qualify(r);await e.members(r);
  const page=await repo.listWorks();assert.equal(page.total,1);assert.equal(page.items[0].id,id);assert.equal(page.items[0].publications.length,1);
  assert.equal(page.items[0].publications[0].platform,"xiaohongshu");assert.equal(page.items[0].collection?.metrics.views,999);assert.equal(page.items[0].collection?.metricsScope,"bilibili-season");
  assert.equal(page.items[0].occurredAt,"2026-01-01T00:00:00.000Z");assert.equal(page.items[0].collection?.firstPublishedAt,null);
  assert.equal(page.items[0].title,"Approved collection");assert.equal((await old.listWorks()).total,2); // Old API behavior is unchanged.
  for(const name of ["accountId","collectionId","publicationId","members","member_review_keys","seen_videos","payload","responseSha256"])assert.equal(JSON.stringify(page).includes(`"${name}"`),false);
  const remove=structuredClone(r);remove.observedAt=next(1);remove.members.shift();remove.target.representativeUrl="https://www.bilibili.com/video/BV0000000002/";
  await e.ingest(remove);assert.equal((await repo.listWorks()).total,2); // Removed membership no longer suppresses a video.
  const restore=structuredClone(r);restore.observedAt=next(2);await e.ingest(restore);assert.equal((await repo.listWorks()).total,1);
  assert.equal((await repo.listWorks()).items[0].collection?.latestAddition,null);
  await e.db.query("INSERT INTO social_sync.collection_standalone_overrides VALUES($1,true)",[publicationKey(targets[0])]);assert.equal((await repo.listWorks()).total,2);
  const first=await repo.listWorks({limit:1});assert.ok(first.nextCursor);
  await e.db.query("UPDATE social_sync.collection_visibility SET approved=false WHERE collection_key=$1",[key]);
  await assert.rejects(repo.listWorks({limit:1,cursor:first.nextCursor!}),(e:unknown)=>e instanceof ContentServiceError && e.code==="INVALID_QUERY");
  assert.equal((await repo.listWorks()).total,2);
  const snapshot=await readSocialTimelineSnapshot(e.reader);assert.equal(snapshot.items.every(w=>w.collection===null),true);
});
test("collection SQLite v1 upgrades only its own file and seeds latest samples for private upload",async t=>{
  const root=await directory(t),store=(await openCollectionStore(root))!;store.ingest(row());store.close();
  const Constructor=(sqlite as unknown as {Database?:typeof sqlite.DatabaseSync}).Database??sqlite.DatabaseSync;
  const db=new Constructor(join(root,"social-collections.sqlite"));db.exec("DROP TABLE collection_outbox;PRAGMA user_version=1;");db.close();
  const old=(await openCollectionStore(root,true))!;assert.equal(old.status().pending,null);old.close();
  const upgraded=(await openCollectionStore(root))!;t.after(async()=>upgraded.close());assert.equal(upgraded.status().pending,1);
  const item=upgraded.pending()[0];assert.equal(collectionPayload(item),JSON.stringify(row()));assert.equal((await stat(join(root,"social-collections.sqlite"))).mode&0o077,0);
  await assert.rejects(stat(join(root,"social.sqlite")),{code:"ENOENT"});
});
test("failed, interrupted and mismatched upload receipts remain pending; a verified retry is idempotent",async t=>{
  const store=(await openCollectionStore(await directory(t)))!;t.after(async()=>store.close());store.ingest(row());const key=collectionKey(row().target);
  const options={allowedKeys:new Set([key])};
  assert.equal((await flushCollectionOutbox(store,async()=>{throw Error("private endpoint");},options)).failed,1);assert.equal(store.status().failedUploads,1);
  assert.equal((await flushCollectionOutbox(store,async item=>({key:item.key,sha256:"wrong"}),options)).failed,1);assert.equal(store.status().pending,1);
  assert.equal((await flushCollectionOutbox(store,async item=>({key:item.key,sha256:item.sha256}),options)).acknowledged,1);assert.equal(store.status().pending,0);
  assert.equal((await flushCollectionOutbox(store,async()=>{throw Error();},options)).acknowledged,0);
});
test("an in-flight older collection receipt cannot acknowledge newer data and removed configs cannot upload",async t=>{
  const store=(await openCollectionStore(await directory(t)))!;t.after(async()=>store.close());store.ingest(row());const key=collectionKey(row().target);
  const newer=row();newer.observedAt=next(1);newer.metrics.likes=3;
  const report=await flushCollectionOutbox(store,async item=>{store.ingest(newer);return {key:item.key,sha256:item.sha256};},{allowedKeys:new Set([key])});
  assert.equal(report.superseded,1);assert.equal(store.status().pending,1);
  let calls=0;assert.equal((await flushCollectionOutbox(store,async()=>{calls++;throw Error();},{allowedKeys:new Set()})).skipped,1);assert.equal(calls,0);
});
test("collection transport rejects inappropriate credentials/protocol, bad payloads and cancelled responses without leaking errors",async()=>{
  const handshake={role:"nb_social_worker",login:"nb_social_worker",version:1,elevated:false};
  for(const h of [{...handshake,login:"postgres"},{...handshake,role:"nb_social_reader"},{...handshake,elevated:true},{...handshake,version:2}])
    await assert.rejects(createCollectionTransport({query:async()=>({rows:[h]})} as unknown as SqlExecutor),error("CLOUD_HANDSHAKE_INVALID"));
  const r=row(),item={key:collectionKey(r.target),sha256:hash(JSON.stringify(r)),snapshot:r};let calls=0;const abort=new AbortController();
  const send=await createCollectionTransport({query:async()=>{calls++;if(calls===1)return {rows:[handshake]};abort.abort();return {rows:[{key:item.key,sha256:item.sha256}]};}} as unknown as SqlExecutor,abort.signal);
  await assert.rejects(send(item),error("CANCELLED"));
  assert.throws(()=>collectionPayload({...item,sha256:"0".repeat(64)}),error("LOCAL_DATA_INVALID"));
});
