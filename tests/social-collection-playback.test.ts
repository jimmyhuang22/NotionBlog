import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { SqlExecutor } from "../src/server/database/sql.ts";
import { hash, publicationKey } from "../scripts/social-sync/model.ts";
import { collectionKey } from "../scripts/social-sync/collection.ts";
import type { CollectionSnapshot } from "../scripts/social-sync/collection.ts";
import { exampleCollectionSnapshot } from "./helpers/social-collection-samples.ts";
import { verifyCollectionPlaybacks, verifyCollectionPlaybackScope } from "../scripts/social-sync/collection-playback.ts";
import { readRetainedSocialSnapshot } from "../src/server/social/retained-repository.ts";
import { readSocialTimelineSnapshot } from "../src/server/social/timeline-repository.ts";
import { socialCollectionPlaybackEnabled } from "../src/server/social/collection-members.ts";
import { withSocialCovers } from "../src/server/social/covers.ts";

const migration = "20261018010218_social_collection_playback_links.sql";
function html(s: CollectionSnapshot, bvid = "BV0000000002") {
  const member=s.members.find(m=>m.id===bvid)!;
  const pages=(ids:string[])=>ids.map(cid=>({cid:Number(cid)}));
  return `<script>window.__INITIAL_STATE__=${JSON.stringify({videoData:{bvid,aid:1,owner:{mid:Number(s.target.accountId)},state:0,
    videos:member.parts.length,pages:pages(member.parts),season_id:Number(s.target.collectionId),ugc_season:{id:Number(s.target.collectionId),mid:Number(s.target.accountId),
      title:s.title,stat:{season_id:Number(s.target.collectionId)},ep_count:s.members.length,sections:[{season_id:Number(s.target.collectionId),episodes:s.members.map((m,i)=>({
        bvid:m.id,aid:i+1,season_id:Number(s.target.collectionId),pages:pages(m.parts),arc:{aid:i+1,author:{mid:Number(s.target.accountId)},state:0,videos:m.parts.length,
          pubdate:m.publishedAt===null?0:Date.parse(m.publishedAt)/1000}}))}]}}})};</script>`;
}
async function engine(t: { after: (fn:()=>Promise<void>)=>void }, install=true) {
  const db=await PGlite.create();t.after(()=>db.close());
  await db.exec("CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;CREATE ROLE nb_reader;");
  for(const file of ["20261012005001_social_sync_v1.sql","20261012015408_social_reader_v1.sql","20261012020551_social_reader_binding_index.sql","20261012054647_social_collections_v1.sql","20261012213401_social_retained_projections.sql","20261013214552_social_collection_follow_members.sql","20261014014825_social_work_covers.sql",...(install?[migration]:[])])
    await db.exec(await readFile(new URL(`../supabase/migrations/${file}`,import.meta.url),"utf8"));
  const role=(name:string):SqlExecutor=>({query:async<T>(sql:string,values?:unknown[])=>{
    await db.exec(`SET SESSION AUTHORIZATION ${name}`);try{return await db.query<T>(sql,values);}finally{await db.exec("SET SESSION AUTHORIZATION postgres");}
  }});
  const worker=role("nb_social_worker"),reader=role("nb_social_reader");
  const ingest=(s:CollectionSnapshot)=>worker.query("SELECT * FROM social_sync.ingest_collection($1,$2,$3)",[collectionKey(s.target),hash(JSON.stringify(s)),JSON.stringify(s)]);
  const add=async(id="200")=>{
    const s=exampleCollectionSnapshot(new Date(Date.now()-1000).toISOString());s.target.collectionId=id;s.members[1].publishedAt="2026-02-01T00:00:00.000Z";
    await db.query("INSERT INTO social_sync.collection_bindings(account_id,kind,collection_id,enabled) VALUES($1,'season',$2,true)",[s.target.accountId,id]);await ingest(s);
    await db.query(`INSERT INTO social_sync.retained_collections(collection_key,approved,reviewed_at,title,approved_source_sha256,source_sha256,approved_member_keys,follow_public_members)
      SELECT collection_key,true,now(),'Approved collection',payload_sha256,payload_sha256,member_review_keys,true FROM social_sync.collection_states WHERE collection_key=$1`,[collectionKey(s.target)]);
    return s;
  };
  const get=async()=>(await readRetainedSocialSnapshot(reader,true)).items.find(w=>w.collection)!;
  return {db,role,worker,reader,add,ingest,get};
}

