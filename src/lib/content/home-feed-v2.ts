import { publicRepository } from "../../server/public-cache/runtime.ts";
import "server-only";
import type { HomeFeedV2Repository } from "../../../contracts/social-timeline.ts";
import { getContentProvider, readContentTimelineSnapshot, hydrateContentTimelinePage } from "./index.ts";
import { isSocialEnabled } from "./social.ts";
import { readSocialTimelineWorkSnapshot } from "./social-timeline.ts";
import { getSiteConfig } from "../site/index.ts";
import { createHomeFeedV2Repository } from "./home-feed-v2-core.ts";
import { withListReadBudget } from "../../server/list-read-budget.ts";

const uncachedRepository:HomeFeedV2Repository={getPage:query=>withListReadBudget("home-feed",()=>{
  const enabled=isSocialEnabled();return createHomeFeedV2Repository({content:readContentTimelineSnapshot,hydrateContent:hydrateContentTimelinePage,
    ...(enabled?{social:readSocialTimelineWorkSnapshot}:{}),sources:{content:getContentProvider(),social:enabled?"database":"disabled"},
    timeZone:getSiteConfig().timeZone}).getPage(query);
})};

export const homeFeedV2Repository = publicRepository("home", "homeFeedV2Repository", uncachedRepository);
