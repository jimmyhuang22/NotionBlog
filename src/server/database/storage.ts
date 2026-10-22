import { createHash } from "node:crypto";
import type { StoredMedia } from "../../../contracts/sync.ts";
import { ContentServiceError } from "../../../contracts/repository.ts";
import { validateMedia } from "./validation.ts";
import { hasStorageRole, type StorageIdentity } from "./storage-role.ts";

/** A classified transient transport failure; authorization and byte errors never use this type. */
export class TransientStorageReadError extends ContentServiceError {
  constructor() { super("CONTENT_UNAVAILABLE", "Media is temporarily unavailable."); }
}

export interface ObjectStorage {
  read(media: StoredMedia): Promise<Uint8Array>;
  /** Immutable upload; an existing key is accepted only after byte verification. */
  put(media: StoredMedia,bytes: Uint8Array): Promise<void>;
}
export interface StorageOptions {
  url: string;
  bucket: string;
  apiKey: string;
  token: string | (() => Promise<string>);
  role: "reader" | "writer";
  identity?: StorageIdentity;
  fetch?: typeof fetch;
}
function unavailable(): never { throw new ContentServiceError("CONTENT_UNAVAILABLE","Media is temporarily unavailable."); }
export function verifyMediaBytes(media: StoredMedia,bytes: Uint8Array): void {
  const b=Buffer.from(bytes);
  const mime=b.subarray(0,3).equals(Buffer.from([255,216,255]))?"image/jpeg":
    b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?"image/png":
    ["GIF87a","GIF89a"].includes(b.subarray(0,6).toString())?"image/gif":
    b.subarray(0,4).toString()==="RIFF"&&b.subarray(8,12).toString()==="WEBP"?"image/webp":
    b.subarray(4,8).toString()==="ftyp"&&["avif","avis"].includes(b.subarray(8,12).toString())?"image/avif":null;
  if(bytes.length!==media.byteSize||mime!==media.mime||createHash("sha256").update(bytes).digest("hex")!==media.sha256)unavailable();
}
/** Fetches only a fixed operator-configured Storage endpoint, never a source URL. */
export function createSupabaseStorage(options: StorageOptions): ObjectStorage {
  let base: URL;
  function validateToken(token: string): void {
    const claims=JSON.parse(Buffer.from(token.split(".")[1]??"","base64url").toString());
    if(claims.role!=="authenticated"||!hasStorageRole(claims.app_metadata,options.role,options.identity)||!Number.isFinite(claims.exp)||claims.exp<=Date.now()/1000)throw new Error();
  }
  try {
    if(options.identity!==undefined&&!["notion","social"].includes(options.identity))throw new Error();
    base=new URL(options.url);
    if(base.protocol!=="https:"||base.username||base.password||base.search||base.hash||base.pathname.replace(/\/$/,"")!=="/storage/v1"||!/^[a-zA-Z0-9_-]{1,100}$/.test(options.bucket))throw new Error();
    // Refuse broad service_role / secret keys. Storage verifies the actual JWT signature.
    if(typeof options.token==="string")validateToken(options.token);
    else if(typeof options.token!=="function")throw new Error();
    const apiClaims=options.apiKey.startsWith("sb_publishable_")?null:JSON.parse(Buffer.from(options.apiKey.split(".")[1]??"","base64url").toString());
    if(!options.apiKey||options.apiKey.startsWith("sb_secret_")||(apiClaims!==null&&apiClaims.role!=="anon"))throw new Error();
  } catch { throw new ContentServiceError("MISCONFIGURED","The restricted server-side media storage is not configured."); }
  const fetcher=options.fetch??fetch;
  async function headers() {
    const token=typeof options.token==="string"?options.token:await options.token();
    validateToken(token);
    return {apikey:options.apiKey,Authorization:`Bearer ${token}`};
  }
  async function read(media: StoredMedia): Promise<Uint8Array> {
    validateMedia(media);
    try {
      const response=await fetcher(`${base.origin}/storage/v1/object/authenticated/${options.bucket}/${media.objectKey}`,{
        headers:await headers(),redirect:"error",cache:"no-store",signal:AbortSignal.timeout(20000),
      });
      if(!response.ok||!response.body)unavailable();
      const declared=response.headers.get("Content-Length");
      if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>20*1024*1024))unavailable();
      const reader=response.body.getReader();const chunks: Uint8Array[]=[];let size=0;
      try { while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>20*1024*1024||size>media.byteSize)unavailable();chunks.push(value);} }
      catch {await reader.cancel().catch(()=>{});return unavailable();}
      const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
      verifyMediaBytes(media,bytes);return bytes;
    } catch {return unavailable();}
  }
  return {
    read,
    async put(media,bytes) {
      if(options.role!=="writer")unavailable();validateMedia(media);verifyMediaBytes(media,bytes);
      try {
        const result=await fetcher(`${base.origin}/storage/v1/object/${options.bucket}/${media.objectKey}`,{
          method:"POST",headers:{...await headers(),"Content-Type":media.mime,"x-upsert":"false"},body:Buffer.from(bytes),
          redirect:"error",cache:"no-store",signal:AbortSignal.timeout(20000),
        });
        if(result.ok)return;
        // Storage may report an existing immutable object as 400 or 409. Never overwrite it.
        if(result.status===400||result.status===409){await read(media);return;}
        unavailable();
      } catch {unavailable();}
    },
  };
}