test("a collection with no standalone member records obtains a checked latest link using one bounded request",async t=>{
  const e=await engine(t),s=await e.add(),key=collectionKey(s.target);let requests=0;
  assert.equal((await e.db.query("SELECT * FROM social_sync.publications")).rows.length,0);
  assert.equal((await e.get()).collection!.latestMemberUrl,null);
  const before=(await e.db.query("SELECT payload,card,observed_at FROM social_sync.collection_states")).rows;
  const report=await verifyCollectionPlaybacks(e.worker,[key],"retained",{request:async(input,init)=>{
    requests++;assert.equal(String(input),"https://www.bilibili.com/video/BV0000000002/");assert.equal(init!.redirect,"manual");
    return new Response(html(s),{headers:{"content-type":"text/html"}});
  }});
  assert.deepEqual(report,{selected:1,verified:1,failed:0,code:null});assert.equal(requests,1);
  const work=await e.get();assert.equal(work.collection!.latestMemberUrl,"https://www.bilibili.com/video/BV0000000002/");
  assert.equal(work.collection!.latestMemberPublishedAt,s.members[1].publishedAt);assert(work.collection!.latestMemberLinkVerifiedAt);
  assert(!/"(?:accountId|publicationId|members|sourceSha256)"/.test(JSON.stringify(work)));
  assert.deepEqual((await e.db.query("SELECT payload,card,observed_at FROM social_sync.collection_states")).rows,before);
  assert.equal((await withSocialCovers(await readRetainedSocialSnapshot(e.reader,true),e.reader,"retained",true)).items[0].cover,null);
  const again=await verifyCollectionPlaybacks(e.worker,[key],"retained",{request:async()=>assert.fail("verified identity must not download again")});assert.equal(again.selected,0);
});

test("a source update replaces pending identity without re-collecting old episodes; removal and denial cannot keep an old link",async t=>{
  const e=await engine(t),s=await e.add(),key=collectionKey(s.target);
  await verifyCollectionPlaybacks(e.worker,[key],"retained",{request:async()=>new Response(html(s),{headers:{"content-type":"text/html"}})});
  const next=structuredClone(s);next.observedAt=new Date().toISOString();next.members.push({id:"BV0000000003",publishedAt:"2026-03-01T00:00:00.000Z",parts:["1003"],partsComplete:true});await e.ingest(next);
  let work=await e.get();assert.equal(work.collection!.latestMemberUrl,null);assert.equal(work.collection!.latestMemberPublishedAt,next.members[2].publishedAt);
  await verifyCollectionPlaybacks(e.worker,[key],"retained",{request:async()=>new Response(html(next,"BV0000000003"),{headers:{"content-type":"text/html"}})});
  assert.match((await e.get()).collection!.latestMemberUrl!,/BV0000000003\/$/);
  await e.db.query("INSERT INTO social_sync.bindings(platform,account_id,publication_id,work_id,enabled) VALUES('bilibili','10001','BV0000000003','denied-member',false)");
  work=await e.get();assert.match(work.collection!.latestMemberUrl!,/BV0000000002\/$/);assert.equal(work.collection!.latestMemberPublishedAt,s.members[1].publishedAt);
  await e.db.query("UPDATE social_sync.retained_collections SET approved=false WHERE collection_key=$1",[key]);
  assert.equal((await readRetainedSocialSnapshot(e.reader,true)).items.length,0);
  assert.equal((await e.reader.query("SELECT * FROM social_sync.collection_playback_links")).rows.length,0);
});

