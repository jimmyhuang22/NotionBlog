import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {randomUUID,createHash} from "node:crypto";
import {PGlite} from "@electric-sql/pglite";
import {CONTENT_KINDS,contentFeatures} from "../config/features.ts";
import {fixtureItems} from "../fixtures/content.ts";
import type {ContentDetail,AnyContent} from "../contracts/content.ts";
import type {WebsiteRecord} from "../contracts/website-sync.ts";
import {WEBSITE_SCHEMA_DIGEST} from "../contracts/website-sync.ts";
import {SYNC_SCHEMA_DIGEST} from "../contracts/sync.ts";
import {configDigest,validateWebsiteRecord,mediaIdentity} from "../src/server/database/website-validation.ts";
import {createWebsiteWriter} from "../src/server/database/website-writer.ts";
import {createWebsiteDatabaseRepository} from "../src/server/database/website-repository.ts";
import {websiteMediaResponse} from "../src/server/database/website-media.ts";
import type {SqlExecutor} from "../src/server/database/sql.ts";
import {createContentService} from "../src/lib/content/factory.ts";
import protocol from "../database/website-protocol.json" with {type:"json"};
const controlled=(code:string)=>(e:unknown)=>!!e&&typeof e==="object"&&"code"in e&&e.code===code;
const all=Object.fromEntries(CONTENT_KINDS.map(k=>[k,true])) as typeof contentFeatures;
function records():WebsiteRecord[] {
 const result:WebsiteRecord[]=[];
 for(const kind of CONTENT_KINDS){for(const raw of fixtureItems[kind].slice(0,kind==="post"?3:1)){
   const item=structuredClone(raw);item.cover=null;
   if(item.kind==="status"){item.href=`/status#${item.id}`;item.text=[{text:"Visible public body",equation:true}];}
   if(item.kind==="study-note"){item.parentId=null;item.courseId=fixtureItems.course[0].id;item.href=`/study/${item.courseId}/notes/${item.slug}`;item.breadcrumbs=[];}
   const detail:ContentDetail<AnyContent>={item,document:{blocks:[{id:"paragraph",type:"paragraph",text:[{text:"Searchable body"}]}],toc:[],completeness:"complete"}};
   result.push({detail,evidence:{sourceKey:kind,dataSourceId:kind==="page"?null:`source-${kind}`,databaseParentId:kind==="study-note"?fixtureItems.course[0].id:null,courseId:kind==="study-note"?fixtureItems.course[0].id:null,parentId:kind==="study-note"?fixtureItems.course[0].id:null,ordinal:result.length}});
 }}return result;
}
test("v2 database supports all DTOs and preserves the frozen v1 worker and roles",async t=>{
 const db=await PGlite.create();try {
  await db.exec("CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;");
  await db.exec(await readFile(new URL("../database/migrations/001_content.sql",import.meta.url),"utf8"));await db.query("UPDATE nb.state SET schema_digest=$1",[SYNC_SCHEMA_DIGEST]);
  const sql=await readFile(new URL("../database/website-migrations/001_website.sql",import.meta.url),"utf8");assert.equal(createHash("sha256").update(sql).digest("hex"),protocol.migration.sha256);
  await db.exec(sql);await db.query("UPDATE nb_v2.state SET schema_digest=$1",[WEBSITE_SCHEMA_DIGEST]);
  assert.equal((await db.query<{schema_digest:string}>("SELECT schema_digest FROM nb.state")).rows[0].schema_digest,SYNC_SCHEMA_DIGEST);
  const role=(name:string):SqlExecutor=>({query:<T>(sql:string,values?:unknown[])=>db.transaction(async tx=>{await tx.exec(`SET LOCAL ROLE ${name}`);return tx.query<T>(sql,values);})});
  const reader=role("nb_reader"),writer=createWebsiteWriter(role("nb_writer")),repo=createContentService({provider:"database",features:all,databaseRepository:createWebsiteDatabaseRepository(reader)}).repository;
  const batch=records(),sources=CONTENT_KINDS.map(kind=>({key:kind,kind,mode:["course","study-note","page"].includes(kind)?"allowlist":"all",dataSourceId:kind==="page"?null:`source-${kind}`,databaseParentId:kind==="study-note"?fixtureItems.course[0].id:null,pageId:kind==="page"?fixtureItems.page[0].id:null})),permits=batch.filter(r=>sources.find(s=>s.key===r.evidence.sourceKey)!.mode==="allowlist").map(r=>({id:r.detail.item.id,kind:r.detail.item.kind,sourceKey:r.evidence.sourceKey,courseId:r.evidence.courseId,parentId:r.evidence.parentId})),digest=configDigest([sources,permits]);
  await db.query("SELECT nb_v2_api.configure_policy($1,600,$2::jsonb,$3::jsonb)",[digest,JSON.stringify(sources),JSON.stringify(permits)]);
  async function publish(){const lease=await writer.begin(randomUUID(),digest);await writer.stage(lease,batch);await writer.promote(lease,{records:batch.length,media:0,complete:true});return lease;}
  await publish();
  await t.test("rich Status previews use current reader projection without persisting list fields",async()=>{
   const record=batch.find(r=>r.detail.item.kind==="status")!, original=structuredClone(record.detail.document);
   record.detail.document={blocks:[{id:"quote",type:"quote",text:[{text:"x".repeat(450),bold:true}]}],toc:[],completeness:"complete"};
   await publish();
   const status=(await repo.list("status",{limit:1})).items[0];
   assert.deepEqual(status.previewBody,[{id:"quote",type:"quote",text:[{text:"x".repeat(400),bold:true}]}]);
   assert.equal(status.previewBodyTruncated,true);
   assert.ok(!Object.hasOwn((await repo.get("status",status.slug))!.item,"previewBody"));
   await db.query("SELECT nb_v2_api.set_denied($1,true)",[status.id]);
   assert.equal((await repo.list("status")).items.length,0);
   await db.query("SELECT nb_v2_api.set_denied($1,false)",[status.id]);
   record.detail.document=original;await publish();
  });
  await t.test("play dates are projected to days and use the later manual end through real restricted SQL",async()=>{
   const game=batch.find(record=>record.detail.item.kind==="game")!.detail.item;
   assert.equal(game.kind,"game");if(game.kind!=="game")throw Error("Game fixture missing");
   const experience=structuredClone(game.playedDate);
   game.lastPlayedDate={start:"2025-06-15T10:00:00.000Z",end:null,precision:"datetime"};
   game.firstPlayedDate={start:"2024-01-02",end:null,precision:"date"};
   await publish();
   const detail=await repo.get("game",game.slug);
   assert.deepEqual(detail!.item.playedDate,experience);
   assert.deepEqual(detail!.item.lastPlayedDate,{start:"2025-06-15",end:null,precision:"date"});
   assert.deepEqual(detail!.item.firstPlayedDate,game.firstPlayedDate);
   assert.deepEqual(detail!.item.archiveDate,{start:"2026-09-01",end:null,precision:"date"});
   assert.deepEqual((await repo.getLibraryYears!("game")).years,[{year:2026,count:1}]);
   assert.equal((await repo.list("game",{year:2025})).total,0);
   assert.equal((await repo.list("game",{year:2026})).total,1);
   const bad=structuredClone(batch.find(record=>record.detail.item.kind==="game")!);
   Object.assign(bad.detail.item,{lastPlayedDate:{start:"invalid",end:null,precision:"datetime"}});
   assert.throws(()=>validateWebsiteRecord(bad),controlled("CONTENT_UNAVAILABLE"));
   delete game.lastPlayedDate;
   await publish();
   assert.equal((await repo.get("game",game.slug))!.item.lastPlayedDate,null);
   assert.deepEqual((await repo.getLibraryYears!("game")).years,[{year:2026,count:1}]);
  });
  await t.test("page qualification reads current metadata without requesting documents",async()=>{
   const calls:unknown[][]=[];
   const metadata=createWebsiteDatabaseRepository({query:async(sql,params=[])=>{calls.push(params);return reader.query(sql,params);}});
   assert.equal((await metadata.getContentMetadata!("game",fixtureItems.game[0].slug))?.id,fixtureItems.game[0].id);
   assert.equal((await metadata.getContentMetadata!("page","about"))?.kind,"page");
   assert.equal(await metadata.getContentMetadata!("game","missing"),null);
   assert.ok(calls.every(params=>params[1]===false));
  });
  await t.test("all sections, fixed page, totals and body search use reader-only snapshots",async()=>{
   for(const kind of CONTENT_KINDS){const p=await repo.list(kind,{limit:1});assert.equal(p.total,kind==="post"?3:1);assert.equal(p.items[0].kind,kind);}
   assert.equal((await repo.getPage!("about"))?.slug,"about");assert.equal(await repo.getPage!(fixtureItems.page[0].id as "about"),null);
   assert.equal((await repo.search!({q:"Searchable",limit:50})).total,batch.length);
   assert.equal((await repo.getCourseTree(fixtureItems.course[0].slug))?.nodes.length,1);
   assert.ok((await repo.get("post",fixtureItems.post[0].slug))?.adjacent);
   for(const r of ["nb_writer","anon","authenticated","service_role"])await assert.rejects(role(r).query("SELECT nb_v2_api.read_snapshot(ARRAY['post'],true)"),/permission denied/);
   await assert.rejects(reader.query("SELECT * FROM nb_v2.records"),/permission denied/);await assert.rejects(reader.query("SELECT nb_v2_api.configure_policy(NULL,1,'[]','[]')"),/permission denied/);
  });
  await t.test("library summaries use actual reader eligibility and follow status and withdrawal",async()=>{
   for(const kind of ["movie","book","game"] as const) {
    const item=batch.find(record=>record.detail.item.kind===kind)!.detail.item;
    const years=await repo.getLibraryYears!(kind);
    assert.equal(years.undatedCount+years.years.reduce((sum,value)=>sum+value.count,0),1);
    const selection=years.years[0]?.year??"undated";
    assert.equal((await repo.list(kind,{year:selection,limit:1})).total,1);
    const status="status" in item?item.status:undefined;
    assert.deepEqual(await repo.getLibraryYears!(kind,{status}),years);
    await db.query("SELECT nb_v2_api.set_denied($1,true)",[item.id]);
    assert.deepEqual(await repo.getLibraryYears!(kind),{years:[],undatedCount:0,timeZone:"UTC"});
    assert.equal((await repo.list(kind,{year:selection})).total,0);
    await db.query("SELECT nb_v2_api.set_denied($1,false)",[item.id]);
   }
  });
  await t.test("v2 media checks bytes, version and owner withdrawal during object reads",async()=>{
   const bytes=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZL98AAAAASUVORK5CYII=","base64"),sha=createHash("sha256").update(bytes).digest("hex");
   const owner=batch[0].detail.item.id,assetId=mediaIdentity(owner,"cover",sha);
   const media={assetId,ownerPageId:owner,objectKey:`sha256/${sha}`,sha256:sha,byteSize:bytes.length,mime:"image/png" as const,width:1,height:1};
   batch[0].detail.item.cover={id:assetId,src:`/media/v2/${assetId}`,alt:"Sample",width:1,height:1};
   const lease=await writer.begin(randomUUID(),digest);await writer.stage(lease,batch,[media]);await writer.promote(lease,{records:batch.length,media:1,complete:true});
   const storage={read:async()=>bytes,put:async()=>{throw new Error("Reader must not upload");}};
   const response=await websiteMediaResponse(assetId,reader,()=>storage);
   assert.equal(response.status,200);assert.equal(response.headers.get("Content-Type"),"image/png");assert.equal(response.headers.get("Cache-Control"),"private, max-age=86400, must-revalidate");assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
   await assert.rejects(websiteMediaResponse(assetId,reader,()=>({...storage,read:async()=>Buffer.from("bad")})),controlled("CONTENT_UNAVAILABLE"));
   await db.query("UPDATE nb_v2.state SET schema_digest=$1",[SYNC_SCHEMA_DIGEST]);
   await assert.rejects(websiteMediaResponse(assetId,reader,()=>storage),controlled("CONTENT_UNAVAILABLE"));await db.query("UPDATE nb_v2.state SET schema_digest=$1",[WEBSITE_SCHEMA_DIGEST]);
   const withdrawn=await websiteMediaResponse(assetId,reader,()=>({...storage,read:async()=>{await db.query("SELECT nb_v2_api.set_denied($1,true)",[owner]);return bytes;}}));assert.equal(withdrawn.status,404);
   await db.query("SELECT nb_v2_api.set_denied($1,false)",[owner]);
  });
  await t.test("withdrawal removes search, About and descendants and invalidates old cursors",async()=>{
   const p=await repo.list("post",{limit:1});assert.ok(p.nextCursor);
   await db.query("SELECT nb_v2_api.set_denied($1,true)",[fixtureItems.post[0].id]);
   await assert.rejects(repo.list("post",{limit:1,cursor:p.nextCursor!}),controlled("INVALID_QUERY"));
   assert.equal((await repo.list("post")).total,2);assert.ok(!(await repo.search!({q:"Searchable",limit:50})).items.some(i=>i.id===fixtureItems.post[0].id));
   await db.query("SELECT nb_v2_api.set_denied($1,true)",[fixtureItems.course[0].id]);assert.equal((await repo.list("study-note")).total,0);
   await db.query("SELECT nb_v2_api.set_denied($1,true)",[fixtureItems.page[0].id]);assert.equal(await repo.getPage!("about"),null);
   assert.equal(await repo.getContentMetadata!("page","about"),null);
  });
  await t.test("failed full publication preserves prior run and expired snapshots fail closed",async()=>{
   await db.exec("TRUNCATE nb_v2.denied");const prior=(await db.query<{current_run:string}>("SELECT current_run FROM nb_v2.state")).rows[0].current_run;
   const lease=await writer.begin(randomUUID(),digest);await writer.stage(lease,batch.slice(0,1));await assert.rejects(writer.promote(lease,{records:1,media:0,complete:true}),controlled("CONTENT_UNAVAILABLE"));await writer.fail(lease);
   assert.equal((await db.query<{current_run:string}>("SELECT current_run FROM nb_v2.state")).rows[0].current_run,prior);
   await db.exec("UPDATE nb_v2.runs SET valid_until=clock_timestamp()-interval '1 second' WHERE status='published'");await assert.rejects(repo.list("game"),controlled("CONTENT_UNAVAILABLE"));
   await assert.rejects(repo.getLibraryYears!("game"),controlled("CONTENT_UNAVAILABLE"));
  });
 } finally{await db.close();}
});
test("v2 validation rejects unknown fields, wrong routes, signed links and invalid inline math",()=>{
 for(const r of records())validateWebsiteRecord(r);
 const wrong=records().find(r=>r.detail.item.kind==="page")!;wrong.detail.item.slug="private-child";assert.throws(()=>validateWebsiteRecord(wrong));
 const extra=records()[0];(extra.detail.item as unknown as Record<string,unknown>).secret="hidden";assert.throws(()=>validateWebsiteRecord(extra));
 const math=records()[0];math.detail.document!.blocks=[{id:"p",type:"paragraph",text:[{text:"x",equation:false as unknown as true}]}];assert.throws(()=>validateWebsiteRecord(math));
});
