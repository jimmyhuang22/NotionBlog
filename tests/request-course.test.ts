import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { requestStudyRepository } from "../src/lib/content/request-study.ts";
import { createMockRepository } from "../adapters/mock-repository.ts";

test("course metadata deduplicates in a real RSC render and rechecks a later render after withdrawal",async()=>{
  const execute=promisify(execFile);
  const {stdout}=await execute(process.execPath,["--conditions=react-server","--input-type=module","-e",`
    import React from 'react';
    import {renderToReadableStream} from 'next/dist/compiled/react-server-dom-webpack/server.node.js';
    import {requestCourseMetadata} from './src/lib/content/request-course.ts';
    let calls=0,current={id:'synthetic-public-course'};
    const repository={getCourseMetadata:async()=>{calls++;return current;}};
    async function Child(){return React.createElement('p',null,JSON.stringify(await requestCourseMetadata(repository,'course')));}
    const render=async()=>new Response(await renderToReadableStream(React.createElement(React.Fragment,null,React.createElement(Child),React.createElement(Child)))).text();
    const first=await render(),firstCalls=calls;
    current=null;const second=await render();
    console.log(JSON.stringify({firstCalls,calls,firstVisible:first.includes('synthetic-public-course'),secondWithdrawn:!second.includes('synthetic-public-course')}));
  `],{cwd:new URL("../",import.meta.url)});
  assert.deepEqual(JSON.parse(stdout.trim()),{firstCalls:1,calls:2,firstVisible:true,secondWithdrawn:true});
});

test("a render batch pairs course metadata and note body, but never retains a settled qualification",async()=>{
  const raw=createMockRepository(),owner=(await raw.getCourseMetadata!("demo101"))!,note=(await raw.list("study-note",{limit:50})).items.find(item=>item.courseId===owner.id)!;
  const detail=await raw.get("study-note",note.slug);let batches=0,metadata=0,details=0,withdrawn=false;
  const originalGet=raw.get.bind(raw),originalMetadata=raw.getCourseMetadata!.bind(raw);
  raw.getCourseMetadata=async slug=>{metadata++;return withdrawn?null:originalMetadata(slug);};
  raw.get=(kind,slug)=>{details++;return originalGet(kind,slug);};
  raw.readStudyNote=async()=>{batches++;return{course:owner,note:detail};};
  const request=requestStudyRepository(raw);
  const values=await Promise.all([request.getCourseMetadata!(owner.slug),request.get("study-note",note.slug)]);
  assert.deepEqual(values,[owner,detail]);assert.equal(batches,1);assert.equal(metadata,0);assert.equal(details,0);
  withdrawn=true;assert.equal(await request.getCourseMetadata!(owner.slug),null);assert.equal(metadata,1);
  raw.readStudyNote=async()=>({course:owner,note:null});
  const separate=await Promise.all([request.getCourseMetadata!(owner.slug),request.get("study-note",note.slug)]);
  assert.deepEqual(separate[1],detail);assert.equal(details,1);
  raw.readStudyNote=async()=>{throw Error("synthetic-query-error");};
  const failed=await Promise.allSettled([request.getCourseMetadata!(owner.slug),request.get("study-note",note.slug)]);
  assert.ok(failed.every(result=>result.status==="rejected"));
  const fresh=requestStudyRepository(raw);
  const full=await fresh.get("course",owner.slug),metadataBefore=metadata;
  assert.deepEqual(await fresh.getCourseMetadata!(owner.slug),full?.item??null);assert.equal(metadata,metadataBefore);
  const next=requestStudyRepository(raw);assert.equal(await next.getCourseMetadata!(owner.slug),null);assert.equal(metadata,metadataBefore+1);
});
