import "server-only";
import { ContentServiceError } from "../../../contracts/repository.ts";
import { socialReaderRuntimePoolConfig, verifySocialReader } from "./reader.ts";
import { readSocialSnapshot } from "./repository.ts";
import { Pool } from "pg";
import { readerSqlExecutor } from "../database/connection.ts";
import { readSocialTimelineSnapshot, verifyCollectionReader } from "./timeline-repository.ts";
import { readRetainedSocialSnapshot, socialDisplayMode } from "./retained-repository.ts";
import { attachSocialReaderPool, monitoredSocialReaderSql } from "./pool.ts";
import { createPagedSocialRepository } from "./repository.ts";
import { socialMediaEnabled, withSocialCovers, type CoverMode } from "./covers.ts";
import type { SocialWork } from "../../../contracts/social.ts";
import type { FeedSnapshot } from "../../../contracts/home-feed.ts";
import { createSocialStorage, socialReaderTransport } from "./media-storage.ts";
import type { ObjectStorage } from "../database/storage.ts";
import { createSocialWorksRepository } from "./works-repository.ts";
import { socialCollectionPlaybackEnabled } from "./collection-members.ts";
import { measureContentRead, measureContentReadAsync, traceContentRead } from "../content-read-timing.ts";
import type { SocialCoverSnapshot } from "./cover-hydration.ts";
import type { SocialTimelineWork } from "../../../contracts/social-timeline.ts";
import { collectionDayAdditionsEnabled } from "./collection-day-additions.ts";
import { getSiteConfig } from "../../lib/site/index.ts";
import { createSocialReadQueue, queueSocialWorksRepository } from "./read-queue.ts";
import { contentReadBudgetIdentity, checkContentReadBudget } from "../content-read-budget.ts";
import { createSocialMediaSql } from "./media-query.ts";

let pool: Pool | undefined;
let worksQueue: ReturnType<typeof createSocialReadQueue> | undefined;
export function socialProvider(): "disabled" | "database" | "mock" {
  const value = process.env.SOCIAL_PROVIDER ?? "disabled";
  if (value !== "disabled" && value !== "database" && value !== "mock") throw new ContentServiceError("MISCONFIGURED", "Unsupported social provider configuration.");
  return value;
}
function readerPool() {
  if (!pool) {
    const candidate = measureContentRead("database-pool", () => new Pool(socialReaderRuntimePoolConfig(process.env)));
    attachSocialReaderPool(candidate);
    pool = candidate;
  }
  return pool;
}
async function readerSql() {
  const sql = monitoredSocialReaderSql(readerSqlExecutor(readerPool()));
  await measureContentReadAsync("social-reader-check", () => verifySocialReader(sql));
  return sql;
}
async function covers<T extends SocialWork>(snapshot: FeedSnapshot<T>, sql: Awaited<ReturnType<typeof readerSql>>, mode: CoverMode, playback=false) {
  return socialMediaEnabled(process.env.SOCIAL_MEDIA_ENABLED) ? measureContentReadAsync("social-covers", () => withSocialCovers(snapshot, sql, mode,playback)) : snapshot;
}
export async function socialRuntime() { return createPagedSocialRepository(socialSnapshot); }
export function socialSnapshot() { return traceContentRead("social-snapshot", "unknown", async () => { const sql=await readerSql();return covers(await measureContentReadAsync("social-snapshot", () => readSocialSnapshot(sql)),sql,socialDisplayMode(process.env.SOCIAL_DISPLAY_MODE)); }); }
async function collectionReaderSql(){const sql=await readerSql();await measureContentReadAsync("social-collection-check", () => verifyCollectionReader(sql));return sql;}
function timelineSettings(){
  return {mode:socialDisplayMode(process.env.SOCIAL_DISPLAY_MODE),playback:socialCollectionPlaybackEnabled(process.env.SOCIAL_COLLECTION_PLAYBACK),
    day:{enabled:collectionDayAdditionsEnabled(process.env.SOCIAL_COLLECTION_DAY_ADDITIONS),timeZone:getSiteConfig().timeZone}};
}
function readTimelineRows(sql:Awaited<ReturnType<typeof readerSql>>,{mode,playback,day}:ReturnType<typeof timelineSettings>):Promise<FeedSnapshot<SocialTimelineWork>>{
  return measureContentReadAsync("social-snapshot", () => mode==="retained"?readRetainedSocialSnapshot(sql,playback,day):readSocialTimelineSnapshot(sql,playback,day));
}
async function hydrateTimelineCovers(version:string,selected:SocialTimelineWork[],sql:Awaited<ReturnType<typeof readerSql>>,{mode,playback}:ReturnType<typeof timelineSettings>){
  return (await measureContentReadAsync("social-covers",()=>withSocialCovers({version,items:selected},sql,mode,playback))).items;
}
/** Without `rows`, one verified reader serves the rows and their covers, as before. With shared rows
 * (the public cache), covers still qualify per request through withLiveSocialCovers. */
