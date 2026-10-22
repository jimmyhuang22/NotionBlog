import test from "node:test";
import assert from "node:assert/strict";
import type { ContentDocument, ImageAsset, StatusEntry } from "../contracts/content.ts";
import { createMockRepository } from "../adapters/mock-repository.ts";
import { statusPreview, statusYear } from "../src/lib/content/status.ts";
import { parseListQuery } from "../src/lib/content/query.ts";
import { statusYearsResponse, contentListResponse } from "../src/lib/content/http.ts";
import { createFeatureGatedRepository } from "../src/lib/content/factory.ts";
import { contentFeatures } from "../config/features.ts";

const entry: StatusEntry = {id:"example",kind:"status",slug:"example",href:"/status#example",title:"Example",summary:null,tags:[],cover:null,updatedAt:null,recordedAt:null,text:[]};
const image = (n: number): ImageAsset => ({id:`image-${n}`,src:`/mock-media/${n}.svg`,alt:"Example",width:null,height:null});
const body = (blocks: ContentDocument["blocks"], completeness: ContentDocument["completeness"] = "complete"): ContentDocument => ({blocks,toc:[],completeness});
const invalid = (e: unknown) => !!e && typeof e === "object" && "code" in e && e.code === "INVALID_QUERY";

test("Status preview preserves image order, caps at nine, and keeps omitted content expandable", () => {
  const images = Array.from({length:10}, (_,n)=>({id:`block-${n}`,type:"image" as const,image:image(n),caption:[]}));
  const preview = statusPreview(entry,body(images));
  assert.deepEqual(preview.images!.map(i=>i.id),Array.from({length:9},(_,n)=>`image-${n}`));
  assert.equal(preview.hasMoreBody,true);
  assert.equal(statusPreview(entry,body(images.slice(0,9))).hasMoreBody,false);
  assert.equal(statusPreview(entry,body([{...images[0],caption:[{text:"Image caption"}]}])).hasMoreBody,true);
  assert.equal(statusPreview(entry,body([])).hasMoreBody,false);
  assert.equal(statusPreview(entry,null).hasMoreBody,true);
  assert.equal(statusPreview(entry,body([],"partial")).hasMoreBody,true);
});

test("Status preview traverses containers and never hides structures or missing paragraph text", () => {
  const document=body([{id:"toggle",type:"toggle",title:[{text:"More"}],children:[{id:"cols",type:"columns",columns:[{ratio:null,blocks:[{id:"list",type:"list",ordered:false,items:[{id:"row",checked:null,text:[],children:[{id:"img",type:"image",image:image(1),caption:[]}]}]}]}]}]}]);
  assert.deepEqual(statusPreview(entry,document).images,[image(1)]);
  assert.equal(statusPreview(entry,document).hasMoreBody,true);
  const paragraph=body([{id:"p",type:"paragraph",text:[{text:"Complete paragraph"}]}]);
  assert.equal(statusPreview({...entry,text:[{text:"Complete paragraph\n"}]},paragraph).hasMoreBody,false);
  assert.equal(statusPreview({...entry,text:[{text:"Complete"}]},paragraph).hasMoreBody,true);
  assert.equal(statusPreview(entry,body([{id:"q",type:"quote",text:[]}])).hasMoreBody,true);
  assert.equal(statusPreview(entry,body([{id:"c",type:"code",language:"text",code:"Example",caption:[]}])).hasMoreBody,true);
});

test("Status year uses the site zone at New Year and leaves date-only and missing values intact", () => {
  const item={...entry,recordedAt:{start:"2025-12-31T14:30:00Z",end:null,precision:"datetime" as const}};
  assert.equal(statusYear(item,"Australia/Melbourne"),2026);
  assert.equal(statusYear(item,"UTC"),2025);
  assert.equal(statusYear({...item,recordedAt:{...item.recordedAt,start:"2025-12-31",precision:"date"}},"Australia/Melbourne"),2025);
  assert.equal(statusYear(entry,"UTC"),null);
});

test("Status-only year queries reject duplicate, fractional, padded and unsupported values", () => {
  assert.deepEqual(parseListQuery("status",new URLSearchParams("year=2026&limit=12")),{year:2026,limit:12});
  assert.deepEqual(parseListQuery("status",new URLSearchParams("year=undated")),{year:"undated"});
  for(const value of ["","0","10000","2026.1","02026"," 2026","-1","unknown","2026&year=2025"]) assert.throws(()=>parseListQuery("status",new URLSearchParams(`year=${value}`)),invalid);
  assert.throws(()=>parseListQuery("course",new URLSearchParams("year=2026")),invalid);
});

test("mock Status years, unknown-date selection and list previews agree; cursors bind filters and zone", async () => {
  let zone="Australia/Melbourne";
  const repository=createMockRepository({timeZone:()=>zone});
  assert.deepEqual(await repository.getStatusYears!(),{years:[{year:2026,count:15},{year:2025,count:17}],undatedCount:4,timeZone:zone});
  assert.equal((await repository.list("status",{year:2026,limit:50})).items.length,15);
  assert.equal((await repository.list("status",{year:"undated"})).items[0].recordedAt,null);
  const first=await repository.list("status",{limit:1});
  assert.ok(Array.isArray(first.items[0].images));
  await assert.rejects(repository.list("status",{limit:1,year:2026,cursor:first.nextCursor!}),invalid);
  zone="UTC";
  await assert.rejects(repository.list("status",{limit:1,cursor:first.nextCursor!}),invalid);
});

test("year summary HTTP uses no-store, respects feature gates, and withholds provider exceptions",async()=>{
  const request=new Request("https://example.test/api/status/years");
  const repository=createMockRepository();
  const response=await statusYearsResponse(request,repository);
  assert.equal(response.status,200);assert.equal(response.headers.get("Cache-Control"),"no-store");
  assert.equal((await response.json()).data.undatedCount,4);
  assert.equal((await statusYearsResponse(new Request(request.url+"?year=2026"),repository)).status,400);
  const broken={...repository,getStatusYears:async()=>{throw Error("private-provider-details");}};
  const failure=await statusYearsResponse(request,broken);
  assert.equal(failure.status,503);assert.ok(!(await failure.text()).includes("private-provider-details"));
  const features={...contentFeatures,status:false};
  assert.equal((await statusYearsResponse(request,broken,features)).status,404);
  assert.deepEqual((await createFeatureGatedRepository(broken,features).getStatusYears!()).years,[]);
  assert.equal((await contentListResponse(new Request("https://example.test/api/content/status?year=2026.1"),"status",repository)).status,400);
});
