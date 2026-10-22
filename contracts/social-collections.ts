import type { SocialMetric } from "./social.ts";

/** Counts for activity's calendar day in the site timezone, not server "today". */
export interface SocialCollectionDayAddition {
  day: string;
  addedVideos: number;
  addedParts: number;
  basis: "member-published" | "addition-detected" | "mixed";
}

/** A candidate card projection. Cloud eligibility and checked links are separate from collection. */
export interface SocialCollectionCard {
  id: string;
  platform: "bilibili";
  kind: "season" | "multi-part";
  title: string;
  memberCount: number;
  partCount: number | null;
  firstPublishedAt: string | null;
  latestMemberPublishedAt: string | null;
  observedAt: string;
  metricsScope: "bilibili-season" | "bilibili-multi-part";
  metrics: Record<SocialMetric, number | null>;
  /** Stable on metric/title/reordering refresh. Detection is explicitly different from publication. */
  activity: { at: string; basis: "member-published" | "addition-detected" } | null;
  latestAddition: { detectedAt: string; publishedAt: string | null; addedVideos: number; addedParts: number } | null;
  originalUrl: null;
}
