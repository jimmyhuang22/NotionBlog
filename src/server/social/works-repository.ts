import { createHash } from "node:crypto";
import type { SocialTimelineRepository, SocialTimelineWork } from "../../../contracts/social-timeline.ts";
import { socialWorkMetric, socialWorkPlatform, socialWorkPublishedAt, validateSocialWorksQuery } from "../../lib/content/social-works-query.ts";
import { createPagedSocialRepository } from "./repository.ts";
import { measureContentReadAsync, traceContentRead } from "../content-read-timing.ts";
import { hydrateSelectedSocialCovers, type SocialCoverSnapshot } from "./cover-hydration.ts";

/** The input remains a fresh, fully qualified snapshot. No stored eligibility or SQL policy changes. */
export function createSocialWorksRepository(read: () => Promise<SocialCoverSnapshot<SocialTimelineWork>>): SocialTimelineRepository {
  return { listWorks:(query={})=>traceContentRead("works", "unknown", async () => {
    validateSocialWorksQuery(query);
    const snapshot = await read();
    const page = await measureContentReadAsync("social-pagination", async () => {
      const entries = snapshot.items.filter(work => query.platform === undefined || socialWorkPlatform(work) === query.platform)
        .map(work => ({ work, at: socialWorkPublishedAt(work), metric: query.order ? socialWorkMetric(work, query.order) : null }));
      entries.sort((a, b) => {
        if (query.order && a.metric !== b.metric) {
          if (a.metric === null) return 1;
          if (b.metric === null) return -1;
          return b.metric - a.metric;
        }
        if (a.at !== b.at) {
          if (a.at === null) return 1;
          if (b.at === null) return -1;
          return a.at > b.at ? -1 : 1;
        }
        return a.work.id < b.work.id ? -1 : a.work.id > b.work.id ? 1 : 0;
      });
      // Time cursors survive statistics refresh. Metric cursors bind the exact ordering values;
      // a refresh that could move an item must restart, rather than silently repeat or skip it.
      const version = createHash("sha256").update(JSON.stringify(["social-works-filters-v1", snapshot.version,
        query.platform ?? null, query.order ?? null, entries.map(({ work, at, metric }) => [work.id, at, metric])])).digest("hex");
      return createPagedSocialRepository(async () => ({ version, items: entries.map(entry => entry.work) }))
        .listWorks({ ...(query.limit === undefined ? {} : { limit: query.limit }), ...(query.cursor === undefined ? {} : { cursor: query.cursor }) });
    });
    return { ...page, items: await hydrateSelectedSocialCovers(snapshot, page.items) };
  }) };
}
