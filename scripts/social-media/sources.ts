import { coverUrl, noteCoverUrl, publicationKey, validateObservation, timestamp, hash, SocialSyncError, object, identity } from "../social-sync/model.ts";
import type { Observation } from "../social-sync/model.ts";
import { collectionKey, collectionFromPage, collectionFromVideoData, type CollectionTarget } from "../social-sync/collection.ts";
import { collectionPageState } from "../social-sync/bilibili.ts";
import { apiVideoData } from "../social-sync/bilibili-api.ts";
import type { CoverKind } from "../../src/server/social/covers.ts";

export interface CoverSource { kind: CoverKind; key: string; platform: "bilibili" | "xiaohongshu"; url: string | null; observedAt: string }
/** Season SSR uses a distinct image host; keep this exception out of frozen statistics. */
function collectionImageUrl(value: unknown): string | null {
  if (typeof value === "string") {
    let url: URL | undefined;
    try { url = new URL(value); } catch { /* Existing validation supplies the fixed error. */ }
    if (url?.hostname === "archive.biliimg.com") {
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.port || url.search || url.hash ||
          !/^\/bfs\/archive\/[a-f0-9]{40}\.(?:jpe?g|png|webp|avif|gif)$/i.test(url.pathname)) throw new SocialSyncError("COVER_SOURCE_INVALID");
      url.protocol = "https:"; return url.href;
    }
  }
  return coverUrl(value);
}
export function publicationCoverSource(row: Observation): CoverSource {
  validateObservation(row);
  return { kind: "publication", key: publicationKey(row), platform: row.platform, url: row.coverUrl, observedAt: row.observedAt };
}
/** Sidecar from the SAME already collected HTML; the frozen collection/statistics payload is untouched. */
export function collectionCoverSource(html: string, target: CollectionTarget, observedAt: string, snapshotSha?: string): CoverSource {
  // The existing parser checks author, collection identity, roster and completeness.
  const snapshot=collectionFromPage(html, target, observedAt);
  if(snapshotSha!==undefined&&hash(JSON.stringify(snapshot))!==snapshotSha)throw new SocialSyncError("COVER_COLLECTION_SOURCE_MISMATCH");
  const video = object(collectionPageState(html).videoData);
  if (identity(object(video.owner).mid) !== target.accountId) throw new SocialSyncError("IDENTITY_MISMATCH");
  const own = target.kind === "multi-part" ? video.pic : object(video.ugc_season).cover;
  return { kind: "collection", key: collectionKey(target), platform: "bilibili", url: collectionImageUrl(own), observedAt: timestamp(observedAt) };
}
/** JSON metadata must prove the same snapshot and raw response as the statistics ACK. */
export function collectionApiCoverSource(raw: string, target: CollectionTarget, observedAt: string, snapshotSha: string): CoverSource {
  const id = target.representativeUrl.split("/")[4], video = apiVideoData(raw, { platform: "bilibili", accountId: target.accountId,
    workId: `bc_${collectionKey(target).slice(0,40)}`, publicationId: id, url: target.representativeUrl });
  const snapshot = collectionFromVideoData(video, target, observedAt, "bilibili-collection-api-json", hash(raw));
  if (hash(JSON.stringify(snapshot)) !== snapshotSha) throw new SocialSyncError("COVER_COLLECTION_SOURCE_MISMATCH");
  const own = target.kind === "multi-part" ? video.pic : object(video.ugc_season).cover;
  return { kind: "collection", key: collectionKey(target), platform: "bilibili", url: collectionImageUrl(own), observedAt: timestamp(observedAt) };
}
export function validateCoverSource(row: CoverSource): void {
  if (!row || typeof row !== "object" || Object.keys(row).sort().join(",") !== "key,kind,observedAt,platform,url" ||
      !["publication", "collection"].includes(row.kind) || !/^[a-f0-9]{64}$/.test(row.key) ||
      !["bilibili", "xiaohongshu"].includes(row.platform) || (row.kind === "collection" && row.platform !== "bilibili")) throw new SocialSyncError("COVER_SOURCE_INVALID");
  timestamp(row.observedAt);
  const checked = row.platform === "bilibili" ? row.kind === "collection" ? collectionImageUrl(row.url) : coverUrl(row.url) : noteCoverUrl(row.url);
  if (checked !== row.url || (row.url && new URL(row.url).hash)) throw new SocialSyncError("COVER_SOURCE_INVALID");
}
export const sourceDigest = (source: CoverSource) => source.url === null ? null : hash(source.url);
