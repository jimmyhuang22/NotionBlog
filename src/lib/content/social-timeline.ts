import { publicRepository } from "../../server/public-cache/runtime.ts";
import "server-only";
import type { SocialTimelineRepository } from "../../../contracts/social-timeline.ts";
import { isSocialEnabled } from "./social.ts";
import { socialTimelineRuntime, socialTimelineSnapshot, socialProvider } from "../../server/social/runtime.ts";
import { createMockSocialWorksRepository } from "../../../adapters/mock-social-works.ts";
import { withListReadBudget } from "../../server/list-read-budget.ts";

/** The explicit demo mode enables only the works v2 page/API, never the real mixed homepage. */
export function isSocialWorksEnabled() { return socialProvider() !== "disabled"; }

const uncachedRepository:SocialTimelineRepository={listWorks:query=>withListReadBudget("works",async()=>{
  if(!isSocialWorksEnabled())throw new Error("Social content is disabled.");
  return socialProvider() === "mock" ? createMockSocialWorksRepository().listWorks(query) : (await socialTimelineRuntime()).listWorks(query);
})};
export async function readSocialTimelineWorkSnapshot(){
  if(!isSocialEnabled())throw new Error("Social content is disabled.");return socialTimelineSnapshot();
}

export const socialTimelineRepository = publicRepository("social", "socialTimelineRepository", uncachedRepository);
