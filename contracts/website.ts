import type { AnyContent, ContentDetail, ContentKind, DateRange, ImageAsset, Page, Rating, StatusEntry, TimeAmount } from "./content.ts";

/** Server adapter capability. version changes whenever content or eligibility changes. */
export interface PublicContentSnapshot { version: string; records: ContentDetail<AnyContent>[] }
export interface CursorQuery { limit?: number; cursor?: string }
export type TimelineEvent =
  | { id: string; type: "status"; occurredAt: DateRange | null; entry: StatusEntry }
  | { id: string; type: "movie-watched" | "book-reading" | "book-read" | "book-given-up" | "game-playing" | "game-cleared" | "game-platinumed" | "album-new" | "post-new" | "project-new";
      occurredAt: DateRange | null; title: string; summary: string | null; cover: ImageAsset | null;
      href: string | null; externalUrl: string | null; rating: Rating | null;
      progressPercent: number | null; detail: string | null;
      /** Present on game events; the current public Game total, preserving its unit and unknown/zero distinction. */
      playedTime?: TimeAmount | null };
export interface SearchQuery extends CursorQuery { q: string; kinds?: ContentKind[] }
export interface SearchHit { id: string; kind: ContentKind; title: string; href: string; excerpt: string; updatedAt: string | null }
export type TimelinePage = Page<TimelineEvent>;