test("failed verification stops later requests and remains visibly failed instead of retrying automatically",async t=>{
  const e=await engine(t),a=await e.add(),b=await e.add("201");let requests=0;
  const keys=[collectionKey(a.target),collectionKey(b.target)];
  const report=await verifyCollectionPlaybacks(e.worker,keys,"retained",{request:async()=>{requests++;return new Response(null,{status:403});}});
  assert.equal(report.failed,1);assert.equal(report.code,"SOURCE_BLOCKED");assert.equal(requests,1);
  assert.equal((await e.db.query("SELECT * FROM social_sync.collection_playback_links WHERE failure_code='SOURCE_BLOCKED'")).rows.length,1);
  const pending=(await e.worker.query("SELECT social_sync.pending_collection_playbacks($1::jsonb,'retained') AS candidate",[JSON.stringify(keys)])).rows;
  assert.equal(pending.length,2);
  const again=await verifyCollectionPlaybacks(e.worker,keys,"retained",{request:async()=>assert.fail("failed evidence requires explicit recovery")});
  assert.equal(again.failed,1);assert.equal(again.code,"SOURCE_BLOCKED");
});

test("foreign or changed source pages and in-flight withdrawal never produce a playback proof",async t=>{
  for(const action of ["foreign","changed","withdraw"]){
    const e=await engine(t),s=await e.add(),key=collectionKey(s.target);
    const report=await verifyCollectionPlaybacks(e.worker,[key],"retained",{request:async()=>{
      if(action==="withdraw")await e.db.query("UPDATE social_sync.retained_collections SET approved=false WHERE collection_key=$1",[key]);
      const copy=structuredClone(s);if(action==="foreign")copy.target.accountId="10002";if(action==="changed")copy.members[1].publishedAt="2026-03-01T00:00:00.000Z";
      return new Response(html(copy),{headers:{"content-type":"text/html"}});
    }});
    assert.equal(report.verified,0,action);assert.equal(report.failed,1,action);
    assert.equal((await e.db.query("SELECT * FROM social_sync.collection_playback_links WHERE outbound_url IS NOT NULL")).rows.length,0);
  }
});

test("extension roles cannot approve cards, forge arbitrary URLs or read unrelated playback records",async t=>{
  const e=await engine(t),s=await e.add(),key=collectionKey(s.target);
  for(const name of ["anon","authenticated","service_role","nb_reader","nb_social_worker"])await assert.rejects(e.role(name).query("SELECT * FROM social_sync.collection_playback_links"),/permission denied/);
  for(const actor of [e.worker,e.reader])for(const sql of ["UPDATE social_sync.collection_playback_links SET outbound_url='https://evil.example/'","UPDATE social_sync.retained_collections SET approved=true"])
    await assert.rejects(actor.query(sql),/permission denied/);
  await assert.rejects(e.reader.query("SELECT social_sync.pending_collection_playbacks($1::jsonb,'retained')",[JSON.stringify([key])]),/permission denied/);
  for(const args of [[key,"0".repeat(64),"BV0000000002"],[key,hash(JSON.stringify(s)),"BV0000000001"],[key,hash(JSON.stringify(s)),"BV0000000002/?vd_source=private"]])
    await assert.rejects(e.worker.query("SELECT social_sync.complete_collection_playback($1,$2,$3,'retained',$4,null)",[...args,new Date().toISOString()]),/NB_PLAYBACK_/);
  await e.db.query("UPDATE social_sync.retained_collections SET approved=false WHERE collection_key=$1",[key]);
  assert.equal((await e.reader.query("SELECT * FROM social_sync.collection_playback_sources")).rows.length,0);
});

test("uninstalled or invalid playback configuration fails explicitly only when opted in",async t=>{
  const e=await engine(t,false);await e.add();
  assert.equal((await readRetainedSocialSnapshot(e.reader)).items.length,1);
  await assert.rejects(readRetainedSocialSnapshot(e.reader,true));
  assert.equal(socialCollectionPlaybackEnabled(undefined),false);assert.equal(socialCollectionPlaybackEnabled("enabled"),true);
  assert.throws(()=>socialCollectionPlaybackEnabled("true"));
});

