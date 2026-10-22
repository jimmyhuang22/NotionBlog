import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, chmod, stat, symlink, link } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { openStudyCheckpoint } from "../scripts/website-incremental-sync/study-checkpoint.ts";
import { preparedStudyFixture } from "./helpers/study-runtime.ts";
import { randomUUID } from "node:crypto";
import { fixtureItems } from "../fixtures/content.ts";
import { preparePublicationDelta } from "../src/server/database/incremental-publication.ts";
import { configDigest } from "../src/server/database/website-validation.ts";
import { prepareStudyDelta } from "../src/server/notion/study-incremental.ts";
import { studyId } from "./helpers/study-runtime.ts";
const code=(s:string)=>(e:unknown)=>!!e&&typeof e==="object"&&"code" in e&&e.code===s;
async function directory(){return realpath(await mkdtemp(join(tmpdir(),"study-checkpoint-")));}
test("private checkpoint persists staged next state and installs only an independently verified matching receipt",async()=>{
  const dir=await directory(),f=await preparedStudyFixture();let store=await openStudyCheckpoint(dir,f.checkpoint.sourceDigest);
  try{
    store.initialize(f.checkpoint,{...f.state,readerVerified:true});store.stage(f.operationId,f.study,f.publication);
    assert.deepEqual(store.load(),f.checkpoint);store.close();store=await openStudyCheckpoint(dir,f.checkpoint.sourceDigest);
    const receipt={operationId:f.operationId,payloadDigest:f.publication.payloadDigest,publicationRevision:f.nextVersion,readerVerified:true as const};
    assert.throws(()=>store.install({...receipt,readerVerified:false as never}),code("STUDY_READER_UNVERIFIED"));
    assert.throws(()=>store.install({...receipt,payloadDigest:"b".repeat(64)}),code("STUDY_OPERATION_CONFLICT"));
    assert.throws(()=>store.install({...receipt,publicationRevision:receipt.publicationRevision.split(":")[0]+":"+"1".repeat(161)}),code("STUDY_CHECKPOINT_INVALID"));
    assert.equal(store.install(receipt),"installed");assert.equal(store.install(receipt),"unchanged");
    assert.equal(store.load().version,f.nextVersion);assert.deepEqual(store.load().entries[1].record.detail.document!.blocks,[]);
    assert.equal((await stat(join(dir,"study.sqlite"))).mode&0o077,0);
  }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
test("stage is immutable, baseline is explicit and a stale next state cannot overwrite a later checkpoint",async()=>{
  const dir=await directory(),f=await preparedStudyFixture(),store=await openStudyCheckpoint(dir,f.checkpoint.sourceDigest);
  try{
    assert.throws(()=>store.load(),code("STUDY_CHECKPOINT_MISSING"));
    assert.throws(()=>store.initialize(f.checkpoint,{...f.state,readerVerified:false as never}),code("STUDY_READER_UNVERIFIED"));
    store.initialize(f.checkpoint,{...f.state,readerVerified:true});store.initialize(f.checkpoint,{...f.state,readerVerified:true});
    store.stage(f.operationId,f.study,f.publication);store.stage(f.operationId,f.study,f.publication);
    const changed=structuredClone(f.publication);changed.upserts[0].detail.item.title="Mismatched delta";
    assert.throws(()=>store.stage(f.operationId,f.study,changed),code("STUDY_PREPARED_DELTA_INVALID"));
    store.install({operationId:f.operationId,payloadDigest:f.publication.payloadDigest,publicationRevision:f.nextVersion,readerVerified:true});
    assert.throws(()=>store.stage(f.operationId,f.study,f.publication),code("STUDY_CHECKPOINT_VERSION_CHANGED"));
    assert.throws(()=>store.install({operationId:f.operationId,payloadDigest:f.publication.payloadDigest,publicationRevision:f.checkpoint.version,readerVerified:true}),code("STUDY_CHECKPOINT_VERSION_CHANGED"));
  }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
test("checkpoint scope and private file ownership reject mismatched, permissive, symlink and hardlink state",async()=>{
  const dir=await directory(),f=await preparedStudyFixture();let store=await openStudyCheckpoint(dir,f.checkpoint.sourceDigest);store.close();
  try{
    await assert.rejects(openStudyCheckpoint(dir,"b".repeat(64)),code("STUDY_CHECKPOINT_SCOPE_MISMATCH"));
    await chmod(join(dir,"study.sqlite"),0o644);await assert.rejects(openStudyCheckpoint(dir,f.checkpoint.sourceDigest),code("STUDY_PRIVATE_STATE_INVALID"));await chmod(join(dir,"study.sqlite"),0o600);
    await link(join(dir,"study.sqlite"),join(dir,"duplicate.sqlite"));await assert.rejects(openStudyCheckpoint(dir,f.checkpoint.sourceDigest),code("STUDY_PRIVATE_STATE_INVALID"));await rm(join(dir,"duplicate.sqlite"));
    await symlink(join(dir,"study.sqlite"),join(dir,"study.sqlite-journal"));await assert.rejects(openStudyCheckpoint(dir,f.checkpoint.sourceDigest),code("STUDY_PRIVATE_STATE_INVALID"));
  }finally{await rm(dir,{recursive:true,force:true});}
});
test("process exit after local installation recovers idempotently without repeating preparation",async()=>{
  const dir=await directory(),f=await preparedStudyFixture();let store=await openStudyCheckpoint(dir,f.checkpoint.sourceDigest);
  try{
    store.initialize(f.checkpoint,{...f.state,readerVerified:true});store.stage(f.operationId,f.study,f.publication);store.close();
    const receipt={operationId:f.operationId,payloadDigest:f.publication.payloadDigest,publicationRevision:f.nextVersion,readerVerified:true as const};
    const module=new URL("../scripts/website-incremental-sync/study-checkpoint.ts",import.meta.url).href;
    const child=spawnSync(process.execPath,["--input-type=module","--eval",`import {openStudyCheckpoint} from ${JSON.stringify(module)}; const s=await openStudyCheckpoint(process.env.STUDY_TEST_DIRECTORY,process.env.STUDY_TEST_DIGEST); s.install(JSON.parse(process.env.STUDY_TEST_RECEIPT)); process.exit(17);`],
      {env:{...process.env,STUDY_TEST_DIRECTORY:dir,STUDY_TEST_DIGEST:f.checkpoint.sourceDigest,STUDY_TEST_RECEIPT:JSON.stringify(receipt)},encoding:"utf8",timeout:10000});
    assert.equal(child.status,17,child.stderr);store=await openStudyCheckpoint(dir,f.checkpoint.sourceDigest);
    assert.equal(store.install(receipt),"unchanged");assert.equal(store.load().version,f.nextVersion);
  }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
test("other-domain receipts advance global version and preserve study state; study metadata still requires its own engine",async()=>{
  const dir=await directory(),f=await preparedStudyFixture(),store=await openStudyCheckpoint(dir,f.checkpoint.sourceDigest);
  try{
    store.initialize(f.checkpoint,{...f.state,readerVerified:true});
    const post=structuredClone(fixtureItems.post[0]);post.cover=null;
    const record={detail:{item:post,document:{blocks:[],toc:[],completeness:"complete" as const}},evidence:{sourceKey:"posts",dataSourceId:"fictional-posts",databaseParentId:null,courseId:null,parentId:null,ordinal:0}};
    const delta=preparePublicationDelta({expectedRevision:f.checkpoint.version,configDigest:f.checkpoint.sourceDigest,upserts:[record],media:[],withdrawals:[]});
    const operationId=randomUUID();store.stageOtherPublication(operationId,delta);
    assert.equal(store.ownsOperation(operationId,delta.payloadDigest),true);
    assert.equal(store.ownsOperation(randomUUID(),delta.payloadDigest),false);
    assert.equal(store.load().version,f.checkpoint.version);
    store.install({operationId,payloadDigest:delta.payloadDigest,publicationRevision:f.nextVersion,readerVerified:true});
    assert.deepEqual(store.load().entries,f.checkpoint.entries);assert.equal(store.load().version,f.nextVersion);
    const renamed=structuredClone(f.checkpoint.entries[1].record);renamed.detail.item.title="Unqualified study rename";
    const invalid=preparePublicationDelta({expectedRevision:f.nextVersion,configDigest:f.checkpoint.sourceDigest,upserts:[renamed],media:[],withdrawals:[]});
    assert.throws(()=>store.stageOtherPublication(randomUUID(),invalid),code("STUDY_EXTERNAL_DELTA_REQUIRES_RECONCILIATION"));
  }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
test("staged private state must match SQL study updates and the full confirmed withdrawal subtree",async()=>{
  const dir=await directory(),f=await preparedStudyFixture(),store=await openStudyCheckpoint(dir,f.checkpoint.sourceDigest);
  try{
    store.initialize(f.checkpoint,{...f.state,readerVerified:true});
    const extra=structuredClone(f.checkpoint.entries[0].record);extra.detail.item.title="Extra course rename";
    const mixed=preparePublicationDelta({...f.publication,upserts:[...f.publication.upserts,extra]});
    assert.throws(()=>store.stage(f.operationId,f.study,mixed),code("STUDY_PREPARED_DELTA_INVALID"));
    const withdrawal=await prepareStudyDelta(f.checkpoint,[studyId(2)],{...f.source,read:async()=>({state:"withdrawn",reason:"archived"})});
    withdrawal.withdrawals=[];const {idempotencyKey:_key,reads:_reads,...payload}=withdrawal;withdrawal.idempotencyKey=configDigest(payload);
    const published=preparePublicationDelta({expectedRevision:f.checkpoint.version,configDigest:f.checkpoint.sourceDigest,upserts:[],media:[],withdrawals:[{id:studyId(2),sourceKey:"notes",reason:"archived"}]});
    assert.throws(()=>store.stage(randomUUID(),withdrawal,published),code("STUDY_PREPARED_DELTA_INVALID"));assert.deepEqual(store.load(),f.checkpoint);
  }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
test("pending state is bounded and retirement needs a definitive queue proof, never a missing lookup",async()=>{
  const dir=await directory(),f=await preparedStudyFixture(),store=await openStudyCheckpoint(dir,f.checkpoint.sourceDigest);
  try{
    store.initialize(f.checkpoint,{...f.state,readerVerified:true});
    const operations=Array.from({length:9},()=>randomUUID());for(const id of operations.slice(0,8))store.stage(id,f.study,f.publication);
    assert.throws(()=>store.stage(operations[8],f.study,f.publication),code("STUDY_CHECKPOINT_BUDGET_REACHED"));
    assert.throws(()=>store.retirePrepared(operations[0],f.publication.payloadDigest,{neverSubmitted:false as never}),code("STUDY_OPERATION_UNCONFIRMED"));
    store.retirePrepared(operations[0],f.publication.payloadDigest,{definitivelyRejected:true});store.stage(operations[8],f.study,f.publication);
    assert.throws(()=>store.install({operationId:operations[0],payloadDigest:f.publication.payloadDigest,publicationRevision:f.nextVersion,readerVerified:true}),code("STUDY_OPERATION_RETIRED"));
    assert.deepEqual(store.load(),f.checkpoint);
  }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
