import test from "node:test";
import assert from "node:assert/strict";
import type { SocialTimelineWork, SocialWorksQuery } from "../contracts/social-timeline.ts";
import { ContentServiceError } from "../contracts/repository.ts";
import { demoSocialWorks } from "../fixtures/social-works.ts";
import { createMockSocialWorksRepository } from "../adapters/mock-social-works.ts";
import { createSocialWorksRepository } from "../src/server/social/works-repository.ts";
import { parseSocialWorksQuery, socialWorkMetric, socialWorkPlatform, socialWorkPublishedAt } from "../src/lib/content/social-works-query.ts";
import { socialTimelineWorksResponse, socialWorksResponse } from "../src/lib/content/social-http.ts";
import { createHomeFeedV2Repository } from "../src/lib/content/home-feed-v2-core.ts";

const invalid = (error: unknown) => error instanceof ContentServiceError && error.code === "INVALID_QUERY";
const base = () => structuredClone(demoSocialWorks);
function work(id: string, value: number | null, date: string | null): SocialTimelineWork {
  const item = base()[1]!;
  item.id = id; item.publications[0]!.metrics.views = value; item.publications[0]!.publishedAt = date;
  return item;
}

test("v2 rejects unsupported, repeated and malformed combinations before reading; v1 stays unchanged", async () => {
  let reads = 0;
  const repo = createSocialWorksRepository(async () => { reads++; return { version: "current", items: base() }; });
  for (const query of ["platform=other", "platform=", "order=views", "order=likes", "platform=xiaohongshu&order=views",
    "platform=bilibili&order=likes", "platform=bilibili&order=time", "platform=bilibili&order=", "platform=bilibili&platform=bilibili",
    "platform=bilibili&order=views&order=views", "account=123", "limit=0", "limit=21", "limit=1.0", "limit=90071992547409999", "cursor="]) {
    const response = await socialTimelineWorksResponse(new Request(`http://example.test/api/social/works/v2?${query}`), repo, () => true);
    assert.equal(response.status, 400, query);
    assert.equal((await response.json()).error.code, "INVALID_QUERY");
    assert.equal(response.headers.get("cache-control"), "private, no-store");
  }
  for (const query of [{ platform: "other" }, { order: "views" }, { secret: true }]) {
    await assert.rejects(repo.listWorks(query as SocialWorksQuery), invalid);
  }
  assert.equal(reads, 0);
  assert.equal((await socialWorksResponse(new Request("http://example.test/api/social/works?platform=bilibili"), repo, () => true)).status, 400);
  assert.equal(reads, 0);
  assert.deepEqual(parseSocialWorksQuery(new URLSearchParams("platform=bilibili&order=views&limit=20")), { platform: "bilibili", order: "views", limit: 20 });
});

test("mock and direct SSR repository queries filter the same total; cross-posts have one primary platform", async () => {
  const repo = createMockSocialWorksRepository();
  assert.equal((await repo.listWorks()).total, 56);
  for (const platform of ["bilibili", "xiaohongshu"] as const) {
    const page = await repo.listWorks({ platform, limit: 20 });
    assert.equal(page.total, 28); assert.equal(page.items.length, 20);
    assert(page.items.every(item => socialWorkPlatform(item) === platform));
    const response = await socialTimelineWorksResponse(new Request(`http://example.test/api/social/works/v2?platform=${platform}&limit=20`), repo, () => true);
    assert.equal(response.status, 200); assert.deepEqual((await response.json()).data, page);
    assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
  }
  const cross = demoSocialWorks.find(item => item.publications.length === 2)!;
  assert.equal(socialWorkPlatform(cross), "bilibili");
  assert.equal(socialWorkPlatform({ ...cross, publications: [...cross.publications].reverse() }), "bilibili");
  const page = await repo.listWorks({ platform: "bilibili", limit: 20 });
  const returned = page.items.find(item => item.id === cross.id)!;
  assert.deepEqual(returned.publications, cross.publications);
  returned.title = "changed by caller";
  assert.notEqual((await repo.listWorks({ platform: "bilibili", limit: 20 })).items.find(item => item.id === cross.id)!.title, returned.title);
});

test("metric sorting uses exact platform totals, then publication date and ID; unknown follows real zero", async () => {
  const items = [work("null", null, "2026-10-01T00:00:00.000Z"), work("zero", 0, null),
    work("tie-b", 50, "2026-09-01T00:00:00.000Z"), work("tie-a", 50, "2026-09-01T00:00:00.000Z"),
    work("newer", 50, "2026-09-02T00:00:00.000Z"), work("top", 100, null)];
  const repo = createSocialWorksRepository(async () => ({ version: "fixed", items }));
  assert.deepEqual((await repo.listWorks({ platform: "bilibili", order: "views", limit: 20 })).items.map(item => item.id),
    ["top", "newer", "tie-a", "tie-b", "zero", "null"]);
  const cross = items[1]!;
  cross.publications.push(structuredClone(demoSocialWorks[29]!.publications[0]!));
  cross.publications[1]!.metrics.likes = 999999;
  assert.equal(socialWorkMetric(cross, "views"), 0);
  cross.publications.push({ ...structuredClone(cross.publications[0]!), id: "second", metrics: { ...cross.publications[0]!.metrics, views: 12 } });
  assert.equal(socialWorkMetric(cross, "views"), 12);
  cross.publications[2]!.metrics.views = null; assert.equal(socialWorkMetric(cross, "views"), null);
  cross.publications[0]!.metrics.views = Number.MAX_SAFE_INTEGER; cross.publications[2]!.metrics.views = 1;
  assert.equal(socialWorkMetric(cross, "views"), null);
  const collection = base().find(item => item.collection)!;
  assert.equal(socialWorkMetric(collection, "views"), collection.collection!.metrics.views);
});

