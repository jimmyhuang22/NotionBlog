import { cacheableMediaHeaders } from "../media/cache.ts";
import type { StoredMedia } from "../../../contracts/sync.ts";
import { SYNC_SCHEMA_DIGEST } from "../../../contracts/sync.ts";
import { ContentServiceError } from "../../../contracts/repository.ts";
import { callSql, type SqlExecutor } from "./sql.ts";
import type { ObjectStorage } from "./storage.ts";
import { verifyMediaBytes } from "./storage.ts";
import { validateMedia } from "./validation.ts";

const noStore={"Cache-Control":"private, no-store","Referrer-Policy":"no-referrer","X-Content-Type-Options":"nosniff"};
/** Stream through the station origin; no vendor URL or bearer credential reaches the browser. */
export async function databaseMediaResponse(assetId: string,db: SqlExecutor,storage: ()=>ObjectStorage, cacheSuccess = false): Promise<Response> {
  const missing=()=>new Response(null,{status:404,headers:noStore});
  if(!/^a1\.[a-f0-9]{64}$/.test(assetId))return missing();
  const read=async ()=>{
    const projection=await callSql<{schemaDigest:string;media:StoredMedia|null}>(db,"SELECT nb_api.read_media($1) AS result",[assetId]);
    if(projection.schemaDigest!==SYNC_SCHEMA_DIGEST)throw new ContentServiceError("CONTENT_UNAVAILABLE","Database schema is incompatible.");
    return projection.media;
  };
  const media=await read();if(!media)return missing();validateMedia(media);
  const bytes=await storage().read(media);verifyMediaBytes(media,bytes);
  // A withdrawal during a slow object request must not start a new body response.
  const current=await read();if(!current)return missing();
  if(current.objectKey!==media.objectKey||current.sha256!==media.sha256||current.ownerPageId!==media.ownerPageId)throw new ContentServiceError("CONTENT_UNAVAILABLE","Media changed during the request.");
  return new Response(Buffer.from(bytes),{headers:{...(cacheSuccess?cacheableMediaHeaders(noStore):noStore),"Content-Type":media.mime,"Content-Length":String(bytes.length)}});
}
