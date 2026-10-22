import test from "node:test";
import assert from "node:assert/strict";
import type { FeedSnapshot, HomeFeedSources } from "../contracts/home-feed.ts";
import type { TimelineEvent } from "../contracts/website.ts";
import type { SocialWork } from "../contracts/social.ts";
import { ContentServiceError } from "../contracts/repository.ts";
import { defaultContentFeatures } from "../config/features.ts";
import { createContentService } from "../src/lib/content/factory.ts";
import { readTimelineSnapshot } from "../src/lib/content/website.ts";
import { createHomeFeedRepository } from "../src/lib/content/home-feed-core.ts";
import { homeFeedResponse } from "../src/lib/content/home-feed-http.ts";
import { createSocialRepository, readSocialSnapshot } from "../src/server/social/repository.ts";
import { exampleContent, exampleSocialWork } from "./helpers/home-feed-samples.ts";

const error = (code: string) => (e: unknown) => e instanceof ContentServiceError && e.code === code;
function scenario(content: TimelineEvent[], social: SocialWork[], timeZone = "UTC") {
  let contentVersion = "content-v1", socialVersion = "social-v1", contentReads = 0, socialReads = 0;
  const sources: HomeFeedSources = { content: "mock", social: "database" };
  const options = { content: async () => { contentReads++; return { items: content, version: contentVersion }; },
    social: async () => { socialReads++; return { items: social, version: socialVersion }; }, sources, timeZone };
  return { repo: createHomeFeedRepository(options), options, content, social,
    versions: (c: string, s: string) => { contentVersion = c; socialVersion = s; }, reads: () => ({ content: contentReads, social: socialReads }) };
}
test("mixed feed globally orders both complete sources with no missing or duplicate items across pages", async () => {
  const content = Array.from({ length: 45 }, (_, i) => exampleContent(`c${i}`, new Date(Date.UTC(2026, 0, 2, 0, i * 2)).toISOString()));
  const social = Array.from({ length: 30 }, (_, i) => exampleSocialWork(`s${i}`, new Date(Date.UTC(2026, 0, 2, 0, i * 3 + 1)).toISOString()));
  const s = scenario(content.reverse(), social.reverse()), seen: string[] = []; let cursor: string | undefined, requests = 0;
  do {
    const page = await s.repo.getPage({ limit: 7, ...(cursor ? { cursor } : {}) }); requests++;
    assert.equal(page.total, 75); assert.deepEqual(page.sources, { content: "mock", social: "database" });
    for (const item of page.items) { assert.ok(!seen.includes(item.id)); seen.push(item.id); }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  const all = await s.repo.getPage({ limit: 50 }); requests++;
  assert.deepEqual(all.items.map(i => i.id), seen.slice(0, 50)); assert.equal(seen.length, 75);
  assert.deepEqual(s.reads(), { content: requests, social: requests });
  const dates = seen.map(id => id.startsWith("content:") ? content.find(i => "content:" + i.id === id)!.occurredAt!.start : social.find(i => "social:" + i.id === id)!.occurredAt!);
  assert.deepEqual(dates, [...dates].sort().reverse());
});
test("mixed feed pages every item in a complete 243-work social directory without truncation", async () => {
  const s=scenario([exampleContent("a",null)],Array.from({length:243},(_,i)=>exampleSocialWork(`s${i}`,null)));
  const seen:string[]=[];let cursor:string|undefined;
  do {
    const page=await s.repo.getPage({limit:50,...(cursor?{cursor}:{})});assert.equal(page.total,244);
    seen.push(...page.items.map(i=>i.id));cursor=page.nextCursor??undefined;
  } while(cursor);
  assert.equal(seen.length,244);assert.equal(new Set(seen).size,244);
});
test("the site time zone, offset equivalence, pure dates and unknown dates preserve a deterministic order", async () => {
  const content = [exampleContent("pure", "2026-01-01", "date"), exampleContent("offset", "2026-01-01T12:00:00+11:00"),
    exampleContent("unknown", null), exampleContent("utc", "2026-01-01T02:00:00Z")];
  const social = [exampleSocialWork("previous-utc-day", "2025-12-31T23:30:00.000Z"), exampleSocialWork("next-local-day", "2026-01-01T14:00:00.000Z"), exampleSocialWork("unknown", null)];
  const page = await scenario(content, social, "Australia/Melbourne").repo.getPage();
  assert.deepEqual(page.items.map(i => i.id), ["social:next-local-day", "content:utc", "content:offset", "social:previous-utc-day", "content:pure", "content:unknown", "social:unknown"]);
  assert.deepEqual(page.items.find(i => i.id === "content:pure")!.occurredAt, { start: "2026-01-01", end: null, precision: "date" });
  assert.equal(page.items.find(i => i.id === "social:unknown")!.occurredAt, null);
  const equal = await scenario([exampleContent("x", "2026-01-01T12:00:00+11:00")], [exampleSocialWork("x", "2026-01-01T01:00:00.000Z")]).repo.getPage();
  assert.deepEqual(equal.items.map(i => i.id), ["content:x", "social:x"]);
});
test("one multi-platform work remains one card with source labels and exact/null/rounded counters unchanged", async () => {
  const work = exampleSocialWork("same-id", null), content = exampleContent("same-id", null);
  const page = await scenario([content], [work]).repo.getPage(); assert.equal(page.total, 2);
  const [c, s] = page.items; assert.equal(c.provider, "mock"); assert.equal(s.provider, "database");
  assert.equal(c.source, "content"); if (c.source !== "content") throw Error(); assert.deepEqual(c.event, content);
  assert.equal(s.source, "social"); if (s.source !== "social") throw Error(); assert.deepEqual(s.work, work);
  assert.equal(s.work.publications.length, 2); assert.equal(s.work.publications[0].metrics.likes, 0);
  assert.equal(s.work.publications[1].metrics.likes, null); assert.equal(s.work.publications[1].metricDisplay.likes, "1.2万");
  assert.equal(s.work.publications[1].originalUrl, null); assert.notEqual(c.id, s.id);
});
test("both source versions, enabled mode, time zone and page size bind the mixed cursor", async () => {
  const s = scenario([exampleContent("a", null), exampleContent("b", null)], [exampleSocialWork("w", null)]);
  const first = await s.repo.getPage({ limit: 1 }); assert.ok(first.nextCursor);
  const cursor = first.nextCursor!;
  for (const [c, v] of [["new-content", "social-v1"], ["content-v1", "new-metrics"], ["content-v1", "revoked"]]) {
    s.versions(c, v); await assert.rejects(s.repo.getPage({ limit: 1, cursor }), error("INVALID_QUERY"));
  }
  s.versions("content-v1", "social-v1");
  await assert.rejects(s.repo.getPage({ limit: 2, cursor }), error("INVALID_QUERY"));
  await assert.rejects(createHomeFeedRepository({ ...s.options, timeZone: "Australia/Melbourne" }).getPage({ limit: 1, cursor }), error("INVALID_QUERY"));
  const { social: _social, ...off } = s.options;
  await assert.rejects(createHomeFeedRepository({ ...off, sources: { content: "mock", social: "disabled" } }).getPage({ limit: 1, cursor }), error("INVALID_QUERY"));
  const ordinary = await createContentService().repository.getTimeline!({ limit: 1 });
  await assert.rejects(s.repo.getPage({ limit: 1, cursor: ordinary.nextCursor! }), error("INVALID_QUERY"));
  await assert.rejects(s.repo.getPage({ limit: 1, cursor: "bad" }), error("INVALID_QUERY"));
});
test("social disabled performs no social read; an enabled failure cannot become a content-only success", async () => {
  let reads = 0;
  const content = async () => ({ version: "c", items: [exampleContent("a", null)] });
  const off = createHomeFeedRepository({ content, sources: { content: "notion", social: "disabled" }, timeZone: "UTC" });
  assert.equal((await off.getPage()).items[0].provider, "notion"); assert.equal(reads, 0);
  const on = createHomeFeedRepository({ content, social: async () => { reads++; throw Error("private SQL credentials"); }, sources: { content: "mock", social: "database" }, timeZone: "UTC" });
  const response = await homeFeedResponse(new Request("http://example.test/api/home/feed"), on); assert.equal(response.status, 503); assert.equal(reads, 1);
  assert.equal((await response.text()).includes("private SQL"), false);
  const failedContent = createHomeFeedRepository({ content: async () => { throw Error("private source"); }, social: async () => ({ version: "s", items: [] }), sources: { content: "database", social: "database" }, timeZone: "UTC" });
  assert.equal((await homeFeedResponse(new Request("http://example.test/api/home/feed"), failedContent)).status, 503);
  const missingSnapshot = createHomeFeedRepository({ content, social: async () => undefined as unknown as FeedSnapshot<SocialWork>, sources: { content: "mock", social: "database" }, timeZone: "UTC" });
  await assert.rejects(missingSnapshot.getPage(), error("CONTENT_UNAVAILABLE"));
});
test("HTTP validates unsupported/repeated/invalid queries before reads, preserves busy errors and prevents caching", async () => {
  let reads = 0; const repo = createHomeFeedRepository({ content: async () => { reads++; return { version: "c", items: [] }; }, sources: { content: "mock", social: "disabled" }, timeZone: "UTC" });
  for (const query of ["limit=0", "limit=51", "limit=01", "limit=1&limit=2", "cursor=", "q=private", "all=true", "cursor=%20"]) {
    const response = await homeFeedResponse(new Request("http://example.test/api/home/feed?" + query), repo); assert.equal(response.status, 400); assert.equal(reads, 0);
    assert.equal(response.headers.get("Cache-Control"), "private, no-store"); assert.equal(response.headers.get("X-Robots-Tag"), "noindex, nofollow");
  }
  const response = await homeFeedResponse(new Request("http://example.test/api/home/feed"), repo); assert.equal(response.status, 200); assert.equal(reads, 1);
  assert.deepEqual((await response.json()).data, { items: [], hasMore: false, total: 0, nextCursor: null, sources: { content: "mock", social: "disabled" } });
  const busy = { getPage: async () => { throw new ContentServiceError("RATE_LIMITED", "private detail"); } };
  const failure = await homeFeedResponse(new Request("http://example.test/api/home/feed"), busy); assert.equal(failure.status, 503); assert.equal((await failure.json()).error.code, "RATE_LIMITED");
});
test("server content snapshot shares feature gating and reads once, including documents only for enabled timeline sections", async () => {
  const repository = createContentService().repository; let calls = 0;
  const original = repository.readSnapshot!; repository.readSnapshot = async (kinds, docs) => {
    calls++; assert.deepEqual(kinds, ["status"]); assert.equal(docs, true); return original(kinds, docs);
  };
  const snapshot = await readTimelineSnapshot(repository, defaultContentFeatures, "UTC"); assert.equal(calls, 1);
  assert.ok(snapshot.items.length); assert.equal(snapshot.items.some(i => i.type !== "status"), false);
  const all = await repository.getTimeline!({ limit: 50 }); assert.deepEqual(snapshot.items, all.items);
});
test("social snapshot and ordinary social pagination share the same validated one-statement read", async () => {
  let queries = 0;
  const sql = { query: async <T>() => { queries++; return { rows: [] as T[] }; } };
  const snapshot = await readSocialSnapshot(sql); assert.equal(queries, 1); assert.deepEqual(snapshot.items, []);
  assert.equal((await createSocialRepository(sql).listWorks()).total, 0); assert.equal(queries, 2);
});
test("duplicate identities, oversized snapshots and invalid dates fail clearly without truncation", async () => {
  const build = (content: FeedSnapshot<TimelineEvent>, social?: FeedSnapshot<SocialWork>) => createHomeFeedRepository({ content: async () => content,
    ...(social ? { social: async () => social } : {}), sources: { content: "mock", social: social ? "database" : "disabled" }, timeZone: "UTC" });
  const duplicate = exampleContent("duplicate", null);
  for (const snapshot of [{ version: "c", items: [duplicate, duplicate] }, { version: "", items: [] },
    { version: "c", items: [exampleContent("bad", "2026-02-30", "date")] },
    { version: "c", items: [exampleContent("bad", "2026-02-30T00:00:00Z")] },
    { version: "c", items: Array.from({ length: 20001 }, (_, i) => exampleContent(String(i), null)) }]) await assert.rejects(build(snapshot).getPage(), error("CONTENT_UNAVAILABLE"));
  await assert.rejects(build({ version: "c", items: [] }, { version: "s", items: Array.from({ length: 501 }, (_, i) => exampleSocialWork(String(i), null)) }).getPage(), error("CONTENT_UNAVAILABLE"));
});
