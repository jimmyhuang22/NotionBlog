import type { SocialCollectionCard, SocialCollectionDayAddition } from "./social-collections.ts";
import type { SocialPlatform, SocialWork } from "./social.ts";
import type { Page } from "./content.ts";
import type { CursorQuery } from "./website.ts";
import type { HomeFeedItem, HomeFeedPage, HomeFeedRepository } from "./home-feed.ts";

export interface PublishedSocialCollection extends Omit<SocialCollectionCard,"originalUrl"> {
  /** Additive field. Legacy DTOs may omit it; unknown history is null. */
  dayAddition?: SocialCollectionDayAddition | null;
  originalUrl:string|null;
  linkVerifiedAt:string|null;
  /** Latest currently eligible episode, with independently checked canonical playback link. */
  latestMemberUrl:string|null;
  latestMemberLinkVerifiedAt:string|null;
}
/** Versioned extension. Old SocialWork/occurredAt and old endpoint responses stay unchanged. */
export interface SocialTimelineWork extends SocialWork { collection:PublishedSocialCollection|null }
export interface SocialWorksQuery extends CursorQuery {
  platform?: SocialPlatform;
  /** Views requires Bilibili; likes requires Xiaohongshu. Omit for publication-date ordering. */
  order?: "views" | "likes";
}
export interface SocialTimelineRepository {listWorks(query?:SocialWorksQuery):Promise<Page<SocialTimelineWork>>}
export type HomeFeedV2Item = Extract<HomeFeedItem,{source:"content"}> |
  {id:string;source:"social";provider:"database";occurredAt:HomeFeedItem["occurredAt"];work:SocialTimelineWork};
export interface HomeFeedV2Page extends Omit<HomeFeedPage,"items"> {items:HomeFeedV2Item[]}
export interface HomeFeedV2Repository extends HomeFeedRepository {getPage(query?:CursorQuery):Promise<HomeFeedV2Page>}