test("works date is latest member publication or primary-platform publication, never discovery or editorial time", async () => {
  const collection = base().find(item => item.collection)!;
  assert.equal(socialWorkPublishedAt(collection), collection.collection!.latestMemberPublishedAt);
  assert.notEqual(socialWorkPublishedAt(collection), collection.collection!.activity!.at);
  const single = work("single", 10, "2026-09-01T00:00:00.000Z");
  single.occurredAt = "2026-10-15T00:00:00.000Z";
  assert.equal(socialWorkPublishedAt(single), "2026-09-01T00:00:00.000Z");
  const repo = createSocialWorksRepository(async () => ({ version: "v", items: [collection, single] }));
  assert.deepEqual((await repo.listWorks()).items.map(item => item.id), [single.id, collection.id]);
  const home = createHomeFeedV2Repository({ content: async () => ({ version: "c", items: [] }),
    social: async () => ({ version: "s", items: [collection, single] }), sources: { content: "mock", social: "database" }, timeZone: "UTC" });
  assert.equal((await home.getPage()).items[0]!.id, `social:${single.id}`);
  // A noticed collection remains dated by activity on the homepage, even when no member date is known.
  single.occurredAt = "2026-01-01T00:00:00.000Z";
  assert.equal((await home.getPage()).items[0]!.id, `social:${collection.id}`);
  collection.collection!.latestMemberPublishedAt = null;
  assert.equal(socialWorkPublishedAt(collection), null);
  single.publications[0]!.publishedAt = null; assert.equal(socialWorkPublishedAt(single), null);
});

test("every supported mode traverses the complete mock set without duplicates, omissions or mutating the snapshot", async () => {
  const items = base(), before = structuredClone(items);
  const repo = createSocialWorksRepository(async () => ({ version: "v", items }));
  for (const query of [{}, { platform: "bilibili" }, { platform: "xiaohongshu" },
    { platform: "bilibili", order: "views" }, { platform: "xiaohongshu", order: "likes" }] as SocialWorksQuery[]) {
    const ids: string[] = []; let cursor: string | undefined; let total = 0;
    do {
      const page = await repo.listWorks({ ...query, limit: 7, ...(cursor ? { cursor } : {}) });
      total = page.total!; ids.push(...page.items.map(item => item.id)); cursor = page.nextCursor ?? undefined;
      assert.equal(page.hasMore, cursor !== undefined);
    } while (cursor);
    const expected = items.filter(item => query.platform === undefined || socialWorkPlatform(item) === query.platform).map(item => item.id);
    assert.equal(total, expected.length); assert.equal(ids.length, total); assert.equal(new Set(ids).size, total);
    assert.deepEqual([...ids].sort(), expected.sort());
  }
  assert.deepEqual(items, before);
});

test("filter/order changes and ordering-metric refresh invalidate old cursors; time paging survives statistics", async () => {
  let items = base(), version = "v";
  const repo = createSocialWorksRepository(async () => ({ version, items }));
  const query = { platform: "bilibili", order: "views", limit: 1 } as const;
  const hot = await repo.listWorks(query), time = await repo.listWorks({ platform: "bilibili", limit: 1 });
  assert(hot.nextCursor); assert(time.nextCursor);
  for (const changed of [{}, { platform: "bilibili" }, { platform: "xiaohongshu" }, { platform: "xiaohongshu", order: "likes" }] as SocialWorksQuery[]) {
    await assert.rejects(repo.listWorks({ ...changed, cursor: hot.nextCursor! }), invalid);
  }
  items = structuredClone(items); items.find(item => item.collection)!.collection!.metrics.views!++;
  await assert.rejects(repo.listWorks({ ...query, cursor: hot.nextCursor }), invalid);
  assert.equal((await repo.listWorks({ platform: "bilibili", limit: 1, cursor: time.nextCursor })).items.length, 1);
  const current = await repo.listWorks(query);
  version = "withdrawal"; items.pop();
  await assert.rejects(repo.listWorks({ ...query, cursor: current.nextCursor! }), invalid);
});

test("disabled and unavailable real readers never become mock success", async () => {
  let calls = 0;
  const repo = createSocialWorksRepository(async () => { calls++; throw new Error("private connection details"); });
  const request = new Request("http://example.test/api/social/works/v2?platform=bilibili&order=views");
  assert.equal((await socialTimelineWorksResponse(request, repo, () => false)).status, 404); assert.equal(calls, 0);
  const response = await socialTimelineWorksResponse(request, repo, () => true);
  assert.equal(response.status, 503); assert.equal(calls, 1); assert(!(await response.text()).includes("private connection"));
});
