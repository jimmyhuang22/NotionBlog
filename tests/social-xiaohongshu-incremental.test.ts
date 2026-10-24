import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,chmod,rm,readFile,writeFile,realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { hash,publicationKey,SocialSyncError } from "../scripts/social-sync/model.ts";
import { refreshConfig,planRefresh } from "../scripts/social-sync/refresh.ts";
import { openStore } from "../scripts/social-sync/store.ts";
import { openCoverQueue } from "../scripts/social-media/queue.ts";
import { prepareHttpNotes } from "../scripts/social-sync/prepare-xiaohongshu-http.ts";
import { readHttpNoteScope } from "../scripts/social-sync/xiaohongshu-http-config.ts";
import { httpNoteObservation,httpNoteState } from "../scripts/social-sync/xiaohongshu-http.ts";
import { automaticNoteTarget,newDirectoryCards,xhsDirectory,candidateNoteShareUrl } from "../scripts/social-sync/xiaohongshu-account.ts";
import { handleXhsDiscovery,readXhsDiscoveryState } from "../scripts/social-sync/xiaohongshu-discovery-bridge.ts";
import { runXhsDiscovery } from "../scripts/social-sync/xiaohongshu-discovery-worker.ts";
import { holdNoteLink,readNoteLinkHolds } from "../scripts/social-sync/xiaohongshu-link-holds.ts";
import { CycleCloudSession } from "../scripts/social-sync/cycle-cloud.ts";
import { executeRefresh } from "../scripts/social-sync/refresh-executor.ts";
import { captureXhsDirectory } from "../scripts/social-sync/browser/xiaohongshu-directory.js";
import { httpTarget,httpHtml,httpUrl,httpState } from "./helpers/social-xiaohongshu-http-samples.ts";
import { handleXhsBrowserNotes,readBrowserOnlyIds,readBrowserNoteCapture,ingestAcceptedBrowserNotes,resumeBrowserNoteLane } from "../scripts/social-sync/xiaohongshu-browser-notes.ts";
import { recordExternalHttpPause,parseHttpHealth } from "../scripts/social-sync/xiaohongshu-http-cycle.ts";
import { armBrowserNoteRecovery,finishBrowserNoteRecovery,inspectBrowserNoteRecovery,cancelBrowserNoteRecovery,retryBrowserNoteUpload } from "../scripts/social-sync/xiaohongshu-browser-notes.ts";

