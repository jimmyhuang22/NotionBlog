import test from "node:test";
import assert from "node:assert/strict";
import { createCollectionReadSession } from "../scripts/website-sync/collection-source-proof.ts";
import { createDemo, demoId, demoParagraph } from "../scripts/notion-sync/demo.ts";
import type { BlockObjectResponse } from "@notionhq/client";
import type { NotionReadClient } from "../src/server/notion/types.ts";
import { configDigest } from "../src/server/database/website-validation.ts";

test("future proof requests exclude fulfilled discovery and seeded entities only in this session", async () => {
  const demo=createDemo(1),id=demoId(1000),source=demo.config.sources[0].dataSourceId;
  const proof=[{method:"getPage" as const,id,digest:"a".repeat(64),requestUpperBound:1}];
  const session=createCollectionReadSession(demo.client,()=>{});
  assert.equal(session.pendingProofRequests([proof,proof]),1,"Shared reads are counted once");
  await session.client.listPages!(source);
  assert.equal(session.pendingProofRequests([proof]),0,"A complete fresh listing already supplied the page");
  assert.equal(session.pendingProofRequests([[{...proof[0],method:"listBlocks",requestUpperBound:4}]]),4,"Same ID with a different method is still pending");
  assert.equal(createCollectionReadSession(demo.client,()=>{}).pendingProofRequests([proof]),1,"A later run must read again");
});

test("pending and failed reads never reduce the remaining proof request reserve",async()=>{
  const id=demoId(1),proof=[{method:"getPage" as const,id,digest:"a".repeat(64),requestUpperBound:1}];
  let reject!: (error:Error)=>void;
  const source={getPage:()=>new Promise((_resolve,no)=>{reject=no;})} as unknown as NotionReadClient;
  const session=createCollectionReadSession(source,()=>{}),pending=session.client.getPage(id);
  await Promise.resolve();assert.equal(session.pendingProofRequests([proof]),1);
  reject(new Error("fixture failure"));await assert.rejects(pending);
  assert.equal(session.pendingProofRequests([proof]),1);
});

test("response request IDs rotate without invalidating any entity or list proof", async () => {
  let request = "first";
  const methods = ["getPage", "getBlock", "getDataSource", "getDatabase", "listPages", "listBlocks"] as const;
  const entity = () => ({ id: demoId(1), object: "page", request_id: request, properties: { title: "unchanged" } });
  const client = Object.fromEntries(methods.map(method => [method, async () => method.startsWith("list") ? [entity()] : entity()])) as unknown as NotionReadClient;
  for (const method of methods) {
    const trace = createCollectionReadSession(client, () => {}).trace();
    await trace.client[method]!(demoId(2));
    const proof = trace.seal();
    assert.equal(proof[0].digestVersion, 2);
    request += "-next";
    assert.equal(await createCollectionReadSession(client, () => {}).matches(proof), true, method);
  }
});

test("normalization preserves same-named user properties, source schema, parent and archival changes", async () => {
  const original = { id: demoId(1), request_id: "first", properties: { request_id: { type: "title", title: "user text" } },
    parent: { page_id: demoId(2) }, archived: false, in_trash: false };
  let value = structuredClone(original);
  const client = { getPage: async () => structuredClone(value) } as unknown as NotionReadClient;
  const trace = createCollectionReadSession(client, () => {}).trace();
  await trace.client.getPage(demoId(1)); const proof = trace.seal();
  for (const mutate of [
    () => { value.properties.request_id.title = "changed content"; },
    () => { value.properties.request_id.type = "rich_text"; },
    () => { value.parent.page_id = demoId(3); },
    () => { value.archived = true; },
    () => { value.in_trash = true; },
  ]) {
    value = structuredClone(original); mutate();
    assert.equal(await createCollectionReadSession(client, () => {}).matches(proof), false);
  }
});

test("list-seeded entities and GET entities have the same v2 proof; list order remains significant", async () => {
  const demo = createDemo(2), id = demoId(1000);
  const client = { ...demo.client, getPage: async (key: string) => {
    const page = await demo.client.getPage(key); return page && { ...page, request_id: "GET transport ID" };
  } };
  const trace = createCollectionReadSession(client, () => {}).trace();
  await trace.client.getPage(id); const proof = trace.seal();
  const seeded = createCollectionReadSession(client, () => {});
  await seeded.client.listPages!(demo.config.sources[0].dataSourceId);
  assert.equal(await seeded.matches(proof), true);
  const listTrace = createCollectionReadSession(client, () => {}).trace();
  await listTrace.client.listPages!(demo.config.sources[0].dataSourceId);
  const reordered = { ...client, listPages: async (key: string) => (await client.listPages!(key)).reverse() };
  assert.equal(await createCollectionReadSession(reordered, () => {}).matches(listTrace.seal()), false);
});

