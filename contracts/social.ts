import type { ImageAsset, Page } from "./content.ts";
import type { CursorQuery } from "./website.ts";

export type SocialPlatform = "bilibili" | "xiaohongshu";
export type SocialMetric = "views" | "likes" | "comments" | "shares" | "collections" | "coins" | "danmaku";
/** Exact values and the platform's rounded display are separate. Null is unknown; zero is real. */
export interface SocialPublication {
  id: string;
  platform: SocialPlatform;
  kind: "video" | "image-note";
  publishedAt: string | null;
  observedAt: string;
  metricsScope: "individual-video" | "individual-note";
  metrics: Record<SocialMetric, number | null>;
  metricDisplay: Record<SocialMetric, string | null>;
  /** Only an explicitly checked platform link. A platform may still require login. */
  originalUrl: string | null;
  linkVerifiedAt: string | null;
}
export interface SocialWork {
  id: string;
  type: "social-work";
  title: string;
  /** Explicit editorial/publication date, never collection or edit time. */
  occurredAt: string | null;
  cover: ImageAsset | null;
  publications: SocialPublication[];
}
export interface SocialRepository {
  listWorks(query?: CursorQuery): Promise<Page<SocialWork>>;
}
