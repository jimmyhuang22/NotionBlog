import test from "node:test";
import assert from "node:assert/strict";
import type { SocialTimelineWork } from "../contracts/social-timeline.ts";
import { collectionCard, nextCollectionState } from "../scripts/social-sync/collection.ts";
import { createHomeFeedV2Repository } from "../src/lib/content/home-feed-v2-core.ts";
import { createHomeFeedRepository } from "../src/lib/content/home-feed-core.ts";
import { homeFeedResponse } from "../src/lib/content/home-feed-http.ts";
import { createSocialTimelineRepository, readSocialTimelineSnapshot, verifyCollectionReader, socialTimelineSql, mapSocialTimelineRows } from "../src/server/social/timeline-repository.ts";
import { ContentServiceError } from "../contracts/repository.ts";
import { exampleContent, exampleSocialWork } from "./helpers/home-feed-samples.ts";
import { exampleCollectionSnapshot } from "./helpers/social-collection-samples.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";

const error=(code:string)=>(e:unknown)=>e instanceof ContentServiceError && e.code===code;
function collectionWork():SocialTimelineWork {
  const c=collectionCard(nextCollectionState(null,exampleCollectionSnapshot("2026-01-03T00:00:00.000Z")));
  c.activity={at:"2026-01-02T00:00:00.000Z",basis:"addition-detected"};c.latestAddition={detectedAt:c.activity.at,publishedAt:null,addedVideos:1,addedParts:0};
  return {id:c.id,type:"social-work",title:c.title,occurredAt:null,cover:null,publications:[],collection:{...c,originalUrl:null,linkVerifiedAt:null,latestMemberUrl:null,latestMemberLinkVerifiedAt:null}};
}
test("v2 collection activity controls ordering while original work dates and explicit detection labels are preserved",async()=>{
  const work=collectionWork();work.occurredAt="2025-01-01T00:00:00.000Z";
  const content=[exampleContent("between","2026-01-01T12:00:00.000Z")];
  const repo=createHomeFeedV2Repository({content:async()=>({version:"c",items:content}),social:async()=>({version:"s",items:[work]}),sources:{content:"mock",social:"database"},timeZone:"UTC"});
  const page=await repo.getPage();assert.equal(page.items[0].source,"social");const item=page.items[0];if(item.source!=="social")throw Error();
  assert.equal(item.occurredAt?.start,"2026-01-02T00:00:00.000Z");assert.equal(item.work.occurredAt,"2025-01-01T00:00:00.000Z");assert.equal(item.work.collection?.latestAddition?.publishedAt,null);
  assert.equal(item.work.collection?.activity?.basis,"addition-detected");assert.equal(work.occurredAt,"2025-01-01T00:00:00.000Z");
});
test("v2 combines 243 standalone/collection works with content and pages the complete set once per request",async()=>{
  let reads=0;const works:SocialTimelineWork[]=[collectionWork(),...Array.from({length:242},(_,i)=>({...exampleSocialWork(`w${i}`,null),collection:null}))];
  const repo=createHomeFeedV2Repository({content:async()=>({version:"c",items:[exampleContent("same",null)]}),social:async()=>{reads++;return {version:"s",items:works};},sources:{content:"mock",social:"database"},timeZone:"Australia/Melbourne"});
  const ids:string[]=[];let cursor:string|undefined,requests=0;
  do {const page=await repo.getPage({limit:50,...(cursor?{cursor}:{})});requests++;assert.equal(page.total,244);ids.push(...page.items.map(i=>i.id));cursor=page.nextCursor??undefined;}while(cursor);
  assert.equal(ids.length,244);assert.equal(new Set(ids).size,244);assert.equal(reads,requests);
});
test("v1/v2 cursors are distinct and source paging-version changes invalidate v2 paging",async()=>{
  const content=[exampleContent("a",null),exampleContent("b",null)];let version="s";
  const options={content:async()=>({version:"c",items:content}),social:async()=>({version,items:[collectionWork()]}),sources:{content:"mock" as const,social:"database" as const},timeZone:"UTC"};
  const repo=createHomeFeedV2Repository(options),old=createHomeFeedRepository(options);const oldPage=await old.getPage({limit:1});
  await assert.rejects(repo.getPage({limit:1,cursor:oldPage.nextCursor!}),error("INVALID_QUERY"));
  const first=await repo.getPage({limit:1});for(const v of ["changed-activity","revoked-member","new-content"]){version=v;await assert.rejects(repo.getPage({limit:1,cursor:first.nextCursor!}),error("INVALID_QUERY"));}
});
test("v2 disabled source makes no social call; failed or missing configured source never becomes partial success",async()=>{
  const content=async()=>({version:"c",items:[]});
  const off=createHomeFeedV2Repository({content,sources:{content:"mock",social:"disabled"},timeZone:"UTC"});assert.equal((await off.getPage()).total,0);
  const on=createHomeFeedV2Repository({content,social:async()=>{throw Error("private database credentials");},sources:{content:"mock",social:"database"},timeZone:"UTC"});
  const response=await homeFeedResponse(new Request("http://example.test/api/home/feed-v2"),on);assert.equal(response.status,503);assert.equal((await response.text()).includes("credentials"),false);
  const invalid=createHomeFeedV2Repository({content,social:async()=>undefined as never,sources:{content:"mock",social:"database"},timeZone:"UTC"});await assert.rejects(invalid.getPage(),error("CONTENT_UNAVAILABLE"));
});
test("trial collection paging excludes all statistics but retains membership, identity and activity changes",async()=>{
  const work=collectionWork(),raw={id:work.id,title:work.title,occurredAt:work.occurredAt,publications:[],
    collection:work.collection!,collectionIdentity:{accountId:"10001",collectionId:"200"}};
  const snapshot=()=>mapSocialTimelineRows([{work:raw}],"social-timeline-v2");
  const before=snapshot();
  raw.collection=structuredClone(raw.collection);raw.collection.observedAt="2026-01-04T00:00:00.000Z";
  for(const name of Object.keys(raw.collection.metrics) as (keyof typeof raw.collection.metrics)[])raw.collection.metrics[name]=100;
  const updated=snapshot();assert.equal(updated.version,before.version);assert.equal(updated.items[0].collection?.metrics.likes,100);
  for(const update of [
    ()=>{raw.collection.memberCount++;},
    ()=>{raw.collection.activity!.at="2026-01-03T00:00:00.000Z";raw.collection.latestAddition!.detectedAt=raw.collection.activity!.at;},
    ()=>{raw.occurredAt="2026-01-01T00:00:00.000Z";},
    ()=>{raw.title=raw.collection.title="Renamed collection";},
  ]){const previous=snapshot().version;update();assert.notEqual(snapshot().version,previous);}
  assert.notEqual(mapSocialTimelineRows([{work:raw}],"social-retained-v1").version,snapshot().version);
  raw.collection.metrics.likes=-1;assert.throws(snapshot,error("CONTENT_UNAVAILABLE"));
});
test("versioned SQL snapshot rejects overflow, private fields, invalid collection links and missing extension",async()=>{
  const work=collectionWork(),privateRaw={id:work.id,title:work.title,occurredAt:work.occurredAt,publications:[],collection:work.collection,collectionIdentity:{accountId:"10001",collectionId:"200"}};
  const sql=(raw:unknown):SqlExecutor=>({query:async<T>(query:string)=>{assert.equal(query,socialTimelineSql);return {rows:[{work:raw}] as T[]};}});
  const snapshot=await readSocialTimelineSnapshot(sql(privateRaw));assert.deepEqual(snapshot.items,[{...work,collection:{...work.collection!,dayAddition:null}}]);assert.equal(JSON.stringify(snapshot).includes('"accountId"'),false);
  for(const bad of [{...privateRaw,secret:"private"},{...privateRaw,collection:{...privateRaw.collection,originalUrl:"https://space.bilibili.com/10002/lists/200?type=season",linkVerifiedAt:"2026-01-03T00:00:00.000Z"}},
    {...privateRaw,collectionIdentity:{accountId:"10002",collectionId:"200"}}, {...privateRaw,publications:Array(21).fill({})}])await assert.rejects(readSocialTimelineSnapshot(sql(bad)),error("CONTENT_UNAVAILABLE"));
  await assert.rejects(readSocialTimelineSnapshot({query:async()=>({rows:Array(501).fill({work:privateRaw})})} as SqlExecutor),error("CONTENT_UNAVAILABLE"));
  await assert.rejects(verifyCollectionReader({query:async()=>{throw Error("private schema");}}),error("CONTENT_UNAVAILABLE"));
  await assert.rejects(verifyCollectionReader({query:async()=>({rows:[{version:2}]})} as unknown as SqlExecutor),error("CONTENT_UNAVAILABLE"));
  await verifyCollectionReader({query:async()=>({rows:[{version:1}]})} as unknown as SqlExecutor);
  const repo=createSocialTimelineRepository(sql(privateRaw));assert.equal((await repo.listWorks()).total,1);
});
test("v2 HTTP keeps private/no-store/noindex and validates queries before loading sources",async()=>{
  let reads=0;const repo=createHomeFeedV2Repository({content:async()=>{reads++;return {version:"c",items:[]};},sources:{content:"mock",social:"disabled"},timeZone:"UTC"});
  for(const q of ["?limit=0","?limit=51","?cursor=","?account=10001","?limit=1&limit=2"]){const r=await homeFeedResponse(new Request("http://example.test/api/home/feed-v2"+q),repo);assert.equal(r.status,400);assert.equal(reads,0);}
  const response=await homeFeedResponse(new Request("http://example.test/api/home/feed-v2"),repo);assert.equal(response.status,200);assert.equal(response.headers.get("Cache-Control"),"private, no-store");assert.equal(response.headers.get("X-Robots-Tag"),"noindex, nofollow");
});

