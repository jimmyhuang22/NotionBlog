import { SocialSyncError, object, text, identity, count, coverUrl, hash, timestamp, validateObservation, videoUrl } from "./model.ts";
import type { BilibiliObservation, Target } from "./model.ts";

export const MAX_PAGE_BYTES = 2 * 1024 * 1024;
export const MAX_COLLECTION_PAGE_BYTES = 8 * 1024 * 1024;
export function requirePublicApiVideo(value: unknown): void {
  const video = object(value), rights = video.rights == null ? null : object(video.rights), season = video.ugc_season == null ? null : object(video.ugc_season);
  if(video.state!==0||video.is_upower_exclusive||video.is_upower_preview||video.is_pay_season||video.is_only_self||
    rights?.pay||rights?.ugc_pay||rights?.ugc_pay_preview||season?.is_pay_season)throw new SocialSyncError("SOURCE_BLOCKED");
}
/** Read inert JSON only. Never evaluate a page script or choose another video's entry. */
export function pageState(html: string): Record<string, unknown> {
  return boundedPageState(html, MAX_PAGE_BYTES);
}
/** Collection SSR includes the member roster; its larger envelope is still fixed and bounded. */
export function collectionPageState(html: string): Record<string, unknown> {
  return boundedPageState(html, MAX_COLLECTION_PAGE_BYTES);
}
function boundedPageState(html: string, maxBytes: number): Record<string, unknown> {
  if (Buffer.byteLength(html) > maxBytes) throw new SocialSyncError("PAGE_TOO_LARGE");
  const matches = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)]
    .map(m => /^\s*window\.__INITIAL_STATE__\s*=\s*/.exec(m[1]) ? m[1] : null).filter(s => s !== null);
  if (matches.length !== 1) throw new SocialSyncError("PAGE_STATE_MISSING");
  const script = matches[0], prefix = /^\s*window\.__INITIAL_STATE__\s*=\s*/.exec(script)!;
  const start = prefix[0].length;
  if (script[start] !== "{") throw new SocialSyncError("PAGE_STATE_INVALID");
  let depth = 0, quoted = false, escaped = false, end = -1;
  for (let i = start; i < script.length; i++) {
    const char = script[i];
    if (quoted) { if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === '"') quoted = false; }
    else if (char === '"') quoted = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) { end = i + 1; break; }
  }
  if (end < 0) throw new SocialSyncError("PAGE_STATE_INVALID");
  try { return object(JSON.parse(script.slice(start, end))); }
  catch { throw new SocialSyncError("PAGE_STATE_INVALID"); }
}
export function observation(html: string, target: Target, observedAt: string, collectionEnvelope = false): BilibiliObservation {
  const state = collectionEnvelope ? collectionPageState(html) : pageState(html);
  return observationFromVideoData(state.videoData, target, observedAt, "public-video-page-ssr", hash(html));
}
/** Share field validation, without changing the transport's actual provenance. */
export function observationFromVideoData(value: unknown, target: Target, observedAt: string, source: BilibiliObservation["source"], responseSha256: string): BilibiliObservation {
  if (target.platform !== "bilibili") throw new SocialSyncError("IDENTITY_MISMATCH");
  const video = object(value), owner = object(video.owner), stat = object(video.stat);
  if (source === "public-video-api-json") requirePublicApiVideo(video);
  if (video.bvid !== target.publicationId || identity(owner.mid) !== target.accountId) throw new SocialSyncError("IDENTITY_MISMATCH");
  if (stat.aid !== undefined && video.aid !== undefined && identity(stat.aid) !== identity(video.aid)) throw new SocialSyncError("SCOPE_MISMATCH");
  const season = video.ugc_season === undefined || video.ugc_season === null ? null : object(video.ugc_season);
  const seconds = count(video.pubdate);
  if (seconds !== null && (seconds === 0 || seconds > 253402300799)) throw new SocialSyncError("INVALID_TIME");
  const row: BilibiliObservation = {
    version: 1, platform: "bilibili", workId: target.workId, accountId: target.accountId, publicationId: target.publicationId,
    kind: "video", originalUrl: target.url, title: text(video.title), description: video.desc === undefined || video.desc === null || video.desc === "" ? null : text(video.desc, 20000),
    coverUrl: coverUrl(video.pic), publishedAt: seconds === null ? null : new Date(seconds * 1000).toISOString(), observedAt: timestamp(observedAt),
    metricsScope: "individual-video", metrics: { views: count(stat.view), likes: count(stat.like), comments: count(stat.reply),
      shares: count(stat.share), collections: count(stat.favorite), coins: count(stat.coin), danmaku: count(stat.danmaku) },
    collection: season ? { id: identity(season.id), title: text(season.title), episodeCount: count(season.ep_count) } : null,
    source, responseSha256, websitePublicationApproved: false,
  };
  validateObservation(row); return row;
}
export async function fetchVideoPage(target: Target, signal?: AbortSignal, request: typeof fetch = fetch): Promise<{ html: string; observedAt: string }> {
  return fetchBoundedPage(target, MAX_PAGE_BYTES, signal, request);
}
export async function fetchCollectionPage(target: Target, signal?: AbortSignal, request: typeof fetch = fetch): Promise<{ html: string; observedAt: string }> {
  return fetchBoundedPage(target, MAX_COLLECTION_PAGE_BYTES, signal, request);
}
async function fetchBoundedPage(target: Target, maxBytes: number, signal?: AbortSignal, request: typeof fetch = fetch): Promise<{ html: string; observedAt: string }> {
  if (target.platform !== "bilibili") throw new SocialSyncError("BROWSER_SNAPSHOT_REQUIRED");
  const canonical = videoUrl(target.url);
  if (canonical.publicationId !== target.publicationId || canonical.url !== target.url) throw new SocialSyncError("INVALID_URL");
  identity(target.accountId);
  const abort = AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]);
  try {
    abort.throwIfAborted();
    const response = await request(target.url, { method: "GET", redirect: "manual", cache: "no-store", signal: abort,
      headers: { "User-Agent": "Mozilla/5.0", Accept: "text/html", "Cache-Control": "no-cache" } });
    const reject = async (code: string): Promise<never> => { await response.body?.cancel().catch(() => {}); throw new SocialSyncError(code); };
    if (response.status >= 300 && response.status < 400) return await reject("SOURCE_REDIRECT");
    if ([401, 403, 412].includes(response.status)) return await reject("SOURCE_BLOCKED");
    if (response.status === 429) return await reject("RATE_LIMITED");
    if (response.status !== 200) return await reject("SOURCE_HTTP_ERROR");
    if (!response.headers.get("content-type")?.toLowerCase().startsWith("text/html")) return await reject("PAGE_TYPE_INVALID");
    if (Number(response.headers.get("content-length")) > maxBytes) return await reject("PAGE_TOO_LARGE");
    if (!response.body) throw new SocialSyncError("PAGE_STATE_MISSING");
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
    try {
      while (true) {
        abort.throwIfAborted();
        const part = await reader.read(); if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > maxBytes) { await reader.cancel(); throw new SocialSyncError("PAGE_TOO_LARGE"); }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    abort.throwIfAborted();
    let html: string;
    try { html = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); }
    catch { throw new SocialSyncError("PAGE_STATE_INVALID"); }
    return { html, observedAt: new Date().toISOString() };
  } catch (error) {
    if (error instanceof SocialSyncError) throw error;
    throw new SocialSyncError(abort.aborted ? (signal?.aborted ? "CANCELLED" : "SOURCE_TIMEOUT") : "SOURCE_NETWORK_ERROR");
  }
}
export async function collectVideo(target: Target, signal?: AbortSignal, request: typeof fetch = fetch): Promise<BilibiliObservation> {
  const { html, observedAt } = await fetchVideoPage(target, signal, request);
  return observation(html, target, observedAt);
}
