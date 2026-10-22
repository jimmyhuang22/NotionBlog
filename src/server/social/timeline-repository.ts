import { createHash } from "node:crypto";
import { ContentServiceError } from "../../../contracts/repository.ts";
import type { PublishedSocialCollection, SocialTimelineWork } from "../../../contracts/social-timeline.ts";
import type { FeedSnapshot } from "../../../contracts/home-feed.ts";
import type { SqlExecutor } from "../database/sql.ts";
import { MAX_SOCIAL_WORKS, MAX_SOCIAL_PUBLICATIONS_PER_WORK, MAX_SOCIAL_SNAPSHOT_BYTES } from "../../lib/content/social-limits.ts";
import { mapSocialPublication, socialMetrics } from "./repository.ts";
import { createSocialWorksRepository } from "./works-repository.ts";
import { checkedCollectionUrl } from "./collection-links.ts";
import { isVerifiedPlatformUrl } from "./links.ts";
import { collectionDayProjectionSql, parseCollectionDayAddition, type CollectionDayOptions } from "./collection-day-additions.ts";

const unavailable=()=>new ContentServiceError("CONTENT_UNAVAILABLE","Social timeline is temporarily unavailable.");
function object(value:unknown,keys:string[]) {
  if(!value || typeof value!=="object" || Array.isArray(value))throw unavailable();
  const row=value as Record<string,unknown>;
  if(Object.keys(row).length!==keys.length || keys.some(k=>!Object.hasOwn(row,k)))throw unavailable();return row;
}
function time(value:unknown,nullable=true):string|null {
  if(nullable && value===null)return null;
  if(typeof value!=="string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString()!==value)throw unavailable();
  return value;
}
function count(value:unknown,nullable=true):number|null {
  if(nullable && value===null)return null;
  if(typeof value!=="number" || !Number.isSafeInteger(value) || value<0)throw unavailable();return value;
}
function collection(value:unknown,identity:unknown,timeZone:string):PublishedSocialCollection {
  const extra=value!==null&&typeof value==="object"&&Object.hasOwn(value,"dayAddition")?["dayAddition"]:[];
  const c=object(value,["id","platform","kind","title","memberCount","partCount","firstPublishedAt","latestMemberPublishedAt","observedAt","metricsScope","metrics","activity","latestAddition","originalUrl","linkVerifiedAt","latestMemberUrl","latestMemberLinkVerifiedAt",...extra]);
  const ids=object(identity,["accountId","collectionId"]);
  if(typeof ids.accountId!=="string" || !/^[1-9][0-9]{0,19}$/.test(ids.accountId) || typeof ids.collectionId!=="string" ||
    c.platform!=="bilibili" || !["season","multi-part"].includes(String(c.kind)) || typeof c.title!=="string" || !c.title.trim() || c.title.length>1000)throw unavailable();
  const kind=c.kind as "season"|"multi-part",expected=`bc_${createHash("sha256").update(JSON.stringify(["bilibili",ids.accountId,kind,ids.collectionId])).digest("hex").slice(0,40)}`;
  if(c.id!==expected || (kind==="season" ? !/^[1-9][0-9]{0,19}$/.test(ids.collectionId) || c.metricsScope!=="bilibili-season" :
    !/^BV[0-9A-Za-z]{10}$/.test(ids.collectionId) || c.metricsScope!=="bilibili-multi-part"))throw unavailable();
  const observedAt=time(c.observedAt,false)!,memberCount=count(c.memberCount,false)!,partCount=count(c.partCount),firstPublishedAt=time(c.firstPublishedAt),latestMemberPublishedAt=time(c.latestMemberPublishedAt);
  if(memberCount<1 || memberCount>(kind==="season"?1000:2000) || (partCount!==null && (partCount<memberCount || partCount>2000)) ||
    (kind==="season" && firstPublishedAt!==null) || (kind==="multi-part" && (memberCount<2 || partCount!==memberCount)))throw unavailable();
  const m=object(c.metrics,socialMetrics),metrics={} as PublishedSocialCollection["metrics"];
  for(const name of socialMetrics)metrics[name]=count(m[name]);
  let activity:PublishedSocialCollection["activity"]=null,latestAddition:PublishedSocialCollection["latestAddition"]=null;
  if(c.activity!==null){const a=object(c.activity,["at","basis"]);if(!["member-published","addition-detected"].includes(String(a.basis)))throw unavailable();
    activity={at:time(a.at,false)!,basis:a.basis as NonNullable<PublishedSocialCollection["activity"]>["basis"]};}
  if(c.latestAddition!==null){const a=object(c.latestAddition,["detectedAt","publishedAt","addedVideos","addedParts"]);
    const detectedAt=time(a.detectedAt,false)!,publishedAt=time(a.publishedAt),addedVideos=count(a.addedVideos,false)!,addedParts=count(a.addedParts,false)!;
    if(addedVideos+addedParts<1 || addedVideos>1000 || addedParts>2000 || (kind==="multi-part" && addedVideos!==0) ||
      !activity || activity.at!==(publishedAt??detectedAt) || activity.basis!==(publishedAt?"member-published":"addition-detected") || detectedAt>observedAt)throw unavailable();
    latestAddition={detectedAt,publishedAt,addedVideos,addedParts};}
  for(const date of [firstPublishedAt,latestMemberPublishedAt,activity?.at,latestAddition?.publishedAt])if(date && Date.parse(date)>Date.parse(observedAt)+30000)throw unavailable();
  const linkVerifiedAt=time(c.linkVerifiedAt);
  if((c.originalUrl===null)!==(linkVerifiedAt===null) || (c.originalUrl!==null && (typeof c.originalUrl!=="string" || !checkedCollectionUrl(kind,ids.accountId,ids.collectionId,c.originalUrl))))throw unavailable();
  const memberCheckedAt=time(c.latestMemberLinkVerifiedAt);
  const videoId=typeof c.latestMemberUrl==="string" ? /^https:\/\/www\.bilibili\.com\/video\/(BV[0-9A-Za-z]{10})\/$/.exec(c.latestMemberUrl)?.[1] : undefined;
  const latestMemberUrl=memberCheckedAt && videoId && (kind!=="multi-part" || videoId===ids.collectionId) &&
    isVerifiedPlatformUrl("bilibili",videoId,c.latestMemberUrl as string) ? c.latestMemberUrl as string : null;
  const dayAddition=parseCollectionDayAddition(extra.length?c.dayAddition:null,activity,kind,timeZone);
  return {id:expected,platform:"bilibili",kind,title:c.title,memberCount,partCount,firstPublishedAt,latestMemberPublishedAt,observedAt,dayAddition,
    metricsScope:c.metricsScope as PublishedSocialCollection["metricsScope"],metrics,activity,latestAddition,originalUrl:c.originalUrl as string|null,linkVerifiedAt,
    latestMemberUrl,latestMemberLinkVerifiedAt:latestMemberUrl ? memberCheckedAt : null};
}
function mapWork(value:unknown,timeZone:string):SocialTimelineWork {
  const w=object(value,["id","title","occurredAt","publications","collection","collectionIdentity"]);
  if(typeof w.id!=="string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(w.id) || typeof w.title!=="string" || !w.title.trim() || w.title.length>1000 ||
    !Array.isArray(w.publications) || w.publications.length>MAX_SOCIAL_PUBLICATIONS_PER_WORK)throw unavailable();
  const c=w.collection===null?null:collection(w.collection,w.collectionIdentity,timeZone);
  if((c===null && (w.collectionIdentity!==null || w.publications.length<1)) || (c!==null && (c.id!==w.id || c.title!==w.title)))throw unavailable();
  const publications=w.publications.map(mapSocialPublication);if(new Set(publications.map(p=>p.id)).size!==publications.length)throw unavailable();
  return {id:w.id,type:"social-work",title:w.title,occurredAt:time(w.occurredAt),cover:null,publications,collection:c};
}
/** One invoker/RLS statement: only currently eligible collections suppress their currently known members. */
function timelineSql(playback: boolean) { return `WITH collections AS MATERIALIZED (
    SELECT c.collection_key,c.account_id,c.kind,c.collection_id,c.collection||jsonb_build_object(
      'latestMemberPublishedAt',CASE WHEN c.kind='multi-part' THEN c.collection->>'latestMemberPublishedAt' ELSE ${playback ? "playback.published_at" : "c.collection->>'latestMemberPublishedAt'"} END,
      'latestMemberUrl',CASE WHEN c.kind='multi-part' THEN c.collection->>'originalUrl' ELSE ${playback ? "playback.outbound_url" : "NULL"} END,
      'latestMemberLinkVerifiedAt',CASE WHEN c.kind='multi-part' THEN c.collection->>'linkVerifiedAt' ELSE ${playback ? "playback.link_verified_at" : "NULL"} END
    ) AS collection
    FROM social_sync.website_collections c ${playback ? "LEFT JOIN social_sync.website_collection_playbacks playback USING(collection_key)" : ""}
  ),
  -- Candidates and each work's bounded aggregate reuse the same RLS-filtered publications.
  publications AS MATERIALIZED (
    SELECT * FROM social_sync.website_publications p WHERE NOT EXISTS (
      SELECT 1 FROM social_sync.website_collection_members m WHERE m.publication_key=p.publication->>'id'
        AND NOT EXISTS(SELECT 1 FROM social_sync.collection_standalone_overrides o WHERE o.publication_key=m.publication_key AND o.keep_standalone)
    )
  ), candidates AS (
    SELECT coalesce(p.work_id,c.collection->>'id') AS id,CASE WHEN c.collection_key IS NULL THEN p.title ELSE c.collection->>'title' END AS title,
      CASE WHEN p.work_id IS NOT NULL THEN p.occurred_at ELSE c.collection->>'firstPublishedAt' END AS occurred_at,
      c.collection,CASE WHEN c.collection_key IS NULL THEN NULL ELSE jsonb_build_object('accountId',c.account_id,'collectionId',c.collection_id) END AS identity,
      coalesce(c.collection->'activity'->>'at',CASE WHEN p.work_id IS NOT NULL THEN p.occurred_at ELSE c.collection->>'firstPublishedAt' END) AS timeline_at
    FROM (SELECT work_id,title,occurred_at FROM publications GROUP BY work_id,title,occurred_at) p
      FULL JOIN collections c ON c.collection->>'id'=p.work_id
  ), selected AS MATERIALIZED (SELECT * FROM candidates ORDER BY timeline_at DESC NULLS LAST,id LIMIT ${MAX_SOCIAL_WORKS+1})
  SELECT jsonb_build_object('id',s.id,'title',s.title,'occurredAt',s.occurred_at,'collection',s.collection,'collectionIdentity',s.identity,
    'publications',coalesce(p.items,'[]'::jsonb)) AS work FROM selected s CROSS JOIN LATERAL (
      SELECT jsonb_agg(publication ORDER BY publication->>'platform',publication->>'id') AS items FROM (
        SELECT publication FROM publications WHERE work_id=s.id ORDER BY publication->>'platform',publication->>'id' LIMIT ${MAX_SOCIAL_PUBLICATIONS_PER_WORK+1}
      ) bounded
    ) p ORDER BY s.timeline_at DESC NULLS LAST,s.id`; }
export const socialTimelineSql = timelineSql(false);
export const socialPlaybackTimelineSql = timelineSql(true);
export async function verifyCollectionReader(sql:SqlExecutor) {
  try {const rows=(await sql.query<{version:number}>("SELECT version FROM social_sync.collection_meta WHERE singleton")).rows;
    if(rows.length!==1 || rows[0].version!==1)throw unavailable();}
  catch {throw unavailable();}
}
export async function readSocialTimelineSnapshot(sql:SqlExecutor,playback=false,day:CollectionDayOptions={}):Promise<FeedSnapshot<SocialTimelineWork>> {
  let rows:{work:unknown}[];
  const text=playback?socialPlaybackTimelineSql:socialTimelineSql;
  try {rows=(await sql.query<{work:unknown}>(day.enabled?collectionDayProjectionSql(text):text,day.enabled?[day.timeZone??"UTC"]:undefined)).rows;} catch {throw unavailable();}
  return mapSocialTimelineRows(rows,"social-timeline-v2",day);
}
/** Reuse the same strict DTO and limits for each independently guarded SQL projection. */
export function mapSocialTimelineRows(rows:{work:unknown}[],versionNamespace:string,day:CollectionDayOptions={}):FeedSnapshot<SocialTimelineWork> {
  if(rows.length>MAX_SOCIAL_WORKS || Buffer.byteLength(JSON.stringify(rows))>MAX_SOCIAL_SNAPSHOT_BYTES)throw unavailable();
  const items=rows.map(r=>mapWork(r.work,day.timeZone??"UTC"));if(new Set(items.map(w=>w.id)).size!==items.length)throw unavailable();
  // Cursor identity follows eligible works and their ordering, not refreshed
  // statistics. Validate and return the complete current DTO above/below: this
  // projection neither caches an old sample nor bypasses the RLS-filtered read.
  const paging=items.map(w=>({id:w.id,title:w.title,occurredAt:w.occurredAt,
    publications:w.publications.map(p=>({id:p.id,platform:p.platform,kind:p.kind,publishedAt:p.publishedAt,
      metricsScope:p.metricsScope,originalUrl:p.originalUrl})),
    collection:w.collection===null?null:{id:w.collection.id,platform:w.collection.platform,kind:w.collection.kind,
      title:w.collection.title,memberCount:w.collection.memberCount,partCount:w.collection.partCount,
      firstPublishedAt:w.collection.firstPublishedAt,latestMemberPublishedAt:w.collection.latestMemberPublishedAt,
      metricsScope:w.collection.metricsScope,activity:w.collection.activity,latestAddition:w.collection.latestAddition,
      originalUrl:w.collection.originalUrl,latestMemberUrl:w.collection.latestMemberUrl}}));
  return {version:createHash("sha256").update(JSON.stringify([versionNamespace,"stable-statistics-v1",paging])).digest("hex"),items};
}
export function createSocialTimelineRepository(sql:SqlExecutor){return createSocialWorksRepository(()=>readSocialTimelineSnapshot(sql));}
