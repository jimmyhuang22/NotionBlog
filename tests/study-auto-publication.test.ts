import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { BlockObjectResponse, PageObjectResponse, DataSourceObjectResponse, DatabaseObjectResponse } from "@notionhq/client";
import type { NotionReadClient } from "../src/server/notion/types.ts";
import { parseWebsiteNotionConfig } from "../src/server/notion/website-config.ts";
import { createWebsiteNotionRepository } from "../src/server/notion/website-repository.ts";
import { createWebsiteDatabaseRepository } from "../src/server/database/website-repository.ts";
import { createWebsiteWriter } from "../src/server/database/website-writer.ts";
import { websitePolicy, runWebsiteSync } from "../scripts/website-sync/worker.ts";
import { WEBSITE_SCHEMA_DIGEST } from "../contracts/website-sync.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";
import study from "../database/website-study-protocol.json" with {type:"json"};
import { DEMO_PNG } from "../scripts/notion-sync/demo.ts";
import type { StudyDiscoveryProgress } from "../src/server/notion/automatic-study.ts";
const id=(n:number)=>n.toString(16).padStart(32,"0");
const rich=(text:string)=>({type:"text",plain_text:text,text:{content:text,link:null},href:null,annotations:{bold:false,italic:false,underline:false,strikethrough:false,code:false,color:"default"}});
function setup() {
  const config={schemaVersion:2,sources:[
    {key:"courses",kind:"course",enabled:true,dataSourceId:id(1),fields:{title:"Name"},publication:{mode:"all",allowlistPageIds:[]}},
    {key:"notes",kind:"study-note",enabled:true,dataSourceId:id(1),fields:{title:"Name",date:"Date",order:"排序"},publication:{mode:"course-descendants",allowlistPageIds:[]}},
  ]};
  const pages=new Map<string,PageObjectResponse>(), blocks=new Map<string,BlockObjectResponse[]>(),calls:string[]=[];
  const page=(n:number,title:string,parent:unknown,date:string|null=null,order:number|null=null)=>({id:id(n),object:"page",parent,properties:{
    Name:{type:"title",id:"title",title:[rich(title)]},Date:{type:"date",id:"date",date:date?{start:date,end:null,time_zone:null}:null},
    "排序":{type:"number",id:"order",number:order},
  },archived:false,in_trash:false,cover:null,last_edited_time:"2026-10-12T00:00:00Z"}) as unknown as PageObjectResponse;
  const ds=(n:number)=>({type:"data_source_id" as const,data_source_id:id(n)}),owner=(n:number)=>({type:"page_id" as const,page_id:id(n)});
  pages.set(id(10),page(10,"Synthetic course",ds(1)));
  pages.set(id(20),page(20,"Week 10",ds(3),"2026-03-02"));
  pages.set(id(21),page(21,"Week 2",ds(3),"2026-03-02"));
  pages.set(id(22),page(22,"Override",ds(3),"2026-03-30",0));
  pages.set(id(30),page(30,"Child 10",owner(20)));
  pages.set(id(31),page(31,"Child 2",owner(20)));
  pages.set(id(32),page(32,"Grandchild",owner(30)));
  const child=(n:number,parent:number,type:"child_page"|"child_database"|"link_to_page",title="Synthetic")=>({id:id(n),parent:owner(parent),type,
    [type]:type==="link_to_page"?{type:"page_id",page_id:id(999)}:{title},has_children:false,archived:false,in_trash:false}) as unknown as BlockObjectResponse;
  blocks.set(id(10),[child(2,10,"child_database"),child(4,10,"child_database"),child(8,10,"link_to_page")]);
  blocks.set(id(20),[child(30,20,"child_page"),child(31,20,"child_page")]);
  blocks.set(id(30),[child(32,30,"child_page")]);
  const schemas=new Map<string,DataSourceObjectResponse>();
  schemas.set(id(1),{id:id(1),parent:{type:"database_id",database_id:id(100)},database_parent:owner(900),properties:{Name:{id:"title",type:"title"}}} as unknown as DataSourceObjectResponse);
  schemas.set(id(3),{id:id(3),parent:{type:"database_id",database_id:id(2)},database_parent:owner(10),properties:{Name:{id:"title",type:"title"},Date:{id:"date",type:"date"},"排序":{id:"order",type:"number"}}} as unknown as DataSourceObjectResponse);
  const client:NotionReadClient={
    getPage:async key=>{calls.push(`page:${key}`);return structuredClone(pages.get(key)??null);},
    getDataSource:async key=>{calls.push(`schema:${key}`);const schema=schemas.get(key);if(!schema)throw Error("Unexpected schema");return structuredClone(schema);},
    getDatabase:async key=>({id:key,parent:owner(key===id(2)?10:999),data_sources:[{id:key===id(2)?id(3):id(5),name:"Notes"}],archived:false,in_trash:false}) as DatabaseObjectResponse,
    getBlock:async key=>structuredClone([...blocks.values()].flat().find(b=>b.id===key)??null),
    listBlocks:async key=>{calls.push(`blocks:${key}`);return structuredClone(blocks.get(key)??[]);},
    listPages:async key=>{calls.push(`rows:${key}`);return structuredClone([...pages.values()].filter(p=>p.parent.type==="data_source_id"&&p.parent.data_source_id===key));},
  };
  return {config,pages,blocks,calls,client,page,child,owner,ds,schemas};
}
const repo=(s:ReturnType<typeof setup>,deniedPageIds?:ReadonlySet<string>)=>createWebsiteNotionRepository({client:s.client,config:parseWebsiteNotionConfig(s.config),deniedPageIds});

