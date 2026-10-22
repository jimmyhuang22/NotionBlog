import type { DateRange, Page } from "./content.ts";
import type { CursorQuery, TimelineEvent } from "./website.ts";
import type { SocialWork } from "./social.ts";

export type HomeContentProvider = "mock" | "notion" | "database";
export interface HomeFeedSources {
  content: HomeContentProvider;
  social: "disabled" | "database";
}
/** Namespaced IDs are stable across paging. Existing content events remain unchanged inside event. */
export type HomeFeedItem =
  | { id: string; source: "content"; provider: HomeContentProvider; occurredAt: DateRange | null; event: TimelineEvent }
  | { id: string; source: "social"; provider: "database"; occurredAt: DateRange | null; work: SocialWork };
export interface HomeFeedPage extends Page<HomeFeedItem> { total: number; sources: HomeFeedSources }
export interface HomeFeedRepository { getPage(query?: CursorQuery): Promise<HomeFeedPage> }
/** Server adapter capability only; no full-snapshot HTTP endpoint. */
export interface FeedSnapshot<T> { version: string; items: T[] }
