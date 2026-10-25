import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { Pool, type PoolClient, type QueryConfig } from "pg";
import { SYNC_SCHEMA_DIGEST } from "../../contracts/sync.ts";
import { mediaIdentity } from "../../src/server/database/validation.ts";
import { WEBSITE_READER_ISOLATION_SQL } from "../../src/server/database/website-reader-isolation.ts";

const mode=process.argv[2];assert.ok(["unset","off","enforce","invalid"].includes(mode));
const bytes=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]),sha256=createHash("sha256").update(bytes).digest("hex"),owner="0".repeat(31)+"1";
const assetId=mediaIdentity(owner,"cover",sha256),media={assetId,ownerPageId:owner,sha256,objectKey:"sha256/"+sha256,byteSize:bytes.length,mime:"image/png",width:null,height:null};
Object.assign(process.env,{NODE_ENV:"production",CONTENT_PROVIDER:"database",DATABASE_CONTENT_VERSION:"1",DATABASE_PUBLICATION_MODE:"qualified",
  DATABASE_READ_PROJECTION:"legacy",DATABASE_SEARCH_CONTEXT:"off",DATABASE_READER_URL:"postgres://fictional:fictional@localhost/db",DATABASE_TLS:"disable",
  MEDIA_PROVIDER:"storage",MEDIA_THUMBNAILS:"disabled",PUBLIC_CONTENT_CACHE:"disabled",STORAGE_PROVIDER:"cos",COS_BUCKET:"fiction-media-1250000000",COS_REGION:"ap-shanghai",
  COS_PREFIX:"notionblog",COS_SECRET_ID:"fixtureSecretId123",COS_SECRET_KEY:"fixtureSecretKeyForCos123"});
if(mode==="unset")delete process.env.DATABASE_READER_ISOLATION;else process.env.DATABASE_READER_ISOLATION=mode;
let connects=0,inspections=0,business=0,objects=0,missing=false,broken=false;const warnings:unknown[][]=[];
const oldConnect=Pool.prototype.connect,oldQuery=Pool.prototype.query,oldFetch=globalThis.fetch,oldWarn=console.warn;
try {
  console.warn=(...args)=>{warnings.push(args);};
  Pool.prototype.query=(()=>{throw Error("Budgeted checkout is required");}) as typeof Pool.prototype.query;
  Pool.prototype.connect=function(callback:(error:Error|null,client:PoolClient)=>void){connects++;
    const client=Object.assign(new EventEmitter(),{query:async(config:QueryConfig)=>{
      if(config.text===WEBSITE_READER_ISOLATION_SQL){inspections++;return{rows:[{isolated:false}]};}
      business++;assert.equal(config.text,"SELECT nb_api.read_media($1) AS result");
      if(broken)throw Error("private driver details");return{rows:[{result:{schemaDigest:SYNC_SCHEMA_DIGEST,media:missing?null:media}}]};
    },release:()=>{}});callback(null,client as unknown as PoolClient);
  } as typeof Pool.prototype.connect;
  globalThis.fetch=async()=>{objects++;return new Response(bytes);};
  const {GET}=await import("../../src/app/media/[assetId]/route.ts");
  const request=()=>new Request(`https://website.example.test/media/${assetId}`),context={params:Promise.resolve({assetId})};
  const response=await GET(request(),context);
  if(mode==="invalid"){
    assert.equal(response.status,503);const body=await response.json();assert.equal(body.error.code,"MISCONFIGURED");assert.match(body.error.message,/isolation mode/);
    assert.equal(connects,0);assert.equal(business,0);assert.equal(warnings.length,0);
  }else if(mode==="enforce"){
    assert.equal(response.status,503);assert.equal(business,0);assert.equal(objects,0);assert.equal(inspections,1);assert.equal(warnings.length,0);
  }else{
    assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);assert.equal(inspections,0);
    assert.deepEqual(warnings,[["WEBSITE_READER_ISOLATION_DEFERRED"]]);
    missing=true;assert.equal((await GET(request(),context)).status,404);assert.equal(objects,1);
    broken=true;const failure=await GET(request(),context);assert.equal(failure.status,503);assert.equal((await failure.text()).includes("private driver details"),false);
    assert.equal(warnings.filter(args=>args[0]==="WEBSITE_READER_ISOLATION_DEFERRED").length,1);
    assert.equal(JSON.stringify(warnings).includes("private driver details"),false);
  }
  console.log(JSON.stringify({mode,verified:true}));
}finally{Pool.prototype.connect=oldConnect;Pool.prototype.query=oldQuery;globalThis.fetch=oldFetch;console.warn=oldWarn;}