test("discovery reports completed courses and cumulative nodes without additional reads or changing scope", async () => {
  const make = () => { const s = setup(); s.pages.set(id(11), s.page(11, "Second course", s.ds(1)));
    s.pages.set(id(40), s.page(40, "Second note", s.owner(11))); s.blocks.set(id(11), [s.child(40, 11, "child_page")]); return s; };
  const plain = make(), observed = make(), events: StudyDiscoveryProgress[] = [];
  const expected = await repo(plain).collectRecords(false);
  const actual = await createWebsiteNotionRepository({ client: observed.client, config: parseWebsiteNotionConfig(observed.config),
    onStudyDiscoveryProgress: event => events.push(event) }).collectRecords(false);
  assert.deepEqual(actual, expected); assert.deepEqual(observed.calls, plain.calls);
  assert.deepEqual(events.filter(e => e.phase === "course-start").map(e => [e.courseIndex, e.courseCount, e.coursesCompleted]), [[1, 2, 0], [2, 2, 1]]);
  assert.deepEqual(events.at(-1), { phase: "complete", courseIndex: 2, courseCount: 2, coursesCompleted: 2, pagesDiscovered: 7, blocksScanned: 7 });
  assert.equal(JSON.stringify(events).includes(id(10)), false);
});
test("search context reuses qualified physical metadata, current titles and course-name fallback without extra reads", async () => {
  const plain = setup(), contextual = setup();
  const before = await repo(plain).readSnapshot!(["study-note"], true);
  const after = await repo(contextual).readSearchSnapshot!(["study-note"]);
  assert.deepEqual(after.records, before.records); assert.deepEqual(contextual.calls, plain.calls);
  assert.deepEqual(after.searchContexts?.[id(32)], { courseLabel: "Synthetic course", parentLabels: ["Week 10", "Child 10"] });
  assert.deepEqual(after.searchContexts?.[id(20)], { courseLabel: "Synthetic course", parentLabels: [] });
  const renamed = contextual.pages.get(id(30))!;
  if (renamed.properties.Name.type === "title") renamed.properties.Name.title = [rich("Updated activity")] as typeof renamed.properties.Name.title;
  const current = await repo(contextual).readSearchSnapshot!(["study-note"]);
  assert.notEqual(after.version, current.version);
  assert.deepEqual(current.searchContexts?.[id(32)]?.parentLabels, ["Week 10", "Updated activity"]);
  const withdrawn = await repo(contextual, new Set([id(20)])).readSearchSnapshot!(["study-note"]);
  assert.equal(withdrawn.records.some(record => record.item.id === id(32)), false);
  assert.equal(withdrawn.searchContexts?.[id(32)], undefined);
  contextual.client.listBlocks = async () => { throw Error("Fixture provider unavailable"); };
  await assert.rejects(repo(contextual).readSearchSnapshot!(["study-note"]));
});
test("a failed course scan retains partial progress and never reports complete", async () => {
  const s = setup(), events: StudyDiscoveryProgress[] = [];
  const list = s.client.listBlocks;
  s.client.listBlocks = async key => { if (key === id(30)) throw Error("fixture scan failure"); return list(key); };
  await assert.rejects(createWebsiteNotionRepository({ client: s.client, config: parseWebsiteNotionConfig(s.config),
    onStudyDiscoveryProgress: event => events.push(event) }).collectRecords(false));
  assert.ok(events.some(e => e.pagesDiscovered > 0));
  assert.equal(events.some(e => e.phase === "complete" || e.phase === "course-complete"), false);
  assert.equal(events.at(-1)?.coursesCompleted, 0);
});