const now=()=>new Date().toISOString(),card=(n:number)=>({publicationId:httpTarget(n).publicationId,url:`https://www.xiaohongshu.com/user/profile/${httpTarget().accountId}/${httpTarget(n).publicationId}?xsec_token=example_public_locator&xsec_source=pc_user`});
async function fixture(t:{after:(f:()=>Promise<void>)=>void}){
  const parent=await realpath(await mkdtemp(join(tmpdir(),"nb-xhs-incremental-")));await chmod(parent,0o700);t.after(()=>rm(parent,{recursive:true,force:true}));
  const root=join(parent,"runtime"),old=join(parent,"old"),out=join(parent,"new"),store=(await openStore(old))!;
  const targets=Array.from({length:30},(_,i)=>httpTarget(i+2)),at=new Date(Date.now()-2*3600000).toISOString();
  for(const target of targets){const row={...httpNoteObservation(httpHtml(Number(target.publicationId)),target,at),source:"browser-note-state" as const};store.ingest(row);store.acknowledge(publicationKey(row),hash(JSON.stringify(row)));}store.close();
  const base=refreshConfig({version:1,reviewedAt:at,cadence:{bilibiliHours:6,xiaohongshuHours:24},stateDirectories:{publications:old,collections:old},publications:targets.map(target=>({target,kind:"image-note"})),collections:[]});
  const {privateDirectory}=await import("../scripts/notion-sync/state.ts");await privateDirectory(root);
  await writeFile(join(root,"refresh-config.json"),JSON.stringify(base),{mode:0o600});await writeFile(join(root,"browser-links.json"),JSON.stringify({version:1,links:targets.map(t=>({publicationId:t.publicationId,url:httpUrl(Number(t.publicationId))}))}),{mode:0o600});
  const python=join(parent,"example-python");await writeFile(python,"",{mode:0o700});await prepareHttpNotes(root,out,python);
  const hp=JSON.parse(await readFile(join(out,"xiaohongshu-http.json"),"utf8"));await writeFile(join(root,"xiaohongshu-http.json"),JSON.stringify({...hp,enabled:true}),{mode:0o600});
  const policy={version:1,enabled:true,accountId:httpTarget().accountId,baseScopeDigest:hash(JSON.stringify(base)),discoveryHours:1,statisticsHours:1};await writeFile(join(root,"xiaohongshu-account.json"),JSON.stringify(policy),{mode:0o600});
  await writeFile(join(root,"cloud.env"),"SOCIAL_DATABASE_URL=postgresql://nb_social_worker:example@localhost/example\nDATABASE_TLS=disable\n",{mode:0o600});
  return {root,base,policy,dir:hp.stateDirectory as string,targets};
}
test("hourly statistics do not mutate the original shared cadence, and a directory check does not sample known notes",async t=>{
  const f=await fixture(t),before=await readFile(join(f.root,"refresh-config.json"));
  const scope=(await readHttpNoteScope(f.root)).scope;assert.equal(scope.cadence.xiaohongshuHours,1);assert.equal(f.base.cadence.xiaohongshuHours,24);
  const store=(await openStore(f.dir,true))!,plan=planRefresh(scope,{publication:t0=>store.latest(t0),collection:()=>null},now());store.close();assert.equal(plan.summary.due,30);
  const started=await handleXhsDiscovery(f.root,{op:"xiaohongshu-start",manual:false}) as {job:{id:string}};
  const directory={version:1,accountId:f.policy.accountId,observedAt:now(),cards:Array.from({length:30},(_,i)=>card(i+2)),boundaryFound:true};
  const result=await handleXhsDiscovery(f.root,{op:"xiaohongshu-submit",jobId:started.job.id,directory});assert.equal(result.pending,0);
  assert.equal((await handleXhsDiscovery(f.root,{op:"xiaohongshu-start",manual:false}) as {due:boolean}).due,false);
  assert.deepEqual(await runXhsDiscovery(f.root,undefined,{collect:async()=>{throw Error("known note must not be fetched");}}),{state:"idle",uploaded:0,pending:0});
  assert.deepEqual(await readFile(join(f.root,"refresh-config.json")),before);
});
test("single-note recovery replaces a still-valid multi-note lease and cannot repeat on restart or a manual event",async t=>{
  const f=await fixture(t);for(const target of f.targets.slice(0,2))await holdNoteLink(f.root,publicationKey(target),httpUrl(Number(target.publicationId)));
  await handleXhsBrowserNotes(f.root,{op:"xiaohongshu-notes-start",manual:false});await handleXhsBrowserNotes(f.root,{op:"xiaohongshu-notes-pause",code:"BROWSER_TIMEOUT"});
  const ticket=await armBrowserNoteRecovery(f.root,f.targets[0].publicationId);
  const leased=await handleXhsBrowserNotes(f.root,{op:"xiaohongshu-notes-start",manual:false}) as {job:{id:string;targets:{publicationId:string}[]}};
  assert.deepEqual(leased.job.targets.map(t=>t.publicationId),[f.targets[0].publicationId]);
  const second=await handleXhsBrowserNotes(f.root,{op:"xiaohongshu-notes-start",manual:true});assert.equal(second.status,"paused");assert(!('job' in second));
  const diagnostic={version:1,jobId:leased.job.id,targetDigest:hash(f.targets[0].publicationId),phase:"page-load",waitMs:20000,polls:20,lastTabStatus:"loading",frozen:null,discarded:null,lastState:null};
  await assert.rejects(handleXhsBrowserNotes(f.root,{op:"xiaohongshu-notes-pause",code:"BROWSER_PAGE_LOAD_TIMEOUT",diagnostic:{...diagnostic,url:httpUrl(2)}}),{code:"XHS_BROWSER_DIAGNOSTIC_INVALID"});
  await handleXhsBrowserNotes(f.root,{op:"xiaohongshu-notes-pause",code:"BROWSER_PAGE_LOAD_TIMEOUT",diagnostic});
  const status=await inspectBrowserNoteRecovery(f.root);assert.equal(status.code,"BROWSER_PAGE_LOAD_TIMEOUT");assert.equal(status.recovery!.status,"failed");assert.equal((status.diagnostic as {phase:string}).phase,"page-load");
  await assert.rejects(retryBrowserNoteUpload(f.root,ticket.id),{code:"XHS_BROWSER_RECOVERY_INVALID"});assert.equal((await inspectBrowserNoteRecovery(f.root)).status,"paused");
});
test("a recovered sample stays paused after ACK until its reader digest is explicitly accepted",async t=>{
  const f=await fixture(t);await holdNoteLink(f.root,publicationKey(f.targets[0]),httpUrl(2));
  await handleXhsBrowserNotes(f.root,{op:"xiaohongshu-notes-start",manual:false});await handleXhsBrowserNotes(f.root,{op:"xiaohongshu-notes-pause",code:"BROWSER_TIMEOUT"});
  const ticket=await armBrowserNoteRecovery(f.root,f.targets[0].publicationId),leased=await handleXhsBrowserNotes(f.root,{op:"xiaohongshu-notes-start",manual:false}) as {job:{id:string}};
  const n=httpState(2).note.noteDetailMap[httpTarget(2).publicationId]!.note;
  const snapshot={version:1,source:"browser-note-state",observedAt:now(),pageUrl:httpTarget(2).url,note:{noteId:n.noteId,userId:n.user.userId,type:n.type,title:n.title,time:n.time,lastUpdateTime:null,coverUrl:null,interactInfo:n.interactInfo}};
  await handleXhsBrowserNotes(f.root,{op:"xiaohongshu-notes-submit",jobId:leased.job.id,snapshots:[snapshot]});
  await handleXhsBrowserNotes(f.root,{op:"xiaohongshu-notes-pause",code:"CLOUD_UPLOAD_FAILED"});
  const key=publicationKey(f.targets[0]);await ingestAcceptedBrowserNotes(f.root,[key],hash(JSON.stringify(f.policy)));const store=(await openStore(f.dir))!;
  const latest=store.latest(f.targets[0])!,sha=hash(JSON.stringify(latest));assert(!store.acknowledgedFor(f.targets[0],sha));assert(store.acknowledge(key,sha));assert(store.acknowledgedFor(f.targets[0],sha));assert(!store.acknowledgedFor(f.targets[0],"0".repeat(64)));store.close();
  // Simulates an ACK received through the ordinary HTTP lane; no fresh sample or cloud session is needed.
  const uploaded=await retryBrowserNoteUpload(f.root,ticket.id) as {code:string;uploaded:number};assert.equal(uploaded.code,"BROWSER_RECOVERY_ACCEPTED");assert.equal(uploaded.uploaded,0);
  assert.equal((await handleXhsBrowserNotes(f.root,{op:"xiaohongshu-notes-start",manual:true})).status,"paused");
  await assert.rejects(finishBrowserNoteRecovery(f.root,ticket.id,"0".repeat(64)),{code:"ACK_MISMATCH"});
  await finishBrowserNoteRecovery(f.root,ticket.id,sha);assert.equal((await inspectBrowserNoteRecovery(f.root)).recovery,null);assert.equal((await inspectBrowserNoteRecovery(f.root)).status,"complete");
});
test("an expired recovery does not clear the old pause or open a new lease",async t=>{
  const f=await fixture(t);await holdNoteLink(f.root,publicationKey(f.targets[0]),httpUrl(2));await handleXhsBrowserNotes(f.root,{op:"xiaohongshu-notes-start",manual:false});
  await handleXhsBrowserNotes(f.root,{op:"xiaohongshu-notes-pause",code:"BROWSER_TIMEOUT"});const ticket=await armBrowserNoteRecovery(f.root,f.targets[0].publicationId);
  const result=await handleXhsBrowserNotes(f.root,{op:"xiaohongshu-notes-start",manual:false},()=>new Date(Date.now()+31*60000).toISOString());assert.equal(result.code,"BROWSER_RECOVERY_EXPIRED");assert(!('job' in result));
  await cancelBrowserNoteRecovery(f.root,ticket.id);const status=await inspectBrowserNoteRecovery(f.root);assert.equal(status.status,"paused");assert.equal(status.code,"BROWSER_RECOVERY_EXPIRED");assert.equal(status.recovery,null);
});
test("new IDs are queued once, same leased submission replays, and changed replay/foreign author/gaps are rejected",async t=>{
  const f=await fixture(t),started=await handleXhsDiscovery(f.root,{op:"xiaohongshu-start",manual:false}) as {job:{id:string}};
  const directory={version:1,accountId:f.policy.accountId,observedAt:now(),cards:[card(32),...Array.from({length:30},(_,i)=>card(i+2))],boundaryFound:true};
  assert.deepEqual(newDirectoryCards(xhsDirectory(directory,f.policy.accountId,now()),f.targets.map(t0=>t0.publicationId)),[card(32)]);
  const msg={op:"xiaohongshu-submit",jobId:started.job.id,directory},first=await handleXhsDiscovery(f.root,msg);assert.equal(first.pending,1);assert.deepEqual(await handleXhsDiscovery(f.root,msg),first);
  await assert.rejects(handleXhsDiscovery(f.root,{...msg,directory:{...directory,observedAt:new Date(Date.now()+1).toISOString()}}),{code:"BRIDGE_JOB_REPLAY_CHANGED"});
  assert.throws(()=>xhsDirectory({...directory,accountId:"0".repeat(24)},f.policy.accountId,now()),{code:"XHS_DIRECTORY_INVALID"});
  assert.throws(()=>xhsDirectory({...directory,boundaryFound:false},f.policy.accountId,now()),{code:"XHS_DIRECTORY_GAP"});
});
test("one unavailable note keeps old numbers while other due notes still upload",async t=>{
  const f=await fixture(t),scope=(await readHttpNoteScope(f.root)).scope,store=(await openStore(f.dir))!,old=store.latest(f.targets[0]!)!;let calls=0;
  const report=await executeRefresh(scope,{publications:store,collections:null,checkScope:async()=>{},saveReview:async()=>{},progress:async()=>{},sendCollection:async()=>{throw Error("no collections");},sendPublication:async p=>({key:p.key,sha256:p.sha256})},
    {platform:"xiaohongshu",limit:2,keys:f.targets.slice(0,2).map(publicationKey),spacingMs:0,collectHttpNote:async target=>{calls++;if(target.publicationId===old.publicationId)throw new SocialSyncError("SOURCE_NOTE_UNAVAILABLE");return httpNoteObservation(httpHtml(Number(target.publicationId)),target,now());}});
  assert.equal(calls,2);assert.equal(report.paused,false);assert.equal(report.uploaded,1);assert.equal(report.failed,0);assert.equal(report.reviewRequired,1);assert.deepEqual(store.latest(f.targets[0]!),old);store.close();
});
test("a link hold is bound to the failed locator and preserves only safe aggregate metadata",async t=>{
  const f=await fixture(t),key=publicationKey(f.targets[0]!);await holdNoteLink(f.root,key,httpUrl(2));const holds=await readNoteLinkHolds(f.root);
  assert.equal(holds.length,1);assert.equal(holds[0]!.linkSha256,hash(httpUrl(2)));assert(!JSON.stringify(holds).includes("xsec_token"));
  assert.notEqual(holds[0]!.linkSha256,hash(card(2).url));
});
test("new-note upload uncertainty preserves its pending sample and explicit recovery does not re-fetch",async t=>{
  const f=await fixture(t),start=await handleXhsDiscovery(f.root,{op:"xiaohongshu-start",manual:false}) as {job:{id:string}};
  await writeFile(join(f.root,"social-cover-policy.json"),JSON.stringify({version:1,enabled:true,mode:"retained"}),{mode:0o600});
  await handleXhsDiscovery(f.root,{op:"xiaohongshu-submit",jobId:start.job.id,directory:{version:1,accountId:f.policy.accountId,observedAt:now(),cards:[card(32),...Array.from({length:30},(_,i)=>card(i+2))],boundaryFound:true}});
  let calls=0,fail=true;
  const session=()=>new CycleCloudSession(undefined,{connect:async()=>({close:async()=>{},sql:{query:async<T>(sql:string,values?:unknown[])=>{
    if(sql.includes("current_user"))return {rows:[{role:"nb_social_worker",login:"nb_social_worker",version:1,http_note_version:1,xhs_account_version:1,xhs_account_enabled:true,elevated:false}] as T[]};
    if(fail)throw Error("lost response");return {rows:[{key:values![0],sha256:values![1]}] as T[]};
  }}})},{httpNotes:true,xhsAccount:{accountId:f.policy.accountId,link:()=>({url:card(32).url,checkedAt:now()})}});
  const collect=async(target:ReturnType<typeof automaticNoteTarget>)=>{calls++;return httpNoteObservation(httpHtml(32),target,now());};
  await assert.rejects(runXhsDiscovery(f.root,undefined,{cloud:session(),collect}),{code:"CLOUD_UPLOAD_FAILED"});
  assert.equal(await openCoverQueue(f.root,true),null);
  const store=(await openStore(f.dir,true))!;assert.equal(store.pendingFor(automaticNoteTarget(f.policy.accountId,card(32).publicationId))!==null,true);store.close();
  const state=(await readXhsDiscoveryState(f.root,hash(JSON.stringify(f.policy))))!;assert.equal(state.status,"paused");state.status="complete";state.code=null;
  await writeFile(join(f.root,"discovery-xiaohongshu/state.json"),JSON.stringify(state),{mode:0o600});fail=false;
  const resumed=await runXhsDiscovery(f.root,undefined,{cloud:session(),collect});assert.equal(resumed.uploaded,1);assert.equal(calls,1);
  const covers=(await openCoverQueue(f.root,true))!;try{assert.equal(covers.summary(now()).pending,1);}finally{covers.close();}
});
test("a pinned known first card cannot stop a page of new notes; only this task's tab is closed",async()=>{
  const known=Array.from({length:30},(_,i)=>card(i+2).publicationId),first=[card(2),...Array.from({length:29},(_,i)=>card(i+32))],second=[...first,...Array.from({length:30},(_,i)=>card(i+2))];
  let scrolled=0,closed=0;
  const api={tabs:{create:async()=>({id:42}),get:async()=>({status:"complete",url:`https://www.xiaohongshu.com/user/profile/${httpTarget().accountId}`}),remove:async(id:number)=>{assert.equal(id,42);closed++;}},scripting:{executeScript:async(o:{func:{name:string}})=>{if(o.func.name==="scrollXhsDirectory"){scrolled++;return [{frameId:0,result:{scrolled:true}}];}return [{frameId:0,result:{cards:scrolled?second:first,observedAt:now()}}];}}};
  const directory=await captureXhsDirectory(api,{id:"00000000-0000-0000-0000-000000000001",accountId:httpTarget().accountId,knownIds:known,expiresAt:new Date(Date.now()+60000).toISOString()},{sleep:async()=>{}});
  assert.equal(scrolled,1);assert.equal(closed,1);assert.equal(directory.cards.length,59);
});
test("new notes and authenticated exceptions use leased browser evidence, preserve work IDs, and do not enroll foreign snapshots",async t=>{
  const f=await fixture(t),directoryJob=await handleXhsDiscovery(f.root,{op:"xiaohongshu-start",manual:false}) as {job:{id:string}};
  await handleXhsDiscovery(f.root,{op:"xiaohongshu-submit",jobId:directoryJob.job.id,directory:{version:1,accountId:f.policy.accountId,observedAt:now(),cards:[card(32),...Array.from({length:30},(_,i)=>card(i+2))],boundaryFound:true}});
  await holdNoteLink(f.root,publicationKey(f.targets[0]!),httpUrl(2));
  const leased=await handleXhsBrowserNotes(f.root,{op:"xiaohongshu-notes-start",manual:false}) as {job:{id:string;targets:{publicationId:string;accountId:string;url:string}[]}};
  assert.equal(leased.job.targets.length,2);assert.equal(leased.job.targets[0]!.url,candidateNoteShareUrl(card(32).url,automaticNoteTarget(f.policy.accountId,card(32).publicationId)));
  const snapshots=leased.job.targets.map(target=>{const n=httpState(Number(target.publicationId)).note.noteDetailMap[target.publicationId]!.note;return {version:1,source:"browser-note-state",observedAt:now(),pageUrl:`https://www.xiaohongshu.com/explore/${target.publicationId}`,note:{noteId:n.noteId,userId:n.user.userId,type:n.type,title:n.title,time:n.time,lastUpdateTime:null,coverUrl:null,interactInfo:n.interactInfo}};});
  const bad=structuredClone(snapshots);bad[1]!.note.userId="9".repeat(24);
  await assert.rejects(handleXhsBrowserNotes(f.root,{op:"xiaohongshu-notes-submit",jobId:leased.job.id,snapshots:bad}),{code:"IDENTITY_MISMATCH"});
  assert.equal(await readBrowserNoteCapture(f.root,automaticNoteTarget(f.policy.accountId,card(32).publicationId),hash(JSON.stringify(f.policy))),null);
  const msg={op:"xiaohongshu-notes-submit",jobId:leased.job.id,snapshots};const received=await handleXhsBrowserNotes(f.root,msg);assert.equal(received.status,"captured");await handleXhsBrowserNotes(f.root,msg);
  const captured=(await readBrowserNoteCapture(f.root,automaticNoteTarget(f.policy.accountId,card(32).publicationId),hash(JSON.stringify(f.policy))))!;
  assert.equal(captured.source,"browser-note-state");assert.equal(captured.observedAt,snapshots[0]!.observedAt);assert.equal(captured.websitePublicationApproved,false);
  assert.deepEqual(await readBrowserOnlyIds(f.root,hash(JSON.stringify(f.policy))),[card(2).publicationId]);
  const key=publicationKey(f.targets[0]!),file=join(f.root,"xiaohongshu-browser-notes",`${key}.json`),packet=JSON.parse(await readFile(file,"utf8"));
  packet.receivedAt=new Date(Date.now()-9*60000).toISOString();packet.snapshot.observedAt=new Date(Date.now()-10*60000).toISOString();packet.sha256=hash(JSON.stringify(packet.snapshot));await writeFile(file,JSON.stringify(packet),{mode:0o600});
  await ingestAcceptedBrowserNotes(f.root,[key],hash(JSON.stringify(f.policy)));const store=(await openStore(f.dir,true))!;
  assert.equal(store.latest(f.targets[0]!)!.observedAt,packet.snapshot.observedAt);assert(store.pendingFor(f.targets[0]!));store.close();
});
test("external upload failures latch ordinary HTTP checks and explicit browser recovery preserves the failed receipt",async t=>{
  const f=await fixture(t);await recordExternalHttpPause(f.root,hash(JSON.stringify((await readHttpNoteScope(f.root)).scope)),"CLOUD_UPLOAD_FAILED","upload");
  const h=parseHttpHealth(JSON.parse(await readFile(join(f.root,"cycle-xiaohongshu-http/health.json"),"utf8")));assert(h.recovery.manualRequired);assert.equal(h.lastUploadedAt,null);assert.equal(h.cycle,null);
  await handleXhsBrowserNotes(f.root,{op:"xiaohongshu-notes-pause",code:"SOURCE_BLOCKED"});
  assert.equal((await handleXhsBrowserNotes(f.root,{op:"xiaohongshu-notes-start",manual:false})).status,"paused");
  await resumeBrowserNoteLane(f.root,hash(JSON.stringify(f.policy)));assert.equal((await handleXhsBrowserNotes(f.root,{op:"xiaohongshu-notes-start",manual:false})).status,"complete");
});
test("SSR empty Maps are inert and defer only the missing note; redirects must be note-specific and stay on the expected host",()=>{
  const html='<script>window.__INITIAL_STATE__={"note":{"currentNoteId":"'+httpTarget().publicationId+'","noteDetailMap":new Map([])},"label":"new Map([])"}</script>';
  assert.equal(httpNoteState(html).label,"new Map([])");assert.throws(()=>httpNoteObservation(html,httpTarget()),{code:"NOTE_BROWSER_REQUIRED"});
  assert.throws(()=>httpNoteState(html.replace("new Map([])","new Map(globalThis.privateData)")),{code:"PAGE_STATE_INVALID"});
  const script=fileURLToPath(new URL('../scripts/social-sync/python/xiaohongshu_http.py',import.meta.url));
  const code="import importlib.util,sys\ns=importlib.util.spec_from_file_location('probe',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nu='https://www.xiaohongshu.com/explore/'+'0'*23+'2'\nr='/explore?target_note_id='+'0'*23+'2'+'&undertake_note_error=%25E8%25AF%25A5%25E5%2586%2585%25E5%25AE%25B9%25E6%259A%2582%25E6%2597%25B6%25E6%2597%25A0%25E6%25B3%2595%25E6%259F%25A5%25E7%259C%258B'\nassert m.redirect_code(r,u)=='SOURCE_NOTE_UNAVAILABLE'\nassert m.redirect_code('https://example.invalid'+r,u)=='SOURCE_REDIRECT'\nassert m.redirect_code(r+'&captcha=1',u)=='SOURCE_REDIRECT'\nassert m.redirect_code(r.replace('target_note_id='+('0'*23+'2'),'target_note_id='+('0'*23+'3')),u)=='SOURCE_REDIRECT'\n";
  const result=spawnSync('python3',['-I','-B','-c',code,script],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
});
test("accepted browser evidence survives shared-root contention without creating or overwriting a manual pause",async t=>{
  const f=await fixture(t),{acquireLock}=await import('../scripts/notion-sync/state.ts');
  await holdNoteLink(f.root,publicationKey(f.targets[0]!),httpUrl(2));
  const leased=await handleXhsBrowserNotes(f.root,{op:'xiaohongshu-notes-start',manual:false}) as {job:{id:string}};
  const n=httpState(2).note.noteDetailMap[httpTarget(2).publicationId]!.note;
  const snapshot={version:1,source:'browser-note-state',observedAt:now(),pageUrl:httpTarget(2).url,note:{noteId:n.noteId,userId:n.user.userId,type:n.type,title:n.title,time:n.time,lastUpdateTime:null,coverUrl:null,interactInfo:n.interactInfo}};
  await handleXhsBrowserNotes(f.root,{op:'xiaohongshu-notes-submit',jobId:leased.job.id,snapshots:[snapshot]});
  const prepare=CycleCloudSession.prototype.preparePublications;let prepares=0;
  CycleCloudSession.prototype.preparePublications=async()=>{prepares++;};
  const release=await acquireLock(f.root,'00000000-0000-0000-0000-000000000001');
  try{
    const first=await handleXhsBrowserNotes(f.root,{op:'xiaohongshu-notes-upload'}) as {deferred:boolean};assert.equal(first.deferred,true);
    await assert.rejects(readFile(join(f.root,'cycle-xiaohongshu-http/health.json')),{code:'ENOENT'});
    await recordExternalHttpPause(f.root,hash(JSON.stringify((await readHttpNoteScope(f.root)).scope)),'SOURCE_VERIFICATION_REQUIRED','capture');
    const before=await readFile(join(f.root,'cycle-xiaohongshu-http/health.json'));
    const second=await handleXhsBrowserNotes(f.root,{op:'xiaohongshu-notes-upload'}) as {deferred:boolean};assert.equal(second.deferred,true);
    assert.deepEqual(await readFile(join(f.root,'cycle-xiaohongshu-http/health.json')),before);
    assert.equal((await readBrowserNoteCapture(f.root,f.targets[0]!,hash(JSON.stringify(f.policy))))!.observedAt,snapshot.observedAt);
    assert.equal(prepares,2);
  }finally{CycleCloudSession.prototype.preparePublications=prepare;await release();}
});

test("browser upload preserves its failure and pause when configuration disappears and closing also fails",async t=>{
 const f=await fixture(t);
 await holdNoteLink(f.root,publicationKey(f.targets[0]!),httpUrl(2));
 const leased=await handleXhsBrowserNotes(f.root,{op:"xiaohongshu-notes-start",manual:false}) as {job:{id:string}};
 const n=httpState(2).note.noteDetailMap[httpTarget(2).publicationId]!.note;
 const snapshot={version:1,source:"browser-note-state",observedAt:now(),pageUrl:httpTarget(2).url,note:{noteId:n.noteId,userId:n.user.userId,type:n.type,title:n.title,time:n.time,lastUpdateTime:null,coverUrl:null,interactInfo:n.interactInfo}};
 await handleXhsBrowserNotes(f.root,{op:"xiaohongshu-notes-submit",jobId:leased.job.id,snapshots:[snapshot]});
 const original=new SocialSyncError("CLOUD_UPLOAD_FAILED");let closed=0;
 t.mock.method(CycleCloudSession.prototype,"preparePublications",async()=>{
  await rm(join(f.root,"refresh-config.json"));throw original;
 });
 t.mock.method(CycleCloudSession.prototype,"close",async()=>{closed++;throw Error("private close failure");});
 await assert.rejects(handleXhsBrowserNotes(f.root,{op:"xiaohongshu-notes-upload"}),error=>error===original);
 assert.equal(closed,1);
 const health=parseHttpHealth(JSON.parse(await readFile(join(f.root,"cycle-xiaohongshu-http/health.json"),"utf8")));
 assert.equal(health.recovery.code,"CLOUD_UPLOAD_FAILED");assert.equal(health.recovery.stage,"upload");
 for(const lock of ["cycle-xiaohongshu-http/worker.lock","xiaohongshu-browser-notes/worker.lock"])
  await assert.rejects(readFile(join(f.root,lock)),{code:"ENOENT"});
});
