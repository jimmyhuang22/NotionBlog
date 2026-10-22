import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import type { WebsiteRecord } from "../contracts/website-sync.ts";
import type { StoredMedia } from "../contracts/sync.ts";
import type {BlockObjectResponse,PageObjectResponse,DataSourceObjectResponse} from "@notionhq/client";
import type {NotionReadClient} from "../src/server/notion/types.ts";
import {parseWebsiteNotionConfig} from "../src/server/notion/website-config.ts";
import {createWebsiteNotionRepository} from "../src/server/notion/website-repository.ts";
import {websitePolicy,runWebsiteSync} from "../scripts/website-sync/worker.ts";
import { ContentServiceError } from "../contracts/repository.ts";
const id=(n:number)=>n.toString(16).padStart(32,"0");
const rich=(value:string)=>({type:"text",plain_text:value,href:null,text:{content:value,link:null},annotations:{bold:false,italic:false,code:false,underline:false,strikethrough:false,color:"default"}});
function setup(){
 const sources=[{key:"games",kind:"game",enabled:true,dataSourceId:id(1),fields:{title:"Name",status:"Status",playedTime:"Hours",platformMinutes:"Minutes",playedDate:"Date"},playedTimeUnit:"hour",statusMap:{Clear:"clear",Playing:"playing"},publication:{mode:"all",allowlistPageIds:[]}},
 {key:"more-games",kind:"game",enabled:true,dataSourceId:id(2),fields:{title:"Name"},publication:{mode:"all",allowlistPageIds:[]}},
 {key:"about",kind:"page",enabled:true,pageId:id(3),pageKey:"about",fields:{title:"title"},publication:{mode:"allowlist",allowlistPageIds:[id(3)]}}];
 const config={schemaVersion:2,sources};
 const pages=new Map<string,PageObjectResponse>();
 const make=(n:number,parent:unknown,properties:unknown)=>({id:id(n),object:"page",parent,properties,cover:null,last_edited_time:"2026-10-10T12:00:00Z",archived:false,in_trash:false,is_archived:false}) as PageObjectResponse;
 const props={Name:{id:"title",type:"title",title:[rich("Synthetic Game")]},Status:{id:"s",type:"select",select:{name:"Clear"}},Hours:{id:"h",type:"number",number:45},Minutes:{id:"m",type:"number",number:0},Date:{id:"d",type:"date",date:null}};
 pages.set(id(10),make(10,{type:"data_source_id",data_source_id:id(1)},props));pages.set(id(20),make(20,{type:"data_source_id",data_source_id:id(2)},{Name:props.Name}));
 pages.set(id(3),make(3,{type:"page_id",page_id:id(900)},{title:{id:"title",type:"title",title:[rich("About synthetic site")]}}));
 pages.set(id(4),make(4,{type:"page_id",page_id:id(3)},{title:{id:"title",type:"title",title:[rich("Private descendant")]}}));
 const client:NotionReadClient={getPage:async key=>pages.get(key)??null,getBlock:async()=>null,
 getDataSource:async key=>({id:key,properties:Object.fromEntries(Object.entries(key===id(1)?props:{Name:props.Name}).map(([k,v])=>[k,{id:v.id,type:v.type}]))}) as DataSourceObjectResponse,
 listPages:async key=>[...pages.values()].filter(p=>p.parent.type==="data_source_id"&&p.parent.data_source_id===key),
 listBlocks:async owner=>owner===id(3)?[{id:id(101),type:"paragraph",parent:{type:"page_id",page_id:owner},paragraph:{rich_text:[rich("Body with formula "),{...rich("x^2"),type:"equation",equation:{expression:"x^2"}}]},archived:false,in_trash:false,has_children:false} as unknown as BlockObjectResponse]:[]};
 return {config,pages,client};
}
test("v2 Notion maps explicit states and zero time, automatically sees new direct rows and never admits About descendants",async()=>{
 const s=setup(),repo=createWebsiteNotionRepository({client:s.client,config:parseWebsiteNotionConfig(s.config)});
 let page=await repo.list("game");assert.equal(page.total,2);const game=page.items.find(i=>i.id===id(10))!;assert.equal(game.status,"clear");assert.deepEqual(game.playedTime,{value:0,unit:"minute"});assert.equal(game.playedDate,null);assert.equal(game.rating,null);
 const newPage=structuredClone(s.pages.get(id(10))!);newPage.id=id(11);s.pages.set(id(11),newPage);assert.equal((await repo.list("game")).total,3);
 assert.equal((await repo.getPage!("about"))?.document?.blocks[0].type,"paragraph");assert.equal(await repo.get("page",id(4)),null);assert.equal(await repo.resolvePublicPage(id(4)),null);
 const body=(await repo.getPage!("about"))!.document!.blocks[0];assert.equal(body.type,"paragraph");if(body.type==="paragraph")assert.equal(body.text[1].equation,true);
 const records=await repo.collectRecords();assert.equal(records.length,4);assert.equal(records.find(r=>r.detail.item.id===id(20))!.evidence.sourceKey,"more-games");
 const policy=await websitePolicy(s.client,s.config,600);assert.equal(policy.permits.length,1);assert.equal(policy.permits[0].id,id(3));assert.throws(()=>parseWebsiteNotionConfig({...s.config,sources:[{...s.config.sources[2],publication:{mode:"all",allowlistPageIds:[]}}]}));
});
test("v2 sync publishes only complete verified bodies and releases the lease after read failure",async()=>{
 const s=setup(),calls:string[]=[];let published=false;
 const writer={begin:async(_id:string,digest:string)=>({runId:_id,configDigest:digest,revision:"1",fence:"1",deniedPageIds:[]}),renew:async()=>{},stage:async()=>{calls.push("stage");},promote:async()=>{published=true;},fail:async()=>{calls.push("fail");}};
 const storage={put:async()=>{},read:async()=>new Uint8Array()};
 const report=await runWebsiteSync({client:s.client,config:s.config,mode:"publish",writer,storage});assert.equal(report.records,3);assert.equal(published,true);
 published=false;s.client.listBlocks=async()=>{throw Error("private upstream details");};await assert.rejects(runWebsiteSync({client:s.client,config:s.config,mode:"publish",writer,storage}));assert.equal(published,false);assert.equal(calls.at(-1),"fail");
});
test("v2 sync persists original cover dimensions in both its record and media descriptor",async()=>{
 const s=setup(),bytes=await sharp({create:{width:3,height:5,channels:3,background:"#4477aa"}}).png().toBuffer();
 s.pages.get(id(10))!.cover={type:"external",external:{url:"https://images.example.test/original.png"}};
 const config={...s.config,sources:s.config.sources.map((source,index)=>index===0?{...source,cover:{strategy:"native-page-cover"}}:source)};
 const records:WebsiteRecord[]=[],media:StoredMedia[]=[];let published=false;
 const writer={begin:async(runId:string,digest:string)=>({runId,configDigest:digest,revision:"1",fence:"1",deniedPageIds:[]}),renew:async()=>{},stage:async(_lease:unknown,rows:WebsiteRecord[],assets:StoredMedia[]=[])=>{records.push(...rows);media.push(...assets);},promote:async()=>{published=true;},fail:async()=>{}};
 const stored:Uint8Array[]=[];
 const report=await runWebsiteSync({client:s.client,config,mode:"publish",writer,storage:{put:async(_media,data)=>{stored.push(Buffer.from(data));},read:async()=>bytes},download:async()=>({bytes,mime:"image/png"})});
 assert.equal(published,true);assert.equal(report.media,1);assert.equal(stored.length,1);assert.deepEqual(stored[0],bytes);
 assert.deepEqual([media[0].width,media[0].height],[3,5]);
 const cover=records.find(row=>row.detail.item.id===id(10))!.detail.item.cover!;
 assert.deepEqual([cover.width,cover.height],[3,5]);assert.equal(cover.id,media[0].assetId);
});

