import { ContentServiceError } from "../../../contracts/repository.ts";
import type { SqlExecutor } from "../database/sql.ts";
import { createSocialWorksRepository } from "./works-repository.ts";
import { mapSocialTimelineRows, socialTimelineSql, socialPlaybackTimelineSql } from "./timeline-repository.ts";
import { collectionDayProjectionSql, type CollectionDayOptions } from "./collection-day-additions.ts";

const unavailable=()=>new ContentServiceError("CONTENT_UNAVAILABLE","Retained social content is temporarily unavailable.");
export function socialDisplayMode(value:string|undefined):"trial"|"retained" {
  if(value===undefined||value==="trial")return "trial";
  if(value==="retained")return "retained";
  throw new ContentServiceError("MISCONFIGURED","Unsupported social display mode.");
}
// Fixed trusted view names; no SQL identifier is taken from an HTTP request or environment value.
const retainedSql=(sql:string)=>sql
  .replaceAll("social_sync.website_collections","social_sync.retained_website_collections")
  .replaceAll("social_sync.website_publications","social_sync.retained_website_publications")
  .replaceAll("social_sync.website_collection_members","social_sync.retained_website_collection_members")
  .replace("publications AS NOT MATERIALIZED","publications AS MATERIALIZED");
export const retainedTimelineSql=retainedSql(socialTimelineSql);
export const retainedPlaybackTimelineSql=retainedSql(socialPlaybackTimelineSql).replaceAll("social_sync.website_collection_playbacks","social_sync.retained_website_collection_playbacks");
export async function readRetainedSocialSnapshot(sql:SqlExecutor,playback=false,day:CollectionDayOptions={}) {
  try {
    const meta=(await sql.query<{version:number}>("SELECT version FROM social_sync.retained_meta WHERE singleton")).rows;
    if(meta.length!==1||meta[0]!.version!==1)throw unavailable();
    const text=playback?retainedPlaybackTimelineSql:retainedTimelineSql;
    const rows=(await sql.query<{work:unknown}>(day.enabled?collectionDayProjectionSql(text,true):text,day.enabled?[day.timeZone??"UTC"]:undefined)).rows;
    return mapSocialTimelineRows(rows,"social-retained-v1",day);
  }catch{throw unavailable();}
}
export function createRetainedSocialRepository(sql:SqlExecutor){return createSocialWorksRepository(()=>readRetainedSocialSnapshot(sql));}
