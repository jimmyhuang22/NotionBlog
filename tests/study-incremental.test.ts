import test from "node:test";
import assert from "node:assert/strict";
import type { PageObjectResponse, BlockObjectResponse, DataSourceObjectResponse, DatabaseObjectResponse } from "@notionhq/client";
import type { NotionReadClient } from "../src/server/notion/types.ts";
import { parseWebsiteNotionConfig } from "../src/server/notion/website-config.ts";
import { createWebsiteNotionRepository, createWebsiteStudyChangeSource } from "../src/server/notion/website-repository.ts";
import { captureStudyCheckpoint, prepareStudyDelta, syncStudyChanges, type StudyCheckpoint, type StudyDelta, type StudyDeltaStore } from "../src/server/notion/study-incremental.ts";
import { mediaIdentity } from "../src/server/database/website-validation.ts";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { WEBSITE_SCHEMA_DIGEST } from "../contracts/website-sync.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";
import { createWebsiteDatabaseRepository } from "../src/server/database/website-repository.ts";
import { publicationReader, publicationWriter } from "../src/server/database/publication.ts";
import { createIncrementalPublisher, preparePublicationDelta, readPublicationState } from "../src/server/database/incremental-publication.ts";
import { websitePolicy } from "../scripts/website-sync/worker.ts";
import studyProtocol from "../database/website-study-protocol.json" with {type:"json"};
import publicationProtocol from "../database/publication-protocol.json" with {type:"json"};
import incrementalProtocol from "../database/incremental-publication-protocol.json" with {type:"json"};
const id=(n:number)=>n.toString(16).padStart(32,"0"),time="2026-10-13T00:00:00.000Z";
const text=(s:string)=>({type:"text",plain_text:s,text:{content:s,link:null},annotations:{bold:false,italic:false,strikethrough:false,underline:false,code:false,color:"default"},href:null});
const owner=(n:number)=>({type:"page_id" as const,page_id:id(n)}),ds=(n:number)=>({type:"data_source_id" as const,data_source_id:id(n),database_id:id(n===3?2:n===8?7:100)});
async function setup() {
  const config=parseWebsiteNotionConfig({schemaVersion:2,sources:[
    {key:"courses",kind:"course",enabled:true,dataSourceId:id(1),fields:{title:"Name"},publication:{mode:"all"}},
    {key:"notes",kind:"study-note",enabled:true,dataSourceId:id(1),fields:{title:"Name",date:"Date",order:"Sort"},publication:{mode:"course-descendants"}},
  ]});
  const page=(n:number,title:string,parent:unknown)=>({object:"page",id:id(n),parent,archived:false,in_trash:false,cover:null,last_edited_time:time,properties:{
    Name:{type:"title",id:"title",title:[text(title)]},Date:{type:"date",id:"date",date:{start:"2026-03-01",end:null,time_zone:null}},Sort:{type:"number",id:"sort",number:null},
  }}) as unknown as PageObjectResponse;
  const pages=new Map([[id(10),page(10,"Course A",ds(1))],[id(11),page(11,"Course B",ds(1))],[id(20),page(20,"Week 2",ds(3))],[id(21),page(21,"Week 10",ds(3))],[id(30),page(30,"Deep note",owner(20))],[id(40),page(40,"Other course note",ds(8))]]);
  const block=(n:number,p:number,type:string,value:unknown)=>({object:"block",id:id(n),parent:owner(p),type,[type]:value,has_children:false,archived:false,in_trash:false}) as unknown as BlockObjectResponse;
  const blocks=new Map([[id(10),[block(2,10,"child_database",{title:"Notes A"})]],[id(11),[block(7,11,"child_database",{title:"Notes B"})]],[id(20),[block(30,20,"child_page",{title:"Deep note"})]],[id(21),[block(210,21,"paragraph",{rich_text:[text("Unchanged sibling")],color:"default"})]],[id(30),[block(300,30,"paragraph",{rich_text:[text("Old body")],color:"default"})]],[id(40),[]]]);
  const calls:string[]=[],mediaOwners:string[]=[];
  const client:NotionReadClient={
    getPage:async key=>{calls.push(`page:${key}`);return structuredClone(pages.get(key)??null);},
    getBlock:async key=>structuredClone([...blocks.values()].flat().find(b=>b.id===key)??null),
    getDataSource:async key=>({id:key,parent:{type:"database_id",database_id:key===id(3)?id(2):key===id(8)?id(7):id(100)},database_parent:owner(key===id(3)?10:key===id(8)?11:900),properties:{Name:{type:"title",id:"title"},Date:{type:"date",id:"date"},Sort:{type:"number",id:"sort"}}}) as unknown as DataSourceObjectResponse,
    getDatabase:async key=>({id:key,parent:owner(key===id(2)?10:11),data_sources:[{id:key===id(2)?id(3):id(8),name:"Notes"}],archived:false,in_trash:false}) as DatabaseObjectResponse,
    listPages:async key=>{calls.push(`rows:${key}`);return structuredClone([...pages.values()].filter(p=>p.parent.type==="data_source_id"&&p.parent.data_source_id===key));},
    listBlocks:async key=>{calls.push(`blocks:${key}`);return structuredClone(blocks.get(key)??[]);},
  };
  const options={client,config,registerImage:async(input:{ownerPageId:string;blockId?:string;alt:string})=>{
    mediaOwners.push(input.ownerPageId);const asset=mediaIdentity(input.ownerPageId,input.blockId??"cover","a".repeat(64));
    return {id:asset,src:`/media/v2/${asset}`,alt:input.alt,width:400,height:200};
  }};
  const source=()=>createWebsiteStudyChangeSource(options);
  const records=await createWebsiteNotionRepository(options).collectRecords(true);
  // The existing publisher removes the navigation-only breadcrumb before SQL.
  for(const r of records)if(r.detail.item.kind==="study-note")r.detail.item.breadcrumbs=r.detail.item.breadcrumbs.filter(l=>l.href!=="/study");
  const checkpoint=await captureStudyCheckpoint("v1",records,source());calls.length=0;mediaOwners.length=0;
  return {config,pages,blocks,client,calls,mediaOwners,options,source,checkpoint,page,block};
}
function apply(state:StudyCheckpoint,delta:StudyDelta,version="v2"):StudyCheckpoint {
  assert.equal(delta.baseVersion,state.version);assert.equal(delta.sourceDigest,state.sourceDigest);
  const records=new Map(state.entries.map(e=>[e.record.detail.item.id,e]));delta.withdrawals.forEach(id=>records.delete(id));delta.upserts.forEach(e=>records.set(e.record.detail.item.id,e));
  return {...state,version,entries:[...records.values()]};
}
test("deep-page signals read only that body despite unchanged parent timestamps; duplicates coalesce",async()=>{
  const s=await setup();s.blocks.set(id(30),[s.block(300,30,"paragraph",{rich_text:[text("New body")],color:"default"})]);
  const source=s.source(),delta=await prepareStudyDelta(s.checkpoint,[id(30),id(30)],source);
  assert.deepEqual(delta.upserts.map(e=>e.record.detail.item.id),[id(30)]);
  assert.deepEqual(s.calls.filter(c=>c.startsWith("blocks:")),[`blocks:${id(30)}`]);
  assert.equal(s.calls.some(c=>c.startsWith("rows:")),false);assert.equal(s.mediaOwners.length,0);
  assert.equal(delta.directories[0].pages,3);assert.equal(delta.directories[0].maxDepth,2);
  const next=apply(s.checkpoint,delta),repeated=await prepareStudyDelta(next,[id(30)],source);assert.equal(repeated.upserts.length,0);
  s.blocks.set(id(30),[]);const fresh=await prepareStudyDelta(next,[id(30)],source);assert.equal(fresh.upserts.length,1);
});
test("changed parent discovers a future child but never reads unchanged sibling bodies",async()=>{
  const s=await setup();s.pages.set(id(31),s.page(31,"Child 2",owner(20)));s.blocks.get(id(20))!.push(s.block(31,20,"child_page",{title:"Child 2"}));
  const delta=await prepareStudyDelta(s.checkpoint,[id(20)],s.source());
  const tree=delta.directories.find(d=>d.courseId===id(10))!.tree!;
  assert.deepEqual(tree.nodes[0].children!.map(n=>n.id),[id(30),id(31)]);
  assert.deepEqual([...new Set(s.calls.filter(c=>c.startsWith("blocks:")))].sort(),[20,31].map(n=>`blocks:${id(n)}`).sort());
  assert.equal(s.calls.includes(`blocks:${id(21)}`)||s.calls.includes(`blocks:${id(40)}`),false);
  assert.equal(s.calls.filter(c=>c===`page:${id(10)}`).length,1);
});
test("dependent metadata with a changed edit version reloads its body instead of pairing it with the old cache",async()=>{
  const s=await setup();s.pages.set(id(31),s.page(31,"Future child",owner(20)));s.blocks.get(id(20))!.push(s.block(31,20,"child_page",{title:"Future child"}));
  s.pages.get(id(20))!.last_edited_time="2026-10-13T01:00:00.000Z";
  const delta=await prepareStudyDelta(s.checkpoint,[id(31)],s.source());
  const parent=delta.upserts.find(e=>e.record.detail.item.id===id(20))!;
  assert.equal(parent.record.detail.document!.blocks.some(b=>b.type==="child-page"&&b.target?.href===`/study/${id(10)}/notes/${id(31)}`),true);
  assert.equal(s.calls.includes(`blocks:${id(20)}`),true);assert.equal(s.calls.includes(`blocks:${id(21)}`)||s.calls.includes(`blocks:${id(40)}`),false);
});
test("numeric root override and parent body order share the established tree order",async()=>{
  const s=await setup();const sort=s.pages.get(id(21))!.properties.Sort;if(sort.type==="number")sort.number=-1;
  const delta=await prepareStudyDelta(s.checkpoint,[id(21)],s.source());assert.deepEqual(delta.directories[0].tree!.nodes.map(n=>n.id),[id(21),id(20)]);
  const next=apply(s.checkpoint,delta);s.pages.set(id(31),s.page(31,"Child 2",owner(20)));s.blocks.set(id(20),[s.block(31,20,"child_page",{title:"Child 2"}),s.block(30,20,"child_page",{title:"Deep note"})]);
  const reordered=await prepareStudyDelta(next,[id(20)],s.source());
  assert.deepEqual(reordered.directories[0].tree!.nodes[1].children!.map(n=>n.id),[id(31),id(30)]);
});
test("cross-course moves refresh descendant metadata and cached incoming links without descendant bodies",async()=>{
  const s=await setup();const href=`/study/${id(10)}/notes/${id(30)}`;
  const asset=mediaIdentity(id(30),id(301),"a".repeat(64));
  s.checkpoint.entries.find(e=>e.record.detail.item.id===id(30))!.record.detail.document!.blocks.push({id:id(301),type:"image",image:{id:asset,src:`/media/v2/${asset}`,alt:"Cached original",width:400,height:200},caption:[]});
  s.checkpoint.entries.find(e=>e.record.detail.item.id===id(21))!.record.detail.document!.blocks.push({id:id(211),type:"child-page",title:"Deep note",target:{title:"Deep note",href}});
  s.pages.get(id(20))!.parent=ds(8);
  const delta=await prepareStudyDelta(s.checkpoint,[id(20)],s.source());
  assert.deepEqual(delta.directories.map(d=>d.courseId),[id(10),id(11)]);
  const child=delta.upserts.find(e=>e.record.detail.item.id===id(30))!.record.detail.item;
  assert.equal(child.kind,"study-note");if(child.kind==="study-note")assert.equal(child.courseId,id(11));
  const linking=delta.upserts.find(e=>e.record.detail.item.id===id(21))!.record.detail.document!.blocks.at(-1)!;
  assert.equal(linking.type,"child-page");if(linking.type==="child-page")assert.equal(linking.target!.href,`/study/${id(11)}/notes/${id(30)}`);
  assert.equal(s.calls.includes(`blocks:${id(30)}`)||s.calls.includes(`blocks:${id(21)}`)||s.calls.includes(`blocks:${id(40)}`),false);
  assert.equal(s.mediaOwners.length,0);
  assert.deepEqual(delta.upserts.find(e=>e.record.detail.item.id===id(30))!.record.detail.document!.blocks.at(-1),s.checkpoint.entries.find(e=>e.record.detail.item.id===id(30))!.record.detail.document!.blocks.at(-1));
});
test("ancestor archival withdraws the full subtree; unknown pages and source errors never commit",async()=>{
  const s=await setup();s.pages.get(id(20))!.archived=true;
  const delta=await prepareStudyDelta(s.checkpoint,[id(20)],s.source());assert.deepEqual(delta.withdrawals,[id(20),id(30)]);
  assert.deepEqual(delta.withdrawalEvidence,[{id:id(20),sourceKey:"notes",reason:"archived"}]);
  let commits=0;const store:StudyDeltaStore={loadLocal:async()=>s.checkpoint,commit:async()=>{commits++;return{version:"v2"};},saveLocal:async()=>{}};
  s.pages.get(id(20))!.archived=false;s.pages.delete(id(30));await assert.rejects(syncStudyChanges(store,s.source(),[id(30)]));assert.equal(commits,0);
  s.client.listBlocks=async()=>{throw Error("Incomplete source");};await assert.rejects(syncStudyChanges(store,s.source(),[id(20)]));assert.equal(commits,0);
});
test("confirmed moves outside the root and central deny withdraw owned descendants",async()=>{
  const s=await setup();s.pages.get(id(20))!.parent={type:"workspace",workspace:true};
  const moved=await prepareStudyDelta(s.checkpoint,[id(20)],s.source());assert.deepEqual(moved.withdrawals,[id(20),id(30)]);
  const denied=createWebsiteStudyChangeSource({...s.options,deniedPageIds:new Set([id(10)])});
  const delta=await prepareStudyDelta(s.checkpoint,[id(10)],denied);assert.deepEqual(delta.withdrawals,[id(10),id(20),id(21),id(30)]);
  assert.deepEqual(delta.withdrawalEvidence,[{id:id(10),sourceKey:"courses",reason:"denied"}]);
});
test("scope mismatch and read budget exhaustion fail before publication; baseline metadata never rereads media",async()=>{
  const s=await setup();const records=s.checkpoint.entries.map(e=>e.record);
  await captureStudyCheckpoint("v1",records,s.source());assert.equal(s.calls.some(c=>c.startsWith("blocks:")||c.startsWith("rows:")),false);assert.equal(s.mediaOwners.length,0);
  s.calls.length=0;await assert.rejects(prepareStudyDelta(s.checkpoint,[id(20)],{...s.source(),sourceDigest:"b".repeat(64)}));assert.equal(s.calls.length,0);
  s.pages.set(id(31),s.page(31,"New",owner(20)));s.blocks.get(id(20))!.push(s.block(31,20,"child_page",{title:"New"}));
  await assert.rejects(prepareStudyDelta(s.checkpoint,[id(20)],s.source(),1));
});
test("atomic store confirms a new version once; racing or unknown commits are not acknowledged",async()=>{
  const s=await setup();s.blocks.set(id(30),[]);let state=s.checkpoint,commits=0;
  const store:StudyDeltaStore={loadLocal:async()=>state,commit:async delta=>{commits++;assert.equal(delta.baseVersion,state.version);return{version:"v2"};},saveLocal:async next=>{state=next;}};
  const result=await syncStudyChanges(store,s.source(),[id(30)]);assert.equal(result.outcome,"committed");assert.equal(commits,1);
  const again=await syncStudyChanges(store,s.source(),[id(30)]);assert.equal(again.outcome,"unchanged");assert.equal(commits,1);
  const racing:StudyDeltaStore={loadLocal:async()=>s.checkpoint,commit:async()=>{throw Error("Version changed");},saveLocal:async()=>assert.fail("Unconfirmed checkpoint")};
  await assert.rejects(syncStudyChanges(racing,s.source(),[id(30)]));assert.equal(s.checkpoint.version,"v1");
});
test("new courses and owned children enter without enumerating the entire course catalogue",async()=>{
  const s=await setup();s.pages.set(id(12),s.page(12,"Future course",ds(1)));s.pages.set(id(50),s.page(50,"Future note",owner(12)));
  s.blocks.set(id(12),[s.block(50,12,"child_page",{title:"Future note"})]);
  // The child's event can arrive before its new course's event.
  const delta=await prepareStudyDelta(s.checkpoint,[id(50)],s.source());
  assert.deepEqual(delta.upserts.map(e=>e.record.detail.item.id),[id(12),id(50)]);
  assert.equal(delta.directories[0].pages,1);assert.equal(s.calls.some(c=>c.startsWith("rows:")),false);
  assert.equal(s.calls.includes(`blocks:${id(10)}`)||s.calls.includes(`blocks:${id(11)}`),false);
});
test("ancestor renames refresh breadcrumbs and cached link titles without reading dependent bodies",async()=>{
  const s=await setup();const title=s.pages.get(id(20))!.properties.Name;if(title.type==="title")title.title=[text("Renamed week") as typeof title.title[number]];
  const delta=await prepareStudyDelta(s.checkpoint,[id(20)],s.source());
  const note=delta.upserts.find(e=>e.record.detail.item.id===id(30))!.record.detail.item;
  assert.equal(note.kind,"study-note");if(note.kind==="study-note")assert.equal(note.breadcrumbs.at(-1)!.title,"Renamed week");
  assert.equal(s.calls.includes(`blocks:${id(30)}`),false);
});
test("withdrawn linked pages become unavailable in stored AST without refetching its owner",async()=>{
  const s=await setup();const href=`/study/${id(10)}/notes/${id(30)}`;
  const doc=s.checkpoint.entries.find(e=>e.record.detail.item.id===id(21))!.record.detail.document!;
  doc.blocks.push({id:id(211),type:"paragraph",text:[{text:"Old link",link:{kind:"internal",href}}]},
    {id:id(212),type:"child-page",title:"Deep note",target:{title:"Deep note",href}});
  s.pages.get(id(30))!.in_trash=true;const delta=await prepareStudyDelta(s.checkpoint,[id(30)],s.source());
  const blocks=delta.upserts.find(e=>e.record.detail.item.id===id(21))!.record.detail.document!.blocks;
  const paragraph=blocks.at(-2)!;assert.equal(paragraph.type,"paragraph");if(paragraph.type==="paragraph")assert.deepEqual(paragraph.text[0].link,{kind:"unavailable"});
  const link=blocks.at(-1)!;assert.equal(link.type,"child-page");if(link.type==="child-page"){assert.equal(link.target,null);assert.equal(link.title,"Unavailable page");}
  assert.equal(s.calls.some(c=>c.startsWith("blocks:")),false);
});
test("media preparation failure and baseline drift never publish mismatched documents",async()=>{
  const s=await setup();s.pages.get(id(30))!.last_edited_time="2026-10-13T01:00:00.000Z";
  await assert.rejects(captureStudyCheckpoint("v1",s.checkpoint.entries.map(e=>e.record),s.source()));
  s.blocks.set(id(30),[s.block(301,30,"image",{type:"external",external:{url:"https://media.example.com/synthetic.png"},caption:[]})]);
  const source=createWebsiteStudyChangeSource({...s.options,registerImage:async()=>null});let committed=false;
  await assert.rejects(syncStudyChanges({loadLocal:async()=>s.checkpoint,commit:async()=>{committed=true;return{version:"v2"};},saveLocal:async()=>assert.fail("Failed media checkpoint")},source,[id(30)]));
  assert.equal(committed,false);
});
test("local checkpoint failure after a confirmed commit does not report completion or retry publication",async()=>{
  const s=await setup();s.blocks.set(id(30),[]);let commits=0,saves=0;
  const store:StudyDeltaStore={loadLocal:async()=>s.checkpoint,commit:async()=>{commits++;return{version:"v2"};},saveLocal:async()=>{saves++;throw Error("Local cache unavailable");}};
  await assert.rejects(syncStudyChanges(store,s.source(),[id(30)]));
  assert.equal(commits,1);assert.equal(saves,1);assert.equal(s.checkpoint.version,"v1");
});
test("ancestor withdrawal does not discard a separately signalled descendant moved to another approved course",async()=>{
  const s=await setup();s.pages.get(id(20))!.archived=true;s.pages.get(id(30))!.parent=owner(11);
  s.blocks.set(id(20),[]);s.blocks.get(id(11))!.push(s.block(30,11,"child_page",{title:"Deep note"}));
  const delta=await prepareStudyDelta(s.checkpoint,[id(20),id(30)],s.source());
  assert.deepEqual(delta.withdrawals,[id(20)]);
  const child=delta.upserts.find(e=>e.record.detail.item.id===id(30))!.record.detail.item;
  assert.equal(child.kind,"study-note");if(child.kind==="study-note")assert.equal(child.courseId,id(11));
  // A destination-parent signal also discovers the move, even if the child
  // did not have an independent event in this batch.
  const discovered=await prepareStudyDelta(s.checkpoint,[id(20),id(11)],s.source());
  assert.deepEqual(discovered.withdrawals,[id(20)]);
  assert.equal(discovered.upserts.some(e=>e.record.detail.item.id===id(30)),true);
});
test("study deltas commit through the published SQL API after qualified expiry, including moves, withdrawal and denial",async()=>{
  const s=await setup(),db=await PGlite.create();
  try{
    await db.exec(await readFile(new URL("../database/migrations/001_content.sql",import.meta.url),"utf8"));
    await db.exec(await readFile(new URL("../database/website-migrations/001_website.sql",import.meta.url),"utf8"));
    await db.query("UPDATE nb_v2.state SET schema_digest=$1",[WEBSITE_SCHEMA_DIGEST]);
    await db.exec(await readFile(new URL("../database/website-study-migrations/001_automatic_study.sql",import.meta.url),"utf8"));
    await db.query("UPDATE nb_v2.migrations SET digest=$1 WHERE version=$2",[studyProtocol.migration.sha256,studyProtocol.migration.version]);
    await db.exec(await readFile(new URL(`../supabase/migrations/${publicationProtocol.migration.file}`,import.meta.url),"utf8"));
    await db.query("UPDATE nb_publication.state SET migration_digest=$1",[publicationProtocol.migration.sha256]);
    await db.exec(await readFile(new URL(`../supabase/migrations/${incrementalProtocol.migration.file}`,import.meta.url),"utf8"));
    await db.query("UPDATE nb_delta.state SET migration_digest=$1",[incrementalProtocol.migration.sha256]);
    const role=(name:string):SqlExecutor=>({query:<T>(sql:string,values?:unknown[])=>db.transaction(async tx=>{await tx.exec(`SET LOCAL ROLE ${name}`);return tx.query<T>(sql,values);})});
    const policy=await websitePolicy(s.client,s.config,600);
    await db.query("SELECT nb_v2_api.configure_policy($1,600,$2::jsonb,$3::jsonb)",[policy.configDigest,JSON.stringify(policy.sources),"[]"]);
    const writer=publicationWriter(role("nb_writer"),"published");await writer.verifyStudy!();
    const lease=await writer.begin(crypto.randomUUID(),policy.configDigest);
    for(const entry of s.checkpoint.entries)await writer.stage(lease,[entry.record]);
    await writer.promote(lease,{records:s.checkpoint.entries.length,media:0,complete:true});
    const reader=role("nb_reader"),published=createWebsiteDatabaseRepository(publicationReader(reader,"published"));
    const tree=await published.getCourseTree(id(10));s.calls.length=0;
    await db.query("UPDATE nb_v2.runs SET valid_until=clock_timestamp()-interval '1 second' WHERE id=$1",[lease.runId]);
    await assert.rejects(createWebsiteDatabaseRepository(reader).getCourseTree(id(10)));
    assert.deepEqual(await published.getCourseTree(id(10)),tree);assert.equal(s.calls.length,0);
    let checkpoint={...s.checkpoint,version:(await readPublicationState(reader)).publicationRevision};
    const publisher=createIncrementalPublisher(role("nb_writer"));
    const store:StudyDeltaStore={loadLocal:async()=>checkpoint,saveLocal:async next=>{checkpoint=next;},commit:async delta=>{
      const prepared=preparePublicationDelta({expectedRevision:delta.baseVersion,configDigest:delta.sourceDigest,
        upserts:delta.upserts.map(e=>e.record),media:[],withdrawals:delta.withdrawalEvidence.map(({id,sourceKey,reason})=>{
          if(reason==="denied")assert.fail("A policy deny must be reconciled separately, not sent as deletion");
          return {id,sourceKey,reason};
        })});
      const operationId=crypto.randomUUID(),receipt=await publisher.publish(operationId,prepared);
      assert.deepEqual(await publisher.lookup(operationId,prepared.payloadDigest),receipt);
      assert.equal((await readPublicationState(reader)).publicationRevision,receipt.publicationRevision);
      return {version:receipt.publicationRevision};
    }};
    s.blocks.set(id(30),[]);await syncStudyChanges(store,s.source(),[id(30)]);s.calls.length=0;
    assert.deepEqual((await published.get("study-note",id(30)))!.document!.blocks,[]);
    assert.deepEqual(await published.getCourseTree(id(10)),tree);assert.equal(s.calls.length,0);
    // Remove the old ancestor but preserve a freshly qualified descendant move.
    s.pages.get(id(20))!.archived=true;s.pages.get(id(30))!.parent=owner(11);
    s.blocks.set(id(20),[]);s.blocks.get(id(11))!.push(s.block(30,11,"child_page",{title:"Deep note"}));
    await syncStudyChanges(store,s.source(),[id(20),id(11)]);s.calls.length=0;
    assert.deepEqual((await published.getCourseTree(id(10)))!.nodes.map(n=>n.id),[id(21)]);
    assert.equal((await published.getCourseTree(id(11)))!.nodes.some(n=>n.id===id(30)),true);
    assert.equal(await published.get("study-note",id(20)),null);assert.equal(s.calls.length,0);
    await db.query("SELECT nb_v2_api.set_denied($1,true)",[id(11)]);
    assert.equal(await published.getCourseTree(id(11)),null);
    assert.equal(await published.get("study-note",id(30)),null);
    assert.equal(s.calls.length,0);
  }finally{await db.close();}
});