test("route metadata checks preserve exact About authorization and never load blocks or images", async () => {
 const s=setup();s.client.listBlocks=async()=>{throw Error("Metadata must not load bodies");};
 const repo=createWebsiteNotionRepository({client:s.client,config:parseWebsiteNotionConfig(s.config),registerImage:async()=>{throw Error("Metadata must not register images");}});
 assert.equal((await repo.getContentMetadata!("game",id(10)))?.id,id(10));
 assert.equal((await repo.getContentMetadata!("page","about"))?.slug,"about");
 assert.equal(await repo.getContentMetadata!("page",id(4)),null);
 s.pages.get(id(10))!.in_trash=true;
 assert.equal(await repo.getContentMetadata!("game",id(10)),null);
});

test("Game rollups stay independent of stable experience years and do not expose platform rows", async () => {
 const s=setup(), page=s.pages.get(id(10))!;
 const original={start:"2023-06-01",end:"2023-08-01",time_zone:null};
 const latest={start:"2025-12-31T14:30:00Z",end:null,time_zone:null};
 const earliest={start:"2024-12-31T14:30:00Z",end:null,time_zone:null};
 Object.assign(page.properties, { Date:{id:"d",type:"date",date:original},Last:{id:"l",type:"rollup",rollup:{type:"date",date:latest,function:"latest_date"}},First:{id:"fp",type:"rollup",rollup:{type:"date",date:earliest,function:"earliest_date"}} });
 const getSchema=s.client.getDataSource;
 s.client.getDataSource=async key=>{
  const schema=await getSchema(key);
  if(schema&&key===id(1))Object.assign(schema.properties,{Last:{id:"l",name:"Last",type:"rollup",rollup:{relation_property_id:"pr",relation_property_name:"Platforms",rollup_property_id:"lp",rollup_property_name:"Last Played",function:(page.properties.Last as {rollup:{function:string}}).rollup.function}},First:{id:"fp",name:"First",type:"rollup",rollup:{relation_property_id:"pr",relation_property_name:"Platforms",rollup_property_id:"fp-src",rollup_property_name:"First Played",function:(page.properties.First as {rollup:{function:string}}).rollup.function}}});
  return schema;
 };
 const config={...s.config,sources:[{...s.config.sources[0],fields:{...s.config.sources[0].fields,lastPlayedDate:"Last",firstPlayedDate:"First"}},s.config.sources[1]]};
 s.client.listBlocks=async()=>{throw Error("Latest-play metadata must not load bodies");};
 const repo=createWebsiteNotionRepository({client:s.client,config:parseWebsiteNotionConfig(config),timeZone:()=>"Australia/Melbourne",registerImage:async()=>{throw Error("Metadata must not register media");}});
 const result=await repo.list("game",{year:2023});
 assert.equal((await repo.list("game",{year:2026})).total,0);
 assert.equal(result.total,1);
 assert.deepEqual(result.items[0].lastPlayedDate,{start:"2026-01-01",end:null,precision:"date"});
 assert.deepEqual(result.items[0].archiveDate,{start:"2023-08-01",end:null,precision:"date"});
 assert.deepEqual(result.items[0].firstPlayedDate,{start:"2025-01-01",end:null,precision:"date"});
 assert.deepEqual(result.items[0].playedDate,{start:"2023-06-01",end:"2023-08-01",precision:"date"});
 assert.deepEqual((await repo.getLibraryYears!("game")).years,[{year:2023,count:1}]);
 assert.equal(JSON.stringify(result).includes("relation"),false);
 assert.deepEqual(page.properties.Date,{id:"d",type:"date",date:original});
 page.properties.Date={id:"d",type:"date",date:{start:"2023-06-01",end:"2027-01-02",time_zone:null}};
 assert.deepEqual((await repo.getLibraryYears!("game")).years,[{year:2027,count:1}]);
 const laterManual=await repo.list("game",{year:2027});
 assert.deepEqual(laterManual.items[0].archiveDate,{start:"2027-01-02",end:null,precision:"date"});
 page.properties.Date={id:"d",type:"date",date:original};
 const rollup=page.properties.Last as { type:"rollup";rollup:{type:string;date:typeof latest|null;function:string} };
 rollup.rollup.date=null;
 assert.deepEqual((await repo.getLibraryYears!("game")).years,[{year:2023,count:1}]);
 rollup.rollup.type="incomplete";
 await assert.rejects(repo.getLibraryYears!("game"),error=>error instanceof ContentServiceError&&error.code==="CONTENT_UNAVAILABLE");
 rollup.rollup.type="unsupported";
 await assert.rejects(repo.list("game"),error=>error instanceof ContentServiceError&&error.code==="CONTENT_UNAVAILABLE");
 rollup.rollup.type="date";rollup.rollup.function="earliest_date";
 await assert.rejects(repo.list("game"),error=>error instanceof ContentServiceError&&error.code==="MISCONFIGURED");
 rollup.rollup.function="latest_date";
 const first=page.properties.First as {rollup:{type:string;date:typeof earliest|null;function:string}};
 first.rollup.date=null;
 assert.equal((await repo.list("game")).items[0].firstPlayedDate,null);
 first.rollup.type="incomplete";
 await assert.rejects(repo.list("game"),error=>error instanceof ContentServiceError&&error.code==="CONTENT_UNAVAILABLE");
 first.rollup.type="date";first.rollup.function="latest_date";
 await assert.rejects(repo.list("game"),error=>error instanceof ContentServiceError&&error.code==="MISCONFIGURED");
});

