import test from "node:test";
import assert from "node:assert/strict";
import type { SocialTimelineWork, SocialWorksPage } from "../contracts/social-timeline.ts";
import type { SocialPlatform } from "../contracts/social.ts";
import { createMockSocialWorksRepository } from "../adapters/mock-social-works.ts";
import { demoSocialWorks } from "../fixtures/social-works.ts";
import { socialTimelineWorksResponse } from "../src/lib/content/social-http.ts";
import { socialWorkMetric, socialWorkPlatform, socialWorkPublishedAt } from "../src/lib/content/social-works-query.ts";
import { dateParts } from "../src/lib/format.ts";
import { worksQuery } from "../src/lib/works.ts";
import { yearTabs, yearTotal } from "../src/lib/year-filter.ts";

/*
 * The works page's year row against the demo works, the way the page reads them: the first page as the server reads
 * it, every later page from the v2 endpoint with the query the list keeps (worksQuery) and the last cursor.
 */
const zone = "Asia/Shanghai";
const repo = createMockSocialWorksRepository(zone);
const yearOf = (work: SocialTimelineWork) => { const at = socialWorkPublishedAt(work); return (at ? dateParts(at, "datetime", zone)?.year : null) ?? "undated"; };

async function page(query: Record<string, string>, cursor: string | null): Promise<SocialWorksPage> {
  const params = new URLSearchParams(query);
  if (cursor) params.set("cursor", cursor);
  const response = await socialTimelineWorksResponse(new Request(`http://example.test/api/social/works/v2?${params}`), repo, () => true);
  assert.equal(response.status, 200, String(params));
  return (await response.json()).data;
}

async function everyPage(platform: SocialPlatform, year: string | null, order: "views" | "likes" | null) {
  const query = worksQuery(platform, year, order, 5);
  const pages: SocialWorksPage[] = [];
  let cursor: string | null = null;
  do { const next = await page(query, cursor); pages.push(next); cursor = next.nextCursor; } while (cursor && pages.length < 50);
  return pages;
}

test("the year row counts each platform's demo works by year and lists the undated ones last", async () => {
  for (const platform of ["bilibili", "xiaohongshu"] as const) {
    const own = demoSocialWorks.filter(work => socialWorkPlatform(work) === platform);
    const expected = new Map<number | "undated", number>();
    for (const work of own) expected.set(yearOf(work), (expected.get(yearOf(work)) ?? 0) + 1);
    const { yearCounts } = await page(worksQuery(platform, null, null, 5), null);
    assert.deepEqual(yearCounts.years, [...expected].filter(([year]) => year !== "undated").sort(([a], [b]) => Number(b) - Number(a)).map(([year, count]) => ({ year, count })), platform);
    assert.equal(yearCounts.undatedCount, expected.get("undated") ?? 0, platform);
    assert.equal(yearTotal(yearCounts, null), own.length, platform);
    const tabs = yearTabs(yearCounts);
    assert.equal(tabs[0]!.value, null);
    if (yearCounts.undatedCount) assert.equal(tabs.at(-1)!.value, "undated");
    // A chosen year keeps the whole row: the counts do not follow the year, the order or the cursor.
    for (const tab of tabs.slice(1)) for (const order of [null, platform === "bilibili" ? "views" as const : "likes" as const]) {
      const first = await page(worksQuery(platform, tab.value, order, 5), null);
      assert.deepEqual(first.yearCounts, yearCounts, `${platform} ${tab.value} ${order}`);
      if (first.nextCursor) assert.deepEqual((await page(worksQuery(platform, tab.value, order, 5), first.nextCursor)).yearCounts, yearCounts);
    }
  }
});

for (const [platform, order] of [["bilibili", "views"], ["xiaohongshu", "likes"]] as const) {
  test(`every year of ${platform}, newest first and by ${order}: all of that year, once each, none of another, in order`, async () => {
    const { yearCounts } = await page(worksQuery(platform, null, null, 5), null);
    const seen = new Set<string>();
    for (const tab of yearTabs(yearCounts).slice(1)) {
      for (const by of [null, order] as const) {
        const pages = await everyPage(platform, tab.value, by);
        const items = pages.flatMap(each => each.items);
        const ids = items.map(work => work.id);
        assert.equal(new Set(ids).size, ids.length, `no repeats in ${tab.value} ${by}`);
        assert.equal(items.length, tab.count, `nothing left out of ${tab.value} ${by}`);
        assert(pages.every(each => each.total === tab.count));
        assert(items.every(work => socialWorkPlatform(work) === platform && String(yearOf(work)) === tab.value), `only ${tab.value}`);
        if (by) {
          const metrics = items.map(work => socialWorkMetric(work, by));
          const known = metrics.filter((value): value is number => value !== null);
          assert.deepEqual(known, [...known].sort((a, b) => b - a), `${tab.value} by ${by}`);
          assert(metrics.indexOf(null) === -1 || metrics.slice(metrics.indexOf(null)).every(value => value === null), "unknown figures last");
        } else {
          const dates = items.map(socialWorkPublishedAt).filter((at): at is string => at !== null);
          assert.deepEqual(dates, [...dates].sort().reverse(), `${tab.value} newest first`);
        }
        for (const id of ids) seen.add(id);
      }
    }
    assert.equal(seen.size, yearTotal(yearCounts, null), "the years together are the whole platform");
  });
}

test("a cursor from one year is not taken by another year or by every year: the list starts over", async () => {
  const { yearCounts } = await page(worksQuery("bilibili", null, null, 5), null);
  const busiest = [...yearCounts.years].sort((a, b) => b.count - a.count)[0]!;
  const other = yearCounts.years.find(entry => entry.year !== busiest.year)!;
  const first = await page(worksQuery("bilibili", String(busiest.year), "views", 5), null);
  assert(first.nextCursor, "the demo's busiest year needs more than one page of five");
  for (const query of [worksQuery("bilibili", String(other.year), "views", 5), worksQuery("bilibili", null, "views", 5), worksQuery("bilibili", String(busiest.year), null, 5)]) {
    const params = new URLSearchParams({ ...query, cursor: first.nextCursor! });
    const response = await socialTimelineWorksResponse(new Request(`http://example.test/api/social/works/v2?${params}`), repo, () => true);
    assert.equal(response.status, 400, String(params));
    assert.equal((await response.json()).error.code, "INVALID_QUERY");
  }
});