export async function socialTimelineRuntime(rows?:()=>Promise<FeedSnapshot<SocialTimelineWork>>){
  const currentPool = readerPool();
  worksQueue ??= createSocialReadQueue(currentPool.options.max ?? 1);
  return queueSocialWorksRepository(createSocialWorksRepository(rows?async()=>withLiveSocialCovers(await rows()):socialTimelineSnapshot), worksQueue);
}
export function socialTimelineSnapshot():Promise<SocialCoverSnapshot<SocialTimelineWork>> {
  return traceContentRead("social-snapshot", "unknown", async () => {
    const sql=await collectionReaderSql(),settings=timelineSettings();
    const snapshot=await readTimelineRows(sql,settings);
    if(!socialMediaEnabled(process.env.SOCIAL_MEDIA_ENABLED))return snapshot;
    // Bind the verified reader and mode to this read only. Actual cover qualification
    // still runs after selection; no extra role query or cached positive eligibility.
    return {...snapshot,hydrateCovers:selected=>hydrateTimelineCovers(snapshot.version,selected,sql,settings)};
  });
}
/**
 * The timeline rows alone, read by a verified reader. Every row has `cover: null` and the result carries no
 * request-bound capability, so it holds no cover eligibility and may be kept by the public cache.
 */
export function socialTimelineRows():Promise<FeedSnapshot<SocialTimelineWork>> {
  return traceContentRead("social-snapshot", "unknown", async () => readTimelineRows(await collectionReaderSql(),timelineSettings()));
}
/**
 * Rows (fresh or shared) with live cover qualification: each hydration takes a newly verified reader and
 * qualifies only the selected works, as an uncached snapshot does. No cover result is retained here.
 */
export function withLiveSocialCovers(rows:FeedSnapshot<SocialTimelineWork>):SocialCoverSnapshot<SocialTimelineWork> {
  if(!socialMediaEnabled(process.env.SOCIAL_MEDIA_ENABLED))return rows;
  const settings=timelineSettings();
  return {...rows,hydrateCovers:async selected=>hydrateTimelineCovers(rows.version,selected,await collectionReaderSql(),settings)};
}
let mediaStorage: ObjectStorage | undefined;
let mediaSql: ReturnType<typeof createSocialMediaSql> | undefined;
let mediaTransport: typeof fetch | undefined;
const mediaRequest: typeof fetch = (url, init) => {
  checkContentReadBudget();
  const scope = contentReadBudgetIdentity();
  return (mediaTransport ??= socialReaderTransport(process.env))(url, scope ? { ...init, signal: AbortSignal.any([scope.signal, ...(init?.signal ? [init.signal] : [])]) } : init);
};
export async function socialMediaRuntime(){
  mediaSql ??= createSocialMediaSql(monitoredSocialReaderSql(readerSqlExecutor(readerPool())));
  return {sql:mediaSql,storage:()=>mediaStorage??=createSocialStorage(process.env,"reader",mediaRequest)};
}
