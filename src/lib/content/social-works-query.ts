import type { SocialPlatform } from "../../../contracts/social.ts";
import type { SocialTimelineWork, SocialWorksQuery } from "../../../contracts/social-timeline.ts";
import { ContentServiceError } from "../../../contracts/repository.ts";

const invalid = () => new ContentServiceError("INVALID_QUERY", "Restart social works from the first page.");
/** Shared by the HTTP parser, server-rendered first page and all works adapters. */
export function validateSocialWorksQuery(query: SocialWorksQuery): void {
  if (!query || typeof query !== "object" || Array.isArray(query) ||
      Object.keys(query).some(key => !["limit", "cursor", "platform", "order"].includes(key)) ||
      (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 20)) ||
      (query.cursor !== undefined && (typeof query.cursor !== "string" || !query.cursor || query.cursor.length > 512)) ||
      (query.platform !== undefined && !["bilibili", "xiaohongshu"].includes(query.platform)) ||
      (query.order !== undefined && !((query.order === "views" && query.platform === "bilibili") ||
        (query.order === "likes" && query.platform === "xiaohongshu")))) throw invalid();
}

export function parseSocialWorksQuery(params: URLSearchParams): SocialWorksQuery {
  const query: Record<string, string | number> = {};
  for (const [key, value] of params) {
    if (!["limit", "cursor", "platform", "order"].includes(key) || Object.hasOwn(query, key)) throw invalid();
    if (key === "limit") {
      if (!/^[1-9]\d*$/.test(value)) throw invalid();
      query.limit = Number(value);
    } else query[key] = value;
  }
  validateSocialWorksQuery(query as SocialWorksQuery);
  return query as SocialWorksQuery;
}

/** One work belongs to one platform. Collections and cross-posted videos lead with Bilibili. */
export function socialWorkPlatform(work: SocialTimelineWork): SocialPlatform {
  return work.collection?.platform ?? (work.publications.some(p => p.platform === "bilibili") ? "bilibili" : "xiaohongshu");
}

/** Works-page date only. Homepage activity/detection ordering deliberately stays separate. */
export function socialWorkPublishedAt(work: SocialTimelineWork): string | null {
  if (work.collection) return work.collection.latestMemberPublishedAt;
  const platform = socialWorkPlatform(work);
  const dates = work.publications.filter(p => p.platform === platform).flatMap(p => p.publishedAt === null ? [] : [p.publishedAt]);
  return dates.sort().at(-1) ?? null;
}

/** Exact primary-platform totals only; an unknown component or unsafe sum remains unknown. */
export function socialWorkMetric(work: SocialTimelineWork, metric: "views" | "likes"): number | null {
  if (work.collection) return work.collection.metrics[metric];
  const publications = work.publications.filter(p => p.platform === socialWorkPlatform(work));
  if (!publications.length || publications.some(p => p.metrics[metric] === null)) return null;
  const total = publications.reduce((sum, p) => sum + p.metrics[metric]!, 0);
  return Number.isSafeInteger(total) ? total : null;
}
