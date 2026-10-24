import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { hash } from "../scripts/social-sync/model.ts";
import { browserTimeoutDiagnostic } from "../scripts/social-sync/xiaohongshu-browser-recovery.ts";

const target={publicationId:"1".repeat(24),accountId:"2".repeat(24),url:"https://www.xiaohongshu.com/explore/"+"1".repeat(24)};
const {captureJob}=await import(fileURLToPath(new URL("../scripts/social-sync/browser/driver.js",import.meta.url)));
async function timeoutHarness(tab:object,result:unknown,leaseMs=60000){
  let clock=Date.now(),scripts=0;const removed:number[]=[],job={id:"00000000-0000-0000-0000-000000000001",expiresAt:new Date(clock+leaseMs).toISOString(),targets:[target]};
  const api={tabs:{create:async()=>({id:7}),get:async()=>({url:target.url,...tab}),remove:async(id:number)=>{removed.push(id);}},scripting:{executeScript:async()=>{scripts++;return [{frameId:0,result}];}}};
  let error:any;try{await captureJob(api,job,{diagnostics:true,now:()=>clock,sleep:async(ms:number)=>{clock+=ms;}});}catch(e){error=e;}
  assert(error);assert.deepEqual(removed,[7]);assert.equal(error.diagnostic.targetDigest,hash(target.publicationId));
  assert(!JSON.stringify(error.diagnostic).includes(target.url));assert(!JSON.stringify(error.diagnostic).includes(target.publicationId));
  browserTimeoutDiagnostic(error.diagnostic,error.message,job);return {error,scripts,job};
}
test("timeout distinguishes page loading from an absent note state without retaining page data",async()=>{
  const load=await timeoutHarness({status:"loading",url:"about:blank"},null);assert.equal(load.error.message,"BROWSER_PAGE_LOAD_TIMEOUT");assert.equal(load.scripts,0);assert.equal(load.error.diagnostic.waitMs,20000);
  const state=await timeoutHarness({status:"complete"},{error:"NOTE_STATE_MISSING"});assert.equal(state.error.message,"BROWSER_NOTE_STATE_TIMEOUT");assert.equal(state.error.diagnostic.lastState,"NOTE_STATE_MISSING");assert.equal(state.scripts,20);
});
test("a frozen tab is reported without repeatedly dispatching scripts into it",async()=>{
  const r=await timeoutHarness({status:"complete",frozen:true,discarded:false},null);assert.equal(r.error.diagnostic.frozen,true);assert.equal(r.scripts,0);assert.equal(r.error.diagnostic.phase,"note-state");
});
test("lease exhaustion is distinct from the normal per-page wait",async()=>{
  const r=await timeoutHarness({status:"loading"},null,3000);assert.equal(r.error.message,"BROWSER_LEASE_EXPIRED");assert.equal(r.error.diagnostic.waitMs,3000);
});
test("an already expired diagnostic lease never opens a tab",async()=>{
  const job={id:"00000000-0000-0000-0000-000000000001",expiresAt:new Date(Date.now()-1000).toISOString(),targets:[target]};let opens=0;
  await assert.rejects(captureJob({tabs:{create:async()=>{opens++;}}},job,{diagnostics:true}), (e:any)=>{assert.equal(e.message,"BROWSER_LEASE_EXPIRED");assert.equal(e.diagnostic.polls,0);return true;});assert.equal(opens,0);
});
test("diagnostics reject extra URLs, foreign targets and incompatible timeout phases",async()=>{
  const r=await timeoutHarness({status:"loading",url:"about:blank"},null),d=r.error.diagnostic;
  for(const changed of [{...d,url:target.url},{...d,targetDigest:hash("foreign")},{...d,phase:"note-state"}])assert.throws(()=>browserTimeoutDiagnostic(changed,r.error.message,r.job),{code:"XHS_BROWSER_DIAGNOSTIC_INVALID"});
});