test("unknown member dates stay unknown and trial proofs keep their independent qualification",async t=>{
  const e=await engine(t),s=await e.add(),key=collectionKey(s.target);
  await e.db.query("INSERT INTO social_sync.collection_visibility(collection_key,title,approved,checked_at,valid_until) VALUES($1,'Approved collection',true,now(),now()+interval '1 hour')",[key]);
  for(const m of s.members)await e.db.query("INSERT INTO social_sync.collection_member_reviews(collection_key,member_sha,approved,checked_at,valid_until) VALUES($1,social_sync.collection_member_digest($2::jsonb),true,now(),now()+interval '1 hour')",[key,JSON.stringify(m)]);
  await verifyCollectionPlaybacks(e.worker,[key],"trial",{request:async()=>new Response(html(s),{headers:{"content-type":"text/html"}})});
  assert.match((await readSocialTimelineSnapshot(e.reader,true)).items[0].collection!.latestMemberUrl!,/BV0000000002\/$/);
  await e.db.query("UPDATE social_sync.collection_visibility SET approved=false WHERE collection_key=$1",[key]);
  assert.equal((await readSocialTimelineSnapshot(e.reader,true)).items.length,0);
  const unknown=structuredClone(s);unknown.observedAt=new Date().toISOString();for(const member of unknown.members)member.publishedAt=null;await e.ingest(unknown);
  const card=(await e.get()).collection!;assert.equal(card.latestMemberUrl,null);assert.equal(card.latestMemberPublishedAt,null);assert(card.activity);
  const idle=await verifyCollectionPlaybacks(e.worker,[key],"retained",{request:async()=>assert.fail("unknown publication dates do not select a guessed episode")});assert.equal(idle.selected,0);
});

test("cancellation and private scope changes cannot register a checked link",async t=>{
  for(const action of ["cancel","scope"]){
    const e=await engine(t),s=await e.add(),key=collectionKey(s.target),controller=new AbortController();let changed=false;
    const report=await verifyCollectionPlaybacks(e.worker,[key],"retained",{signal:controller.signal,checkScope:async()=>{if(changed)throw new (await import("../scripts/social-sync/model.ts")).SocialSyncError("REFRESH_SCOPE_CHANGED");},request:async()=>{
      if(action==="cancel")controller.abort();else changed=true;
      return new Response(html(s),{headers:{"content-type":"text/html"}});
    }});
    assert.equal(report.verified,0);assert.equal(report.failed,1);
    assert.equal((await e.db.query("SELECT * FROM social_sync.collection_playback_links")).rows.length,0);
  }
});


test("a larger approved scope uses bounded SQL chunks and at most twenty source requests per execution",async t=>{
  const e=await engine(t),samples=new Map<string,CollectionSnapshot>();
  for(let i=0;i<24;i++){const s=await e.add(String(500+i));samples.set(collectionKey(s.target),s);}
  const keys=[...samples.keys()];let requests=0;const pending: string[]=[];let chunks=0;
  const worker:SqlExecutor={query:async<T>(sql:string,values?:unknown[])=>{
    const result=await e.worker.query<T>(sql,values);
    if(sql.startsWith("SELECT social_sync.pending_collection_playbacks(")){
      assert(JSON.parse(values![0] as string).length<=20);chunks++;
      for(const row of result.rows as {candidate:{key:string}}[])pending.push(row.candidate.key);
    }
    return result;
  }};
  const options={request:async()=>{requests++;return new Response(html(samples.get(pending.shift()!)!),{headers:{"content-type":"text/html"}});}};
  assert.deepEqual(await verifyCollectionPlaybackScope(worker,keys,"retained",options),{selected:20,verified:20,failed:0,code:null,remaining:4});
  assert.equal(requests,20);assert.equal(chunks,2);pending.length=0;
  assert.deepEqual(await verifyCollectionPlaybackScope(worker,keys,"retained",options),{selected:4,verified:4,failed:0,code:null,remaining:0});
  assert.equal(requests,24);pending.length=0;
  assert.deepEqual(await verifyCollectionPlaybackScope(worker,keys,"retained",{request:async()=>assert.fail("No re-download after proof")}),{selected:0,verified:0,failed:0,code:null,remaining:0});
  await assert.rejects(verifyCollectionPlaybacks(worker,keys,"retained",options),{code:"PLAYBACK_SCOPE_INVALID"});
});
