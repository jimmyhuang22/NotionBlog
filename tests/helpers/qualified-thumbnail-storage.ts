import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mediaIdentity} from "../../src/server/database/validation.ts";
import type {StoredMedia} from "../../contracts/sync.ts";

const original=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
const variant=Buffer.from([82,73,70,70,4,0,0,0,87,69,66,80]);
const descriptor=(bytes:Buffer,mime:StoredMedia["mime"],locator:string):StoredMedia=>{
  const sha=createHash("sha256").update(bytes).digest("hex");
  return {assetId:mediaIdentity("fiction-page",locator,sha),ownerPageId:"fiction-page",objectKey:`sha256/${sha}`,sha256:sha,byteSize:bytes.length,mime,width:null,height:null};
};
const parent=descriptor(original,"image/png","cover"),thumbnail=descriptor(variant,"image/webp","thumbnail");
for(const key of ["DATABASE_MEDIA_DIRECTORY","STORAGE_READER_EMAIL","STORAGE_READER_PASSWORD","STORAGE_READER_USER_ID","COS_SECURITY_TOKEN","COS_CREDENTIALS_EXPIRES_AT"])delete process.env[key];
const token=`e30.${Buffer.from(JSON.stringify({role:"authenticated",exp:Date.now()/1000+600,app_metadata:{notionblog_storage_role:"reader"}})).toString("base64url")}.fixture`;
Object.assign(process.env,{DATABASE_READER_URL:"postgres://fixture:fixture@localhost/db",DATABASE_TLS:"disable",DATABASE_CONTENT_VERSION:"2",
  DATABASE_PUBLICATION_MODE:"qualified",MEDIA_PROVIDER:"notion",STORAGE_PROVIDER:"supabase",THUMBNAIL_STORAGE_PROVIDER:"cos",
  STORAGE_URL:"https://storage.example.test/storage/v1",STORAGE_BUCKET:"fiction-media",STORAGE_API_KEY:"sb_publishable_fixture",STORAGE_READ_TOKEN:token,
  COS_BUCKET:"fiction-media-1250000000",COS_REGION:"ap-shanghai",COS_PREFIX:"notionblog",COS_SECRET_ID:"fixtureSecretId123",COS_SECRET_KEY:"fixtureSecretKeyForCos123"});
let originals=0,variants=0,missing=false;
globalThis.fetch=async(input,init)=>{
 const u=new URL(String(input));assert.equal(init?.redirect,"error");assert.equal(init?.method??"GET","GET");
 if(u.hostname==="storage.example.test"){
  originals++;assert.equal(u.pathname,`/storage/v1/object/authenticated/fiction-media/${parent.objectKey}`);return new Response(original);
 }
 assert.equal(u.hostname,"fiction-media-1250000000.cos.ap-shanghai.myqcloud.com");
 variants++;assert.equal(u.pathname,`/notionblog/${thumbnail.objectKey}`);
 return missing?new Response(null,{status:404}):new Response(variant);
};
const {getDatabaseRuntime}=await import("../../src/server/database/runtime.ts");
const runtime=getDatabaseRuntime();
assert.deepEqual(Buffer.from(await runtime.storage().read(parent)),original);
assert.deepEqual(Buffer.from(await runtime.thumbnailStorage().read(thumbnail)),variant);
missing=true;await assert.rejects(runtime.thumbnailStorage().read(thumbnail));
assert.equal(originals,1,"a missing COS thumbnail must not read an unrelated original store");
await assert.rejects(runtime.thumbnailStorage().put(thumbnail,variant));assert.equal(variants,2);
console.log(JSON.stringify({originals,variants,cosFailureDidNotFallBack:true,writesDenied:true}));
