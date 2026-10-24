import { collectionPageState, fetchCollectionPage, observation, observationFromVideoData } from "./bilibili.ts";
import { collectionFromPage, collectionFromVideoData, collectionKey } from "./collection.ts";
import type { CollectionSnapshot, CollectionTarget } from "./collection.ts";
import { count, hash, identity, object, publicationKey, SocialSyncError, timestamp, videoUrl } from "./model.ts";
import type { BilibiliObservation, Target } from "./model.ts";
import { validateObservation } from "./model.ts";
import { validateCollectionSnapshot } from "./collection.ts";
import { join } from "node:path";
import { privateDirectory, readPrivateFile } from "../notion-sync/state.ts";
import { writeJson } from "../game-sync/private.ts";

export const MAX_DIRECTORY_ENTRIES = 1000;
export interface DirectoryPage {
  version: 1; accountId: string; observedAt: string; page: number; pageSize: number; pages: number; total: number; ids: string[];
}
export interface Directory { version: 1; accountId: string; observedAt: string; ids: string[]; sha256: string }
export function directoryPage(value: unknown, expectedAccount: string): DirectoryPage {
  const p = object(value), keys = ["version", "accountId", "observedAt", "page", "pageSize", "pages", "total", "ids"];
  if (Object.keys(p).length !== keys.length || keys.some(k => !Object.hasOwn(p, k)) || p.version !== 1 || p.accountId !== identity(expectedAccount) ||
      typeof p.observedAt !== "string" || !Array.isArray(p.ids) || !Number.isSafeInteger(p.page) || !Number.isSafeInteger(p.pages) ||
      !Number.isSafeInteger(p.pageSize) || (p.pageSize as number)<1 || (p.pageSize as number)>100 ||
      !Number.isSafeInteger(p.total) || (p.total as number) < 1 || (p.total as number) > MAX_DIRECTORY_ENTRIES ||
      p.pages !== Math.ceil((p.total as number) / (p.pageSize as number)) || (p.page as number) < 1 || (p.page as number) > (p.pages as number)) {
    throw new SocialSyncError("BILIBILI_DIRECTORY_INVALID");
  }
  timestamp(p.observedAt);
  const expected = Math.min(p.pageSize as number, (p.total as number) - ((p.page as number) - 1) * (p.pageSize as number));
  const ids = p.ids.map(id => videoUrl(`https://www.bilibili.com/video/${id}/`).publicationId);
  if (ids.length !== expected || new Set(ids).size !== ids.length) throw new SocialSyncError("BILIBILI_DIRECTORY_INCOMPLETE");
  return { version: 1, accountId: expectedAccount, observedAt: p.observedAt, page: p.page as number, pageSize:p.pageSize as number, pages: p.pages as number, total: p.total as number, ids };
}
/** A complete, consistent traversal is required. No absent item is interpreted as deletion. */
export function completeDirectory(values: unknown, accountId: string, at: string): Directory {
  if (!Array.isArray(values) || values.length < 1 || values.length > 25 || Buffer.byteLength(JSON.stringify(values)) > 128 * 1024) throw new SocialSyncError("BILIBILI_DIRECTORY_INVALID");
  const pages = values.map(v => directoryPage(v, accountId)), first = pages[0]!, now = Date.parse(timestamp(at));
  if (pages.length !== first.pages || pages.some((p, i) => p.page !== i + 1 || p.pageSize!==first.pageSize || p.pages !== first.pages || p.total !== first.total ||
      Date.parse(p.observedAt) > now + 30000 || now - Date.parse(p.observedAt) > 5 * 60000 || i > 0 && p.observedAt < pages[i - 1]!.observedAt)) {
    throw new SocialSyncError("BILIBILI_DIRECTORY_INCOMPLETE");
  }
  const ids = pages.flatMap(p => p.ids);
  if (ids.length !== first.total || new Set(ids).size !== ids.length) throw new SocialSyncError("BILIBILI_DIRECTORY_INCOMPLETE");
  return { version: 1, accountId, observedAt: pages.at(-1)!.observedAt, ids, sha256: hash(JSON.stringify(pages)) };
}
export function automaticVideoTarget(accountId: string, id: string): Target {
  const url = videoUrl(`https://www.bilibili.com/video/${id}/`), target = { platform: "bilibili" as const, accountId: identity(accountId), ...url };
  return { ...target, workId: `ba_${publicationKey(target).slice(0, 40)}` };
}
export type DiscoveredVideo = { type: "publication"; value: BilibiliObservation } | { type: "collection"; value: CollectionSnapshot };
/** Use one actual public video response to choose the card and verify all relevant ownership. */
export function classifyDiscoveredVideo(html: string, target: Target, at: string): DiscoveredVideo {
  return classifyVideoData(collectionPageState(html).videoData, target, at, "public-video-page-ssr", hash(html));
}
export function classifyVideoData(value: unknown, target: Target, at: string, source: BilibiliObservation["source"], responseSha256: string): DiscoveredVideo {
  const v = object(value), owner = object(v.owner);
  if (target.platform !== "bilibili" || v.bvid !== target.publicationId || identity(owner.mid) !== target.accountId) throw new SocialSyncError("IDENTITY_MISMATCH");
  if (v.state !== 0 || v.is_upower_exclusive || v.is_upower_preview || v.is_pay_season) throw new SocialSyncError("SOURCE_BLOCKED");
  if (!Array.isArray(v.pages) || v.pages.length < 1 || count(v.videos) !== v.pages.length) throw new SocialSyncError("COLLECTION_INCOMPLETE");
  const season = v.ugc_season === null || v.ugc_season === undefined ? null : object(v.ugc_season);
  if (season || v.pages.length > 1) {
    const value = collectionFromVideoData(v, { platform: "bilibili", accountId: target.accountId, kind: season ? "season" : "multi-part",
      collectionId: season ? identity(season.id) : target.publicationId, representativeUrl: target.url }, at,
      source === "public-video-api-json" ? "bilibili-collection-api-json" : "bilibili-collection-ssr", responseSha256);
    return { type: "collection", value };
  }
  const row = observationFromVideoData(v, target, at, source, responseSha256);
  if (row.publishedAt && row.publishedAt > new Date(Date.parse(timestamp(at)) + 30000).toISOString()) throw new SocialSyncError("INVALID_TIME");
  return { type: "publication", value: row };
}
export async function captureDiscoveredVideo(accountId: string, id: string, signal?: AbortSignal, request?: typeof fetch, knownTarget?: Target, captured?: (html:string,snapshot:CollectionSnapshot)=>Promise<void>) {
  const target = knownTarget ?? automaticVideoTarget(accountId, id);
  if (target.accountId !== accountId || target.publicationId !== id || target.platform !== "bilibili") throw new SocialSyncError("IDENTITY_MISMATCH");
  const { html, observedAt } = await fetchCollectionPage(target, signal, request);
  const candidate=classifyDiscoveredVideo(html,target,observedAt);
  if(candidate.type==="collection")await captured?.(html,candidate.value);
  return candidate;
}
export const discoveredKey = (v: DiscoveredVideo) => v.type === "publication" ? publicationKey(v.value) : collectionKey(v.value.target);
export function validateDiscoveredVideo(value: unknown, target: Target): DiscoveredVideo {
  const c=object(value) as unknown as DiscoveredVideo;
  if(Object.keys(c).sort().join()!=="type,value")throw new SocialSyncError("BILIBILI_CLASSIFICATION_INVALID");
  if(c.type==="publication"){
    validateObservation(c.value);if(c.value.platform!=="bilibili"||publicationKey(c.value)!==publicationKey(target)||c.value.workId!==target.workId)throw new SocialSyncError("IDENTITY_MISMATCH");
  }else if(c.type==="collection"){
    validateCollectionSnapshot(c.value);if(c.value.target.accountId!==target.accountId||c.value.target.representativeUrl!==target.url)throw new SocialSyncError("IDENTITY_MISMATCH");
  }else throw new SocialSyncError("BILIBILI_CLASSIFICATION_INVALID");
  return c;
}

