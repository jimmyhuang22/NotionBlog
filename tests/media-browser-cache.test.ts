import test from "node:test";
import assert from "node:assert/strict";
import { cacheableMediaHeaders, MEDIA_BROWSER_CACHE_CONTROL, hasSafeMediaCachePolicy } from "../src/server/media/cache.ts";
import { thumbnailMediaResponse } from "../src/server/media/thumbnail.ts";
import { hybridMediaResponse } from "../src/server/media/hybrid.ts";
import { createHash } from "node:crypto";
import { mediaIdentity } from "../src/server/database/validation.ts";
import type { ThumbnailProjection } from "../src/server/database/thumbnail-index.ts";
import { publicHttpResponse } from "../src/server/public-cache/http.ts";
import { TransientStorageReadError } from "../src/server/database/storage.ts";
const hash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const bytes = Buffer.from([82,73,70,70,4,0,0,0,87,69,66,80]);
const owner = "0".repeat(31)+"1", sha256 = hash(bytes), assetId = mediaIdentity(owner,"cover",sha256);
const media = { assetId, ownerPageId: owner, objectKey: "sha256/"+sha256, sha256, byteSize: bytes.length, mime: "image/webp" as const, width: 800, height: 400 };
const binding = { assetId, ownerPageId: owner, sha256, locator: {kind:"cover" as const}, delivery:"notion" as const, sourceFingerprint:"a".repeat(64) };
const projection: ThumbnailProjection = { version:"v2",runId:"11111111-1111-4111-8111-111111111111",source:{media,binding},thumbnail:{...media,assetId:mediaIdentity(owner,`thumbnail:800:${assetId}`,sha256)} };
function cached(response: Response) {
 assert.equal(response.headers.get("Cache-Control"),MEDIA_BROWSER_CACHE_CONTROL);
 assert.equal(response.headers.get("CDN-Cache-Control"),"no-store");
 assert.equal(response.headers.get("Vercel-CDN-Cache-Control"),"no-store");
 assert.ok(!response.headers.get("Cache-Control")!.includes("immutable"));
}
test("only successful qualified v2 thumbnail bytes receive private one-day cache headers",async()=>{
 let denied=false;
 const ports={qualification:"database" as const,read:async()=>denied?null:projection,resolve:async()=>{throw Error("No Notion for a database hit");},storage:()=>({read:async()=>bytes,put:async()=>{}}),original:async()=>{throw Error("No fallback expected");}};
 const response=await thumbnailMediaResponse(assetId,800,ports);assert.equal(response.status,200);cached(response);
 denied=true;const missing=await thumbnailMediaResponse(assetId,800,ports);assert.equal(missing.status,404);assert.match(missing.headers.get("Cache-Control")!,/no-store/);
 denied=false;const withdrawn=await thumbnailMediaResponse(assetId,800,{...ports,storage:()=>({read:async()=>{denied=true;return bytes;},put:async()=>{}})});
 assert.equal(withdrawn.status,404);assert.match(withdrawn.headers.get("Cache-Control")!,/no-store/);
});
test("qualified original bytes cache for v2; dynamic redirects stay no-store",async()=>{
 const source={media,binding};
 const ports={version:"v2" as const,read:async()=>source,resolve:async()=>({url:"https://example.test/original.webp",sourceFingerprint:binding.sourceFingerprint}),storage:()=>({read:async()=>bytes,put:async()=>{}})};
 const redirect=await hybridMediaResponse(assetId,ports);assert.equal(redirect.status,302);assert.match(redirect.headers.get("Cache-Control")!,/no-store/);
 const stored=await hybridMediaResponse(assetId,{...ports,read:async()=>({...source,binding:{...binding,delivery:"storage" as const}})});assert.equal(stored.status,200);cached(stored);
 const legacy=await hybridMediaResponse(assetId,{...ports,version:"v1",read:async()=>({...source,binding:{...binding,delivery:"storage" as const}})});assert.match(legacy.headers.get("Cache-Control")!,/no-store/);
});
test("cache policy preserves security headers and never mutates no-store error defaults",()=>{
 const base={"Cache-Control":"private, no-store","Referrer-Policy":"no-referrer","X-Content-Type-Options":"nosniff"};
 const cache=cacheableMediaHeaders(base);assert.equal(base["Cache-Control"],"private, no-store");assert.equal(cache["Referrer-Policy"],"no-referrer");assert.equal(cache["X-Content-Type-Options"],"nosniff");
});