test("latest collection links require a canonical playback URL and independent verification evidence",()=>{
  const c=collectionWork(),checked="2026-01-03T00:00:00.000Z",url="https://www.bilibili.com/video/BV0000000002/";
  const map=()=>mapSocialTimelineRows([{work:{id:c.id,title:c.title,occurredAt:c.occurredAt,publications:[],collection:c.collection,collectionIdentity:{accountId:"10001",collectionId:"200"}}}],"social-timeline-v2");
  c.collection!.latestMemberUrl=url;c.collection!.latestMemberLinkVerifiedAt=checked;
  const verified=map();assert.equal(verified.items[0].collection!.latestMemberUrl,url);
  for(const bad of [url+"?spm_id_from=example&vd_source=private",url+"#fragment","http://www.bilibili.com/video/BV0000000002/","https://evil.example/video/BV0000000002/"]){
    c.collection!.latestMemberUrl=bad;
    const result=map().items[0].collection!;assert.equal(result.latestMemberUrl,null);assert.equal(result.latestMemberLinkVerifiedAt,null);
  }
  c.collection!.latestMemberUrl=url;c.collection!.latestMemberLinkVerifiedAt=null;
  assert.equal(map().items[0].collection!.latestMemberUrl,null);
  c.collection!.latestMemberLinkVerifiedAt=checked;
  const before=map();c.collection!.latestMemberLinkVerifiedAt="2026-01-04T00:00:00.000Z";
  assert.equal(map().version,before.version,"proof refresh alone must not invalidate paging");
  c.collection!.latestMemberUrl="https://www.bilibili.com/video/BV0000000001/";
  assert.notEqual(map().version,before.version,"a different playback target invalidates old cursors");
});
