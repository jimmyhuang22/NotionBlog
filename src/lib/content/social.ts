import { publicRepository } from "../../server/public-cache/runtime.ts";
import "server-only";
import type { SocialRepository } from "../../../contracts/social.ts";
import { socialProvider, socialRuntime, socialSnapshot } from "../../server/social/runtime.ts";

/** Independent optional source; never substitutes for the existing Notion/content provider. */
export function isSocialEnabled() { return socialProvider() === "database"; }
const uncachedRepository: SocialRepository = {
  listWorks: async query => {
    if (!isSocialEnabled()) throw new Error("Social content is disabled.");
    return (await socialRuntime()).listWorks(query);
  },
};
export async function readSocialWorkSnapshot() {
  if (!isSocialEnabled()) throw new Error("Social content is disabled.");
  return socialSnapshot();
}

export const socialRepository = publicRepository("social", "socialRepository", uncachedRepository);