test("public cache preserves live-source qualification, including database-thumbnail fallback", async t => {
 const previous={...process.env};
 Object.assign(process.env,{VERCEL:"",PUBLIC_CONTENT_CACHE:"tagged-v1",CONTENT_PROVIDER:"database",DATABASE_CONTENT_VERSION:"2",DATABASE_PUBLICATION_MODE:"qualified",PUBLIC_CACHE_SITE_KEY:"fixture",CACHE_PURGE_SECRET:"a".repeat(64),PUBLIC_CACHE_ORIGIN:"https://example.test"});
 delete process.env.PUBLIC_CACHE_PURGE_SECRET;
 try {
  const source={media,binding:{...binding,delivery:"storage" as const}};
  const original=()=>hybridMediaResponse(assetId,{version:"v2",read:async()=>source,resolve:async()=>({url:"https://example.test/original.webp",sourceFingerprint:binding.sourceFingerprint}),storage:()=>({read:async()=>bytes,put:async()=>{}})});
  const ports={read:async()=>projection,resolve:async()=>({url:"https://example.test/original.webp",sourceFingerprint:binding.sourceFingerprint}),storage:()=>({read:async()=>bytes,put:async()=>{}}),original};
  const request=new Request(`https://example.test/media/v2/${assetId}?thumbnail=800`,{headers:{"If-None-Match":"*"}});
  async function privateOnly(response:Response){
   const result=await publicHttpResponse(request,response,"media");
   assert.equal(result.status,304);
   assert.equal(result.headers.get("Cache-Control"),"private, no-cache, must-revalidate");
   assert.equal(result.headers.get("CDN-Cache-Control"),"no-store");
   assert.equal(result.headers.get("Vercel-CDN-Cache-Control"),"no-store");
   assert.equal(result.headers.get("Vercel-Cache-Tag"),null);
   assert.equal(hasSafeMediaCachePolicy(result,request.url),true);
   const full=await publicHttpResponse(new Request(request.url),await original(),"media");
   assert.equal(full.status,200);assert.equal(full.headers.get("Vercel-CDN-Cache-Control"),"no-store");
   assert.deepEqual(Buffer.from(await full.arrayBuffer()),bytes);
  }
  await t.test("live original bytes cannot be upgraded to shared CDN caching",async()=>privateOnly(await original()));
  await t.test("explicit and default live thumbnail qualification both stay private",async()=>{
   for(const qualification of [undefined,"live-notion"] as const)await privateOnly(await thumbnailMediaResponse(assetId,800,{...ports,qualification}));
  });
  await t.test("a database-qualified thumbnail still uses the approved public cache",async()=>{
   const result=await publicHttpResponse(request,await thumbnailMediaResponse(assetId,800,{...ports,qualification:"database"}),"media");
   assert.equal(result.status,304);assert.match(result.headers.get("Vercel-CDN-Cache-Control")!,/max-age=/);
   assert.equal(result.headers.get("X-Content-Cache-Policy"),"nb-public-cache-v1");
  });
  await t.test("missing and transient variants preserve the live original's exclusion",async()=>{
   await privateOnly(await thumbnailMediaResponse(assetId,800,{...ports,qualification:"database",read:async()=>({...projection,thumbnail:null})}));
   await privateOnly(await thumbnailMediaResponse(assetId,800,{...ports,qualification:"database",storage:()=>({read:async()=>{throw new TransientStorageReadError();},put:async()=>{}})}));
  });
 }finally{for(const key of Object.keys(process.env))if(!(key in previous))delete process.env[key];Object.assign(process.env,previous);}
});


test("visitor guards accept the exact image cache exception and keep API, errors, redirects and shared caches strict",()=>{
 const path=`/media/v2/${assetId}?thumbnail=800`, headers=cacheableMediaHeaders({});
 assert.equal(hasSafeMediaCachePolicy(new Response(bytes,{headers}),path),true);
 assert.equal(hasSafeMediaCachePolicy(new Response(bytes,{headers}),`/media/social/s1.${"a".repeat(64)}?thumbnail=400`),true);
 for(const other of ["/api/content/status",`/media/${assetId}`,"/robots.txt"]) assert.equal(hasSafeMediaCachePolicy(new Response(bytes,{headers}),other),false);
 for(const status of [302,404,503]) assert.equal(hasSafeMediaCachePolicy(new Response(null,{status,headers}),path),false);
 for(const policy of ["public, max-age=86400","private, max-age=172800, must-revalidate","private, max-age=86400, must-revalidate, stale-if-error=3600","private, max-age=86400, immutable"]) {
  assert.equal(hasSafeMediaCachePolicy(new Response(bytes,{headers:{"Cache-Control":policy}}),path),false);
 }
 assert.equal(hasSafeMediaCachePolicy(new Response(bytes,{headers:{...headers,"CDN-Cache-Control":"public, max-age=3600"}}),path),false);
 assert.equal(hasSafeMediaCachePolicy(new Response(bytes,{headers:{"Cache-Control":"no-store","Vercel-CDN-Cache-Control":"public, max-age=3600"}}),"/api/content/status"),false);
 assert.equal(hasSafeMediaCachePolicy(new Response(null,{status:404,headers:{"Cache-Control":"private, no-store"}}),path),true);
});
