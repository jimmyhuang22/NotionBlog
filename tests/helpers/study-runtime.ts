import { randomUUID } from "node:crypto";
import { fixtureItems } from "../../fixtures/content.ts";
import { prepareStudyDelta, type StudyCheckpoint, type StudyChangeSource, type StudyEntry } from "../../src/server/notion/study-incremental.ts";
import { preparePublicationDelta } from "../../src/server/database/incremental-publication.ts";
import { WEBSITE_SCHEMA_DIGEST } from "../../contracts/website-sync.ts";
export const studyId=(n:number)=>n.toString(16).padStart(32,"0");
export function studyFixture(){
  const course=structuredClone(fixtureItems.course[0]),note=structuredClone(fixtureItems["study-note"][0]);
  Object.assign(course,{id:studyId(1),slug:studyId(1),href:`/study/${studyId(1)}`,title:"Course A",cover:null});
  Object.assign(note,{id:studyId(2),slug:studyId(2),courseId:course.id,parentId:null,breadcrumbs:[],title:"Note A",href:`/study/${course.id}/notes/${studyId(2)}`,cover:null});
  const entries:StudyEntry[]=[course,note].map((item,ordinal)=>({override:null,position:item.kind==="course"?null:0,record:{
    detail:{item,document:{blocks:[{id:"body",type:"paragraph",text:[{text:"Old body"}]}],toc:[],completeness:"complete"}},
    evidence:{sourceKey:item.kind==="course"?"courses":"notes",dataSourceId:studyId(10),databaseParentId:null,courseId:item.kind==="course"?null:course.id,parentId:item.kind==="course"?null:course.id,ordinal:item.kind==="course"?0:ordinal-1},
  }}));
  const checkpoint:StudyCheckpoint={version:`${randomUUID()}:0`,sourceDigest:"a".repeat(64),entries};
  const current=new Map(entries.map(e=>[e.record.detail.item.id,structuredClone(e)]));let reads=0;
  const source:StudyChangeSource={sourceDigest:checkpoint.sourceDigest,read:async(id,options)=>{
    reads++;const e=current.get(id);if(!e)throw Error("Unknown source");
    return{state:"active",entry:structuredClone(e),ancestors:e.record.evidence.parentId?[e.record.evidence.parentId]:[],
      ...(options.children?{children:[...current.values()].filter(child=>child.record.evidence.parentId===id).map((child,position)=>({id:child.record.detail.item.id,position,updatedAt:child.record.detail.item.updatedAt}))}:{}),
    };
  }};
  const state={publicationRevision:checkpoint.version,configDigest:checkpoint.sourceDigest,schemaDigest:WEBSITE_SCHEMA_DIGEST,policyEpoch:"0"};
  return{checkpoint,current,source,state,reads:()=>reads};
}
export async function preparedStudyFixture(){
  const f=studyFixture();f.current.get(studyId(2))!.record.detail.document!.blocks=[];
  const study=await prepareStudyDelta(f.checkpoint,[studyId(2)],f.source);
  const publication=preparePublicationDelta({expectedRevision:f.checkpoint.version,configDigest:f.checkpoint.sourceDigest,upserts:study.upserts.map(e=>e.record),withdrawals:[],media:[]});
  return{...f,study,publication,operationId:randomUUID(),nextVersion:`${randomUUID()}:1`};
}
