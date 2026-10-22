import { demoSocialWorks } from "../fixtures/social-works.ts";
import { createSocialWorksRepository } from "../src/server/social/works-repository.ts";

/** Explicit SOCIAL_PROVIDER=mock only; never a fallback for an unavailable real reader. */
export function createMockSocialWorksRepository() {
  return createSocialWorksRepository(async () => ({ version: "fictional-social-works-v1", items: structuredClone(demoSocialWorks) }));
}
