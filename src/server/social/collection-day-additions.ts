import type { SocialCollectionDayAddition } from "../../../contracts/social-collections.ts";
import type { PublishedSocialCollection } from "../../../contracts/social-timeline.ts";
import { ContentServiceError } from "../../../contracts/repository.ts";

export interface CollectionDayOptions { enabled?: boolean; timeZone?: string }
const unavailable=()=>new ContentServiceError("CONTENT_UNAVAILABLE","Collection updates are temporarily unavailable.");
export function collectionDayAdditionsEnabled(value:string|undefined):boolean {
  if(value===undefined||value==="disabled")return false;
  if(value==="enabled")return true;
  throw new ContentServiceError("MISCONFIGURED","Unsupported collection day-addition configuration.");
}
export function collectionCalendarDay(at:string,timeZone:string):string {
  try {
    const parts=new Intl.DateTimeFormat("en-CA",{timeZone,year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date(at));
    const get=(key:string)=>parts.find(part=>part.type===key)!.value;
    return `${get("year")}-${get("month")}-${get("day")}`;
  } catch {throw unavailable();}
}
export function parseCollectionDayAddition(value:unknown,activity:PublishedSocialCollection["activity"],kind:PublishedSocialCollection["kind"],zone:string):SocialCollectionDayAddition|null {
  if(value===null)return null;
  if(!value||typeof value!=="object"||Array.isArray(value))throw unavailable();
  const v=value as Record<string,unknown>;
  if(Object.keys(v).sort().join(",")!=="addedParts,addedVideos,basis,day"||!activity||typeof v.day!=="string"||
    !/^\d{4}-\d{2}-\d{2}$/.test(v.day)||v.day!==collectionCalendarDay(activity.at,zone)||
    !["member-published","addition-detected","mixed"].includes(String(v.basis))||
    typeof v.addedVideos!=="number"||!Number.isSafeInteger(v.addedVideos)||v.addedVideos<0||v.addedVideos>10000||
    typeof v.addedParts!=="number"||!Number.isSafeInteger(v.addedParts)||v.addedParts<0||v.addedParts>20000||
    v.addedVideos+v.addedParts===0||(kind==="multi-part"&&v.addedVideos!==0))throw unavailable();
  return {day:v.day,addedVideos:v.addedVideos,addedParts:v.addedParts,basis:v.basis as SocialCollectionDayAddition["basis"]};
}
/** Add the tiny derived DTO inside the existing eligible collection statement. */
export function collectionDayProjectionSql(sql:string,retained=false):string {
  const marker=") AS collection\n    FROM social_sync.";
  if(!sql.includes(marker))throw unavailable();
  return sql.replace(marker,`)||jsonb_build_object('dayAddition',social_sync.collection_day_addition(c.collection_key,c.collection->'activity'->>'at',c.collection->>'observedAt',$1,${retained?"true":"false"})) AS collection\n    FROM social_sync.`);
}
