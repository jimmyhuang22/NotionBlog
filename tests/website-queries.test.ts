import test from "node:test";
import assert from "node:assert/strict";
import { createContentService } from "../src/lib/content/factory.ts";
import { CONTENT_KINDS,contentFeatures,parseContentFeatures } from "../config/features.ts";
import { createMockRepository } from "../adapters/mock-repository.ts";
import type { Game, TimeAmount } from "../contracts/content.ts";
import { timelineEvents,documentPlainText,createWebsiteQueries } from "../src/lib/content/website.ts";
import { websiteQueryResponse,sitePageResponse } from "../src/lib/content/website-http.ts";
import { discoveryOptions,sitemapXml,robotsText,feedXml } from "../src/lib/seo/discovery.ts";
const all=Object.fromEntries(CONTENT_KINDS.map(k=>[k,true])) as typeof contentFeatures;
const invalid=(e:unknown)=>!!e&&typeof e==="object"&&"code" in e&&e.code==="INVALID_QUERY";
test("multi-page fixtures expose totals, adjacent articles and only the fixed About key",async()=>{
  const repo=createContentService({features:all}).repository;
  for(const kind of ["status","post","album","book","movie","game"] as const) {
    const ids=new Set<string>();let cursor:string|undefined;
    do {const page=await repo.list(kind,{limit:7,...(cursor?{cursor}:{})});assert.ok(page.total!>12);for(const item of page.items){assert.ok(!ids.has(item.id));ids.add(item.id);}cursor=page.nextCursor??undefined;if(!cursor)assert.equal(ids.size,page.total);}while(cursor);
  }
  const posts=await repo.list("post",{limit:50}),detail=await repo.get("post",posts.items[1].slug);
  assert.deepEqual(detail?.adjacent,{newer:{title:posts.items[0].title,href:posts.items[0].href},older:{title:posts.items[2].title,href:posts.items[2].href}});
  assert.equal((await repo.getPage!("about"))?.slug,"about");assert.equal(await repo.getPage!("arbitrary" as "about"),null);
  assert.equal(await createContentService().repository.getPage!("about"),null);
});
test("timeline is stable across pages, leaves unknown dates last and omits wishlist states",async()=>{
  const repo=createContentService({features:all,timeZone:"Australia/Melbourne"}).repository,ids=new Set<string>();let cursor:string|undefined;let undated=false;
  do {const p=await repo.getTimeline!({limit:5,...(cursor?{cursor}:{})});for(const i of p.items){assert.ok(!ids.has(i.id));ids.add(i.id);if(i.occurredAt===null)undated=true;else assert.equal(undated,false);assert.ok(!i.type.includes("wishlist"));}cursor=p.nextCursor??undefined;if(!cursor)assert.equal(ids.size,p.total);}while(cursor);
  const raw=createMockRepository(),s=await raw.readSnapshot!(["game"]),detail=s.records.find(d=>d.item.kind==="game"&&d.item.status==="clear")!;
  const events=timelineEvents({...s,records:[detail,detail]},"UTC");assert.equal(events.length,1);
});
test("game timeline events preserve current playtime, units, unknowns and real zero",async()=>{
  const raw=createMockRepository(),snapshot=await raw.readSnapshot!(["game","album"]);
  const game=snapshot.records.find(detail=>detail.item.kind==="game")!;
  const cases: {status:Game["status"];playedTime:TimeAmount|null}[]=[
    {status:"playing",playedTime:{value:120.25,unit:"hour"}},
    {status:"clear",playedTime:{value:95,unit:"minute"}},
    {status:"platinumed",playedTime:null},
    {status:"playing",playedTime:{value:0,unit:"hour"}},
  ];
  const records=cases.map((value,index)=>({...structuredClone(game),item:{...structuredClone(game.item),kind:"game" as const,id:`playtime-${index}`,...value} as Game}));
  const album=snapshot.records.find(detail=>detail.item.kind==="album")!;
  const events=timelineEvents({...snapshot,records:[...records,records[0],album]},"UTC");
  assert.equal(events.length,cases.length+1);
  for(const [index,value] of cases.entries()){
    const event=events.find(event=>event.id.startsWith(`game:playtime-${index}:`))!;
    assert.notEqual(event.type,"status");
    if(event.type!=="status")assert.deepEqual(event.playedTime,value.playedTime);
  }
  assert.equal(Object.hasOwn(events.find(event=>event.type==="album-new")!,"playedTime"),false);
  const mock=await createContentService({features:all}).repository.getTimeline!({limit:50});
  for(const event of mock.items.filter(event=>event.type.startsWith("game-"))){
    if(event.type==="status")continue;
    const detail=await raw.get("game",event.href!.split("/").at(-1)!);
    assert.deepEqual(event.playedTime,detail!.item.playedTime);
  }
});
test("search reads plain AST, filters sections and invalidates cursors after query or visibility changes",async()=>{
  const raw=createMockRepository(),base=await raw.readSnapshot!(["status"],true);let version="one";
  raw.readSnapshot=async()=>({...base,version});const repo=createWebsiteQueries(raw,all);
  const first=await repo.search!({q:"演示",kinds:["status"],limit:1});assert.ok(first.total!>1);assert.ok(first.nextCursor);
  await assert.rejects(repo.search!({q:"分页",kinds:["status"],limit:1,cursor:first.nextCursor!}),invalid);
  version="withdrawn";await assert.rejects(repo.search!({q:"演示",kinds:["status"],limit:1,cursor:first.nextCursor!}),invalid);
  assert.equal(documentPlainText({blocks:[{id:"p",type:"paragraph",text:[{text:"secret label",link:{kind:"unavailable"}},{text:"visible"}]}],toc:[],completeness:"complete"}),"visible");
  assert.equal((await createContentService().repository.search!({q:"演示",kinds:["book"]})).total,0);
});
test("HTTP query boundaries reject duplicates, invalid limits and missing pages with no caching",async()=>{
  const repo=createContentService({features:all}).repository;
  for(const q of ["limit=0","limit=51","limit=2&limit=3","x=1","cursor="]){const r=await websiteQueryResponse(new Request(`https://example.test/api/timeline?${q}`),repo,"timeline");assert.equal(r.status,400);assert.match(r.headers.get("Cache-Control")!,/no-store/);}
  for(const q of ["q=x&q=y","q=","q=x&kinds=nope"]){assert.equal((await websiteQueryResponse(new Request(`https://example.test/api/search?${q}`),repo,"search")).status,400);}
  assert.equal((await sitePageResponse(new Request("https://example.test/api/pages/x"),"x",repo)).status,404);
  const broken={...repo,getTimeline:async()=>{throw Error("private-token-value");}};assert.ok(!(await (await websiteQueryResponse(new Request("https://example.test/api/timeline"),broken,"timeline")).text()).includes("private-token-value"));
});
test("discovery is off in demo and platform previews; explicit public discovery excludes disabled routes",async()=>{
  assert.equal(discoveryOptions({SITE_INDEXING_ENABLED:"true",CONTENT_PROVIDER:"mock"}).enabled,false);
  assert.equal(discoveryOptions({SITE_INDEXING_ENABLED:"true",CONTENT_PROVIDER:"database",VERCEL_ENV:"preview"}).enabled,false);
  assert.match(robotsText(discoveryOptions({})),/Disallow: \//);
  assert.throws(()=>discoveryOptions({SITE_INDEXING_ENABLED:"true",CONTENT_PROVIDER:"database",SITE_URL:"http://localhost:3000"}));
  const options=discoveryOptions({SITE_INDEXING_ENABLED:"true",CONTENT_PROVIDER:"database",SITE_URL:"https://example.test",SITE_DISCOVERY_KINDS_JSON:'["status","post","game"]'});
  const repo=createContentService().repository,xml=await sitemapXml(repo,contentFeatures,options);assert.ok(xml.includes("/status"));assert.ok(!xml.includes("/blog"));assert.ok(!xml.includes("library/games"));assert.ok(!xml.includes("#mock"));
  const off=await sitemapXml({...repo,readSnapshot:async()=>{throw Error("should not read");}},all,{...options,enabled:false});assert.ok(!off.includes("<loc>"));
  const feed=await feedXml(createContentService({features:all}).repository,all,options,"A & B");assert.ok(feed.includes("A &amp; B"));assert.ok(!feed.includes("<script>"));
  assert.equal(parseContentFeatures('{"game":true}').game,true);assert.throws(()=>parseContentFeatures('{"unknown":true}'));assert.throws(()=>parseContentFeatures('{"page":"true"}'));
});
