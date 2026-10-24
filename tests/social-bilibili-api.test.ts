import test from "node:test";
import assert from "node:assert/strict";
import { apiVideoData, bilibiliApiUrl, fetchApiVideo, MAX_BILIBILI_API_BYTES } from "../scripts/social-sync/bilibili-api.ts";
import { observation, observationFromVideoData } from "../scripts/social-sync/bilibili.ts";
import { collectionFromVideoData, collectionFromPage, collectionCard, nextCollectionState } from "../scripts/social-sync/collection.ts";
import { classifyVideoData } from "../scripts/social-sync/bilibili-discovery.ts";
import { hash, validateObservation } from "../scripts/social-sync/model.ts";
import { collectionApiCoverSource } from "../scripts/social-media/sources.ts";
import {apiTarget,apiAt,apiVideoSample,apiBody,apiHtml,apiSeasonTarget}from"./helpers/social-bilibili-api-samples.ts";

test("JSON and SSR share field checks while retaining distinct true provenance and original digests",()=>{
  const raw=apiBody(),html=apiHtml(),api=observationFromVideoData(apiVideoData(raw,apiTarget),apiTarget,apiAt,"public-video-api-json",hash(raw)),ssr=observation(html,apiTarget,apiAt);
  assert.equal(api.source,"public-video-api-json");assert.equal(api.responseSha256,hash(raw));assert.equal(ssr.source,"public-video-page-ssr");assert.equal(ssr.responseSha256,hash(html));
  assert.deepEqual(api.metrics,ssr.metrics);assert.equal(api.metrics.likes,0);assert.equal(api.metrics.shares,null);assert.equal(api.websitePublicationApproved,false);validateObservation(api);validateObservation(ssr);
  assert.throws(()=>validateObservation({...api,source:"unverified"} as never),{code:"INVALID_DATA"});
});
test("anonymous JSON requires exact BV/owner and public unrestricted state",()=>{
  for(const change of [{bvid:"BV0000000002"},{owner:{mid:10002}}])assert.throws(()=>apiVideoData(apiBody({...apiVideoSample(),...change}),apiTarget),{code:"IDENTITY_MISMATCH"});
  for(const change of [{state:1},{state:undefined},{is_upower_exclusive:true},{is_upower_preview:true},{is_pay_season:true},{is_only_self:true},{rights:{pay:1}},{rights:{ugc_pay:1}},{rights:{ugc_pay_preview:1}}])assert.throws(()=>apiVideoData(apiBody({...apiVideoSample(),...change}),apiTarget),{code:"SOURCE_BLOCKED"});
  for(const code of [-352,-403,-404,1])assert.throws(()=>apiVideoData(JSON.stringify({code,message:"private source diagnostic"}),apiTarget),e=>!(e as Error).message.includes("private"));
  assert.throws(()=>apiVideoData('{"code":0}',apiTarget));assert.throws(()=>apiVideoData("<html/>",apiTarget),{code:"BILIBILI_API_RESPONSE_INVALID"});
});
test("JSON missing metrics and dates remain null, without carrying an older sample",()=>{
  const data=apiVideoSample() as Record<string,unknown>;delete data.pubdate;delete(data.stat as Record<string,unknown>).view;
  const raw=apiBody(data),row=observationFromVideoData(apiVideoData(raw,apiTarget),apiTarget,apiAt,"public-video-api-json",hash(raw));assert.equal(row.publishedAt,null);assert.equal(row.metrics.views,null);
});
test("one fixed-host GET omits login credentials and never follows a redirect or falls back",async()=>{
  let calls=0;const request=(async(url,init)=>{calls++;assert.equal(url,bilibiliApiUrl(apiTarget));assert.equal(init?.redirect,"manual");assert.equal(init?.credentials,"omit");assert.equal(new Headers(init?.headers).has("cookie"),false);return new Response(apiBody(),{headers:{"content-type":"application/json; charset=utf-8"}});}) as typeof fetch;
  const r=await fetchApiVideo(apiTarget,undefined,request);assert.equal(r.videoData.bvid,apiTarget.publicationId);assert.equal(calls,1);
  await assert.rejects(fetchApiVideo({...apiTarget,url:"https://example.invalid/"},undefined,request));assert.equal(calls,1);
  for(const[status,code]of [[302,"SOURCE_REDIRECT"],[401,"SOURCE_BLOCKED"],[412,"SOURCE_BLOCKED"],[429,"RATE_LIMITED"]]as const){let n=0;await assert.rejects(fetchApiVideo(apiTarget,undefined,async()=>{n++;return new Response(null,{status});}),{code});assert.equal(n,1);}
});
test("JSON declared and streamed overflow cancel the response and invalid UTF8 cannot become JSON",async()=>{
  for(const declared of [true,false]){let cancelled=false;const body=new ReadableStream<Uint8Array>({start(c){if(!declared){c.enqueue(new Uint8Array(MAX_BILIBILI_API_BYTES));c.enqueue(new Uint8Array([1]));}},cancel(){cancelled=true;}});
    await assert.rejects(fetchApiVideo(apiTarget,undefined,async()=>new Response(body,{headers:{"content-type":"application/json",...(declared?{"content-length":String(MAX_BILIBILI_API_BYTES+1)}:{})}})),{code:"PAGE_TOO_LARGE"});assert.equal(cancelled,true);}
  await assert.rejects(fetchApiVideo(apiTarget,undefined,async()=>new Response(new Uint8Array([255]),{headers:{"content-type":"application/json"}})),{code:"BILIBILI_API_RESPONSE_INVALID"});
  await assert.rejects(fetchApiVideo(apiTarget,AbortSignal.abort()),{code:"CANCELLED"});
});
test("complete JSON rosters preserve season totals, dates and existing card semantics",()=>{
  const data=apiVideoSample(true),raw=apiBody(data),a=collectionFromVideoData(apiVideoData(raw,apiTarget),apiSeasonTarget,apiAt,"bilibili-collection-api-json",hash(raw)),s=collectionFromPage(apiHtml(data),apiSeasonTarget,apiAt);
  assert.equal(a.source,"bilibili-collection-api-json");assert.equal(a.responseSha256,hash(raw));assert.equal(a.metrics.views,999);assert.equal(a.members.length,2);assert.deepEqual(collectionCard(nextCollectionState(null,a)),collectionCard(nextCollectionState(null,s)));
  const incomplete=apiVideoSample(true);incomplete.ugc_season!.ep_count=3;assert.throws(()=>collectionFromVideoData(incomplete,apiSeasonTarget,apiAt,"bilibili-collection-api-json",hash(raw)),{code:"COLLECTION_INCOMPLETE"});
  const mixed=apiVideoSample(true);mixed.ugc_season!.sections[0].episodes[1].arc.author.mid=10002;assert.throws(()=>collectionFromVideoData(mixed,apiSeasonTarget,apiAt,"bilibili-collection-api-json",hash(raw)),{code:"IDENTITY_MISMATCH"});
});
test("account classification and the media sidecar use the same raw JSON and exact snapshot",()=>{
  const data=apiVideoSample(true),raw=apiBody(data),c=classifyVideoData(apiVideoData(raw,apiTarget),apiTarget,apiAt,"public-video-api-json",hash(raw));assert.equal(c.type,"collection");if(c.type!=="collection")return;
  const cover=collectionApiCoverSource(raw,c.value.target,apiAt,hash(JSON.stringify(c.value)));assert.equal(cover.kind,"collection");assert.equal(cover.url,data.ugc_season!.cover);
  assert.throws(()=>collectionApiCoverSource(raw,c.value.target,apiAt,"0".repeat(64)),{code:"COVER_COLLECTION_SOURCE_MISMATCH"});
  const v=apiVideoSample();v.pages.push({cid:1002});v.videos=2;const multi=classifyVideoData(v,apiTarget,apiAt,"public-video-api-json",hash(apiBody(v)));assert.equal(multi.type,"collection");if(multi.type==="collection"){assert.equal(multi.value.target.kind,"multi-part");assert.equal(multi.value.metrics.views,5);}
});