test("legacy proofs keep their original meaning and unknown digest versions are rejected", async () => {
  let value = { id: demoId(1), request_id: "old response" };
  const client = { getPage: async () => ({ ...value }) } as unknown as NotionReadClient;
  const proof = [{ method: "getPage" as const, id: demoId(1), digest: configDigest(value), requestUpperBound: 1 }];
  assert.equal(await createCollectionReadSession(client, () => {}).matches(proof), true);
  value = { ...value, request_id: "new response" };
  assert.equal(await createCollectionReadSession(client, () => {}).matches(proof), false, "No silent upgrade of an irreversible legacy hash");
  await assert.rejects(createCollectionReadSession(client, () => {}).matches([{ ...proof[0], digestVersion: 3 as 2 }]), { code: "CHECKPOINT_FAILED" });
});

test("a proof compares every nested response; signed URLs rotate but changed text and properties do not pass",async()=>{
  const demo=createDemo(1),id=demoId(1000), block=demoId(9000);
  const hosted=(signature:string)=>{const url=new URL("https://assets.example.test/same.png");url.searchParams.set("signature",signature);return url.href;};
  const image=()=>({...demoParagraph(block,id,""),type:"image",image:{type:"file",file:{url:hosted("first"),expiry_time:"2027-01-01T00:00:00Z"},caption:[]}} as BlockObjectResponse);
  demo.blocks.set(id,[image()]);
  const first=createCollectionReadSession(demo.client,()=>{}),trace=first.trace();
  await trace.client.getPage(id);await trace.client.listBlocks(id);const proof=trace.seal();
  assert.equal(JSON.stringify(proof).includes("signature"),false);
  const img=image();if(img.type==="image"&&img.image.type==="file")img.image.file.url=hosted("second");
  demo.blocks.set(id,[img]);
  assert.equal(await createCollectionReadSession(demo.client,()=>{}).matches(proof),true);
  demo.blocks.set(id,[demoParagraph(block,id,"A new paragraph without a changed page timestamp")]);
  assert.equal(await createCollectionReadSession(demo.client,()=>{}).matches(proof),false);
});

test("fresh sibling listings remove repeated image block GETs, while a new process cannot inherit stale response objects",async()=>{
  const demo=createDemo(1),id=demoId(1000);
  demo.blocks.set(id,Array.from({length:40},(_,n)=>({...demoParagraph(demoId(9000+n),id,""),type:"image",image:{type:"external",external:{url:`https://assets.example.test/${n}.png`},caption:[]}} as BlockObjectResponse)));
  let gets=0,lists=0;
  const source={...demo.client,getBlock:async(key:string)=>{gets++;return demo.client.getBlock(key);},listBlocks:async(key:string)=>{lists++;return demo.client.listBlocks(key);}};
  const first=createCollectionReadSession(source,()=>{}),trace=first.trace();
  await trace.client.listBlocks(id);
  for(let n=0;n<40;n++)await trace.client.getBlock(demoId(9000+n));
  const proof=trace.seal();assert.equal(gets,0);assert.equal(lists,1);
  assert.equal(await createCollectionReadSession(source,()=>{}).matches(proof),true);
  assert.equal(gets,0);assert.equal(lists,2,"Restart performed a fresh listing, not a persisted-response replay");
  demo.blocks.set(id,[]);
  assert.equal(await createCollectionReadSession(source,()=>{}).matches(proof),false);
});

test("final qualification rereads a shared course once for all descendants, without trusting the collection cache",async()=>{
  const {runWebsiteSync}=await import("../scripts/website-sync/worker.ts");
  const {parseWebsiteNotionConfig}=await import("../src/server/notion/website-config.ts");
  const {DEMO}=await import("../scripts/notion-sync/demo.ts");
  const demo=createDemo(0),config=parseWebsiteNotionConfig({schemaVersion:2,sources:demo.config.sources.slice(1)});
  demo.blocks.set(DEMO.grandchild,[demoParagraph(demoId(9900),DEMO.grandchild,"Synthetic body")]);
  let courseReads=0;
  const client={...demo.client,getPage:async(id:string)=>{if(id===DEMO.course)courseReads++;return demo.client.getPage(id);}};
  const result=await runWebsiteSync({client,config,mode:"dry-run",captureCollection:{save:async()=>{},seal:async()=>{}}});
  assert.equal(result.records,4);assert.equal(courseReads,2,"One source pass and one independent final pass, not one per descendant");
});
