import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import sharp from "sharp";
import type { ThumbnailProjection } from "../src/server/database/thumbnail-index.ts";
import { mediaIdentity } from "../src/server/database/validation.ts";
import { thumbnailMediaResponse, thumbnailsEnabled, thumbnailWidth, thumbnailQualification, type ThumbnailMediaPorts } from "../src/server/media/thumbnail.ts";
import { TransientStorageReadError } from "../src/server/database/storage.ts";
import { ContentServiceError } from "../contracts/repository.ts";
import { hybridMediaResponse } from "../src/server/media/hybrid.ts";
import { sourceFingerprint } from "../src/server/media/notion-source.ts";

async function fixture() {
  const original = await sharp({create:{width:1200,height:900,channels:3,background:"#557799"}}).jpeg().toBuffer();
  const bytes = await sharp(original).resize({width:400}).webp().toBuffer();
  const hash = (value:Uint8Array) => createHash("sha256").update(value).digest("hex");
  const owner="example-owner", sha=hash(original), asset=mediaIdentity(owner,"cover",sha), output=hash(bytes);
  const url="https://images.example.test/photo.jpg", fingerprint=sourceFingerprint(url,false);
  const projection:ThumbnailProjection={version:"v2",runId:"11111111-1111-4111-8111-111111111111",source:{
    media:{assetId:asset,ownerPageId:owner,sha256:sha,objectKey:`sha256/${sha}`,byteSize:original.length,mime:"image/jpeg",width:1200,height:900},
    binding:{assetId:asset,ownerPageId:owner,sha256:sha,locator:{kind:"cover"},delivery:"notion",sourceFingerprint:fingerprint},
  },thumbnail:{assetId:mediaIdentity(owner,`thumbnail:400:${asset}`,output),ownerPageId:owner,sha256:output,objectKey:`sha256/${output}`,byteSize:bytes.length,mime:"image/webp",width:400,height:300}};
  let reads=0,resolves=0,storageReads=0,originals=0;
  const ports:ThumbnailMediaPorts={read:async()=>{reads++;return projection;},resolve:async()=>{resolves++;return{url,sourceFingerprint:fingerprint};},
    storage:()=>({read:async()=>{storageReads++;return bytes;},put:async()=>{throw new Error("HTTP cannot write");}}),
    original:async()=>{originals++;return new Response(null,{status:302,headers:{Location:url,"Cache-Control":"private, no-store"}});},
  };
  return{projection,ports,bytes,asset,counts:()=>({reads,resolves,storageReads,originals})};
}

test("thumbnail queries have two fixed tiers and an explicit server opt-in",()=>{
  assert.equal(thumbnailWidth("https://example.test/media/x"),null);
  assert.equal(thumbnailWidth("https://example.test/media/x?thumbnail=400"),400);
  assert.equal(thumbnailWidth("https://example.test/media/x?thumbnail=800"),800);
  for(const query of ["thumbnail=","thumbnail=401","thumbnail=0400","thumbnail=400&thumbnail=800"])
    assert.throws(()=>thumbnailWidth(`https://example.test/media/x?${query}`));
  assert.equal(thumbnailsEnabled(undefined),false);
  assert.equal(thumbnailsEnabled("disabled"),false);
  assert.equal(thumbnailsEnabled("enabled"),true);
  assert.throws(()=>thumbnailsEnabled("true"));
  assert.equal(thumbnailQualification(undefined),"live-notion");
  assert.equal(thumbnailQualification("database"),"database");
  assert.throws(()=>thumbnailQualification("cached"));
});

test("explicit database qualification serves verified bytes with current scope checked before and after, without Notion",async()=>{
  const f=await fixture();f.ports.qualification="database";
  f.ports.resolve=async()=>assert.fail("stored thumbnail must not depend on Notion availability");
  const response=await thumbnailMediaResponse(f.asset,400,f.ports);assert.equal(response.status,200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),f.bytes);
  assert.deepEqual(f.counts(),{reads:2,resolves:0,storageReads:1,originals:0});
});