test("Notion library years respect allowlists, trash and combined filters without reading bodies or media", async () => {
 const s=setup();
 const source=s.config.sources[0];
 const config={...s.config,sources:[{...source,statusMap:{Clear:"clear",Platinum:"platinumed",Wishlist:"wishlist"},publication:{mode:"allowlist",allowlistPageIds:[id(10),id(11),id(12)]}},s.config.sources[1]]};
 for(const [n,status,start] of [[10,"Clear","2025-12-31T14:30:00Z"],[11,"Platinum","2025-12-31T14:30:00Z"],[12,"Wishlist",null],[13,"Clear","2024-01-01"]] as const) {
  const page=structuredClone(s.pages.get(id(10))!);page.id=id(n);
  Object.assign(page.properties,{Status:{id:"s",type:"select",select:{name:status}},Date:{id:"d",type:"date",date:start?{start,end:null,time_zone:null}:null}});
  s.pages.set(id(n),page);
 }
 s.client.listBlocks=async()=>{throw Error("Years must not read bodies");};
 let zone="Australia/Melbourne";
 const repo=createWebsiteNotionRepository({client:s.client,config:parseWebsiteNotionConfig(config),timeZone:()=>zone,registerImage:async()=>{throw Error("Years must not register media");}});
 assert.deepEqual(await repo.getLibraryYears!("game",{status:"completed"}),{years:[{year:2026,count:2}],undatedCount:0,timeZone:zone});
 assert.equal((await repo.getLibraryYears!("game",{status:"wishlist"})).undatedCount,1);
 const first=await repo.list("game",{status:"completed",year:2026,order:"title-asc",limit:1});assert.equal(first.total,2);
 const second=await repo.list("game",{status:"completed",year:2026,order:"title-asc",limit:1,cursor:first.nextCursor!});assert.equal(second.hasMore,false);assert.notEqual(first.items[0].id,second.items[0].id);
 assert.equal((await repo.list("game",{status:"wishlist",year:"undated"})).total,1);
 assert.equal((await repo.list("game",{year:2024})).total,0);
 zone="UTC";
 await assert.rejects(repo.list("game",{status:"completed",year:2026,order:"title-asc",limit:1,cursor:first.nextCursor!}),error=>error instanceof ContentServiceError&&error.code==="INVALID_QUERY");
 assert.equal((await repo.getLibraryYears!("game",{status:"completed"})).years[0].year,2025);
 s.pages.get(id(11))!.in_trash=true;
 assert.equal((await repo.getLibraryYears!("game",{status:"completed"})).years[0].count,1);
 s.client.listPages=async()=>{throw Error("Upstream failed");};
 await assert.rejects(repo.getLibraryYears!("game"));
});
