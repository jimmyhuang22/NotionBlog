import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,chmod,mkdir,writeFile,readFile,copyFile,rm,realpath}from"node:fs/promises";
import{join}from"node:path";
import{tmpdir}from"node:os";
import{readBilibiliApiPolicy,requireApiMetadataTransfer,bilibiliMetadataRoot}from"../scripts/social-sync/bilibili-api-policy.ts";
import{readRefreshScope}from"../scripts/social-sync/refresh-scope.ts";
import{refreshConfig}from"../scripts/social-sync/refresh.ts";
import{hash,publicationKey}from"../scripts/social-sync/model.ts";
import{observation}from"../scripts/social-sync/bilibili.ts";
import{openStore}from"../scripts/social-sync/store.ts";
import{openCollectionStore}from"../scripts/social-sync/collection-store.ts";
import{CycleCloudSession}from"../scripts/social-sync/cycle-cloud.ts";
import{executeAtRoot}from"../scripts/social-sync/execute-cli.ts";
import{handleBilibiliDiscovery}from"../scripts/social-sync/bilibili-discovery-bridge.ts";
import{captureApiDiscoveredVideo}from"../scripts/social-sync/bilibili-api-collect.ts";
import{verifyCollectionPlaybacks}from"../scripts/social-sync/collection-playback.ts";
import{collectionKey}from"../scripts/social-sync/collection.ts";
import{runBilibiliCycle}from"../scripts/social-sync/bilibili-cycle.ts";
import{inspectRefresh}from"../scripts/social-sync/refresh-state.ts";
import type{RefreshReport}from"../scripts/social-sync/refresh-executor.ts";
import{apiTarget,apiAt,apiVideoSample,apiBody,apiHtml,apiSeasonTarget}from"./helpers/social-bilibili-api-samples.ts";
const raw="SOCIAL_DATABASE_URL=postgresql://nb_social_worker:fictional@localhost/example\nDATABASE_TLS=disable\n";
const save=(f:string,v:unknown)=>writeFile(f,JSON.stringify(v)+"\n",{mode:0o600});
async function fixture(t:{after:(f:()=>Promise<void>)=>void}){
 const root=await realpath(await mkdtemp(join(tmpdir(),"bili-api-runtime-")));await chmod(root,0o700);t.after(()=>rm(root,{recursive:true,force:true}));
 for(const d of ['old-pubs','old-cols','api-pubs','api-cols'])await mkdir(join(root,d),{mode:0o700});
 const base=refreshConfig({version:1,reviewedAt:apiAt,cadence:{bilibiliHours:6,xiaohongshuHours:24},stateDirectories:{publications:join(root,'old-pubs'),collections:join(root,'old-cols')},publications:[{target:apiTarget,kind:'video'}],collections:[]});
 await save(join(root,'refresh-config.json'),base);await writeFile(join(root,'cloud.env'),raw,{mode:0o600});const old=await openStore(base.stateDirectories.publications);old!.ingest(observation(apiHtml(),apiTarget,apiAt));old!.acknowledge(publicationKey(apiTarget),hash(JSON.stringify(old!.latest(apiTarget))));old!.close();(await openCollectionStore(base.stateDirectories.collections))!.close();
 const policy={version:1 as const,enabled:true,baseScopeDigest:hash(JSON.stringify(base)),stateDirectories:{publications:join(root,'api-pubs'),collections:join(root,'api-cols')}};
 await copyFile(join(base.stateDirectories.publications,'social.sqlite'),join(policy.stateDirectories.publications,'social.sqlite'));await copyFile(join(base.stateDirectories.collections,'social-collections.sqlite'),join(policy.stateDirectories.collections,'social-collections.sqlite'));
 await save(join(root,'bilibili-api.json'),policy);let queries=0,connections=0,closes=0,capability=1,ingests=0;
 const cloud=()=>new CycleCloudSession(undefined,{connect:async()=>{connections++;return{sql:{query:async<T>(text:string,values?:unknown[])=>{queries++;if(text.includes('current_user'))return{rows:[{role:'nb_social_worker',login:'nb_social_worker',elevated:false,version:1,bilibili_api_version:capability}]as T[]};ingests++;return{rows:[{key:values![0],sha256:values![1]}]as T[]};}},close:async()=>{closes++;}};}},{bilibiliApi:true});
 return{root,base,policy,cloud,setCapability:(n:number)=>{capability=n;},counts:()=>({queries,connections,closes,ingests})};
}
test("API scope redirects only Bilibili to isolated state while default-off leaves old readers intact",async t=>{
 const f=await fixture(t);assert.deepEqual((await readRefreshScope(f.root,'bilibili')).stateDirectories,f.policy.stateDirectories);assert.deepEqual((await readRefreshScope(f.root,'xiaohongshu')).stateDirectories,f.base.stateDirectories);
  await save(join(f.root,'bilibili-api.json'),{...f.policy,enabled:false,baseScopeDigest:'0'.repeat(64),stateDirectories:f.base.stateDirectories});assert.deepEqual(await readRefreshScope(f.root,'bilibili'),f.base);
 for(const directories of [{...f.policy.stateDirectories,publications:f.base.stateDirectories.publications},{...f.policy.stateDirectories,collections:f.policy.stateDirectories.publications}]){await save(join(f.root,'bilibili-api.json'),{...f.policy,stateDirectories:directories});await assert.rejects(readBilibiliApiPolicy(f.root,f.base),{code:'BILIBILI_API_STATE_OVERLAP'});}
 await save(join(f.root,'bilibili-api.json'),f.policy);await save(join(f.root,'xiaohongshu-http.json'),{stateDirectory:f.policy.stateDirectories.publications});await assert.rejects(readBilibiliApiPolicy(f.root,f.base),{code:'BILIBILI_API_STATE_OVERLAP'});
});
test("source GET and local mutation require both capabilities and the exact prepared credentials/scope",async t=>{
 const f=await fixture(t),scope=await readRefreshScope(f.root,'bilibili'),digest=hash(JSON.stringify(scope));let calls=0;const request=(async()=>{calls++;return new Response(apiBody(),{headers:{'content-type':'application/json'}});})as typeof fetch;
 const before=await readFile(join(f.policy.stateDirectories.publications,'social.sqlite'));
 const cold=f.cloud();await assert.rejects(executeAtRoot(f.root,{platform:'bilibili',limit:1,keys:[publicationKey(apiTarget)],bilibiliApi:true,cloudSession:cold,request}),{code:'BILIBILI_API_PROTOCOL_REQUIRED'});assert.equal(calls,0);assert.deepEqual(await readFile(join(f.policy.stateDirectories.publications,'social.sqlite')),before);
 f.setCapability(0);await assert.rejects(cold.prepareBilibiliApi(raw,digest,false),{code:'BILIBILI_API_PROTOCOL_REQUIRED'});await cold.close();assert.equal(calls,0);
 f.setCapability(1);const wrong=f.cloud();await wrong.prepareBilibiliApi(raw,'a'.repeat(64),false);await assert.rejects(executeAtRoot(f.root,{platform:'bilibili',limit:1,bilibiliApi:true,cloudSession:wrong,request}),{code:'BILIBILI_API_PROTOCOL_REQUIRED'});await wrong.close();assert.equal(calls,0);
  const custom=f.cloud();await custom.prepareBilibiliApi(raw,hash(JSON.stringify(f.base)),false);await assert.rejects(executeAtRoot(f.root,{platform:'bilibili',limit:1,bilibiliApi:true,scopeProvider:async()=>f.base,cloudSession:custom,request}),{code:'BILIBILI_API_STATE_OVERLAP'});await custom.close();assert.equal(calls,0);
  const mode=f.cloud();await mode.prepareBilibiliApi(raw,digest,false);await save(join(f.root,'bilibili-account.json'),{version:1,enabled:true,accountId:'10001',baseScopeDigest:hash(JSON.stringify(f.base))});assert.equal(hash(JSON.stringify(await readRefreshScope(f.root,'bilibili'))),digest);
  await assert.rejects(executeAtRoot(f.root,{platform:'bilibili',limit:1,bilibiliApi:true,cloudSession:mode,request}),{code:'BILIBILI_API_PROTOCOL_REQUIRED'});await mode.close();assert.equal(calls,0);
});
test("legacy review holds remain effective without putting JSON review records into the legacy root",async t=>{
 const f=await fixture(t),row={...observation(apiHtml(),apiTarget,apiAt),workId:'other-work'},key=publicationKey(apiTarget);
 await save(join(f.root,`review-publication-${key}.json`),{version:1,candidate:{type:'publication',key,value:row}});
 const current=await inspectRefresh(f.root,'bilibili');assert.equal(current.reviewRequired,1);assert.equal(current.keys.length,0);
 const cloud=f.cloud();await cloud.prepareBilibiliApi(raw,current.scopeDigest,false);let calls=0;
 const report=await executeAtRoot(f.root,{platform:'bilibili',limit:1,bilibiliApi:true,cloudSession:cloud,request:async()=>{calls++;throw Error('unexpected');}});assert('entries'in report);assert.equal(report.selected,0);assert.equal(calls,0);await cloud.close();
});
test("API transient failures persist a manual latch instead of automatic backoff retries",async t=>{
 const f=await fixture(t),scope=await readRefreshScope(f.root,'bilibili'),digest=hash(JSON.stringify(scope));let executions=0;const clock=new Date().toISOString();
 const ports={inspect:()=>inspectRefresh(f.root,'bilibili'),execute:async()=>{executions++;return{version:1,scopeDigest:digest,startedAt:clock,finishedAt:clock,selected:1,collected:0,resumed:0,uploaded:0,superseded:0,reviewRequired:0,failed:1,waitingBrowser:0,paused:true,cancelled:false,entries:[{key:publicationKey(apiTarget),type:'publication',status:'failed',code:'SOURCE_TIMEOUT',observedAt:null,sha256:null}]}as RefreshReport;},saveCycle:async()=>{},saveHealth:async()=>{}};
 const h=await runBilibiliCycle('resume',null,null,ports,{manualOnFailure:true});assert.equal(h.recovery.manualRequired,true);assert.equal(h.recovery.retryAt,null);await runBilibiliCycle('run',null,h,ports,{manualOnFailure:true});assert.equal(executions,1);
});
test("prepared root execution ACKs new provenance only in the isolated store",async t=>{
 const f=await fixture(t),legacy=await readFile(join(f.base.stateDirectories.publications,'social.sqlite')),scope=await readRefreshScope(f.root,'bilibili'),digest=hash(JSON.stringify(scope)),cloud=f.cloud();await cloud.prepareBilibiliApi(raw,digest,false);let calls=0;
 const report=await executeAtRoot(f.root,{platform:'bilibili',limit:1,keys:[publicationKey(apiTarget)],scopeDigest:digest,bilibiliApi:true,cloudSession:cloud,request:async()=>{calls++;return new Response(apiBody(),{headers:{'content-type':'application/json'}});}});assert('entries'in report);assert.equal(report.uploaded,1);assert.equal(calls,1);await cloud.close();assert.deepEqual(f.counts(),{queries:3,connections:1,closes:1,ingests:1});
 const store=await openStore(f.policy.stateDirectories.publications,true);try{assert.equal(store!.latest(apiTarget)!.source,'public-video-api-json');assert.equal(store!.status().pending,0);assert.equal(store!.status().samples,2);}finally{store!.close();}assert.deepEqual(await readFile(join(f.base.stateDirectories.publications,'social.sqlite')),legacy);
});
test("API capture failure stops the cycle after its first selected source",async t=>{
 const f=await fixture(t),scope=await readRefreshScope(f.root,'bilibili'),cloud=f.cloud();await cloud.prepareBilibiliApi(raw,hash(JSON.stringify(scope)),false);let calls=0;
 const report=await executeAtRoot(f.root,{platform:'bilibili',limit:1,bilibiliApi:true,cloudSession:cloud,request:async()=>{calls++;return new Response('{"code":-352}',{headers:{'content-type':'application/json'}});}});assert('entries'in report);assert.equal(report.paused,true);assert.equal(report.entries[0].code,'SOURCE_VERIFICATION_REQUIRED');assert.equal(calls,1);assert.equal(f.counts().ingests,0);await cloud.close();
});
test("old manual cycle/discovery state cannot be silently omitted during API preparation",async t=>{
 const f=await fixture(t),metadataRoot=bilibiliMetadataRoot(f.root,f.policy);for(const directory of ['cycle-bilibili','discovery-bilibili']as const)await mkdir(join(f.root,directory),{mode:0o700});
 await save(join(f.root,'cycle-bilibili/health.json'),{recovery:{manualRequired:true}});await assert.rejects(requireApiMetadataTransfer(f.root,metadataRoot,'cycle-bilibili','health.json'),{code:'BILIBILI_API_STATE_PREPARATION_REQUIRED'});
 await mkdir(join(metadataRoot,'cycle-bilibili'),{mode:0o700});await copyFile(join(f.root,'cycle-bilibili/health.json'),join(metadataRoot,'cycle-bilibili/health.json'));await requireApiMetadataTransfer(f.root,metadataRoot,'cycle-bilibili','health.json');
});
test("account discovery adopts only a validated new scope before first ingest and keeps legacy state untouched",async t=>{
 const f=await fixture(t),account={version:1,enabled:true,accountId:'10001',baseScopeDigest:hash(JSON.stringify(f.base))};await save(join(f.root,'bilibili-account.json'),account);const now=new Date().toISOString(),ports={now:()=>now,cloud:()=>f.cloud(),capture:async(accountId:string,id:string,signal?:AbortSignal,_request?:typeof fetch,known?:typeof apiTarget,captured?:Parameters<typeof captureApiDiscoveredVideo>[5])=>captureApiDiscoveredVideo(accountId,id,signal,async()=>new Response(apiBody({...apiVideoSample(),bvid:id}),{headers:{'content-type':'application/json'}}),known,captured)};
 const legacy=await readFile(join(f.base.stateDirectories.publications,'social.sqlite')),started=await handleBilibiliDiscovery(f.root,{op:'bilibili-start',manual:true},ports)as{job:{id:string}};
 await handleBilibiliDiscovery(f.root,{op:'bilibili-submit',jobId:started.job.id,pages:[{version:1,accountId:'10001',observedAt:now,page:1,pageSize:100,pages:1,total:2,ids:[apiTarget.publicationId,'BV0000000002']}]},ports);
 assert.equal(f.counts().ingests,1);assert.equal(f.counts().connections,1);assert.equal(f.counts().closes,1);assert.deepEqual(await readFile(join(f.base.stateDirectories.publications,'social.sqlite')),legacy);
});
test("API scope adoption cannot change credentials, reuse the old scope, or occur after an ingest",async t=>{
 const f=await fixture(t),cloud=f.cloud(),before='a'.repeat(64),after='b'.repeat(64);await cloud.prepareBilibiliApi(raw,before,true);
 assert.throws(()=>cloud.adoptDiscoveredBilibiliScope(raw+'\n',before,after),{code:'CLOUD_SESSION_INPUT_CHANGED'});cloud.adoptDiscoveredBilibiliScope(raw,before,after);assert.equal(cloud.hasPreparedBilibiliApi(raw,after),true);assert.equal(cloud.hasPreparedBilibiliApi(raw,before),false);
 const row={...observation(apiHtml(),apiTarget,new Date().toISOString()),source:'public-video-api-json' as const};await cloud.sendPublication(raw,after,{key:publicationKey(row),sha256:hash(JSON.stringify(row)),observation:row},undefined,async()=>{},true);
 assert.throws(()=>cloud.adoptDiscoveredBilibiliScope(raw,after,before),{code:'CLOUD_SESSION_INPUT_CHANGED'});await cloud.close();
});
test("playback JSON proof checks the complete member/date vector and uses the same bounded transport",async()=>{
 const key=collectionKey(apiSeasonTarget),publishedAt=new Date(1700000000*1000).toISOString();let calls=0,completed=0;
 const sql={query:async<T>(text:string)=>{if(text.includes('current_user'))return{rows:[{role:'nb_social_worker',login:'nb_social_worker',ready:true,elevated:false,bilibili_api_version:1}]as T[]};if(text.includes('pending_collection_playbacks'))return{rows:[{candidate:{key,sourceSha256:'0'.repeat(64),accountId:'10001',collectionId:'200',publicationId:apiTarget.publicationId,publishedAt,members:[{id:'BV0000000001',key:'x',publishedAt},{id:'BV0000000002',key:'y',publishedAt}],failureCode:null}}]as T[]};completed++;return{rows:[{accepted:true}]as T[]};}};
 const report=await verifyCollectionPlaybacks(sql,[key],'retained',{bilibiliApi:true,request:async url=>{calls++;assert.equal(new URL(String(url)).hostname,'api.bilibili.com');return new Response(apiBody(apiVideoSample(true)),{headers:{'content-type':'application/json'}});}});assert.equal(report.verified,1);assert.equal(calls,1);assert.equal(completed,1);
});