test("cached bytes never cache qualification: every request rechecks current scope and keeps private HTTP policy", async () => {
  const f = await fixture(); f.ports.qualification = "database";
  const objectStorage = f.ports.storage(); f.ports.storage = () => objectStorage;
  const first = await thumbnailMediaResponse(f.asset,400,f.ports);
  assert.match(first.headers.get("Server-Timing")!, /thumb_object;dur=[\d.]+;desc="miss"/);
  const hit = await thumbnailMediaResponse(f.asset,400,f.ports);
  assert.equal(hit.status,200); assert.deepEqual(Buffer.from(await hit.arrayBuffer()),f.bytes);
  assert.match(hit.headers.get("Server-Timing")!, /thumb_scope;dur=[\d.]+, thumb_object;dur=[\d.]+;desc="hit", thumb_recheck;dur=[\d.]+/);
  assert.equal(hit.headers.get("Cache-Control"),"private, max-age=86400, must-revalidate");
  assert.equal(hit.headers.get("CDN-Cache-Control"),"no-store");
  assert.equal(hit.headers.get("Vercel-CDN-Cache-Control"),"no-store");
  assert.deepEqual(f.counts(),{reads:4,resolves:0,storageReads:1,originals:0});
  f.ports.read = async () => null;
  const withdrawn = await thumbnailMediaResponse(f.asset,400,f.ports);
  assert.equal(withdrawn.status,404); assert.equal(withdrawn.headers.get("Cache-Control"),"private, no-store");
  assert.equal(withdrawn.headers.get("Server-Timing"),null); assert.equal(f.counts().storageReads,1);
});

test("cache hits cannot outlive in-flight withdrawal, source changes or a publication switch", async () => {
  for (const change of ["withdraw", "generation", "binding", "variant"]) {
    const f = await fixture(); f.ports.qualification = "database";
    const objectStorage = f.ports.storage(); f.ports.storage = () => objectStorage;
    await thumbnailMediaResponse(f.asset,400,f.ports);
    let reads = 0;
    f.ports.read = async () => {
      if (++reads === 1) return structuredClone(f.projection);
      if (change === "withdraw") return null;
      const current = structuredClone(f.projection);
      if (change === "generation") current.runId = "22222222-2222-4222-8222-222222222222";
      if (change === "binding") current.source.binding.sourceFingerprint = "0".repeat(64);
      if (change === "variant") current.thumbnail!.width = 399;
      return current;
    };
    assert.equal((await thumbnailMediaResponse(f.asset,400,f.ports)).status,404,change);
    assert.equal(f.counts().storageReads,1); assert.equal(f.counts().originals,0); assert.equal(reads,2);
  }
});

test("database thumbnail scope still blocks central withdrawal, new generations, changed bindings and corrupt bytes",async()=>{
  for(const change of ["denied","generation","binding","bytes"]){
    const f=await fixture();f.ports.qualification="database";let reads=0;
    f.ports.resolve=async()=>assert.fail("no live lookup");
    f.ports.read=async()=>{
      if(++reads===1)return structuredClone(f.projection);
      if(change==="denied")return null;
      const value=structuredClone(f.projection);
      if(change==="generation")value.runId="22222222-2222-4222-8222-222222222222";
      if(change==="binding")value.source.binding.sourceFingerprint="0".repeat(64);
      return value;
    };
    if(change==="bytes"){
      f.ports.storage=()=>({read:async()=>new Uint8Array([1]),put:async()=>assert.fail()});
      await assert.rejects(thumbnailMediaResponse(f.asset,400,f.ports));
    }else assert.equal((await thumbnailMediaResponse(f.asset,400,f.ports)).status,404,change);
    assert.equal(f.counts().originals,0);
  }
});

test("database qualification never bypasses the original resolver when a variant is absent or its connection fails",async()=>{
  for(const absent of [true,false]){
    const f=await fixture();f.ports.qualification="database";
    if(absent)f.projection.thumbnail=null;
    else f.ports.storage=()=>({read:async()=>{throw new TransientStorageReadError();},put:async()=>assert.fail()});
    f.ports.original=()=>hybridMediaResponse(f.asset,{version:"v2",read:async()=>f.projection.source,resolve:async()=>{throw new ContentServiceError("RATE_LIMITED","The Notion service is busy. Try again later.");},storage:()=>assert.fail()});
    await assert.rejects(thumbnailMediaResponse(f.asset,400,f.ports),{code:"RATE_LIMITED"});
  }
});

test("thumbnail HTTP returns verified small bytes while checking the original source twice and generation three times",async()=>{
  const f=await fixture(), response=await thumbnailMediaResponse(f.asset,400,f.ports);
  assert.equal(response.status,200);
  assert.equal(response.headers.get("Content-Type"),"image/webp");
  assert.equal(response.headers.get("Cache-Control"),"private, max-age=86400, must-revalidate");
  assert.equal(response.headers.get("CDN-Cache-Control"),"no-store");
  assert.equal(response.headers.get("Location"),null);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),f.bytes);
  assert.deepEqual(f.counts(),{reads:3,resolves:2,storageReads:1,originals:0});
});