export async function readClassification(root: string, target: Target, policyDigest: string, at: string): Promise<DiscoveredVideo | null> {
  let p: Record<string, unknown>;
  try { p=object(JSON.parse(await readPrivateFile(join(root,"bilibili-classifications",`${publicationKey(target)}.json`),600*1024))); }
  catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return null;throw e;}
  if(Object.keys(p).sort().join()!=="candidate,policyDigest,sha256,targetKey,version"||p.version!==1||p.policyDigest!==policyDigest||p.targetKey!==publicationKey(target)||
     p.sha256!==hash(JSON.stringify(p.candidate)))throw new SocialSyncError("BILIBILI_CLASSIFICATION_INVALID");
  const c=validateDiscoveredVideo(p.candidate,target);
  const age=Date.parse(timestamp(at))-Date.parse(c.value.observedAt);
  if(age < -30000)throw new SocialSyncError("INVALID_TIME");
  return age>6*3600000?null:c;
}
/** The normal six-hour request also supplies classification; discovery can reuse it. */
export async function collectAccountPublication(root: string, policyDigest: string, target: Target, signal?: AbortSignal, request?: typeof fetch, captured?: (html:string,snapshot:CollectionSnapshot)=>Promise<void>) {
  const {html,observedAt}=await fetchCollectionPage(target,signal,request),candidate=classifyDiscoveredVideo(html,target,observedAt);
  if(candidate.type==="collection")await captured?.(html,candidate.value);
  const dir=join(root,"bilibili-classifications");await privateDirectory(dir);
  if(signal?.aborted)throw new SocialSyncError("CANCELLED");
  await writeJson(join(dir,`${publicationKey(target)}.json`),{version:1,policyDigest,targetKey:publicationKey(target),candidate,sha256:hash(JSON.stringify(candidate))});
  return candidate.type==="publication"?candidate.value:observation(html,target,observedAt,true);
}
export function collectionProbeTarget(target:CollectionTarget,publications:Target[]=[]):Target{
  const url=videoUrl(target.representativeUrl);
  return publications.find(p=>p.platform==="bilibili"&&p.accountId===target.accountId&&p.publicationId===url.publicationId)??
    {platform:"bilibili",accountId:target.accountId,...url,workId:`bc_${collectionKey(target).slice(0,40)}`};
}
export async function collectAccountCollection(root:string,policyDigest:string,target:CollectionTarget,publications:Target[],signal?:AbortSignal,request?:typeof fetch,captured?: (html:string,snapshot:CollectionSnapshot)=>Promise<void>){
  const probe=collectionProbeTarget(target,publications),{html,observedAt}=await fetchCollectionPage(probe,signal,request);
  if(target.kind==="multi-part"){
    const candidate=classifyDiscoveredVideo(html,probe,observedAt),dir=join(root,"bilibili-classifications");await privateDirectory(dir);
    if(signal?.aborted)throw new SocialSyncError("CANCELLED");
    await writeJson(join(dir,`${publicationKey(probe)}.json`),{version:1,policyDigest,targetKey:publicationKey(probe),candidate,sha256:hash(JSON.stringify(candidate))});
  }
  const snapshot=collectionFromPage(html,target,observedAt);
  await captured?.(html,snapshot);
  return snapshot;
}
