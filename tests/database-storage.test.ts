import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { databasePoolConfig } from "../src/server/database/connection.ts";
import { createSupabaseStorage,verifyMediaBytes } from "../src/server/database/storage.ts";
import { mediaIdentity } from "../src/server/database/validation.ts";
import type { StoredMedia } from "../contracts/sync.ts";

const bytes=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
const sha=createHash("sha256").update(bytes).digest("hex");
const media: StoredMedia={assetId:mediaIdentity("fiction-page","cover",sha),ownerPageId:"fiction-page",objectKey:`sha256/${sha}`,sha256:sha,byteSize:bytes.length,mime:"image/png",width:null,height:null};
const jwt=(role:string,storageRole="reader",exp=Date.now()/1000+300)=>`e30.${Buffer.from(JSON.stringify({role,exp,app_metadata:{notionblog_storage_role:storageRole}})).toString("base64url")}.fixture`;
const options={url:"https://storage.example.test/storage/v1",bucket:"fiction-media",apiKey:"sb_publishable_fixture",token:jwt("authenticated"),role:"reader" as const};

test("database credentials and TLS are server-side, verified and bounded",()=>{
  const c=databasePoolConfig("postgresql://fiction:fixture@database.example.test/db",undefined);
  assert.equal(c.max,2);assert.deepEqual(c.ssl,{rejectUnauthorized:true});
  for(const [url,tls] of [[undefined,undefined],["postgresql://fiction:fixture@database.example.test/db","disable"],["postgresql://fiction:fixture@database.example.test/db?sslmode=no-verify",undefined]])assert.throws(()=>databasePoolConfig(url,tls));
  assert.equal(databasePoolConfig("postgresql://fiction:fixture@127.0.0.1/db","disable").ssl,false);
});
test("storage refuses broad/expired/wrong-role credentials and malformed endpoints",()=>{
  for(const change of [{token:jwt("service_role")},{token:jwt("authenticated","writer")},{token:jwt("authenticated","reader",0)},{apiKey:"sb_secret_fixture"},{url:"http://storage.example.test/storage/v1"},{url:"https://storage.example.test/redirect"},{bucket:"../private"}])assert.throws(()=>createSupabaseStorage({...options,...change}));
});
test("storage reads from a fixed authenticated endpoint without redirects or browser caching",async()=>{
  let calls=0;
  const s=createSupabaseStorage({...options,fetch:async (input,init)=>{
    calls++;assert.equal(input,`${options.url}/object/authenticated/fiction-media/${media.objectKey}`);
    assert.equal(init?.redirect,"error");assert.equal(init?.cache,"no-store");assert.ok(init?.signal);
    assert.equal((init?.headers as Record<string,string>).Authorization,`Bearer ${options.token}`);
    return new Response(bytes,{headers:{"Content-Type":"image/png","Content-Length":String(bytes.length)}});
  }});
  assert.deepEqual(Buffer.from(await s.read(media)),bytes);assert.equal(calls,1);
  await assert.rejects(s.put(media,bytes));assert.equal(calls,1);
});
test("storage rejects oversized, corrupt and MIME-mismatched bytes without forwarding errors",async()=>{
  for(const response of [()=>new Response(bytes,{headers:{"Content-Length":"20971521"}}),()=>new Response(new Uint8Array(bytes.length+1)),()=>new Response(new Uint8Array(bytes.length)),()=>new Response(null,{status:302,headers:{Location:"https://private.example.test"}})]){
    const s=createSupabaseStorage({...options,fetch:async()=>response()});await assert.rejects(s.read(media),e=>e instanceof Error&&e.message==="Media is temporarily unavailable.");
  }
  assert.throws(()=>verifyMediaBytes({...media,mime:"image/jpeg"},bytes));
});
test("immutable uploads verify existing bytes after an idempotent conflict",async()=>{
  const requests:string[]=[];
  const s=createSupabaseStorage({...options,role:"writer",token:jwt("authenticated","writer"),fetch:async (url,init)=>{
    requests.push(String(url));if(init?.method==="POST"){
      assert.equal((init.headers as Record<string,string>)["x-upsert"],"false");return new Response(null,{status:409});
    }return new Response(bytes);
  }});
  await s.put(media,bytes);assert.equal(requests.length,2);
});
test("storage acquires and validates current reader credentials for each object request",async()=>{
  let tokenCalls=0,objectCalls=0;
  let current=jwt("authenticated");
  const storage=createSupabaseStorage({...options,token:async()=>{tokenCalls++;return current;},fetch:async(_url,init)=>{
    objectCalls++;assert.equal((init?.headers as Record<string,string>).Authorization,`Bearer ${current}`);return new Response(bytes);
  }});
  await storage.read(media);assert.equal(tokenCalls,1);assert.equal(objectCalls,1);
  for(const invalid of [jwt("authenticated","reader",0),jwt("authenticated","writer"),jwt("service_role"),"malformed"]){
    current=invalid;await assert.rejects(storage.read(media));
  }
  assert.equal(tokenCalls,5);assert.equal(objectCalls,1);
  current=jwt("authenticated");await storage.read(media);assert.equal(objectCalls,2);
});
test("static writer and reader credentials that expire after construction cannot reach Storage",async t=>{
  t.mock.timers.enable({apis:["Date"],now:Date.now()});
  let requests=0;
  const expires=Date.now()/1000+10;
  const reader=createSupabaseStorage({...options,token:jwt("authenticated","reader",expires),fetch:async()=>{requests++;return new Response(bytes);}});
  const writer=createSupabaseStorage({...options,role:"writer",token:jwt("authenticated","writer",expires),fetch:async()=>{requests++;return new Response(null,{status:200});}});
  t.mock.timers.tick(10_001);
  await assert.rejects(reader.read(media));await assert.rejects(writer.put(media,bytes));assert.equal(requests,0);
});