test("an absent variant uses the qualified original; lookup and byte errors never fall back",async()=>{
  const f=await fixture();f.projection.thumbnail=null;
  assert.equal((await thumbnailMediaResponse(f.asset,400,f.ports)).status,302);
  assert.equal(f.counts().originals,1);
  f.ports.read=async()=>{throw new Error("Index unavailable");};
  await assert.rejects(thumbnailMediaResponse(f.asset,400,f.ports));
  assert.equal(f.counts().originals,1);
  const bad=await fixture();bad.ports.storage=()=>({read:async()=>new Uint8Array([1,2,3]),put:async()=>{}});
  await assert.rejects(thumbnailMediaResponse(bad.asset,400,bad.ports));
  assert.equal(bad.counts().originals,0);
});

test("withdrawal or changed source before the download returns no derivative",async()=>{
  const f=await fixture();f.ports.read=async()=>null;
  assert.equal((await thumbnailMediaResponse(f.asset,400,f.ports)).status,404);
  assert.equal(f.counts().storageReads,0);
  const changed=await fixture();changed.ports.resolve=async()=>({url:"https://images.example.test/replaced.jpg",sourceFingerprint:"0".repeat(64)});
  assert.equal((await thumbnailMediaResponse(changed.asset,400,changed.ports)).status,404);
  assert.equal(changed.counts().storageReads,0);
});

test("a slow object read cannot outlive withdrawal, generation replacement or a changed variant",async()=>{
  for(const change of ["withdraw","generation","variant"]){
    const f=await fixture();let read=0;
    f.ports.read=async()=>{
      if(++read===1)return structuredClone(f.projection);
      if(change==="withdraw")return null;
      const result=structuredClone(f.projection);
      if(change==="generation")result.runId="22222222-2222-4222-8222-222222222222";
      else result.thumbnail!.sha256="0".repeat(64);
      return result;
    };
    assert.equal((await thumbnailMediaResponse(f.asset,400,f.ports)).status,404,change);
    assert.equal(f.counts().originals,0);
  }
});

test("live source withdrawal after object download and withdrawal after its final lookup both block the response",async()=>{
  const f=await fixture();let resolve=0;
  const initial=f.ports.resolve;
  f.ports.resolve=async binding=>++resolve===1?initial(binding):null;
  assert.equal((await thumbnailMediaResponse(f.asset,400,f.ports)).status,404);
  const final=await fixture();let read=0;
  final.ports.read=async()=>++read<3?final.projection:null;
  assert.equal((await thumbnailMediaResponse(final.asset,400,final.ports)).status,404);
});


test("transient thumbnail transport failure re-enters the qualified original path without another object attempt", async () => {
  const f=await fixture();let attempts=0;
  f.ports.storage=()=>({read:async()=>{attempts++;throw new TransientStorageReadError();},put:async()=>assert.fail()});
  f.ports.original=()=>hybridMediaResponse(f.asset,{version:"v2",read:async()=>f.projection.source,resolve:f.ports.resolve,storage:()=>assert.fail()});
  const response=await thumbnailMediaResponse(f.asset,400,f.ports);
  assert.equal(response.status,302);assert.equal(response.headers.get("Location"),"https://images.example.test/photo.jpg");
  assert.equal(response.headers.get("Cache-Control"),"private, no-store");assert.equal(attempts,1);
});
test("temporary object failure cannot bypass withdrawal, generation change, Notion denial or original failure",async t=>{
  for(const mode of ["withdraw","generation","source-denied","original-error"])await t.test(mode,async()=>{
    const f=await fixture();let failed=false;
    f.ports.storage=()=>({read:async()=>{failed=true;throw new TransientStorageReadError();},put:async()=>assert.fail()});
    f.ports.read=async()=>failed&&mode==="withdraw"?null:failed&&mode==="generation"?{...f.projection,runId:"22222222-2222-4222-8222-222222222222"}:f.projection;
    f.ports.original=()=>hybridMediaResponse(f.asset,{version:"v2",read:async()=>f.projection.source,resolve:async()=>{
      if(mode==="original-error")throw new ContentServiceError("CONTENT_UNAVAILABLE","Original unavailable");
      return null;
    },storage:()=>assert.fail()});
    if(mode==="original-error")await assert.rejects(thumbnailMediaResponse(f.asset,400,f.ports),{code:"CONTENT_UNAVAILABLE"});
    else assert.equal((await thumbnailMediaResponse(f.asset,400,f.ports)).status,404);
  });
});
test("unclassified object failure remains unavailable and cannot trigger the original path",async()=>{
  const f=await fixture();f.ports.storage=()=>({read:async()=>{throw new ContentServiceError("CONTENT_UNAVAILABLE","Provider denied");},put:async()=>assert.fail()});
  await assert.rejects(thumbnailMediaResponse(f.asset,400,f.ports));assert.equal(f.counts().originals,0);
});
