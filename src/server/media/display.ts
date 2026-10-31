import type {StoredMedia} from "../../../contracts/sync.ts";
import type {SqlExecutor} from "../database/sql.ts";
import type {PublicationMode} from "../database/publication.ts";
import {mediaIdentity} from "../database/website-validation.ts";
import {readDisplayAssets,DisplayError,type DisplayProjection} from "../database/display.ts";
import {selectDisplayFile,displayAssetId,displayRunId,type DisplayAsset,type DisplayFile} from "../self-hosted-media/manifest.ts";
import {verifyDisplayBytes} from "../self-hosted-media/files.ts";
import {DISPLAY_V2_RECIPE} from "../self-hosted-media/manifest.ts";
import type {ObjectStorage} from "../database/storage.ts";
import {WEBSITE_SCHEMA_DIGEST} from "../../../contracts/website-sync.ts";
import {cacheableMediaHeaders} from "./cache.ts";
import {ContentServiceError} from "../../../contracts/repository.ts";

/** The object port receives only a verified display descriptor. This helper
 * never exposes an original callback or source URL. */
export function displayStoredMedia(asset:DisplayAsset,file:DisplayFile):StoredMedia{
 return {assetId:mediaIdentity(asset.ownerPageId,"display:"+asset.assetId,file.sha256),ownerPageId:asset.ownerPageId,
  objectKey:"sha256/"+file.sha256,...file};
}
export async function databaseDisplayResponse(assetId:string,width:400|800|1600|null,ports:{
 read(assetId:string):Promise<DisplayProjection|null>;storage():Pick<ObjectStorage,"read">;
}):Promise<Response>{
 const headers={"Cache-Control":"private, no-store","Referrer-Policy":"no-referrer","X-Content-Type-Options":"nosniff"};
 const missing=()=>new Response(null,{status:404,headers});
 if(!displayAssetId(assetId))return missing();
 const first=await ports.read(assetId);if(!first)return missing();
 const file=selectDisplayFile(first.asset,width),bytes=await ports.storage().read(displayStoredMedia(first.asset,file));
 verifyDisplayBytes(file,bytes,DISPLAY_V2_RECIPE);
 const current=await ports.read(assetId);
 if(!current||JSON.stringify(current)!==JSON.stringify(first))return missing();
 return new Response(Buffer.from(bytes),{headers:{...cacheableMediaHeaders(headers),"Content-Type":file.mime,"Content-Length":String(bytes.byteLength)}});
}
/** One bounded mapping read per content envelope, rather than a query per image.
 * The existing content/cache projections and their query text are preserved. */
export function databaseDisplayProjectionSql(content:SqlExecutor,mappings:SqlExecutor,mode:PublicationMode):SqlExecutor{
 return {async query<T>(text:string,values?:unknown[]){
  const result=await content.query<T>(text,values);let visited=0;
  const image=(v:Record<string,unknown>)=>typeof v.id==="string"&&typeof v.src==="string"&&v.src==="/media/v2/"+v.id;
  async function transform(value:unknown,depth:number):Promise<unknown>{
   if(++visited>200000||depth>64)throw new DisplayError("DISPLAY_LIMIT");
   if(Array.isArray(value))return Promise.all(value.map(v=>transform(v,depth+1)));
   if(!value||typeof value!=="object")return value;
   const p=value as Record<string,unknown>;
   if(p.schemaDigest===WEBSITE_SCHEMA_DIGEST&&displayRunId(p.runId)&&Array.isArray(p.records)&&Array.isArray(p.mediaIds)){
    const requested=new Set<string>(),allowed=new Set(p.mediaIds);
    function collect(v:unknown,level:number){
     if(++visited>200000||level>64)throw new DisplayError("DISPLAY_LIMIT");
     if(Array.isArray(v)){v.forEach(x=>collect(x,level+1));return;}
     if(!v||typeof v!=="object")return;
     const obj=v as Record<string,unknown>;
     if(image(obj)){if(!allowed.has(obj.id))throw new DisplayError("DISPLAY_SOURCE_MISMATCH");requested.add(obj.id as string);}
     Object.values(obj).forEach(x=>collect(x,level+1));
    }collect(p.records,depth+1);
    if(!requested.size)return value;
    const response=await readDisplayAssets(mappings,p.runId,[...requested],mode);
    if(p.revision!==undefined&&String(p.revision)!==response.revision)throw new DisplayError("DISPLAY_VERSION_CHANGED");
    const assets=new Map(response.assets.map(a=>[a.assetId,a]));
    if(assets.size!==requested.size)throw new DisplayError("DISPLAY_MEDIA_NOT_READY");
    function project(v:unknown,level:number):unknown{
     if(++visited>200000||level>64)throw new DisplayError("DISPLAY_LIMIT");
     if(Array.isArray(v))return v.map(x=>project(x,level+1));
     if(!v||typeof v!=="object")return v;
     const obj=v as Record<string,unknown>;
     if(image(obj)){const a=assets.get(obj.id as string);if(!a)throw new DisplayError("DISPLAY_MEDIA_NOT_READY");return {...obj,delivery:{mode:"display-only",maxWidth:a.base.width,maxHeight:a.base.height}};}
     return Object.fromEntries(Object.entries(obj).map(([k,x])=>[k,project(x,level+1)]));
    }
    return {...p,records:project(p.records,depth+1)};
   }
   return Object.fromEntries(await Promise.all(Object.entries(p).map(async([k,v])=>[k,await transform(v,depth+1)])));
  }
  try{return {...result,rows:await transform(result.rows,0) as T[]};}
  catch(e){if(e instanceof DisplayError)throw new ContentServiceError("CONTENT_UNAVAILABLE","The display projection is unavailable.");throw e;}
 }};
}
