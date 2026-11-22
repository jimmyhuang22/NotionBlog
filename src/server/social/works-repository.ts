import { createHash } from "node:crypto";
import type { SocialTimelineRepository, SocialTimelineWork } from "../../../contracts/social-timeline.ts";
import { socialWorkMetric, socialWorkPlatform, socialWorkPublishedAt, validateSocialWorksQuery } from "../../lib/content/social-works-query.ts";
import { dateParts } from "../../lib/format.ts";
import { createPagedSocialRepository } from "./repository.ts";
import { measureContentReadAsync, traceContentRead } from "../content-read-timing.ts";
import { hydrateSelectedSocialCovers, type SocialCoverSnapshot } from "./cover-hydration.ts";

/** The input is a qualified snapshot: read fresh, or rows shared by the public cache (no covers). Covers always
 * qualify live for the selected page through hydrateCovers. No stored eligibility or SQL policy changes. */
export function createSocialWorksRepository(read: () => Promise<SocialCoverSnapshot<SocialTimelineWork>>, timeZone = "UTC"): SocialTimelineRepository {
  return { listWorks:(query={})=>traceContentRead("works", "unknown", async () => {
    validateSocialWorksQuery(query);
    const snapshot = await read();
    const page = await measureContentReadAsync("social-pagination", async () => {
      const counts = new Map<number, number>();
      let undatedCount = 0;
      const entries = snapshot.items.flatMap(work => {
        if (query.platform !== undefined && socialWorkPlatform(work) !== query.platform) return [];
        const at = socialWorkPublishedAt(work);
        const year = (at ? dateParts(at, "datetime", timeZone)?.year : null) ?? "undated";
        if (year === "undated") undatedCount++;
        else counts.set(year, (counts.get(year) ?? 0) + 1);
        if (query.year !== undefined && query.year !== year) return [];
        return [{ work, at, metric: query.order ? socialWorkMetric(work, query.order) : null }];
      });
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
      const yearScope = query.year === undefined ? [] : [query.year, timeZone];
      const version = createHash("sha256").update(JSON.stringify(["social-works-filters-v1", snapshot.version,
        query.platform ?? null, query.order ?? null, ...yearScope, entries.map(({ work, at, metric }) => [work.id, at, metric])])).digest("hex");
      const paged = await createPagedSocialRepository(async () => ({ version, items: entries.map(entry => entry.work) }))
        .listWorks({ ...(query.limit === undefined ? {} : { limit: query.limit }), ...(query.cursor === undefined ? {} : { cursor: query.cursor }) });
      const years = [...counts].sort(([a], [b]) => b - a).map(([year, count]) => ({ year, count }));
      return { ...paged, yearCounts: { years, undatedCount, timeZone } };
    });
    return { ...page, items: await hydrateSelectedSocialCovers(snapshot, page.items) };
  }) };
}
