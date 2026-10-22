import type { SocialPublication, SocialWork } from "../../contracts/social.ts";
import type { TimelineEvent } from "../../contracts/website.ts";

/** Fictional test/handoff data only. Not registered with any product provider or publication config. */
export function exampleContent(id: string, start: string | null, precision: "date" | "datetime" = "datetime"): TimelineEvent {
  return { id, type: "post-new", occurredAt: start === null ? null : { start, end: null, precision },
    title: "示例文章", summary: null, cover: null, href: null, externalUrl: null, rating: null, progressPercent: null, detail: null };
}
export function examplePublication(platform: "bilibili" | "xiaohongshu", id = platform === "bilibili" ? "0".repeat(64) : "1".repeat(64)): SocialPublication {
  return { id, platform, kind: platform === "bilibili" ? "video" : "image-note", publishedAt: null,
    observedAt: "2026-01-02T00:00:00.000Z", metricsScope: platform === "bilibili" ? "individual-video" : "individual-note",
    metrics: { views: null, likes: platform === "bilibili" ? 0 : null, comments: 0, shares: null, collections: null, coins: null, danmaku: null },
    metricDisplay: { views: null, likes: platform === "bilibili" ? "0" : "1.2万", comments: "0", shares: null, collections: null, coins: null, danmaku: null },
    originalUrl: null, linkVerifiedAt: null };
}
export function exampleSocialWork(id: string, at: string | null): SocialWork {
  return { id, type: "social-work", title: "示例作品", occurredAt: at, cover: null,
    publications: [examplePublication("bilibili"), examplePublication("xiaohongshu")] };
}
