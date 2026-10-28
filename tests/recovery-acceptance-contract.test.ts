import test from 'node:test';
import assert from 'node:assert/strict';
import {hostFixture} from './helpers/incremental-host.ts';
import {validateWebsiteRecord} from '../src/server/database/website-validation.ts';
test('recovery read validators accept nullable courses and marked mentions without accepting malformed markers',async()=>{
 const f=await hostFixture();try{
  const rows=f.artifact.collection.records;
  const course=structuredClone(rows.find(r=>r.detail.item.kind==='course')!);
  assert.ok(course);validateWebsiteRecord(course);
  (course.detail.item as any).code=null;validateWebsiteRecord(course);
  const note=structuredClone(rows.find(r=>r.detail.item.kind==='study-note')!);
  assert.ok(note.detail.document);
  const block={id:'fixture-marked-mention',type:'paragraph',text:[{text:'Unavailable',pageMention:true,link:{kind:'unavailable'}}]};
  (note.detail.document!.blocks as any[]).push(block);validateWebsiteRecord(note);
  for(const patch of [{pageMention:false},{equation:true},{link:{kind:'external',url:'https://example.com'}},{unexpected:true}]){
   const invalid=structuredClone(note);Object.assign((invalid.detail.document!.blocks.at(-1) as any).text[0],patch);assert.throws(()=>validateWebsiteRecord(invalid));
  }
 }finally{await f.close();}
});
