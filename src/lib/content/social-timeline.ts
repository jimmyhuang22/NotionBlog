import { sharedSocialProjection, publicRepository } from "../../server/public-cache/runtime.ts";
import { publicCacheEnabled } from "../../server/public-cache/policy.ts";
import "server-only";
import type { SocialTimelineRepository } from "../../../contracts/social-timeline.ts";
import { isSocialEnabled } from "./social.ts";
import { socialTimelineRows, socialTimelineRuntime, socialTimelineSnapshot, socialProvider, withLiveSocialCovers } from "../../server/social/runtime.ts";
import { createMockSocialWorksRepository } from "../../../adapters/mock-social-works.ts";
import { withListReadBudget } from "../../server/list-read-budget.ts";

/** The explicit demo mode enables only the works v2 page/API, never the real mixed homepage. */
export function isSocialWorksEnabled() { return socialProvider() !== "disabled"; }

/**
 * With the public cache on, the timeline rows are kept once per publication generation and day, under the
 * social tags, and every works filter, cursor and the mixed home feed select from them. Before, each of those
 * cache keys read the whole snapshot again on a miss. The rows carry no covers; covers still qualify live
 * for the selected works. With the cache off, nothing changes: one fresh read per request.
 */
const sharedTimelineRows = () => sharedSocialProjection(socialTimelineRows);

const uncachedRepository:SocialTimelineRepository={listWorks:query=>withListReadBudget("works",async()=>{
  if(!isSocialWorksEnabled())throw new Error("Social content is disabled.");
  return socialProvider() === "mock" ? createMockSocialWorksRepository().listWorks(query) : (await socialTimelineRuntime(publicCacheEnabled() ? sharedTimelineRows : undefined)).listWorks(query);
})};
export async function readSocialTimelineWorkSnapshot(){
  if(!isSocialEnabled())throw new Error("Social content is disabled.");
  return publicCacheEnabled() ? withLiveSocialCovers(await sharedTimelineRows()) : socialTimelineSnapshot();
}

export const socialTimelineRepository = publicRepository("social", "socialTimelineRepository", uncachedRepository);
