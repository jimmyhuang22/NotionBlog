import test from "node:test";
import assert from "node:assert/strict";
import type { SocialTimelineWork, SocialWorksQuery } from "../contracts/social-timeline.ts";
import { createSocialWorksRepository } from "../src/server/social/works-repository.ts";
import { createHomeFeedV2Repository } from "../src/lib/content/home-feed-v2-core.ts";
import { hydrateSelectedSocialCovers } from "../src/server/social/cover-hydration.ts";
import { exampleContent, exampleSocialWork } from "./helpers/home-feed-samples.ts";

const cover = { id: `s1.${"a".repeat(64)}`, src: `/media/social/s1.${"a".repeat(64)}`, alt: "", width: 640, height: 360 };
function works(count = 30): SocialTimelineWork[] {
  return Array.from({ length: count }, (_, i) => {
    const work = { ...exampleSocialWork(`work-${String(i).padStart(3,"0")}`, new Date(Date.UTC(2026,0,1,i)).toISOString()), collection: null };
    for (const p of work.publications) { p.metrics.views = 100 - i; p.metrics.likes = i; }
    work.publications = [work.publications[i % 2]];
    return work;
  });
}
const decorate = (items: SocialTimelineWork[]) => items.map(work => ({ ...work, cover }));

test("selected cover hydration preserves works filters, ordering, all pages and cursors", async () => {
  for (const filter of [{}, { platform: "bilibili", order: "views" }, { platform: "xiaohongshu", order: "likes" }] as SocialWorksQuery[]) {
    const items = works(), selections: string[][] = [];
    let reads = 0;
    const eager = createSocialWorksRepository(async () => ({ version: "fixture", items: decorate(items) }));
    const selected = createSocialWorksRepository(async () => {
      reads++;
      return { version: "fixture", items, hydrateCovers: async page => { selections.push(page.map(w=>w.id)); return decorate(page); } };
    });
    let cursor: string | undefined, pages = 0;
    do {
      const query = { ...filter, limit: 7, ...(cursor ? { cursor } : {}) };
      const before = await eager.listWorks(query), after = await selected.listWorks(query);
      assert.deepEqual(after, before);
      assert.deepEqual(selections.at(-1), after.items.map(w=>w.id));
      assert.ok(after.items.length <= 7);
      assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort());
      cursor = after.nextCursor ?? undefined; pages++;
    } while (cursor);
    assert.equal(reads, pages); assert.equal(selections.length, pages);
    assert.equal(selections.flat().length, filter.platform ? items.length / 2 : items.length);
  }
});

test("home hydrates only selected social items while content hydration stays parallel", async () => {
  const items = works(3), events = [exampleContent("content", "2026-01-01T01:30:00.000Z")];
  const options = { content: async () => ({ version: "content", items: events }),
    sources: { content: "mock" as const, social: "database" as const }, timeZone: "UTC" };
  const eager = createHomeFeedV2Repository({ ...options, social: async () => ({ version: "social", items: decorate(items) }) });
  const calls: string[] = [], selected: string[][] = [];
  let finishContent!: () => void, finishCovers!: () => void;
  const contentGate = new Promise<void>(resolve => { finishContent = resolve; });
  const coversGate = new Promise<void>(resolve => { finishCovers = resolve; });
  const repo = createHomeFeedV2Repository({ ...options,
    hydrateContent: async page => { calls.push("content"); await contentGate; return page; },
    social: async () => ({ version: "social", items, hydrateCovers: async page => {
      calls.push("covers"); selected.push(page.map(w=>w.id)); await coversGate; return decorate(page);
    } }),
  });
  const pending = repo.getPage({ limit: 2 });
  // Both hydrators must start without waiting for the other.
  try {
    for (let i=0;i<12 && calls.length<2;i++) await Promise.resolve();
    assert.deepEqual(calls, ["content", "covers"]);
  } finally { finishContent(); finishCovers(); }
  const page = await pending;
  assert.deepEqual(page, await eager.getPage({ limit: 2 }));
  assert.deepEqual(selected, [page.items.flatMap(item=>item.source==="social"?[item.work.id]:[])]);
  assert.equal(selected[0].length, 1);
});

test("content-only and empty selections perform no cover hydration", async () => {
  let coverReads = 0, reads = 0;
  const social = async () => { reads++; return { version: "social", items: works(1),
    hydrateCovers: async (page:SocialTimelineWork[]) => { coverReads++; return decorate(page); } }; };
  const home = createHomeFeedV2Repository({ content: async () => ({ version: "content", items: [exampleContent("newer","2026-02-01T00:00:00.000Z")] }),
    social, sources: { content: "mock", social: "database" }, timeZone: "UTC" });
  assert.equal((await home.getPage({ limit: 1 })).items[0].source, "content");
  const repo = createSocialWorksRepository(async () => ({ version: "empty", items: [], hydrateCovers: async page => { coverReads++; return page; } }));
  assert.equal((await repo.listWorks()).items.length, 0);
  assert.equal(coverReads, 0); assert.equal(reads, 1);
});

test("invalid queries and stale cursors do not run a cover query", async () => {
  let version = "initial", reads = 0, covers = 0;
  const repo = createSocialWorksRepository(async () => { reads++; return { version, items: works(2),
    hydrateCovers: async page => { covers++; return decorate(page); } }; });
  await assert.rejects(repo.listWorks(null as never)); assert.equal(reads, 0);
  const first = await repo.listWorks({ limit: 1 }); assert(first.nextCursor); assert.equal(covers, 1);
  version = "withdrawn";
  await assert.rejects(repo.listWorks({ limit: 1, cursor: first.nextCursor! }), { code: "INVALID_QUERY" });
  assert.equal(covers, 1); assert.equal(reads, 2);
});

test("hydration cannot remove, reorder or modify selected work metadata, including in-place mutation", async () => {
  for (const tamper of [
    (items: SocialTimelineWork[]) => items.slice(0,1),
    (items: SocialTimelineWork[]) => [...items].reverse(),
    (items: SocialTimelineWork[]) => items.map(w=>({...w,title:"changed"})),
    (items: SocialTimelineWork[]) => { items[0].publications[0].metrics.views=10000; return items; },
    (items: SocialTimelineWork[]) => { items.splice(0); return items; },
  ]) {
    const items = works(2);
    await assert.rejects(hydrateSelectedSocialCovers({ version: "fixture", items, hydrateCovers: async page=>tamper(page) }, items), { code: "CONTENT_UNAVAILABLE" });
  }
  const original = Error("fixture provider error");
  const repo = createSocialWorksRepository(async () => ({ version: "fixture", items: works(1), hydrateCovers: async ()=>{throw original;} }));
  await assert.rejects(repo.listWorks(), e=>e===original);
});

test("each request receives its own hydration capability rather than cached cover results", async () => {
  let reads = 0;
  const captured: number[] = [];
  const repo = createSocialWorksRepository(async () => {
    const request = ++reads;
    return { version: "fixture", items: works(1), hydrateCovers: async page => { captured.push(request); return request===1?decorate(page):page; } };
  });
  assert((await repo.listWorks()).items[0].cover);
  assert.equal((await repo.listWorks()).items[0].cover, null);
  assert.deepEqual(captured,[1,2]);
});