test("automatic study discovers owned descendants, uses numeric/date roots and body-ordered children",async()=>{
  const s=setup(),tree=await repo(s).getCourseTree(id(10));
  assert.deepEqual(tree!.nodes.map(n=>n.id),[id(22),id(21),id(20)]);
  assert.deepEqual(tree!.nodes[2].children!.map(n=>n.id),[id(30),id(31)]);
  assert.equal(tree!.nodes[2].children![0].children![0].id,id(32));
  assert.equal(s.calls.includes(`rows:${id(5)}`),false);assert.equal(s.calls.includes(`page:${id(999)}`),false);
  s.pages.set(id(11),s.page(11,"Future course",s.ds(1)));s.pages.set(id(40),s.page(40,"Future note",s.owner(11)));
  s.blocks.set(id(11),[s.child(40,11,"child_page")]);
  assert.equal((await repo(s).list("course")).total,2);
  assert.equal((await repo(s).getCourseTree(id(11)))!.nodes[0].id,id(40));
  assert.equal(await repo(s).get("study-note",id(999)),null);
  const policy=await websitePolicy({...s.client,listBlocks:async()=>assert.fail("Static automatic policy must not traverse any study body"),listPages:async()=>assert.fail("Static policy must not enumerate automatic sources")},s.config,600);
  assert.equal(policy.permits.length,0);assert.equal(policy.sources[1].mode,"course-descendants");
});
test("missing order property remains optional, parent denial/archival/moves remove their entire subtree",async()=>{
  const s=setup();delete s.schemas.get(id(3))!.properties["排序"];
  assert.deepEqual((await repo(s).getCourseTree(id(10)))!.nodes.map(n=>n.id),[id(21),id(20),id(22)]);
  assert.deepEqual((await repo(s,new Set([id(20)])).getCourseTree(id(10)))!.nodes.map(n=>n.id),[id(21),id(22)]);
  assert.equal(await repo(s,new Set([id(10)])).getCourseTree(id(10)),null);
  s.pages.get(id(20))!.archived=true;assert.equal(await repo(s).get("study-note",id(32)),null);
  s.pages.get(id(20))!.archived=false;s.pages.get(id(30))!.parent=s.owner(999);
  assert.equal(await repo(s).resolveMediaOwner!(id(32)),null);
});
test("media owner qualification follows only its live ancestors; discovery reuses body reads once per operation",async()=>{
  const s=setup();await repo(s).resolveMediaOwner!(id(32));
  assert.equal(s.calls.some(c=>c.startsWith("blocks:")||c.startsWith("rows:")),false);
  s.calls.length=0;await repo(s).collectRecords(true);
  const reads=s.calls.filter(c=>c.startsWith("blocks:"));assert.equal(new Set(reads).size,reads.length);
  s.client.listBlocks=async()=>{throw Error("Incomplete body");};await assert.rejects(repo(s).collectRecords(true));
});
test("automatic study refreshes expired sibling locators once and refuses a changed source file",async()=>{
  const s=setup(),oldUrl="https://media.example.com/synthetic/original.png?token=old";
  const freshUrl=oldUrl.replace("token=old","token=fresh");
  const image={id:id(200),parent:s.owner(20),type:"image",image:{type:"file",file:{url:oldUrl,expiry_time:new Date(Date.now()-60000).toISOString()},caption:[]},has_children:false,archived:false,in_trash:false} as unknown as BlockObjectResponse;
  s.blocks.get(id(20))!.push(image);
  const listBlocks=s.client.listBlocks;
  let locatorReads=0,downloads=0,changed=false,ownerListings=0;
  s.client.listBlocks=async key=>{
    const rows=structuredClone(await listBlocks(key));
    if(key!==id(20)||++ownerListings===1)return rows;
    locatorReads++;
    return rows.map(block=>{
      if(block.id!==id(200))return block;
      const fresh=structuredClone(image);
      if(fresh.type==="image"&&fresh.image.type==="file")fresh.image.file={url:changed?freshUrl.replace("original.png","replacement.png"):freshUrl,expiry_time:new Date(Date.now()+3600000).toISOString()};
      return fresh;
    });
  };
  const download=async(url:string)=>{downloads++;assert.equal(url,freshUrl);return {bytes:DEMO_PNG,mime:"image/png" as const};};
  const progress: StudyDiscoveryProgress[] = [];
  const report=await runWebsiteSync({client:s.client,config:s.config,mode:"dry-run",download,onStudyDiscoveryProgress:event=>progress.push(event)});
  assert.equal(progress.at(-1)?.phase,"complete");
  assert.equal(report.media,1);assert.equal(report.sourceRefreshes,1);assert.equal(locatorReads,1);assert.equal(downloads,1);
  changed=true;downloads=0;ownerListings=0;
  await assert.rejects(runWebsiteSync({client:s.client,config:s.config,mode:"dry-run",download}));
  assert.equal(downloads,0);
});
test("owned blocks and nested databases stay in their course; referenced synced content is not traversed",async()=>{
  const s=setup();
  const block=(n:number,parent:unknown,type:string,body:unknown,has_children=true)=>({id:id(n),parent,type,[type]:body,has_children,archived:false,in_trash:false}) as unknown as BlockObjectResponse;
  s.blocks.get(id(20))!.push(block(50,s.owner(20),"column_list",{}),block(80,s.owner(20),"synced_block",{synced_from:{type:"block_id",block_id:id(90)}}));
  s.blocks.set(id(50),[block(51,{type:"block_id",block_id:id(50)},"column",{})]);
  s.pages.set(id(33),s.page(33,"In a column",{type:"block_id",block_id:id(51)}));
  const child=s.child(33,20,"child_page");child.parent={type:"block_id",block_id:id(51)};
  s.blocks.set(id(51),[child]);
  const getDatabase=s.client.getDatabase!;
  s.client.getDatabase=async key=>key===id(70)?({id:key,parent:s.owner(20),data_sources:[{id:id(71),name:"Nested notes"}],archived:false,in_trash:false} as DatabaseObjectResponse):getDatabase(key);
  s.schemas.set(id(71),{id:id(71),parent:{type:"database_id",database_id:id(70)},database_parent:s.owner(20),properties:{Name:{id:"title",type:"title"}}} as unknown as DataSourceObjectResponse);
  s.pages.set(id(72),s.page(72,"Nested 10",s.ds(71)));s.pages.set(id(73),s.page(73,"Nested 2",s.ds(71)));
  s.blocks.get(id(20))!.push(s.child(70,20,"child_database"));
  const tree=await repo(s).getCourseTree(id(10));
  assert.deepEqual(tree!.nodes[2].children!.map(n=>n.id),[id(30),id(31),id(33),id(73),id(72)]);
  assert.equal(s.calls.includes(`blocks:${id(80)}`)||s.calls.includes(`blocks:${id(90)}`),false);
  s.pages.set(id(34),s.page(34,"Referenced child",{type:"block_id",block_id:id(80)}));
  assert.equal(await repo(s).resolvePublicPage(id(34)),null);
  s.pages.set(id(90),s.page(90,"Loop A",s.owner(91)));s.pages.set(id(91),s.page(91,"Loop B",s.owner(90)));
  await assert.rejects(repo(s).resolvePublicPage(id(90)));
});
test("study extension gates staging, preserves legacy SQL, matches provider trees and rejects cross-course admission",async()=>{
  const s=setup(),db=await PGlite.create();
  try {
    await db.exec(await readFile(new URL("../database/website-migrations/001_website.sql",import.meta.url),"utf8"));
    await db.query("UPDATE nb_v2.state SET schema_digest=$1",[WEBSITE_SCHEMA_DIGEST]);
    await db.exec(await readFile(new URL("../database/website-study-migrations/001_automatic_study.sql",import.meta.url),"utf8"));
    const role=(name:string):SqlExecutor=>({query:<T>(sql:string,values?:unknown[])=>db.transaction(async tx=>{await tx.exec(`SET LOCAL ROLE ${name}`);return tx.query<T>(sql,values);})});
    const writer=createWebsiteWriter(role("nb_writer"));await assert.rejects(writer.verifyStudy!());
    await db.query("UPDATE nb_v2.migrations SET digest=$1 WHERE version=$2",[study.migration.sha256,study.migration.version]);
    await writer.verifyStudy!();
    const policy=await websitePolicy(s.client,s.config,600);
    await db.query("SELECT nb_v2_api.configure_policy($1,$2,$3::jsonb,$4::jsonb)",[policy.configDigest,600,JSON.stringify(policy.sources),"[]"]);
    const storage={put:async()=>assert.fail("No image objects"),read:async()=>new Uint8Array()};
    await runWebsiteSync({client:s.client,config:s.config,mode:"publish",writer,storage});
    const database=createWebsiteDatabaseRepository(role("nb_reader"));
    assert.deepEqual(await database.getCourseTree(id(10)),await repo(s).getCourseTree(id(10)));
    await db.query("SELECT nb_v2_api.set_denied($1,true)",[id(20)]);
    assert.deepEqual((await database.getCourseTree(id(10)))!.nodes.map(n=>n.id),[id(22),id(21)]);
    await db.query("SELECT nb_v2_api.set_denied($1,false)",[id(20)]);
    const records=await repo(s).collectRecords(true),lease=await writer.begin(crypto.randomUUID(),policy.configDigest);
    await writer.stage(lease,[records.find(r=>r.detail.item.kind==="course")!]);
    const bad=structuredClone(records.find(r=>r.detail.item.id===id(21))!);
    bad.evidence.parentId=id(999);await assert.rejects(writer.stage(lease,[bad]));
    await writer.fail(lease);
    for (const sql of ["SELECT * FROM nb_v2.records","SELECT nb_study.configure_legacy('x',1,'[]','[]')"]) await assert.rejects(role("nb_writer").query(sql));
    await assert.rejects(role("nb_reader").query("SELECT nb_study_api.check_capability($1)",[study.migration.sha256]));
    // The independent extension preserves old allowlist policy, stage and
    // publication behavior, including the new consistent directory order.
    const legacy={...s.config,sources:[
      {...s.config.sources[0],publication:{mode:"allowlist",allowlistPageIds:[id(10)]}},
      {...s.config.sources[1],dataSourceId:id(3),coursePageId:id(10),publication:{mode:"allowlist",allowlistPageIds:[20,21,22,30,31,32].map(id)}},
    ]};
    const oldPolicy=await websitePolicy(s.client,legacy,600);
    await db.query("SELECT nb_v2_api.configure_policy($1,$2,$3::jsonb,$4::jsonb)",[oldPolicy.configDigest,600,JSON.stringify(oldPolicy.sources),JSON.stringify(oldPolicy.permits)]);
    const report=await runWebsiteSync({client:s.client,config:legacy,mode:"publish",writer,storage});assert.equal(report.records,7);
    assert.deepEqual(await database.getCourseTree(id(10)),await createWebsiteNotionRepository({client:s.client,config:parseWebsiteNotionConfig(legacy)}).getCourseTree(id(10)));
  } finally {await db.close();}
});


