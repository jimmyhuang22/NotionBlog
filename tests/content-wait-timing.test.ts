import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { fixtureItems } from "../fixtures/content.ts";
import { WEBSITE_SCHEMA_DIGEST } from "../contracts/website-sync.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";
import { SCOPED_SEARCH_SQL, SCOPED_VERSION_SQL } from "../src/server/database/scoped-reads.ts";
import { createWebsiteDatabaseRepository } from "../src/server/database/website-repository.ts";
import { createHomeFeedV2Repository } from "../src/lib/content/home-feed-v2-core.ts";
import { createSocialWorksRepository } from "../src/server/social/works-repository.ts";
import { exampleSocialWork } from "./helpers/home-feed-samples.ts";
import { contentReadTimingActive, measureContentReadAsync, traceContentRead, type ContentReadTiming } from "../src/server/content-read-timing.ts";

async function capture(work: (reports: ContentReadTiming[]) => Promise<void>) {
  const setting = process.env.CONTENT_READ_TIMING, info = console.info;
  const reports: ContentReadTiming[] = [];
  process.env.CONTENT_READ_TIMING = "enabled";
  console.info = (tag, payload) => { assert.equal(tag, "CONTENT_READ_TIMING"); reports.push(JSON.parse(payload)); };
  try { await work(reports); }
  finally { console.info = info; if (setting === undefined) delete process.env.CONTENT_READ_TIMING; else process.env.CONTENT_READ_TIMING = setting; }
}

test("scoped search timing keeps the same two SQL calls, results and final version check", async () => {
  const engine = await PGlite.create(), calls: string[] = [];
  const item = { ...structuredClone(fixtureItems.book[0]), title: "private-search-fixture", cover: null };
  const snapshot = { runId: "private-run", revision: "private-revision", schemaDigest: WEBSITE_SCHEMA_DIGEST,
    records: [{ item, document: null, parts: ["private-search-fixture"] }], links: [item.href], mediaIds: [] };
  const sql: SqlExecutor = { query: async <T>(text: string) => {
    calls.push(text);
    // Actual isolated SQL execution; no hosted database or credentials.
    return engine.query<T>("SELECT $1::jsonb AS result", [JSON.stringify(text === SCOPED_VERSION_SQL ? { ...snapshot, records: [] } : snapshot)]);
  } };
  try {
    const repo = createWebsiteDatabaseRepository(sql, { scoped: true });
    const plain = await repo.search!({ q: "private-search-fixture", kinds: ["book"] });
    const reports: ContentReadTiming[] = [];
    const timed = await traceContentRead("search", "unknown", () => repo.search!({ q: "private-search-fixture", kinds: ["book"] }), t => reports.push(t));
    assert.deepEqual(timed, plain);
    assert.equal(timed.items.length, 1);
    assert.deepEqual(calls, [SCOPED_SEARCH_SQL, SCOPED_VERSION_SQL, SCOPED_SEARCH_SQL, SCOPED_VERSION_SQL]);
    const phases = Object.fromEntries(reports[0].phases.map(p => [p.phase, p.calls]));
    assert.deepEqual(phases, { "search-read": 1, "dto-projection": 1, "search-text": 1, "search-match": 1, "search-version": 1 });
    assert.ok(!JSON.stringify(reports).includes("private-"));
  } finally { await engine.close(); }
});

test("search still rejects a withdrawal/version change with timing enabled", async () => {
  let calls = 0;
  const sql: SqlExecutor = { query: async <T>(text: string) => {
    calls++;
    return { rows: [{ result: { runId: "fixture", revision: text === SCOPED_VERSION_SQL ? "changed" : "initial",
      schemaDigest: WEBSITE_SCHEMA_DIGEST, records: [], links: [], mediaIds: [] } }] as T[] };
  } };
  const reports: ContentReadTiming[] = [], repo = createWebsiteDatabaseRepository(sql, { scoped: true });
  await assert.rejects(traceContentRead("search", "unknown", () => repo.search!({ q: "fixture" }), t => reports.push(t)), { code: "INVALID_QUERY" });
  assert.equal(calls, 2);
  assert.equal(reports[0].outcome, "error");
  assert.ok(reports[0].phases.some(p => p.phase === "search-version"));
});

