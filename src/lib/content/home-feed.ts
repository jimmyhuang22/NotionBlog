import { publicRepository } from "../../server/public-cache/runtime.ts";
import "server-only";
import type { HomeFeedRepository } from "../../../contracts/home-feed.ts";
import { getContentProvider, readContentTimelineSnapshot, hydrateContentTimelinePage } from "./index.ts";
import { isSocialEnabled, readSocialWorkSnapshot } from "./social.ts";
import { getSiteConfig } from "../site/index.ts";
import { createHomeFeedRepository } from "./home-feed-core.ts";

/** Home components and the GET route share the same merged service. No source IDs or credentials. */
const uncachedRepository: HomeFeedRepository = {
  getPage: query => {
    const enabled = isSocialEnabled();
    return createHomeFeedRepository({ content: readContentTimelineSnapshot, hydrateContent: hydrateContentTimelinePage,
      ...(enabled ? { social: readSocialWorkSnapshot } : {}),
      sources: { content: getContentProvider(), social: enabled ? "database" : "disabled" },
      timeZone: getSiteConfig().timeZone }).getPage(query);
  },
};

export const homeFeedRepository = publicRepository("home", "homeFeedRepository", uncachedRepository);