test("bounded collection preserves automatic study ancestry and ordinal order exactly", async () => {
  const plain=setup(), concurrent=setup();
  const expected=await repo(plain).collectRecords(true);
  const actual=await createWebsiteNotionRepository({client:concurrent.client,config:parseWebsiteNotionConfig(concurrent.config),collectionConcurrency:4}).collectRecords(true);
  assert.deepEqual(actual,expected);
  assert.deepEqual([...concurrent.calls].sort(),[...plain.calls].sort());
  const seen=new Set<string>();
  for(const record of actual){if(record.evidence.parentId)assert.ok(seen.has(record.evidence.parentId));seen.add(record.detail.item.id);}
});


test("course child databases use existing directory coverage only under matching automatic ownership", async () => {
  const s=setup();s.blocks.set(id(10),[s.child(2,10,"child_database")]);
  const detail=await repo(s).get("course",id(10));
  assert.equal(detail!.document!.completeness,"complete");
  assert.deepEqual(detail!.document!.blocks,[]);
  assert.equal(s.calls.some(x=>x.startsWith("rows:")),false);
  const denied=await repo(s,new Set([id(10)])).get("course",id(10));assert.equal(denied,null);
});

test("foreign, archived, mismatched and unconfigured course databases remain explicit unsupported blocks", async () => {
  for (const change of ["foreign","archived","schema-owner","schema-database","schema-id","no-title","disabled-source","denied-database","unconfigured-source"]){
    const s=setup();s.blocks.set(id(10),[s.child(2,10,"child_database")]);
    const getDatabase=s.client.getDatabase!;
    if(change==="foreign"||change==="archived")s.client.getDatabase=async key=>{const db=await getDatabase(key);if(change==="foreign")db.parent=s.owner(999);else db.archived=true;return db;};
    const schema=s.schemas.get(id(3))!;
    if(change==="schema-owner")schema.database_parent=s.owner(999);
    if(change==="schema-database")schema.parent={type:"database_id",database_id:id(99)};
    if(change==="schema-id")schema.id=id(99);
    if(change==="no-title")schema.properties={};
    if(change==="disabled-source")s.config.sources[1].enabled=false;
    if(change==="unconfigured-source")s.config.sources.pop();
    const detail=await repo(s,change==="denied-database"?new Set([id(2)]):undefined).get("course",id(10));
    assert.equal(detail!.document!.completeness,"partial",change);
    assert.equal(detail!.document!.blocks[0].type,"unsupported",change);
    assert.equal(s.calls.some(x=>x.startsWith("rows:")),false,change);
  }
});

test("database lookup failures propagate and non-course documents never resolve database directory links", async () => {
  const s=setup();s.blocks.set(id(10),[s.child(2,10,"child_database")]);
  s.client.getDatabase=async()=>{throw Error("Diagnostic fixture failure");};
  await assert.rejects(repo(s).get("course",id(10)),/Diagnostic fixture failure/);
  const n=setup();n.blocks.set(id(20),[n.child(2,20,"child_database")]);
  n.client.getDatabase=async()=>assert.fail("Note body must not authorize database directory targets");
  const detail=await repo(n).get("study-note",id(20));assert.equal(detail!.document!.blocks[0].type,"unsupported");
});
