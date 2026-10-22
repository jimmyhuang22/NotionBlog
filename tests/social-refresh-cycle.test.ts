import test from "node:test";
import assert from "node:assert/strict";
import { chmod,mkdtemp,readFile,realpath,rm,stat,writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import { endianness } from "node:os";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { config,hash,publicationKey,SocialSyncError } from "../scripts/social-sync/model.ts";
import { observation } from "../scripts/social-sync/bilibili.ts";
import { openStore } from "../scripts/social-sync/store.ts";
import { executeRefresh,refreshRequest } from "../scripts/social-sync/refresh-executor.ts";
import type { RefreshPorts } from "../scripts/social-sync/refresh-executor.ts";
import { BILIBILI_CYCLE,drainCycle,newCycle } from "../scripts/social-sync/refresh-cycle.ts";
import { inspectRefresh } from "../scripts/social-sync/refresh-state.ts";
import { browserLinks,handleBrowserMessage } from "../scripts/social-sync/browser-bridge.ts";
import { nativeFrame,readNativeMessage } from "../scripts/social-sync/native-host.ts";
import { prepareRuntime } from "../scripts/social-sync/prepare-runtime.ts";
import { runCycleCli } from "../scripts/social-sync/cycle-cli.ts";
import { snapshotObservation } from "../scripts/social-sync/xiaohongshu.ts";
import { acquireLock } from "../scripts/notion-sync/state.ts";

const at="2026-01-02T00:00:00.000Z",now="2026-01-03T00:00:00.000Z",origin="chrome-extension://"+"a".repeat(32)+"/";
const target=(n:number,platform="bilibili")=>config({version:1,publications:[{platform,accountId:platform==="bilibili"?"10001":"0".repeat(23)+"1",workId:`example-${n}`,url:platform==="bilibili"?`https://www.bilibili.com/video/BV${String(n).padStart(10,"0")}/`:`https://www.xiaohongshu.com/explore/${String(n+1).padStart(24,"0")}`}]})[0]!;
const rawNote=(t:ReturnType<typeof target>,time=now)=>({version:1,source:"browser-note-state",observedAt:time,pageUrl:t.url,note:{noteId:t.publicationId,userId:t.accountId,type:"normal",title:"Example",time:null,lastUpdateTime:null,coverUrl:null,interactInfo:{likedCount:"1.2万",commentCount:"0",shareCount:null,collectedCount:null}}});
const sample=(t:ReturnType<typeof target>,time=now)=>t.platform==="xiaohongshu"?snapshotObservation(rawNote(t,time),t,time):observation(`<script>window.__INITIAL_STATE__=${JSON.stringify({videoData:{bvid:t.publicationId,owner:{mid:10001},title:"Example",stat:{like:1,reply:0}}})};</script>`,t,time);
async function fixture(t:{after:(f:()=>Promise<void>)=>void},size=45,platform="bilibili"){
  const root=await realpath(await mkdtemp(join(tmpdir(),"nb-social-cycle-")));await chmod(root,0o700);const store=(await openStore(root))!;
  t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
  const targets=Array.from({length:size},(_,i)=>target(i+1,platform));for(const p of targets){store.ingest(sample(p,at));store.acknowledge(publicationKey(p),hash(JSON.stringify(sample(p,at))));}
  const scope={version:1,reviewedAt:at,cadence:{bilibiliHours:6,xiaohongshuHours:24},stateDirectories:{publications:root,collections:root},publications:targets.map(target=>({target,kind:platform==="bilibili"?"video":"image-note"})),collections:[]};
  await writeFile(join(root,"refresh-config.json"),JSON.stringify(scope),{mode:0o600});
  await writeFile(join(root,"bridge-config.json"),JSON.stringify({version:1,origin,enabled:true}),{mode:0o600});
  await writeFile(join(root,"browser-links.json"),JSON.stringify({version:1,links:targets.filter(t=>t.platform==="xiaohongshu").map(t=>({publicationId:t.publicationId,url:t.url}))}),{mode:0o600});
  let calls=0;const echo=async(p:{key:string;sha256:string})=>({key:p.key,sha256:p.sha256});
  const ports:RefreshPorts={publications:store,collections:null,sendPublication:echo,sendCollection:echo,checkScope:async()=>{},saveReview:async(candidate,code)=>{await writeFile(join(root,`review-${candidate.type}-${candidate.key}.json`),JSON.stringify({version:1,code,candidate}),{mode:0o600});},progress:async()=>{}};
  const execute=async(options:Parameters<typeof executeRefresh>[2])=>executeRefresh(scope,ports,{...options,now:()=>now,spacingMs:0,collectPublication:async p=>{calls++;return sample(p);}});
  return {root,targets,scope,store,ports,execute,calls:()=>calls};
}
test("a cycle drains more than one batch exactly once and freezes its starting keys",async t=>{
  const f=await fixture(t),state=await inspectRefresh(f.root,"bilibili",now),cycle=newCycle(state.keys.slice(0,43),state.scopeDigest,0,now);
  const r=await drainCycle(cycle,{execute:keys=>f.execute({platform:"bilibili",limit:20,keys}),save:async()=>{}},{now:()=>now});
  assert.equal(r.status,"complete");assert.equal(r.batches,3);assert.equal(r.uploaded,43);assert.equal(f.calls(),43);assert.equal(f.store.status().samples,88);assert.equal(f.store.status().pending,0);
  assert.equal((await inspectRefresh(f.root,"bilibili",now)).keys.length,2);
});
test("cycle batch/time limits stop without collecting its remaining targets",async t=>{
  const f=await fixture(t),s=await inspectRefresh(f.root,"bilibili",now);
  const r=await drainCycle(newCycle(s.keys,s.scopeDigest,0,now),{execute:keys=>f.execute({platform:"bilibili",limit:20,keys}),save:async()=>{}},{now:()=>now,budget:{...BILIBILI_CYCLE,batches:1}});
  assert.equal(r.status,"budget");assert.equal(r.remaining.length,25);assert.equal(f.calls(),20);
  const expired=await drainCycle(newCycle(s.keys,s.scopeDigest,0,at),{execute:async()=>{throw Error("late capture");},save:async()=>{}},{now:()=>now});assert.equal(expired.status,"budget");assert.equal(expired.batches,0);
});
test("verification and cancellation stop the entire cycle, while old statistics remain",async t=>{
  const f=await fixture(t,25),s=await inspectRefresh(f.root,"bilibili",now);let calls=0;
  const r=await drainCycle(newCycle(s.keys,s.scopeDigest,0,now),{execute:keys=>executeRefresh(f.scope,f.ports,{platform:"bilibili",limit:20,keys,now:()=>now,spacingMs:0,collectPublication:async()=>{calls++;throw new SocialSyncError("SOURCE_BLOCKED");}}),save:async()=>{}},{now:()=>now});
  assert.equal(r.status,"paused");assert.equal(calls,1);assert.equal(r.remaining.length,25);assert.equal(f.store.status().samples,25);
  const signal=AbortSignal.abort(),cancelled=await drainCycle(newCycle(s.keys,s.scopeDigest,0,now),{execute:async()=>{throw Error("cancelled source");},save:async()=>{}},{signal,now:()=>now});assert.equal(cancelled.status,"cancelled");assert.equal(cancelled.batches,0);
});
test("a cycle-level streaming/request budget survives individual batch boundaries",async()=>{
  let calls=0;const global=refreshRequest(async()=>{calls++;return new Response("1234");},{requests:3,bytes:9});
  const batch1=refreshRequest(global);await(await batch1("https://example.com")).text();await(await batch1("https://example.com")).text();
  const batch2=refreshRequest(global);await assert.rejects((await batch2("https://example.com")).text(),{code:"REFRESH_BYTE_BUDGET"});await assert.rejects(batch2("https://example.com"),{code:"REFRESH_REQUEST_BUDGET"});assert.equal(calls,3);
});
test("ordinary shared-lock contention defers a cycle without latching a failure",async t=>{
  const f=await fixture(t,1),state=await inspectRefresh(f.root,"bilibili",now),cycle=newCycle(state.keys,state.scopeDigest,0,now);
  await assert.rejects(drainCycle(cycle,{execute:async()=>{throw Object.assign(Error("locked"),{code:"BUSY"});},save:async()=>{}},{now:()=>now}),{code:"BUSY"});
  assert.equal(cycle.status,"deferred");assert.equal(cycle.failed,0);assert.equal(cycle.remaining.length,1);assert.equal(f.store.status().samples,1);
});
test("native framing accepts fragmented UTF-8, and rejects oversize, trailing or incomplete messages",async()=>{
  const framed=nativeFrame({op:"example",value:"中文"});assert.deepEqual(await readNativeMessage(Readable.from([framed.subarray(0,1),framed.subarray(1,6),framed.subarray(6)])),{op:"example",value:"中文"});
  const huge=Buffer.alloc(4);if(endianness()==="LE")huge.writeUInt32LE(1048576);else huge.writeUInt32BE(1048576);
  await assert.rejects(readNativeMessage(Readable.from([huge])),{code:"BRIDGE_MESSAGE_TOO_LARGE"});
  await assert.rejects(readNativeMessage(Readable.from([Buffer.concat([framed,Buffer.from("x")])])),{code:"BRIDGE_MESSAGE_INVALID"});await assert.rejects(readNativeMessage(Readable.from([framed.subarray(0,6)])),{code:"BRIDGE_MESSAGE_TRUNCATED"});
});
test("bridge pins origin and rejects command/path fields before exposing work",async t=>{
  const f=await fixture(t,1,"xiaohongshu");await assert.rejects(handleBrowserMessage(f.root,origin.replace(/a/g,"b"),{op:"start"}),{code:"BRIDGE_ORIGIN_REJECTED"});
  await assert.rejects(handleBrowserMessage(f.root,origin,{op:"start",path:"/example"}),{code:"BRIDGE_REQUEST_INVALID"});
  await writeFile(join(f.root,"bridge-config.json"),JSON.stringify({version:1,origin,enabled:false}),{mode:0o600});assert.deepEqual(await handleBrowserMessage(f.root,origin,{op:"settings"}),{enabled:false,periodMinutes:15,cadenceHours:24});await assert.rejects(handleBrowserMessage(f.root,origin,{op:"start"}),{code:"BRIDGE_DISABLED"});assert.equal(f.store.status().samples,1);
});
test("a browser cycle processes five-note jobs and a lost reply is replayed without re-ingestion",async t=>{
  const f=await fixture(t,6,"xiaohongshu"),ports={now:()=>now,execute:f.execute};
  const start=await handleBrowserMessage(f.root,origin,{op:"start"},ports) as {cycleId:string};
  const first=await handleBrowserMessage(f.root,origin,{op:"next",cycleId:start.cycleId},ports) as {job:{id:string;targets:{publicationId:string}[]}};assert.equal(first.job.targets.length,5);
  const snapshots=first.job.targets.map(p=>rawNote(f.targets.find(t=>t.publicationId===p.publicationId)!)),message={op:"submit",cycleId:start.cycleId,jobId:first.job.id,snapshots};
  const reply=await handleBrowserMessage(f.root,origin,message,ports);assert.equal(f.store.status().samples,11);assert.deepEqual(await handleBrowserMessage(f.root,origin,message,ports),reply);assert.equal(f.store.status().samples,11);
  await assert.rejects(handleBrowserMessage(f.root,origin,{...message,snapshots:[]},ports),{code:"BRIDGE_JOB_REPLAY_CHANGED"});
  const next=await handleBrowserMessage(f.root,origin,{op:"next",cycleId:start.cycleId},ports) as typeof first;assert.equal(next.job.targets.length,1);
  const done=await handleBrowserMessage(f.root,origin,{op:"submit",cycleId:start.cycleId,jobId:next.job.id,snapshots:next.job.targets.map(p=>rawNote(f.targets.find(t=>t.publicationId===p.publicationId)!))},ports) as {status:string;uploaded:number};assert.equal(done.status,"complete");assert.equal(done.uploaded,6);assert.equal(f.store.status().pending,0);assert.equal(f.calls(),0);
  await assert.rejects(stat(join(f.root,"cycle-xiaohongshu","worker.lock")),{code:"ENOENT"});
});
test("bridge validates the entire job before any source write, and rejects stale source versions",async t=>{
  const f=await fixture(t,2,"xiaohongshu"),ports={now:()=>now,execute:f.execute};const start=await handleBrowserMessage(f.root,origin,{op:"start"},ports) as {cycleId:string};
  const next=await handleBrowserMessage(f.root,origin,{op:"next",cycleId:start.cycleId},ports) as {job:{id:string}};
  const snapshots=f.targets.map(t=>rawNote(t));const bad=structuredClone(snapshots);bad[1]!.note.userId="f".repeat(24);
  await assert.rejects(handleBrowserMessage(f.root,origin,{op:"submit",cycleId:start.cycleId,jobId:next.job.id,snapshots:bad},ports),{code:"IDENTITY_MISMATCH"});assert.equal(f.store.status().samples,2);
  f.store.ingest(sample(f.targets[0]!));
  await assert.rejects(handleBrowserMessage(f.root,origin,{op:"submit",cycleId:start.cycleId,jobId:next.job.id,snapshots},ports),{code:"REFRESH_SOURCE_CHANGED"});assert.equal(f.store.status().samples,3);
});
test("bridge resumes a locally captured pending note without visiting a page",async t=>{
  const f=await fixture(t,1,"xiaohongshu");f.store.ingest(sample(f.targets[0]!));const ports={now:()=>now,execute:f.execute};const start=await handleBrowserMessage(f.root,origin,{op:"start"},ports) as {cycleId:string};
  const next=await handleBrowserMessage(f.root,origin,{op:"next",cycleId:start.cycleId},ports) as {job?:unknown;uploaded:number;resumed:number};assert.equal(next.job,undefined);assert.equal(next.uploaded,1);assert.equal(next.resumed,1);assert.equal(f.store.status().samples,2);
});
test("a validated browser packet survives shared-lock contention on SSD and uploads without reopening pages",async t=>{
  const f=await fixture(t,2,"xiaohongshu"),ports={now:()=>now,execute:f.execute},start=await handleBrowserMessage(f.root,origin,{op:"start"},ports) as {cycleId:string};
  const job=await handleBrowserMessage(f.root,origin,{op:"next",cycleId:start.cycleId},ports) as {job:{id:string}};
  const release=await acquireLock(f.root,"other-platform");
  try{
    const deferred=await handleBrowserMessage(f.root,origin,{op:"submit",cycleId:start.cycleId,jobId:job.job.id,snapshots:f.targets.map(t=>rawNote(t))},ports) as {deferred:boolean;status:string};
    assert.equal(deferred.deferred,true);assert.equal(deferred.status,"running");assert.equal(f.store.status().samples,2);
    const saved=JSON.parse(await readFile(join(f.root,"cycle-xiaohongshu","latest-cycle.json"),"utf8"));assert(saved.job.captureRaw);assert.equal(JSON.parse(saved.job.captureRaw).snapshots.length,2);
  }finally{await release();}
  const done=await handleBrowserMessage(f.root,origin,{op:"next",cycleId:start.cycleId},ports) as {status:string;uploaded:number;job?:unknown};
  assert.equal(done.status,"complete");assert.equal(done.uploaded,2);assert.equal(done.job,undefined);assert.equal(f.store.status().samples,4);assert.equal(f.calls(),0);
});
test("a paused browser cycle stays paused on alarms until an explicit manual resume",async t=>{
  const f=await fixture(t,1,"xiaohongshu"),ports={now:()=>now,execute:f.execute},start=await handleBrowserMessage(f.root,origin,{op:"start"},ports) as {cycleId:string};
  await handleBrowserMessage(f.root,origin,{op:"pause",cycleId:start.cycleId,code:"SOURCE_BLOCKED"},ports);
  const alarm=await handleBrowserMessage(f.root,origin,{op:"start",manual:false},ports) as {cycleId:string;status:string};assert.equal(alarm.status,"paused");assert.equal(alarm.cycleId,start.cycleId);assert.equal(f.store.status().samples,1);
  const resumed=await handleBrowserMessage(f.root,origin,{op:"start",manual:true},ports) as typeof alarm;assert.equal(resumed.status,"running");assert.notEqual(resumed.cycleId,start.cycleId);
});
test("scheduled Bilibili run honors a saved pause without inspecting or contacting sources",async t=>{
  const f=await fixture(t,1),dir=join(f.root,"cycle-bilibili");await import("node:fs/promises").then(fs=>fs.mkdir(dir,{mode:0o700}));
  await writeFile(join(dir,"latest-cycle.json"),JSON.stringify({status:"paused"}),{mode:0o600});await rm(join(f.root,"refresh-config.json"));
  t.mock.method(console,"log",()=>{});const previous=process.exitCode;try{await runCycleCli(["run",f.root,"bilibili"]);assert.equal(process.exitCode,1);}finally{process.exitCode=previous;}
  assert.equal(f.store.status().samples,1);await assert.rejects(stat(join(dir,"worker.lock")),{code:"ENOENT"});
});
test("share-link lookup rejects missing, foreign and duplicate identities",()=>{
  const a=target(1,"xiaohongshu"),good={version:1,links:[{publicationId:a.publicationId,url:a.url+"?xsec_token=example"}]};assert.equal(browserLinks(good,[a]).size,1);
  for(const v of [{version:1,links:[]},{version:1,links:[{publicationId:a.publicationId,url:"https://example.com/explore/"+a.publicationId}]},{version:1,links:[...good.links,...good.links]}])assert.throws(()=>browserLinks(v,[a]),SocialSyncError);
});
test("extension MAIN projection remains narrow and rejects a mismatched current author",async()=>{
  const code=(await readFile(new URL("../scripts/social-sync/browser/capture.js",import.meta.url),"utf8")).replace("export function","function"),t=target(1,"xiaohongshu");
  const ctx={location:{protocol:"https:",hostname:"www.xiaohongshu.com",pathname:`/discovery/item/${t.publicationId}`},window:{__INITIAL_STATE__:{note:{noteDetailMap:{[t.publicationId]:{note:{noteId:t.publicationId,user:{userId:t.accountId},type:"normal",title:"例",interactInfo:{likedCount:"1.2万",commentCount:"0"},comments:["private"],description:"private"}}}}}}};
  const result=runInNewContext(code+`;captureNote(${JSON.stringify(t)})`,ctx);assert.deepEqual(Object.keys(result).sort(),["version","source","observedAt","pageUrl","note"].sort());assert.equal(result.note.interactInfo.likedCount,"1.2万");assert(!JSON.stringify(result).includes("private"));
  ctx.window.__INITIAL_STATE__.note.noteDetailMap[t.publicationId]!.note.user.userId="f".repeat(24);assert.equal(runInNewContext(code+`;captureNote(${JSON.stringify(t)})`,ctx).error,"IDENTITY_MISMATCH");
});
test("browser driver closes only its own tab on capture success or verification failure",async()=>{
  const path=fileURLToPath(new URL("../scripts/social-sync/browser/driver.js",import.meta.url)),{captureJob}=await import(path);const t=target(1,"xiaohongshu"),removed:number[]=[],created:unknown[]=[],job={id:"00000000-0000-0000-0000-000000000000",expiresAt:new Date(Date.now()+60000).toISOString(),targets:[t]};
  let blocked=false;const api={tabs:{create:async(value:unknown)=>{created.push(value);return {id:12};},get:async(id:number)=>{assert.equal(id,12);return {status:"complete",url:blocked?"https://www.xiaohongshu.com/login":t.url};},remove:async(id:number)=>{removed.push(id);}},scripting:{executeScript:async(o:{world:string;target:{tabId:number;frameIds:number[]}})=>{assert.equal(o.world,"MAIN");assert.equal(o.target.tabId,12);assert.deepEqual(o.target.frameIds,[0]);return [{frameId:0,result:rawNote(t)}];}}};
  const got=await captureJob(api,job,{sleep:async()=>{}});assert.equal(got.length,1);blocked=true;await assert.rejects(captureJob(api,job,{sleep:async()=>{}}),/SOURCE_BLOCKED/);assert.deepEqual(removed,[12,12]);assert.deepEqual(created,[{url:t.url,active:false},{url:t.url,active:false}]);
});
test("runtime preparation creates a disabled SSD package with no installation or secret exposure",async t=>{
  const f=await fixture(t,1,"xiaohongshu");await rm(join(f.root,"bridge-config.json"));const out=join(f.root,"package");const result=await prepareRuntime(f.root,out);assert.deepEqual(result,{notes:1,enabled:false,installed:false});
  const cfg=JSON.parse(await readFile(join(f.root,"bridge-config.json"),"utf8")),manifest=JSON.parse(await readFile(join(out,"extension","manifest.json"),"utf8")),native=JSON.parse(await readFile(join(out,"com.notionblog.social_refresh.json"),"utf8"));
  assert(!/^(?:name|timeout|command):/m.test(await readFile(join(out,"social-bilibili.dagu.yaml"),"utf8")));
  assert.equal(cfg.enabled,false);assert.deepEqual(native.allowed_origins,[cfg.origin]);assert.deepEqual(manifest.host_permissions,["https://www.xiaohongshu.com/*","https://space.bilibili.com/*"]);assert(!manifest.permissions.includes("cookies"));assert.equal((await stat(native.path)).mode&0o077,0);assert(!JSON.stringify(native).includes("postgresql"));
  await assert.rejects(prepareRuntime(f.root,out),{code:"REFRESH_PACKAGE_EXISTS"});
});
test("the native process responds and exits with Chrome stdin still open",async t=>{
  const f=await fixture(t,1,"xiaohongshu"),host=fileURLToPath(new URL("../scripts/social-sync/native-host.ts",import.meta.url));
  const child=spawn(process.execPath,[host,f.root,origin],{stdio:["pipe","pipe","pipe"]});let output=Buffer.alloc(0);child.stdout.on("data",b=>{output=Buffer.concat([output,b]);});
  child.stdin.write(nativeFrame({op:"settings"}));
  const timer=setTimeout(()=>child.kill("SIGKILL"),3000);
  try{const code=await new Promise<number|null>((resolve,reject)=>{child.once("close",resolve);child.once("error",reject);});assert.equal(code,0);assert.deepEqual(await readNativeMessage(Readable.from([output])),{enabled:true,periodMinutes:15,cadenceHours:24});}finally{clearTimeout(timer);child.stdin.destroy();}
});
test("extension schedules one-job continuations rather than a long browser event",async()=>{
  const code=(await readFile(new URL("../scripts/social-sync/browser/background.js",import.meta.url),"utf8")).replace(/^import[^\n]+\n/gm,""),events:Record<string,(arg?:unknown)=>unknown>={},session:Record<string,unknown>={},alarms:unknown[]=[],ops:string[]=[];let captures=0,nexts=0;
  const event=(name:string)=>({addListener:(fn:(arg?:unknown)=>unknown)=>{events[name]=fn;}});
  let busy=false;
  const chrome={runtime:{lastError:null,connectNative:()=>{
    let receive:(v:unknown)=>void=()=>{};return {onMessage:{addListener:(fn:typeof receive)=>{receive=fn;},removeListener:()=>{}},onDisconnect:{addListener:()=>{},removeListener:()=>{}},disconnect:()=>{},postMessage:(m:{op:string})=>{ops.push(m.op);queueMicrotask(()=>receive(busy?{error:"BUSY"}:m.op==="settings"?{enabled:false}:m.op==="start"?{cycleId:"example"}:m.op==="next"?++nexts===1?{status:"running",job:{id:"example"}}:{status:"complete",uploaded:5,remaining:0}:{status:"running"}));}};
  },onStartup:event("startup"),onInstalled:event("installed")},storage:{session:{get:async()=>({...session}),set:async(o:unknown)=>Object.assign(session,o),remove:async(k:string)=>{delete session[k];}}},tabs:{},alarms:{get:async()=>null,create:async(n:string,o:unknown)=>{alarms.push([n,o]);},clear:async()=>{},onAlarm:event("alarm")},action:{setBadgeText:async()=>{},setTitle:async()=>{},onClicked:event("click")}};
  const ctx={chrome,setTimeout,clearTimeout,queueMicrotask,Date,URL,captureJob:async()=>{captures++;return [];}};runInNewContext(code,ctx);
  await runInNewContext("run()",ctx);assert.equal(captures,1);assert.deepEqual(ops.filter(o=>o!=="settings"),["start","next","submit"]);assert.equal((alarms[0] as string[])[0],"reviewed-notes-continue");
  await runInNewContext("run(true)",ctx);assert.equal(captures,1);assert.equal(session.cycleId,undefined);
  busy=true;const before=ops.length;await runInNewContext("run()",ctx);assert.equal(captures,1);assert.deepEqual(ops.slice(before),["start"]);assert.equal((alarms.at(-1) as string[])[0],"reviewed-notes-continue");
});