test("home timing preserves parallel source reads and isolates nested social SQL phases", async () => capture(async reports => {
  const started: string[] = [];
  let contentDone!: () => void, socialDone!: () => void;
  const contentGate = new Promise<void>(resolve => { contentDone = resolve; });
  const socialGate = new Promise<void>(resolve => { socialDone = resolve; });
  const repo = createHomeFeedV2Repository({
    content: async () => { started.push("content"); await contentGate; return { version: "content", items: [] }; },
    social: () => traceContentRead("social-snapshot", "unknown", async () => {
      started.push("social");
      await measureContentReadAsync("database-roundtrip", () => socialGate);
      return { version: "social", items: [] };
    }), sources: { content: "mock", social: "database" }, timeZone: "UTC",
  });
  const work = repo.getPage();
  try { assert.deepEqual(started, ["content", "social"]); }
  finally { contentDone(); socialDone(); }
  assert.equal((await work).total, 0);
  const home = reports.find(t => t.operation === "home-feed")!, social = reports.find(t => t.operation === "social-snapshot")!;
  assert.equal(home.outcome, "ok");
  assert.deepEqual(home.phases.map(p => p.phase).sort(), ["home-compose", "home-content", "home-hydrate", "home-social"]);
  assert.deepEqual(social.phases.map(p => p.phase), ["database-roundtrip"]);
  assert.equal(contentReadTimingActive(), false);
}));

test("disabled social source is not read or reported as a home social phase", async () => capture(async reports => {
  const repo = createHomeFeedV2Repository({ content: async () => ({ version: "fixture", items: [] }),
    sources: { content: "mock", social: "disabled" }, timeZone: "UTC" });
  assert.equal((await repo.getPage()).total, 0);
  assert.equal(reports.length, 1);
  assert.ok(!reports[0].phases.some(p => p.phase === "home-social"));
}));

test("works diagnostics preserve filtered pagination and never record work titles or query values", async () => {
  const item = { ...exampleSocialWork("private-work-fixture", null), title: "private-title-fixture", collection: null };
  let reads = 0;
  const repo = createSocialWorksRepository(async () => { reads++; return { version: "private-version", items: [item] }; });
  const plain = await repo.listWorks({ limit: 1 });
  await capture(async reports => {
    assert.deepEqual(await repo.listWorks({ limit: 1 }), plain);
    assert.equal(reads, 2);
    assert.equal(reports.length, 1);
    assert.equal(reports[0].operation, "works");
    assert.deepEqual(reports[0].phases.map(p => p.phase), ["social-pagination"]);
    assert.ok(!JSON.stringify(reports).includes("private-"));
  });
});

test("invalid null queries are rejected before reading either repository", async () => capture(async reports => {
  let reads = 0;
  const home = createHomeFeedV2Repository({ content: async () => { reads++; return { version: "fixture", items: [] }; },
    sources: { content: "mock", social: "disabled" }, timeZone: "UTC" });
  const works = createSocialWorksRepository(async () => { reads++; return { version: "fixture", items: [] }; });
  await assert.rejects(home.getPage(null as never));
  await assert.rejects(works.listWorks(null as never));
  assert.equal(reads, 0);
  assert.equal(reports.length, 2);
  assert.ok(reports.every(t => t.outcome === "error"));
}));

test("nested source failures and a failing logger preserve the original provider error", async () => {
  const setting = process.env.CONTENT_READ_TIMING, info = console.info, original = Error("private-source-fixture");
  process.env.CONTENT_READ_TIMING = "enabled";
  console.info = () => { throw Error("private-logger-fixture"); };
  try {
    const repo = createSocialWorksRepository(() => traceContentRead("social-snapshot", "unknown", async () => { throw original; }));
    await assert.rejects(repo.listWorks(), error => error === original);
    assert.equal(contentReadTimingActive(), false);
  } finally { console.info = info; if (setting === undefined) delete process.env.CONTENT_READ_TIMING; else process.env.CONTENT_READ_TIMING = setting; }
});