function readyFixture(){
  const clock={value:Date.now()},removed:number[]=[],injections:any[]=[],note={noteId:target.publicationId,user:{userId:target.accountId},type:"normal",title:"Example",
    time:null,lastUpdateTime:null,imageList:[],shareInfo:{unShare:false},interactInfo:{likedCount:"1",commentCount:"0",shareCount:"",collectedCount:"0"}};
  const job={id:"00000000-0000-0000-0000-000000000001",expiresAt:new Date(clock.value+60000).toISOString(),targets:[{...target,requireShareable:true}]};
  const page={status:"loading",url:target.url,frozen:false,discarded:false};
  const api={tabs:{create:async()=>({id:7}),get:async()=>page,remove:async(id:number)=>{removed.push(id);}},scripting:{executeScript:async(options:any)=>{
    injections.push(options);
    const result=runInNewContext(`(${options.func.toString()})(${JSON.stringify(options.args[0])})`,{
      window:{__INITIAL_STATE__:{note:{currentNoteId:target.publicationId,noteDetailMap:{[target.publicationId]:{note}}}}},
      location:{protocol:"https:",hostname:"www.xiaohongshu.com",pathname:new URL(target.url).pathname}});
    return [{frameId:0,result}];
  }}};
  const options={diagnostics:true,now:()=>clock.value,sleep:async(ms:number)=>{clock.value+=ms;}};
  return {clock,removed,injections,note,job,page,api,options};
}
test("an eligible note is captured while loading with immediate main-frame injection and unchanged share checks",async()=>{
  const f=readyFixture(),rows=await captureJob(f.api,f.job,f.options);
  assert.equal(rows.length,1);assert.equal(rows[0].note.noteId,target.publicationId);assert.deepEqual(f.removed,[7]);assert.equal(f.injections.length,1);
  assert.equal(f.injections[0].injectImmediately,true);assert.equal(f.injections[0].world,"MAIN");assert.equal(f.injections[0].args[0].requireShareable,true);
});
test("missing note state can be polled while loading and is diagnosed as note-state rather than page-load",async()=>{
  const r=await timeoutHarness({status:"loading"},{error:"NOTE_STATE_MISSING"});assert.equal(r.error.message,"BROWSER_NOTE_STATE_TIMEOUT");assert.equal(r.scripts,20);
  assert.equal(r.error.diagnostic.lastTabStatus,"loading");assert.equal(r.error.diagnostic.lastState,"NOTE_STATE_MISSING");
  const f=readyFixture(),execute=f.api.scripting.executeScript;let tries=0;
  f.api.scripting.executeScript=async o=>++tries===1?[{frameId:0,result:{error:"NOTE_STATE_MISSING"}}]:execute(o);
  assert.equal((await captureJob(f.api,f.job,f.options)).length,1);assert.equal(tries,2);assert.deepEqual(f.removed,[7]);
});
test("early capture still rejects foreign authors and non-shareable notes, and never injects into unrelated or inactive documents",async()=>{
  for(const code of ["IDENTITY_MISMATCH","SOURCE_VISIBILITY_UNKNOWN"]){const f=readyFixture();
    if(code==="IDENTITY_MISMATCH")f.note.user.userId="3".repeat(24);else f.note.shareInfo.unShare=true;
    await assert.rejects(captureJob(f.api,f.job,f.options),{message:code});assert.deepEqual(f.removed,[7]);assert.equal(f.injections.length,1);
  }
  for(const tab of [{status:"loading",url:"https://example.com/"},{status:"loading",frozen:true},{status:"loading",discarded:true}]){
    const r=await timeoutHarness(tab,null);assert.equal(r.scripts,0);
  }
  const f=readyFixture();f.page.status="complete";f.page.url="https://example.com/";
  await assert.rejects(captureJob(f.api,f.job,f.options),{message:"SOURCE_BLOCKED"});assert.equal(f.injections.length,0);assert.deepEqual(f.removed,[7]);
});
test("a stalled injected read is bounded by the lease and its late result cannot complete the job",async t=>{
  t.mock.timers.enable({apis:["Date","setTimeout"],now:Date.UTC(2026,0,1)});
  const f=readyFixture();f.job.expiresAt=new Date(Date.now()+80).toISOString();let resolveRead:(value:any)=>void=()=>{},injected:()=>void=()=>{};
  const started=new Promise<void>(resolve=>{injected=resolve;});
  f.api.scripting.executeScript=()=>new Promise(resolve=>{resolveRead=resolve;injected();});
  const expired=assert.rejects(captureJob(f.api,f.job,{diagnostics:true}),{message:"BROWSER_LEASE_EXPIRED"});await started;
  t.mock.timers.tick(79);await Promise.resolve();assert.deepEqual(f.removed,[]);
  t.mock.timers.tick(1);await expired;assert.deepEqual(f.removed,[7]);
  resolveRead([{frameId:0,result:{version:1}}]);await Promise.resolve();assert.deepEqual(f.removed,[7]);
  const late=readyFixture();late.api.scripting.executeScript=async()=>{late.clock.value+=20000;return [{frameId:0,result:{version:1}}];};
  await assert.rejects(captureJob(late.api,late.job,late.options),{message:"BROWSER_NOTE_STATE_TIMEOUT"});assert.deepEqual(late.removed,[7]);
  const lookup=readyFixture();lookup.api.tabs.get=async()=>{lookup.clock.value+=20000;return lookup.page;};
  await assert.rejects(captureJob(lookup.api,lookup.job,lookup.options),{message:"BROWSER_PAGE_LOAD_TIMEOUT"});assert.equal(lookup.injections.length,0);assert.deepEqual(lookup.removed,[7]);
});
test("legacy capture keeps its complete-page gate and does not opt into immediate injection",async()=>{
  const f=readyFixture();await assert.rejects(captureJob(f.api,f.job,{...f.options,diagnostics:false}),{message:"BROWSER_TIMEOUT"});assert.equal(f.injections.length,0);
  const complete=readyFixture();complete.page.status="complete";await captureJob(complete.api,complete.job,{...complete.options,diagnostics:false});
  assert.equal(Object.hasOwn(complete.injections[0],"injectImmediately"),false);
});
test("the exception background sends bounded diagnostics to the native pause without retrying capture",async()=>{
  const code=(await readFile(new URL("../scripts/social-sync/browser/background.js",import.meta.url),"utf8")).replace(/^import[^\n]+\n/gm,""),messages:any[]=[],session:Record<string,unknown>={};let captures=0;
  const diagnostic={version:1,jobId:"00000000-0000-0000-0000-000000000001",targetDigest:hash(target.publicationId),phase:"page-load",waitMs:20000,polls:20,lastTabStatus:"loading",frozen:null,discarded:null,lastState:null};
  const event={addListener:()=>{}},chrome={runtime:{lastError:null,onStartup:event,onInstalled:event,connectNative:()=>{let receiver:(v:unknown)=>void=()=>{};
    return {onMessage:{addListener:(fn:typeof receiver)=>{receiver=fn;},removeListener:()=>{}},onDisconnect:{addListener:()=>{},removeListener:()=>{}},disconnect:()=>{},postMessage:(m:any)=>{messages.push(m);queueMicrotask(()=>receiver(m.op==="settings"?{enabled:false}:m.op==="xiaohongshu-notes-start"?{job:{id:diagnostic.jobId}}:{status:"paused"}));}};}},
    storage:{session:{get:async()=>({...session}),set:async(o:object)=>Object.assign(session,o),remove:async(k:string)=>{delete session[k];}}},tabs:{},alarms:{clear:async()=>{},onAlarm:event},action:{setBadgeText:async()=>{},setTitle:async()=>{},onClicked:event}};
  const context={chrome,setTimeout,clearTimeout,queueMicrotask,Date,URL,captureJob:async(_api:unknown,_job:unknown,options:{diagnostics:boolean})=>{captures++;assert.equal(options.diagnostics,true);throw Object.assign(Error("BROWSER_PAGE_LOAD_TIMEOUT"),{diagnostic});}};
  runInNewContext(code,context);await runInNewContext("runXhsNotes()",context);
  assert.equal(captures,1);const pause=messages.find(m=>m.op==="xiaohongshu-notes-pause");assert(pause);assert.equal(pause.code,"BROWSER_PAGE_LOAD_TIMEOUT");assert.deepEqual(pause.diagnostic,diagnostic);assert(!messages.some(m=>m.op==="xiaohongshu-notes-upload"));
});
