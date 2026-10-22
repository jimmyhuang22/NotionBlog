import { createHash } from "node:crypto";
import { ContentServiceError } from "../../../contracts/repository.ts";
import type { SocialMetric, SocialPublication, SocialRepository, SocialWork } from "../../../contracts/social.ts";
import type { CursorQuery } from "../../../contracts/website.ts";
import type { SqlExecutor } from "../database/sql.ts";
import { isVerifiedPlatformUrl } from "./links.ts";
import type { FeedSnapshot } from "../../../contracts/home-feed.ts";
import { MAX_SOCIAL_WORKS, MAX_SOCIAL_PUBLICATIONS_PER_WORK, MAX_SOCIAL_SNAPSHOT_BYTES } from "../../lib/content/social-limits.ts";

export const socialMetrics: SocialMetric[] = ["views", "likes", "comments", "shares", "collections", "coins", "danmaku"];
const unavailable = () => new ContentServiceError("CONTENT_UNAVAILABLE", "Social content is temporarily unavailable.");
const invalid = () => new ContentServiceError("INVALID_QUERY", "Restart social content from the first page.");
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailable();
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, names: string[]) {
  if (Object.keys(value).length !== names.length || names.some(n => !Object.hasOwn(value, n))) throw unavailable();
}
function time(value: unknown, nullable = true): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw unavailable();
  return value;
}
export function mapSocialPublication(value: unknown): SocialPublication {
  const p = object(value);
  keys(p, ["id", "platform", "publicationId", "kind", "publishedAt", "observedAt", "metricsScope", "metrics", "metricDisplay", "originalUrl", "linkVerifiedAt"]);
  if (typeof p.id !== "string" || !/^[a-f0-9]{64}$/.test(p.id) || (p.platform !== "bilibili" && p.platform !== "xiaohongshu") ||
      typeof p.publicationId !== "string" || (p.platform === "bilibili" ? !/^BV[0-9A-Za-z]{10}$/.test(p.publicationId) : !/^[a-f0-9]{24}$/.test(p.publicationId)) ||
      (p.platform === "bilibili" ? p.kind !== "video" || p.metricsScope !== "individual-video" : !["video", "image-note"].includes(String(p.kind)) || p.metricsScope !== "individual-note")) throw unavailable();
  const m = object(p.metrics), display = object(p.metricDisplay);
  keys(m, socialMetrics); keys(display, ["likes", "comments", "shares", "collections"]);
  const metrics = {} as SocialPublication["metrics"], metricDisplay = {} as SocialPublication["metricDisplay"];
  for (const name of socialMetrics) {
    const count = m[name];
    if (count !== null && (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)) throw unavailable();
    metrics[name] = count as number | null;
    const label = display[name];
    if (p.platform === "xiaohongshu" && Object.hasOwn(display, name)) {
      if (label !== null && (typeof label !== "string" || label.length > 32 || !/^(?:[0-9]+(?:\.[0-9]+)?(?:万|亿|[kKmMwW])\+?|[0-9]+\+?)$/.test(label))) throw unavailable();
      const exact = typeof label === "string" && /^[0-9]+$/.test(label) ? Number(label) : null;
      if (exact !== count) throw unavailable();
      metricDisplay[name] = label as string | null;
    } else metricDisplay[name] = count === null ? null : String(count);
  }
  if (p.platform === "xiaohongshu" && ["views", "coins", "danmaku"].some(n => m[n] !== null)) throw unavailable();
  if (p.platform === "bilibili" && Object.values(display).some(v => v !== null)) throw unavailable();
  if (p.originalUrl !== null && (typeof p.originalUrl !== "string" || !isVerifiedPlatformUrl(p.platform, p.publicationId, p.originalUrl))) throw unavailable();
  const linkVerifiedAt = time(p.linkVerifiedAt);
  if ((p.originalUrl === null) !== (linkVerifiedAt === null)) throw unavailable();
  return { id: p.id, platform: p.platform, kind: p.kind as SocialPublication["kind"],
    publishedAt: time(p.publishedAt), observedAt: time(p.observedAt, false)!, metricsScope: p.metricsScope as SocialPublication["metricsScope"],
    metrics, metricDisplay, originalUrl: p.originalUrl as string | null, linkVerifiedAt };
}
function work(value: unknown): SocialWork {
  const w = object(value); keys(w, ["id", "title", "occurredAt", "publications"]);
  if (typeof w.id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(w.id) || typeof w.title !== "string" || !w.title.trim() || w.title.length > 1000 ||
      !Array.isArray(w.publications) || w.publications.length < 1 || w.publications.length > MAX_SOCIAL_PUBLICATIONS_PER_WORK) throw unavailable();
  const publications = w.publications.map(mapSocialPublication);
  if (new Set(publications.map(p => p.id)).size !== publications.length) throw unavailable();
  return { id: w.id, type: "social-work", title: w.title, occurredAt: time(w.occurredAt), cover: null, publications };
}
/** One statement: eligibility, observations and work metadata use the same database snapshot. */
export const socialWorksSql = `WITH selected AS MATERIALIZED (
  SELECT work_id,title,occurred_at FROM social_sync.website_publications
  GROUP BY work_id,title,occurred_at ORDER BY occurred_at DESC NULLS LAST,work_id LIMIT ${MAX_SOCIAL_WORKS + 1}
) SELECT jsonb_build_object('id',w.work_id,'title',w.title,'occurredAt',w.occurred_at,
  'publications',p.publications) AS work FROM selected w CROSS JOIN LATERAL (
    SELECT jsonb_agg(publication ORDER BY publication->>'platform',publication->>'id') AS publications FROM (
      SELECT publication FROM social_sync.website_publications WHERE work_id=w.work_id
      ORDER BY publication->>'platform',publication->>'id' LIMIT ${MAX_SOCIAL_PUBLICATIONS_PER_WORK + 1}
    ) bounded
  ) p ORDER BY w.occurred_at DESC NULLS LAST,w.work_id`;
