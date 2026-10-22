import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp,realpath,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureItems } from "../fixtures/content.ts";
import { mediaIdentity } from "../src/server/database/website-validation.ts";
import { createStudyDomainPort,type StudyDomainOptions } from "../scripts/website-incremental-sync/study-domain.ts";
import { openStudyCheckpoint } from "../scripts/website-incremental-sync/study-checkpoint.ts";
import { studyFixture,studyId } from "./helpers/study-runtime.ts";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { WEBSITE_SCHEMA_DIGEST } from "../contracts/website-sync.ts";
import { publicationWriter } from "../src/server/database/publication.ts";
import { createIncrementalPublisher,readPublicationState } from "../src/server/database/incremental-publication.ts";
import { readPublishedRecord,verifyPublishedDelta } from "../src/server/database/incremental-reader.ts";
import { installPublication } from "../scripts/website-sync/publication-migration.ts";
import { installIncrementalPublication } from "../scripts/website-sync/incremental-migration.ts";
import { installIncrementalReader } from "../scripts/website-sync/incremental-reader-migration.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";
import studyProtocol from "../database/website-study-protocol.json" with {type:"json"};
async function setup(){
  const f=studyFixture(),directory=await realpath(await mkdtemp(join(tmpdir(),"study-domain-")));
  const store=await openStudyCheckpoint(directory,f.checkpoint.sourceDigest);store.initialize(f.checkpoint,{...f.state,readerVerified:true});
  let links=0,assets=0,verifications=0;
  const options:StudyDomainOptions={store,sourceKeys:["courses","notes"],assertPreparing:()=>{},source:()=>f.source,verify:async()=>{verifications++;return true;},
    incomingLinks:async()=>{links++;return{records:[],...f.state,verified:true};},assets:async()=>{assets++;return{media:[],verified:true};}};
  const ticket={operationId:randomUUID(),sourceKey:"notes",pageKey:studyId(2)},signal=new AbortController().signal;
  return{...f,store,options,ticket,signal,counts:()=>({links,assets,verifications}),close:async()=>{store.close();await rm(directory,{recursive:true,force:true});}};
}
test("study preparation persists next state before submit and installs after one independent verification",async()=>{
  const s=await setup();try{
    s.current.get(studyId(2))!.record.detail.document!.blocks=[];const port=createStudyDomainPort(s.options);
    const p=await port.prepare(s.ticket,s.state,s.signal);assert.equal(p.outcome,"prepared");if(p.outcome!=="prepared")return;
    assert.deepEqual(s.store.load(),s.checkpoint);
    const receipt={operationId:s.ticket.operationId,payloadDigest:p.delta.payloadDigest,publicationRevision:`${randomUUID()}:1`,committed:true as const};
    await assert.rejects(port.finalize(receipt,s.signal),{message:"STUDY_READER_UNVERIFIED"});
    assert.equal(await port.verify(receipt,s.signal),true);await port.finalize(receipt,s.signal);
    assert.deepEqual(s.store.load().entries[1].record.detail.document!.blocks,[]);assert.equal(s.counts().verifications,1);
  }finally{await s.close();}
});
test("a restarted domain recovers saved next state without Notion, assets or preparation",async()=>{
  const s=await setup();try{
    s.current.get(studyId(2))!.record.detail.document!.blocks=[];const p=await createStudyDomainPort(s.options).prepare(s.ticket,s.state,s.signal);assert.equal(p.outcome,"prepared");if(p.outcome!=="prepared")return;
    const calls=s.reads(),receipt={operationId:s.ticket.operationId,payloadDigest:p.delta.payloadDigest,publicationRevision:`${randomUUID()}:1`,committed:true as const};
    const failed=createStudyDomainPort({...s.options,verify:async()=>false});assert.equal(await failed.verify(receipt,s.signal),false);
    await assert.rejects(failed.finalize(receipt,s.signal));assert.equal(s.store.load().version,s.checkpoint.version);
    const recovered=createStudyDomainPort({...s.options,source:()=>assert.fail("Recovery reread Notion"),assets:async()=>assert.fail("Recovery prepared assets")});
    assert.equal(await recovered.verify(receipt,s.signal),true);await recovered.finalize(receipt,s.signal);
    // A crash after the local transaction but before queue ack repeats only proof.
    const again=createStudyDomainPort(s.options);assert.equal(await again.verify(receipt,s.signal),true);await again.finalize(receipt,s.signal);
    assert.equal(s.reads(),calls);assert.equal(s.counts().assets,0);
  }finally{await s.close();}
});
test("unchanged signals and wrong source or publication scope never stage or prepare unrelated dependencies",async()=>{
  const s=await setup();try{
    const port=createStudyDomainPort(s.options);
    assert.deepEqual(await port.prepare({...s.ticket,sourceKey:"other"},s.state,s.signal),{outcome:"review",code:"STUDY_SOURCE_MISMATCH"});assert.equal(s.reads(),0);
    assert.deepEqual(await port.prepare(s.ticket,{...s.state,publicationRevision:`${randomUUID()}:3`},s.signal),{outcome:"review",code:"STUDY_CHECKPOINT_VERSION_CHANGED"});assert.equal(s.reads(),0);
    assert.deepEqual(await port.prepare(s.ticket,s.state,s.signal),{outcome:"unchanged"});assert.deepEqual(s.counts(),{links:0,assets:0,verifications:0});
  }finally{await s.close();}
});
test("renames require verified non-study incoming links from the same publication and include their updates",async()=>{
  const s=await setup();try{
    s.current.get(studyId(2))!.record.detail.item.title="Renamed note";
    const bad=createStudyDomainPort({...s.options,incomingLinks:async()=>({records:[],...s.state,publicationRevision:`${randomUUID()}:7`,verified:true})});
    assert.deepEqual(await bad.prepare(s.ticket,s.state,s.signal),{outcome:"review",code:"STUDY_LINK_CACHE_UNVERIFIED"});
    const post=structuredClone(fixtureItems.post[0]);post.cover=null;
    const record={detail:{item:post,document:{blocks:[],toc:[],completeness:"complete" as const}},evidence:{sourceKey:"posts",dataSourceId:studyId(50),databaseParentId:null,courseId:null,parentId:null,ordinal:0}};
    const port=createStudyDomainPort({...s.options,incomingLinks:async changes=>{assert.equal(changes[0].current!.title,"Renamed note");return{records:[record],...s.state,verified:true};}});
    const p=await port.prepare(s.ticket,s.state,s.signal);assert.equal(p.outcome,"prepared");if(p.outcome==="prepared")assert.deepEqual(p.delta.upserts.map(r=>r.detail.item.id),[studyId(2),post.id]);
  }finally{await s.close();}
});
test("cached image references require matching descriptors while missing assets remain pending",async()=>{
  const s=await setup();try{
    const sha="a".repeat(64),asset=mediaIdentity(studyId(2),"image",sha);
    s.current.get(studyId(2))!.record.detail.document!.blocks=[{id:"image",type:"image",image:{id:asset,src:`/media/v2/${asset}`,alt:"Cached original",width:1,height:1},caption:[]}];
    const pending=await createStudyDomainPort(s.options).prepare(s.ticket,s.state,s.signal);assert.deepEqual(pending,{outcome:"retry",code:"STUDY_MEDIA_PENDING"});
    const media={assetId:asset,ownerPageId:studyId(2),objectKey:`sha256/${sha}`,sha256:sha,byteSize:42,mime:"image/png" as const,width:1,height:1};
    const port=createStudyDomainPort({...s.options,assets:async()=>({media:[media],verified:true})});const p=await port.prepare(s.ticket,s.state,s.signal);
    assert.equal(p.outcome,"prepared");if(p.outcome==="prepared")assert.deepEqual(p.delta.media,[media]);
  }finally{await s.close();}
});
test("confirmed archival carries source evidence while policy denial requires separate reconciliation",async()=>{
  const s=await setup();try{
    const archived=createStudyDomainPort({...s.options,source:()=>({...s.source,read:async()=>({state:"withdrawn",reason:"archived"})})});
    const p=await archived.prepare(s.ticket,s.state,s.signal);assert.equal(p.outcome,"prepared");if(p.outcome==="prepared")assert.deepEqual(p.delta.withdrawals,[{id:studyId(2),sourceKey:"notes",reason:"archived"}]);
    const denied=createStudyDomainPort({...s.options,source:()=>({...s.source,read:async()=>({state:"withdrawn",reason:"denied"})})});
    assert.deepEqual(await denied.prepare({...s.ticket,operationId:randomUUID()},s.state,s.signal),{outcome:"review",code:"STUDY_POLICY_RECONCILIATION_REQUIRED"});
  }finally{await s.close();}
});
test("cancellation cannot stage late preparation or trigger additional page reads",async()=>{
  const s=await setup();try{
    const controller=new AbortController();let calls=0;
    const port=createStudyDomainPort({...s.options,source:()=>({...s.source,read:async()=>{calls++;controller.abort();return{state:"withdrawn",reason:"archived"};}})});
    await assert.rejects(port.prepare(s.ticket,s.state,controller.signal));assert.equal(calls,1);assert.deepEqual(s.store.load(),s.checkpoint);
  }finally{await s.close();}
});
test("oversized asset dependencies stop before resolving or staging assets",async()=>{
  const s=await setup();try{
    s.current.get(studyId(2))!.record.detail.document!.blocks=Array.from({length:101},(_,i)=>{const asset=mediaIdentity(studyId(2),`image-${i}`,"a".repeat(64));return{id:`image-${i}`,type:"image",image:{id:asset,src:`/media/v2/${asset}`,alt:"Cached image",width:1,height:1},caption:[]};});
    assert.deepEqual(await createStudyDomainPort(s.options).prepare(s.ticket,s.state,s.signal),{outcome:"review",code:"STUDY_DELTA_BUDGET_REACHED"});assert.equal(s.counts().assets,0);
  }finally{await s.close();}
});
test("actual writer, independent reader and restarted SQLite checkpoint recover a committed study update with cached media",async()=>{
  const f=studyFixture(),db=await PGlite.create(),directory=await realpath(await mkdtemp(join(tmpdir(),"study-domain-sql-")));
  let store=await openStudyCheckpoint(directory,f.checkpoint.sourceDigest);
  try{
    await db.exec(await readFile(new URL("../database/website-migrations/001_website.sql",import.meta.url),"utf8"));
    await db.query("UPDATE nb_v2.state SET schema_digest=$1",[WEBSITE_SCHEMA_DIGEST]);
    await db.exec(await readFile(new URL("../database/website-study-migrations/001_automatic_study.sql",import.meta.url),"utf8"));
    await db.query("UPDATE nb_v2.migrations SET digest=$1 WHERE version=$2",[studyProtocol.migration.sha256,studyProtocol.migration.version]);
    const owner:SqlExecutor={query:async<T>(sql:string,values?:unknown[])=>{if(sql.startsWith("--")){await db.exec(sql);return{rows:[] as T[]};}return db.query<T>(sql,values);}};
    await installPublication(owner);await installIncrementalPublication(owner);await installIncrementalReader(owner);
    const role=(name:string):SqlExecutor=>({query:<T>(sql:string,values?:unknown[])=>db.transaction(async tx=>{await tx.exec(`SET LOCAL ROLE ${name}`);return tx.query<T>(sql,values);})});
    const reader=role("nb_reader"),writer=role("nb_writer"),publisher=createIncrementalPublisher(writer);
    const sources=[{key:"courses",kind:"course",mode:"all",dataSourceId:studyId(10),databaseParentId:null,pageId:null},
      {key:"notes",kind:"study-note",mode:"course-descendants",dataSourceId:studyId(10),databaseParentId:null,pageId:null}];
    await db.query("SELECT nb_v2_api.configure_policy($1,600,$2::jsonb,'[]')",[f.checkpoint.sourceDigest,JSON.stringify(sources)]);
    const sha="a".repeat(64),asset=mediaIdentity(studyId(2),"image",sha),media={assetId:asset,ownerPageId:studyId(2),objectKey:`sha256/${sha}`,sha256:sha,byteSize:42,mime:"image/png" as const,width:1,height:1};
    const image={id:"image",type:"image" as const,image:{id:asset,src:`/media/v2/${asset}`,alt:"Cached original",width:1,height:1},caption:[]};
    f.checkpoint.entries[1].record.detail.document!.blocks.push(image);f.current.get(studyId(2))!.record.detail.document!.blocks.push(image);
    const full=publicationWriter(writer,"published");await full.verifyStudy!();const lease=await full.begin(randomUUID(),f.checkpoint.sourceDigest);
    await full.stage(lease,f.checkpoint.entries.map(e=>e.record),[media]);await full.promote(lease,{records:2,media:1,complete:true});
    const state=await readPublicationState(reader);f.checkpoint.version=state.publicationRevision;
    for(const e of f.checkpoint.entries){const found=await readPublishedRecord(reader,{pageId:e.record.detail.item.id,sourceKey:e.record.evidence.sourceKey,expectedRevision:state.publicationRevision});assert.deepEqual(found!.record,e.record);}
    store.initialize(f.checkpoint,{...state,readerVerified:true});
    f.current.get(studyId(2))!.record.detail.document!.blocks[0]={id:"body",type:"paragraph",text:[{text:"New body"}]};
    const options:StudyDomainOptions={store,sourceKeys:["courses","notes"],assertPreparing:()=>{},source:()=>f.source,verify:(r,s)=>verifyPublishedDelta(reader,r,s),
      incomingLinks:async()=>({records:[],...state,verified:true}),assets:async()=>({media:[media],verified:true})};
    const ticket={operationId:randomUUID(),sourceKey:"notes",pageKey:studyId(2)},signal=new AbortController().signal;
    const prepared=await createStudyDomainPort(options).prepare(ticket,state,signal);assert.equal(prepared.outcome,"prepared");if(prepared.outcome!=="prepared")return;
    const receipt=await publisher.publish(ticket.operationId,prepared.delta);const calls=f.reads();
    // Drop the transport reply and recreate the domain before local installation.
    assert.equal(store.load().version,state.publicationRevision);store.close();store=await openStudyCheckpoint(directory,f.checkpoint.sourceDigest);
    const restored=await publisher.lookup(ticket.operationId,prepared.delta.payloadDigest);assert.deepEqual(restored,receipt);assert.ok(restored);
    const recovered=createStudyDomainPort({...options,store,source:()=>assert.fail("Recovery accessed Notion"),assets:async()=>assert.fail("Recovery accessed objects")});
    assert.equal(await recovered.verify(restored,signal),true);await recovered.finalize(restored,signal);
    assert.equal(store.load().version,receipt.publicationRevision);assert.equal(f.reads(),calls);
    const actual=await readPublishedRecord(reader,{pageId:studyId(2),sourceKey:"notes",expectedRevision:receipt.publicationRevision});
    assert.deepEqual(actual!.record,store.load().entries[1].record);assert.deepEqual(actual!.media,[media]);
    assert.equal((await readPublishedRecord(reader,{pageId:studyId(1),sourceKey:"courses",expectedRevision:receipt.publicationRevision}))!.record.detail.item.title,"Course A");
  }finally{store.close();await db.close();await rm(directory,{recursive:true,force:true});}
});
test("expired queue tickets cannot stage prepared state even after source preparation succeeds",async()=>{
  const s=await setup();try{
    s.current.get(studyId(2))!.record.detail.document!.blocks=[];
    const port=createStudyDomainPort({...s.options,assertPreparing:()=>{throw Error("Expired queue generation");}});
    assert.deepEqual(await port.prepare(s.ticket,s.state,s.signal),{outcome:"retry",code:"STUDY_PREPARATION_UNAVAILABLE"});
    assert.deepEqual(s.store.load(),s.checkpoint);
    assert.equal(s.store.ownsOperation(s.ticket.operationId,"a".repeat(64)),false);
  }finally{await s.close();}
});
test("queue terminal hooks retire staged or unstaged attempts idempotently and forbid unknown dispositions",async()=>{
  const s=await setup();try{
    s.current.get(studyId(2))!.record.detail.document!.blocks=[];
    const port=createStudyDomainPort(s.options),p=await port.prepare(s.ticket,s.state,s.signal);assert.equal(p.outcome,"prepared");if(p.outcome!=="prepared")return;
    const proof={ticket:s.ticket,disposition:"never_submitted" as const,payloadDigest:null};
    await port.retire(proof,s.signal);await port.retire(proof,s.signal);
    await port.retire({...proof,ticket:{...s.ticket,operationId:randomUUID()}},s.signal);
    assert.throws(()=>s.store.install({operationId:s.ticket.operationId,payloadDigest:p.delta.payloadDigest,publicationRevision:`${randomUUID()}:1`,readerVerified:true}),{message:"STUDY_OPERATION_RETIRED"});
    await assert.rejects(port.retire({...proof,disposition:"unknown" as never},s.signal));
  }finally{await s.close();}
});
