import type { MovieRatingSource } from "../../../contracts/content.ts";

export function isMoviePublicRating(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 10);
}

export function isMovieRatingSource(value: unknown): value is MovieRatingSource | null {
  return value === null || value === "douban" || value === "bangumi" || value === "1905";
}

/** Only configured, recognized source labels become public metadata. */
export function normalizeMovieRatingSource(label: string | null): MovieRatingSource | null {
  switch (label?.trim().toLowerCase()) {
    case "豆瓣": case "douban": return "douban";
    case "bangumi": return "bangumi";
    case "1905": case "1905电影网": return "1905";
    default: return null;
  }
}
