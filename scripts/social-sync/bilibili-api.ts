import { identity, object, SocialSyncError, videoUrl } from "./model.ts";
import type { Target } from "./model.ts";
import { requirePublicApiVideo } from "./bilibili.ts";

export const MAX_BILIBILI_API_BYTES = 8 * 1024 * 1024;
/** A candidate web endpoint, not a promise of anonymous availability or a supported SDK. */
export function bilibiliApiUrl(target: Target): string {
  const canonical = videoUrl(target.url);
  if (target.platform !== "bilibili" || canonical.url !== target.url || canonical.publicationId !== target.publicationId) throw new SocialSyncError("IDENTITY_MISMATCH");
  identity(target.accountId);
  return `https://api.bilibili.com/x/web-interface/view?bvid=${canonical.publicationId}`;
}
export function apiVideoData(raw: string, target: Target): Record<string, unknown> {
  bilibiliApiUrl(target);
  if (Buffer.byteLength(raw) > MAX_BILIBILI_API_BYTES) throw new SocialSyncError("PAGE_TOO_LARGE");
  let response: Record<string, unknown>;
  try { response = object(JSON.parse(raw)); } catch { throw new SocialSyncError("BILIBILI_API_RESPONSE_INVALID"); }
  if (response.code !== 0) throw new SocialSyncError(response.code === -352 ? "SOURCE_VERIFICATION_REQUIRED" : response.code === -403 ? "SOURCE_BLOCKED" : response.code === -404 ? "SOURCE_VIDEO_UNAVAILABLE" : "SOURCE_API_ERROR");
  const video = object(response.data), owner = object(video.owner);
  if (video.bvid !== target.publicationId || identity(owner.mid) !== target.accountId) throw new SocialSyncError("IDENTITY_MISMATCH");
  requirePublicApiVideo(video);
  return video;
}
/** One exact anonymous GET, bounded streaming, no redirects, retry, or SSR fallback. */
export async function fetchApiVideo(target: Target, signal?: AbortSignal, request: typeof fetch = fetch) {
  const url = bilibiliApiUrl(target), abort = AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]);
  try {
    abort.throwIfAborted();
    const response = await request(url, { method: "GET", redirect: "manual", credentials: "omit", cache: "no-store", signal: abort,
      headers: { Accept: "application/json", Referer: "https://www.bilibili.com/", "User-Agent": "Mozilla/5.0" } });
    const reject = async (code: string): Promise<never> => { await response.body?.cancel().catch(() => {}); throw new SocialSyncError(code); };
    if (response.status >= 300 && response.status < 400) return reject("SOURCE_REDIRECT");
    if ([401,403,412].includes(response.status)) return reject("SOURCE_BLOCKED");
    if (response.status === 429) return reject("RATE_LIMITED");
    if (response.status !== 200) return reject("SOURCE_HTTP_ERROR");
    if (response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") return reject("PAGE_TYPE_INVALID");
    const declared = response.headers.get("content-length");
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BILIBILI_API_BYTES)) return reject("PAGE_TOO_LARGE");
    if (!response.body) throw new SocialSyncError("BILIBILI_API_RESPONSE_INVALID");
    const reader = response.body.getReader(), parts: Uint8Array[] = []; let bytes = 0;
    try {
      while (true) {
        abort.throwIfAborted(); const item = await reader.read(); if (item.done) break;
        bytes += item.value.byteLength;
        if (bytes > MAX_BILIBILI_API_BYTES) throw new SocialSyncError("PAGE_TOO_LARGE");
        parts.push(item.value);
      }
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
    abort.throwIfAborted(); let raw: string;
    try { raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(parts)); }
    catch { throw new SocialSyncError("BILIBILI_API_RESPONSE_INVALID"); }
    return { raw, videoData: apiVideoData(raw, target), observedAt: new Date().toISOString() };
  } catch (error) {
    throw error instanceof SocialSyncError ? error : new SocialSyncError(abort.aborted ? signal?.aborted ? "CANCELLED" : "SOURCE_TIMEOUT" : "SOURCE_NETWORK_ERROR");
  }
}
