import test from "node:test";
import assert from "node:assert/strict";
import { chmod,mkdtemp,readFile,realpath,rm,stat,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { config,hash,publicationKey,SocialSyncError } from "../scripts/social-sync/model.ts";
import { observation } from "../scripts/social-sync/bilibili.ts";
import { collectionKey } from "../scripts/social-sync/collection.ts";
import { collectionMemberShas } from "../scripts/social-sync/refresh.ts";
import { executeRefresh,refreshRequest,MAX_REFRESH_SOURCE_BYTES } from "../scripts/social-sync/refresh-executor.ts";
import type { RefreshCandidate,RefreshPorts } from "../scripts/social-sync/refresh-executor.ts";
import { openStore } from "../scripts/social-sync/store.ts";
import { openCollectionStore } from "../scripts/social-sync/collection-store.ts";
import { browserCaptureScript,snapshotObservation } from "../scripts/social-sync/xiaohongshu.ts";
import { runExecuteCli } from "../scripts/social-sync/execute-cli.ts";
import { exampleCollectionSnapshot } from "./helpers/social-collection-samples.ts";

const at="2026-01-02T00:00:00.000Z",now="2026-01-03T00:00:00.000Z";
const target=(n=1)=>config({version:1,publications:[{platform:"bilibili",accountId:"10001",workId:`example-${n}`,url:`https://www.bilibili.com/video/BV${String(n).padStart(10,"0")}/`}]})[0]!;
const note=config({version:1,publications:[{platform:"xiaohongshu",accountId:"000000000000000000000001",workId:"example-note",url:"https://www.xiaohongshu.com/explore/000000000000000000000002"}]})[0]!;
const html=(t=target())=>`<script>window.__INITIAL_STATE__=${JSON.stringify({videoData:{bvid:t.publicationId,owner:{mid:10001},title:"Example",stat:{like:0,reply:2}}})};</script>`;
const video=(t=target(),time=now)=>observation(html(t),t,time);
const xhs=(type="normal",time=now)=>snapshotObservation({version:1,source:"browser-note-state",observedAt:time,pageUrl:note.url,note:{noteId:note.publicationId,userId:note.accountId,type,title:"Example note",time:null,lastUpdateTime:null,coverUrl:null,interactInfo:{likedCount:"1.2万",commentCount:"0",shareCount:null,collectedCount:null}}},note,time);
async function fixture(t:{after:(f:()=>Promise<void>)=>void},pubs=[target()],collection=false){
 const root=await realpath(await mkdtemp(join(tmpdir(),"nb-refresh-exec-")));await chmod(root,0o700);
 const publications=(await openStore(root))!,collections=(await openCollectionStore(root))!;t.after(async()=>{publications.close();collections.close();await rm(root,{recursive:true,force:true});});
 const col=exampleCollectionSnapshot(at),scope={version:1,reviewedAt:at,cadence:{bilibiliHours:6,xiaohongshuHours:24},stateDirectories:{publications:root,collections:root},
  publications:pubs.map(p=>({target:p,kind:p.platform==="bilibili"?"video":"image-note"})),collections:collection?[{target:col.target,memberShas:collectionMemberShas(col)}]:[]};
 const held:RefreshCandidate[]=[],progress:unknown[]=[];
 const echo=async(p:{key:string;sha256:string})=>({key:p.key,sha256:p.sha256});
 const ports:RefreshPorts={publications,collections,sendPublication:echo,sendCollection:echo,checkScope:async()=>{},saveReview:async c=>{held.push(c);},progress:async r=>{progress.push(structuredClone(r));}};
 return {root,scope,col,held,progress,ports,publications,collections};
}
const opts={platform:"bilibili" as const,limit:1,now:()=>now,spacingMs:0};
test("media handoff runs only after the exact ACK and its failure cannot replay statistics",async t=>{
 const f=await fixture(t);let hooks=0;
 f.ports.afterAcknowledged=async()=>{hooks++;assert.equal(f.publications.status().pending,0);throw Error("media unavailable");};
 const r=await executeRefresh(f.scope,f.ports,{...opts,collectPublication:async p=>video(p)});
 assert.equal(hooks,1);assert.equal(r.uploaded,1);assert.equal(r.failed,0);assert.equal(r.paused,false);
 const g=await fixture(t);g.ports.afterAcknowledged=async()=>{throw Error("must not run on mismatched ACK");};
 g.ports.sendPublication=async p=>({key:p.key,sha256:"0".repeat(64)});
 const bad=await executeRefresh(g.scope,g.ports,{...opts,collectPublication:async p=>video(p)});
 assert.equal(bad.uploaded,0);assert.equal(g.publications.status().pending,1);
});
test("a lost upload preserves the real captured payload and resumes without collecting again",async t=>{
 const f=await fixture(t);f.publications.ingest(video(target(),at));f.publications.acknowledge(publicationKey(target()),hash(JSON.stringify(video(target(),at))));let calls=0;
 f.ports.sendPublication=async()=>{throw new SocialSyncError("CLOUD_UPLOAD_FAILED");};
 const first=await executeRefresh(f.scope,f.ports,{...opts,collectPublication:async p=>{calls++;return video(p);}});
 assert.equal(first.failed,1);assert.equal(first.paused,true);assert.equal(first.uploaded,0);assert.equal(f.publications.status().samples,2);assert.equal(f.publications.status().pending,1);
 f.ports.sendPublication=async p=>({key:p.key,sha256:p.sha256});
 const next=await executeRefresh(f.scope,f.ports,{...opts,collectPublication:async()=>{throw Error("must not recollect");}});
 assert.equal(calls,1);assert.equal(next.resumed,1);assert.equal(next.uploaded,1);assert.equal(f.publications.status().pending,0);assert.equal(f.publications.latest(target())!.observedAt,now);
});
test("fixed-target retry is not starved by the legacy one-hundred-row outbox window",async t=>{
 const f=await fixture(t,[target(150)]);for(let n=1;n<=150;n++)f.publications.ingest(video(target(n)));
 const pending=f.publications.pendingFor(target(150))!;assert(pending);assert(f.publications.pending().length===100);
 const r=await executeRefresh(f.scope,f.ports,{...opts,collectPublication:async()=>{throw Error("must reuse pending");}});
 assert.equal(r.resumed,1);assert.equal(r.uploaded,1);assert.equal(f.publications.pendingFor(target(150)),null);assert.equal(f.publications.status().pending,149);
});
test("unreviewed collection changes are held before either source ingestion or cloud sending",async t=>{
 const f=await fixture(t,[],true);f.collections.ingest(f.col);f.collections.acknowledge(f.collections.pendingFor(f.col.target)!);
 const before=f.collections.latest(f.col.target),changed=structuredClone(f.col);changed.observedAt=now;changed.members.push({id:"BV0000000003",publishedAt:null,parts:["1003"],partsComplete:true});
 f.ports.sendCollection=async()=>{throw Error("unreviewed cloud call");};
 const r=await executeRefresh(f.scope,f.ports,{...opts,collectCollection:async()=>changed});
 assert.equal(r.reviewRequired,1);assert.equal(r.collected,0);assert.equal(f.held.length,1);assert.deepEqual(f.collections.latest(f.col.target),before);assert.equal(f.collections.status().pending,0);
 const again=await executeRefresh(f.scope,f.ports,{...opts,held:f.held,collectCollection:async()=>{throw Error("must not recollect held candidate");}});
 assert.equal(again.selected,0);assert.equal(again.reviewRequired,1);assert.deepEqual(f.collections.latest(f.col.target),before);
});
test("manual browser input preserves rounded counts and queues changed note kinds",async t=>{
 const f=await fixture(t,[note]);const row=xhs();const r=await executeRefresh(f.scope,f.ports,{...opts,platform:"xiaohongshu",captures:[row]});
 assert.equal(r.uploaded,1);assert.equal(f.publications.latest(note)!.metrics.likes,null);assert.equal(f.publications.latest(note)!.metrics.comments,0);
 const changed=xhs("video","2026-01-03T00:00:01.000Z"),held=await executeRefresh(f.scope,f.ports,{...opts,platform:"xiaohongshu",captures:[changed]});
 assert.equal(held.reviewRequired,1);assert.equal(f.publications.latest(note)!.kind,"image-note");assert.equal(f.publications.status().samples,1);
});
test("one batch changes at most twenty targets and never requests the remainder",async t=>{
 const targets=Array.from({length:25},(_,i)=>target(i+1)),f=await fixture(t,targets);let collected=0;
 const r=await executeRefresh(f.scope,f.ports,{...opts,limit:20,collectPublication:async p=>{collected++;return video(p);}});
 assert.equal(r.selected,20);assert.equal(r.uploaded,20);assert.equal(collected,20);assert.equal(f.publications.status().publications,20);
 await assert.rejects(executeRefresh(f.scope,f.ports,{...opts,limit:21}),SocialSyncError);
});
test("a platform verification response pauses after one attempt and retains the previous statistics",async t=>{
 const f=await fixture(t,[target(1),target(2)]);for(const p of f.scope.publications)f.publications.ingest(video(p.target,at));let calls=0;
 const r=await executeRefresh(f.scope,f.ports,{...opts,limit:2,collectPublication:async()=>{calls++;throw new SocialSyncError("SOURCE_BLOCKED");}});
 assert.equal(calls,1);assert.equal(r.paused,true);assert.equal(r.uploaded,0);assert.equal(f.publications.status().samples,2);assert(f.publications.status().latestAttempts.some(a=>a.code==="SOURCE_BLOCKED"));
});
test("scope drift after capture blocks local ingestion and transport",async t=>{
 const f=await fixture(t);let checks=0,sends=0;f.ports.checkScope=async()=>{if(++checks===2)throw new SocialSyncError("REFRESH_SCOPE_CHANGED");};f.ports.sendPublication=async p=>{sends++;return p;};
 const r=await executeRefresh(f.scope,f.ports,{...opts,collectPublication:async p=>video(p)});
 assert.equal(r.paused,true);assert.equal(sends,0);assert.equal(f.publications.status().samples,0);assert.equal(r.entries[0]!.code,"REFRESH_SCOPE_CHANGED");
});
test("wrong receipts and superseding writes never acknowledge the wrong snapshot",async t=>{
 const f=await fixture(t);f.ports.sendPublication=async p=>({key:p.key,sha256:"0".repeat(64)});
 const wrong=await executeRefresh(f.scope,f.ports,{...opts,collectPublication:async p=>video(p)});assert.equal(wrong.failed,1);assert.equal(f.publications.status().pending,1);
 f.ports.sendPublication=async p=>{f.publications.ingest(video(target(),"2026-01-03T00:00:01.000Z"));return {key:p.key,sha256:p.sha256};};
 const superseded=await executeRefresh(f.scope,f.ports,opts);assert.equal(superseded.superseded,1);assert.equal(superseded.uploaded,0);assert.equal(f.publications.status().pending,1);
});
test("cancellation after a server receipt leaves the exact payload pending for an idempotent retry",async t=>{
 const f=await fixture(t),controller=new AbortController();f.ports.sendPublication=async p=>{controller.abort();return {key:p.key,sha256:p.sha256};};
 const r=await executeRefresh(f.scope,f.ports,{...opts,signal:controller.signal,collectPublication:async p=>video(p)});
 assert.equal(r.cancelled,true);assert.equal(r.uploaded,0);assert.equal(f.publications.status().pending,1);
});
test("network request and cumulative streaming byte budgets stop additional source work",async()=>{
 let calls=0;const limited=refreshRequest(async()=>{calls++;return new Response("example");});
 for(let i=0;i<20;i++)await (await limited("https://example.com")).text();await assert.rejects(limited("https://example.com"),SocialSyncError);assert.equal(calls,20);
 const chunk=new Uint8Array(MAX_REFRESH_SOURCE_BYTES/4),bytes=refreshRequest(async()=>new Response(chunk));
 for(let i=0;i<4;i++)await (await bytes("https://example.com")).arrayBuffer();await assert.rejects((await bytes("https://example.com")).arrayBuffer(),SocialSyncError);
});
test("browser capture accepts the verified discovery route and emits only the narrow note projection",()=>{
 const script=browserCaptureScript([note]),snapshot=xhs(),n={...snapshot,interactInfo:{likedCount:"1.2万",commentCount:"0"}};
 const result=runInNewContext(script,{location:{protocol:"https:",hostname:"www.xiaohongshu.com",pathname:`/discovery/item/${note.publicationId}`},window:{__INITIAL_STATE__:{note:{currentNoteId:note.publicationId,noteDetailMap:{[note.publicationId]:{note:{noteId:note.publicationId,user:{userId:note.accountId},type:"normal",title:n.title,interactInfo:n.interactInfo}}}}}},TextEncoder,btoa:(x:string)=>Buffer.from(x,"binary").toString("base64")});
 const parsed=JSON.parse(Buffer.from(result.slice("SOCIAL_SYNC_SNAPSHOT ".length),"base64").toString("utf8"));assert.equal(parsed.pageUrl,note.url);assert.equal(parsed.note.userId,note.accountId);assert(!Object.hasOwn(parsed,"cookie"));
});
test("CLI waits for browser input without advancing dates or contacting the database, and keeps locks private",async t=>{
 const f=await fixture(t,[note]);f.publications.ingest(xhs("normal",at));f.publications.acknowledge(publicationKey(note),hash(JSON.stringify(xhs("normal",at))));
 await writeFile(join(f.root,"refresh-config.json"),JSON.stringify(f.scope),{mode:0o600});await writeFile(join(f.root,"cloud.env"),"SOCIAL_DATABASE_URL=postgresql://nb_social_worker:example@localhost/example\nDATABASE_TLS=disable\n",{mode:0o600});
 const cli=fileURLToPath(new URL("../scripts/social-sync/execute-cli.ts",import.meta.url));const r=spawnSync(process.execPath,[cli,"run",f.root,"xiaohongshu","1"],{encoding:"utf8"});
 assert.equal(r.status,1,r.stderr);const summary=JSON.parse(r.stdout);assert.equal(summary.waitingBrowser,1);assert.equal(summary.uploaded,0);assert(!r.stdout.includes(note.accountId));assert.equal(f.publications.latest(note)!.observedAt,at);
 await assert.rejects(stat(join(f.root,"worker.lock")),{code:"ENOENT"});assert.equal((await stat(join(f.root,"latest-execution.json"))).mode&0o077,0);
 const prepared=spawnSync(process.execPath,[cli,"prepare-xhs",f.root,"1"],{encoding:"utf8"});assert.equal(prepared.status,0,prepared.stderr);assert.equal(JSON.parse(prepared.stdout).prepared,1);
 await writeFile(join(f.root,"worker.lock"),"{}",{mode:0o600});const busy=spawnSync(process.execPath,[cli,"prepare-xhs",f.root,"1"],{encoding:"utf8"});assert.equal(busy.status,1);assert.match(busy.stderr,/BUSY/);assert.equal(await readFile(join(f.root,"worker.lock"),"utf8"),"{}");
});
test("CLI rechecks the actual scope file after a source request and releases its locks on drift",async t=>{
 const f=await fixture(t);await writeFile(join(f.root,"refresh-config.json"),JSON.stringify(f.scope),{mode:0o600});await writeFile(join(f.root,"cloud.env"),"SOCIAL_DATABASE_URL=postgresql://nb_social_worker:example@localhost/example\nDATABASE_TLS=disable\n",{mode:0o600});
 t.mock.method(globalThis,"fetch",async()=>{await writeFile(join(f.root,"refresh-config.json"),JSON.stringify({...f.scope,reviewedAt:new Date().toISOString()}),{mode:0o600});return new Response(html(),{headers:{"Content-Type":"text/html"}});});t.mock.method(console,"log",()=>{});
 const previous=process.exitCode;try{await runExecuteCli(["run",f.root,"bilibili","1"]);}finally{process.exitCode=previous;}
 assert.equal(f.publications.status().samples,0);const report=JSON.parse(await readFile(join(f.root,"latest-execution.json"),"utf8"));assert.equal(report.entries[0].code,"REFRESH_SCOPE_CHANGED");await assert.rejects(stat(join(f.root,"worker.lock")),{code:"ENOENT"});
});
