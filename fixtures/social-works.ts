import type { SocialPlatform, SocialPublication } from "../contracts/social.ts";
import type { SocialTimelineWork } from "../contracts/social-timeline.ts";

/** Fictional works only: enough of each platform for several pages, ties, nulls and real zero. */
const observedAt = "2026-10-15T00:00:00.000Z";
function publication(platform: SocialPlatform, index: number): SocialPublication {
  const value = index % 7 === 0 ? null : Math.floor(index / 3) * 100;
  const metrics = { views: platform === "bilibili" ? value : null, likes: value, comments: null,
    shares: null, collections: null, coins: null, danmaku: null };
  return { id: ((platform === "bilibili" ? 1000 : 2000) + index).toString(16).padStart(64, "0"), platform, kind: platform === "bilibili" ? "video" : "image-note",
    publishedAt: index % 13 === 0 ? null : new Date(Date.UTC(2026, 9, 1) - index * 40 * 86400000).toISOString(),
    observedAt, metricsScope: platform === "bilibili" ? "individual-video" : "individual-note", metrics,
    metricDisplay: Object.fromEntries(Object.entries(metrics).map(([key, count]) => [key, count === null ? null : String(count)])) as SocialPublication["metricDisplay"],
    originalUrl: null, linkVerifiedAt: null };
}
export const demoSocialWorks: SocialTimelineWork[] = (["bilibili", "xiaohongshu"] as const).flatMap(platform =>
  Array.from({ length: 28 }, (_, index): SocialTimelineWork => {
    const pub = publication(platform, index), id = `demo-${platform}-${index}`;
    const title = `[演示] ${platform === "bilibili" ? "视频作品" : "图文笔记"} ${String(index + 1).padStart(2, "0")}`;
    return { id, type: "social-work", title, occurredAt: pub.publishedAt,
      cover: { id: `cover-${id}`, src: platform === "bilibili" ? "/mock-media/landscape.svg" : "/mock-media/book.svg", alt: title, width: null, height: null },
      publications: platform === "bilibili" && index === 2 ? [] : platform === "bilibili" && index === 3 ? [pub, publication("xiaohongshu", 100)] : [pub],
      collection: platform === "bilibili" && index === 2 ? {
        id, platform, kind: "season", title, memberCount: 3, partCount: null, firstPublishedAt: null,
        latestMemberPublishedAt: pub.publishedAt, observedAt, metricsScope: "bilibili-season", metrics: { ...pub.metrics, views: 10000 },
        activity: { at: "2026-10-14T00:00:00.000Z", basis: "addition-detected" },
        latestAddition: { detectedAt: "2026-10-14T00:00:00.000Z", publishedAt: null, addedVideos: 1, addedParts: 0 },
        originalUrl: null, linkVerifiedAt: null,
        latestMemberUrl: "https://www.bilibili.com/video/BV0000000002/", latestMemberLinkVerifiedAt: observedAt,
      } : null };
  }));
