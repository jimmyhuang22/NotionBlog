import { createHash } from "node:crypto";

export class SocialSyncError extends Error {
  code: string;
  constructor(code: string) { super(code); this.code = code; }
}
export interface Target { platform: "bilibili" | "xiaohongshu"; workId: string; accountId: string; publicationId: string; url: string }
export const metricNames = ["views", "likes", "comments", "shares", "collections", "coins", "danmaku"] as const;
export type Metrics = Record<typeof metricNames[number], number | null>;
interface ObservationBase {
  workId: string; accountId: string; publicationId: string;
  originalUrl: string; title: string; description: string | null; coverUrl: string | null;
  publishedAt: string | null; observedAt: string; metrics: Metrics;
  responseSha256: string; websitePublicationApproved: false;
}
export interface BilibiliObservation extends ObservationBase {
  version: 1; platform: "bilibili"; kind: "video"; metricsScope: "individual-video";
  collection: { id: string; title: string; episodeCount: number | null } | null;
  source: "public-video-page-ssr";
}
export const noteMetricNames = ["likes", "comments", "shares", "collections"] as const;
export interface XiaohongshuObservation extends ObservationBase {
  version: 2; platform: "xiaohongshu"; kind: "video" | "image-note"; metricsScope: "individual-note";
  collection: null; source: "browser-note-state" | "public-note-page-ssr"; updatedAt: string | null;
  metricDisplay: Record<typeof noteMetricNames[number], string | null>;
}
export type Observation = BilibiliObservation | XiaohongshuObservation;
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SocialSyncError("INVALID_DATA");
  return value as Record<string, unknown>;
}
export function text(value: unknown, max = 1000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new SocialSyncError("INVALID_DATA");
  return value;
}
export function identity(value: unknown): string {
  if (typeof value === "number" && !Number.isSafeInteger(value)) throw new SocialSyncError("INVALID_IDENTITY");
  const result = String(value);
  if (!/^[1-9][0-9]{0,19}$/.test(result)) throw new SocialSyncError("INVALID_IDENTITY");
  return result;
}
export function count(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && /^[0-9]+$/.test(value)) value = Number(value);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new SocialSyncError("INVALID_COUNT");
  return value;
}
export function timestamp(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new SocialSyncError("INVALID_TIME");
  return value;
}
export function videoUrl(value: unknown): { publicationId: string; url: string } {
  let url: URL;
  try { url = new URL(text(value, 2048)); } catch { throw new SocialSyncError("INVALID_URL"); }
  const match = /^\/video\/(BV[0-9A-Za-z]{10})\/?$/.exec(url.pathname);
  if (url.protocol !== "https:" || url.hostname !== "www.bilibili.com" || url.port || url.username || url.password || !match) {
    throw new SocialSyncError("INVALID_URL");
  }
  return { publicationId: match[1], url: `https://www.bilibili.com/video/${match[1]}/` };
}
export function noteIdentity(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{24}$/.test(value)) throw new SocialSyncError("INVALID_IDENTITY");
  return value;
}
export function noteUrl(value: unknown): { publicationId: string; url: string } {
  let url: URL;
  try { url = new URL(text(value, 2048)); } catch { throw new SocialSyncError("INVALID_URL"); }
  const match = /^\/explore\/([a-f0-9]{24})\/?$/.exec(url.pathname);
  if (url.protocol !== "https:" || url.hostname !== "www.xiaohongshu.com" || url.port || url.username || url.password || !match) {
    throw new SocialSyncError("INVALID_URL");
  }
  return { publicationId: match[1], url: `https://www.xiaohongshu.com/explore/${match[1]}` };
}
/** Preserve a rounded display separately; never manufacture an exact integer from it. */
export function noteCount(value: unknown): { exact: number | null; display: string | null } {
  if (value === undefined || value === null || value === "") return { exact: null, display: null };
  if (typeof value === "number") return { exact: count(value), display: String(value) };
  if (typeof value !== "string" || !value.trim() || value.length > 32) throw new SocialSyncError("INVALID_COUNT");
  const display = value.trim();
  if (/^[0-9]+$/.test(display)) return { exact: count(display), display };
  if (/^[0-9]+(?:\.[0-9]+)?(?:万|亿|[kKmMwW])\+?$/.test(display) || /^[0-9]+\+$/.test(display)) return { exact: null, display };
  throw new SocialSyncError("INVALID_COUNT");
}
export function config(value: unknown): Target[] {
  const root = object(value);
  if (root.version !== 1 || Object.keys(root).some(k => !["version", "publications"].includes(k)) ||
      !Array.isArray(root.publications) || root.publications.length < 1 || root.publications.length > 20) throw new SocialSyncError("INVALID_CONFIG");
  const seen = new Set<string>();
  return root.publications.map(raw => {
    const row = object(raw);
    if ((row.platform !== "bilibili" && row.platform !== "xiaohongshu") || Object.keys(row).some(k => !["platform", "workId", "accountId", "url"].includes(k)) ||
        typeof row.workId !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(row.workId) || typeof row.accountId !== "string") {
      throw new SocialSyncError("INVALID_CONFIG");
    }
    const target: Target = row.platform === "bilibili"
      ? { platform: "bilibili", workId: row.workId, accountId: identity(row.accountId), ...videoUrl(row.url) }
      : { platform: "xiaohongshu", workId: row.workId, accountId: noteIdentity(row.accountId), ...noteUrl(row.url) };
    const key = publicationKey(target);
    if (seen.has(key)) throw new SocialSyncError("DUPLICATE_PUBLICATION");
    seen.add(key); return target;
  });
}
export function publicationKey(value: Pick<Target, "platform" | "accountId" | "publicationId">): string {
  return hash(JSON.stringify([value.platform, value.accountId, value.publicationId]));
}
export function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
/** Validate at the persistence boundary, including observations supplied by future adapters. */
export function validateObservation(value: Observation): void {
  const v = object(value);
  const fields = ["version", "platform", "workId", "accountId", "publicationId", "kind", "originalUrl", "title", "description", "coverUrl",
    "publishedAt", "observedAt", "metricsScope", "metrics", "collection", "source", "responseSha256", "websitePublicationApproved"];
  const xhs = v.platform === "xiaohongshu";
  if (xhs) fields.push("updatedAt", "metricDisplay");
  if (Object.keys(v).length !== fields.length || Object.keys(v).some(k => !fields.includes(k))) throw new SocialSyncError("INVALID_DATA");
  const canonical = xhs ? noteUrl(v.originalUrl) : videoUrl(v.originalUrl);
  if ((!xhs && (v.version !== 1 || v.platform !== "bilibili" || v.kind !== "video" || v.source !== "public-video-page-ssr" || v.metricsScope !== "individual-video")) ||
      (xhs && (v.version !== 2 || !["video", "image-note"].includes(String(v.kind)) || !["browser-note-state", "public-note-page-ssr"].includes(String(v.source)) || v.metricsScope !== "individual-note" || v.collection !== null || v.description !== null)) ||
      v.websitePublicationApproved !== false ||
      !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(text(v.workId, 64)) || (xhs ? noteIdentity(v.accountId) : identity(v.accountId)) !== v.accountId ||
      canonical.publicationId !== v.publicationId || canonical.url !== v.originalUrl ||
      !/^[a-f0-9]{64}$/.test(text(v.responseSha256, 64))) throw new SocialSyncError("INVALID_DATA");
  text(v.title); timestamp(text(v.observedAt));
  if (v.publishedAt !== null) timestamp(text(v.publishedAt));
  if (v.description !== null) text(v.description, 20000);
  if (v.coverUrl !== null && (xhs ? noteCoverUrl(v.coverUrl) : coverUrl(v.coverUrl)) !== v.coverUrl) throw new SocialSyncError("INVALID_DATA");
  const metrics = object(v.metrics);
  if (Object.keys(metrics).length !== metricNames.length) throw new SocialSyncError("INVALID_DATA");
  for (const name of metricNames) {
    if (!Object.hasOwn(metrics, name) || count(metrics[name]) !== metrics[name]) throw new SocialSyncError("INVALID_DATA");
  }
  if (xhs) {
    if (v.updatedAt !== null) timestamp(text(v.updatedAt));
    for (const name of ["views", "coins", "danmaku"]) if (metrics[name] !== null) throw new SocialSyncError("INVALID_DATA");
    const displays = object(v.metricDisplay);
    if (Object.keys(displays).length !== noteMetricNames.length) throw new SocialSyncError("INVALID_DATA");
    for (const name of noteMetricNames) {
      if (!Object.hasOwn(displays, name)) throw new SocialSyncError("INVALID_DATA");
      const parsed = noteCount(displays[name]);
      if (parsed.display !== displays[name] || parsed.exact !== metrics[name]) throw new SocialSyncError("INVALID_DATA");
    }
  }
  if (v.collection !== null) {
    const c = object(v.collection);
    if (Object.keys(c).length !== 3 || identity(c.id) !== c.id || count(c.episodeCount) !== c.episodeCount) throw new SocialSyncError("INVALID_DATA");
    text(c.title);
  }
}
export function noteCoverUrl(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  let url: URL;
  try { url = new URL(text(value, 2048)); } catch { throw new SocialSyncError("INVALID_DATA"); }
  if (!["http:", "https:"].includes(url.protocol) || !/^[a-z0-9-]+\.xhscdn\.com$/.test(url.hostname) || url.port || url.username || url.password) {
    throw new SocialSyncError("INVALID_DATA");
  }
  url.protocol = "https:"; url.hash = ""; return url.href;
}
export function coverUrl(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  let url: URL;
  try { url = new URL(text(value, 2048)); } catch { throw new SocialSyncError("INVALID_DATA"); }
  if (!["http:", "https:"].includes(url.protocol) || !/^i[0-9]+\.hdslb\.com$/.test(url.hostname) || url.port || url.username || url.password) {
    throw new SocialSyncError("INVALID_DATA");
  }
  url.protocol = "https:"; return url.href;
}