/** A single current-eligibility SQL read, shared by standalone paging and the mixed home feed. */
export async function readSocialSnapshot(sql: SqlExecutor): Promise<FeedSnapshot<SocialWork>> {
  let rows: { work: unknown }[];
  try { rows = (await sql.query<{ work: unknown }>(socialWorksSql)).rows; } catch { throw unavailable(); }
  if (rows.length > MAX_SOCIAL_WORKS || Buffer.byteLength(JSON.stringify(rows)) > MAX_SOCIAL_SNAPSHOT_BYTES) throw unavailable();
  const items = rows.map(r => work(r.work));
  if (new Set(items.map(w => w.id)).size !== items.length) throw unavailable();
  return { version: createHash("sha256").update(JSON.stringify(items)).digest("hex"), items };
}
export function createSocialRepository(sql: SqlExecutor): SocialRepository {
  return createPagedSocialRepository(()=>readSocialSnapshot(sql));
}
export function createPagedSocialRepository<T extends SocialWork>(read:()=>Promise<FeedSnapshot<T>>) {
  return { async listWorks(query: CursorQuery = {}) {
    if (Object.keys(query).some(k => !["limit", "cursor"].includes(k)) ||
        (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 20)) ||
        (query.cursor !== undefined && (typeof query.cursor !== "string" || !query.cursor || query.cursor.length > 512))) throw invalid();
    const { items, version } = await read();
    let offset = 0;
    if (query.cursor !== undefined) {
      try {
        const c = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8"));
        if (Object.keys(c).length !== 3 || c.v !== 1 || c.version !== version || !Number.isSafeInteger(c.offset) ||
            c.offset < 1 || c.offset >= items.length || Buffer.from(JSON.stringify(c)).toString("base64url") !== query.cursor) throw invalid();
        offset = c.offset;
      } catch { throw invalid(); }
    }
    const end = Math.min(offset + (query.limit ?? 12), items.length), hasMore = end < items.length;
    return { items: items.slice(offset, end), hasMore, total: items.length,
      nextCursor: hasMore ? Buffer.from(JSON.stringify({ v: 1, version, offset: end })).toString("base64url") : null };
  } };
}
