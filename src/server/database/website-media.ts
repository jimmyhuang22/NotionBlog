import { WEBSITE_SCHEMA_DIGEST } from "../../../contracts/website-sync.ts";
import { SYNC_SCHEMA_DIGEST } from "../../../contracts/sync.ts";
import { ContentServiceError } from "../../../contracts/repository.ts";
import { databaseMediaResponse } from "./media.ts";
import type { SqlExecutor } from "./sql.ts";
import type { ObjectStorage } from "./storage.ts";
/** Reuse the verified byte/withdrawal checks with an isolated v2 SQL namespace. */
export function websiteMediaResponse(id:string,db:SqlExecutor,storage:()=>ObjectStorage) {
  const adapter:SqlExecutor={async query<T>(sql:string,values?:unknown[]){
    if(sql!=="SELECT nb_api.read_media($1) AS result")throw new ContentServiceError("CONTENT_UNAVAILABLE","Invalid media query.");
    const p=await db.query<{result:{schemaDigest:string;media:unknown}}>(sql.replace("nb_api.","nb_v2_api."),values);
    for(const row of p.rows){if(row.result.schemaDigest!==WEBSITE_SCHEMA_DIGEST)throw new ContentServiceError("CONTENT_UNAVAILABLE","Website database schema is incompatible.");row.result.schemaDigest=SYNC_SCHEMA_DIGEST;}
    return p as unknown as {rows:T[]};
  }};
  return databaseMediaResponse(id,adapter,storage,true);
}
