import assert from "node:assert/strict";
import test from "node:test";
import { createMockRepository } from "../adapters/mock-repository.ts";
import { contentFeatures } from "../config/features.ts";
import type { ContentKind, ListQuery, Page, StatusEntry } from "../contracts/content.ts";
import { ContentServiceError } from "../contracts/repository.ts";
import {
  createContentService,
  createFeatureGatedRepository,
} from "../src/lib/content/factory.ts";
import {
  contentDetailResponse,
  contentListResponse,
  courseTreeResponse,
} from "../src/lib/content/http.ts";
import { parseListQuery } from "../src/lib/content/query.ts";

const request = (query = "") => new Request(`https://example.test/api/content/status${query}`);
const invalidQuery = (error: unknown) => error instanceof ContentServiceError && error.code === "INVALID_QUERY";

test("default provider is explicitly mock and needs no credentials", async () => {
  const service = createContentService();
  assert.equal(service.provider, "mock");
  assert.equal((await service.repository.list("status")).items.length, 12);
});

test("Notion requires an adapter and never silently falls back", () => {
  assert.throws(() => createContentService({ provider: "notion" }), (error: unknown) => {
    assert.ok(error instanceof ContentServiceError);
    assert.equal(error.code, "MISCONFIGURED");
    assert.match(error.message, /not configured/i);
    return true;
  });
});

test("configured Notion adapter is used and failures propagate through its feature gate", async () => {
  const adapter = createMockRepository();
  adapter.list = async () => { throw new ContentServiceError("CONTENT_UNAVAILABLE", "Service unavailable."); };
  const service = createContentService({ provider: "notion", notionRepository: adapter });
  assert.equal(service.provider, "notion");
  await assert.rejects(service.repository.list("status"), (error: unknown) => error instanceof ContentServiceError && error.code === "CONTENT_UNAVAILABLE");
  assert.deepEqual((await service.repository.list("post")).items, []);
});

test("HTTP course tree validates parent boundary and query shape without caching", async () => {
  const repository = createContentService().repository;
  const response = await courseTreeResponse(new Request("https://example.test/api/study/demo101/tree"), "demo101", repository);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const data = (await response.json()).data;
  assert.equal(data.courseId, "mock-course-demo101");
  const foreign = await courseTreeResponse(new Request("https://example.test/api/study/demo101/tree?parentId=foreign"), "demo101", repository);
  assert.equal(foreign.status, 404);
  for (const query of ["?parentId=", "?parentId=x&parentId=y", "?limit=1"]) {
    assert.equal((await courseTreeResponse(new Request(`https://example.test/api/study/demo101/tree${query}`), "demo101", repository)).status, 400);
  }
});

test("unknown and empty provider values fail without echoing the configuration", () => {
  for (const provider of ["", "untrusted-provider-value", "MOCK", " mock "]) {
    assert.throws(() => createContentService({ provider }), (error: unknown) => {
      assert.ok(error instanceof ContentServiceError);
      assert.equal(error.code, "MISCONFIGURED");
      if (provider) assert.ok(!error.message.includes(provider));
      return true;
    });
  }
});

test("mock pagination preserves undated records and makes an opaque continuation", async () => {
  const repository = createContentService().repository;
  const first = await repository.list("status", { limit: 1 });
  assert.equal(first.items[0]?.slug, "a-small-progress");
  assert.equal(first.hasMore, true);
  assert.ok(first.nextCursor);
  const items = [...first.items];
  let cursor: string | null = first.nextCursor;
  while (cursor) {
    const page: Page<StatusEntry> = await repository.list("status", { limit: 1, cursor: cursor! });
    items.push(...page.items);cursor = page.nextCursor;
  }
  assert.equal(items.length, 36);
  assert.equal(new Set(items.map(i => i.id)).size, 36);
  assert.equal(items.at(-1)?.recordedAt, null);
  assert.equal(items.find(i => i.slug === "untitled")?.cover, null);
  const ascending = await repository.list("status", { order: "date-asc", limit: 50 });
  assert.equal(ascending.items.at(-1)?.recordedAt, null);
});

test("enabled mock filters retain course ratings, hierarchy, and null documents", async () => {
  const repository = createContentService().repository;
  const courses = await repository.list("course", { semester: "26S2" });
  assert.deepEqual(courses.items.map((item) => item.slug), ["demo101"]);
  assert.equal(courses.items[0]?.ratings.experience, null);
  assert.equal((await repository.list("status", { tag: "no-such-tag" })).items.length, 0);
  assert.equal((await repository.get("status", "untitled"))?.document, null);
  assert.equal((await repository.get("study-note", "communication-context"))?.item.parentId, "mock-note-week4");
  assert.equal(await repository.get("study-note", "missing"), null);
});

test("retained mock library filters remain usable for future sections", async () => {
  const repository = createMockRepository();
  const completed = await repository.list("game", { status: "completed", platform: "PlayStation" });
  assert.deepEqual(completed.items.map((item) => item.status).sort(), ["clear", "platinumed"]);
  const films = await repository.list("movie", { status: "watched", type: "电影" });
  assert.equal(films.items.length, 1);
  assert.equal(films.items[0]?.watchedDate, null);
  const books = await repository.list("book", { status: "wishlist" });
  assert.equal(books.items[0]?.personalRating, null);
});

test("disabled kinds expose neither lists nor details, and do not call their provider", async () => {
  const repository = createFeatureGatedRepository({
    ...createMockRepository(),
    async list() { throw new Error("Disabled list called provider"); },
    async get() { throw new Error("Disabled get called provider"); },
  });
  const disabled: ContentKind[] = ["post", "album", "book", "movie", "game"];
  for (const kind of disabled) {
    assert.deepEqual(await repository.list(kind), { items: [], nextCursor: null, hasMore: false, total: 0 });
    assert.equal(await repository.get(kind, "any-slug"), null);
  }
});

test("home summary applies feature gates to every retained section", async () => {
  const home = await createContentService().repository.getHome();
  assert.deepEqual(home.featuredPosts, []);
  assert.deepEqual(home.latestAlbums, []);
  assert.deepEqual(home.readingBooks, []);
  assert.deepEqual(home.playingGames, []);
  assert.equal(home.recentStatuses.length, 12);
  assert.equal(home.featuredCourses.length, 1);
});

test("future sections can be enabled through feature configuration", async () => {
  const repository = createContentService({ features: { ...contentFeatures, book: true } }).repository;
  assert.equal((await repository.list("book", { status: "wishlist" })).items.length, 8);
  assert.equal((await repository.getHome()).readingBooks.length, 3);
});

test("course subtree accepts only a parent belonging to the requested course", async () => {
  const repository = createContentService().repository;
  const tree = await repository.getCourseTree("demo101");
  assert.equal(tree?.nodes[0]?.id, "mock-note-week4");
  const subtree = await repository.getCourseTree("demo101", "mock-note-week4");
  assert.equal(subtree?.nodes[0]?.id, "mock-note-knowledge");
  assert.equal(await repository.getCourseTree("demo102", "mock-note-week4"), null);
  assert.equal(await repository.getCourseTree("demo101", "mock-note-workshop"), null);
  assert.equal(await repository.getCourseTree("demo101", "missing"), null);
  assert.equal(await repository.getCourseTree("missing"), null);
});

test("disabled study notes do not leak course tree descendants", async () => {
  const repository = createContentService({ features: { ...contentFeatures, "study-note": false } }).repository;
  assert.deepEqual(await repository.getCourseTree("demo101"), { courseId: "mock-course-demo101", nodes: [] });
  assert.equal(await repository.getCourseTree("demo101", "mock-note-week4"), null);
});

test("course tree with a mismatched course identity fails closed", async () => {
  const repository = createFeatureGatedRepository({
    ...createMockRepository(),
    async getCourseTree() { return { courseId: "wrong-course", nodes: [] }; },
  });
  await assert.rejects(repository.getCourseTree("demo101"), (error: unknown) =>
    error instanceof ContentServiceError && error.code === "CONTENT_UNAVAILABLE");
});

test("strict query parser accepts supported fields and numeric limits", () => {
  assert.deepEqual(parseListQuery("course", new URLSearchParams("semester=26S2&limit=2&order=title-asc")), {
    semester: "26S2", limit: 2, order: "title-asc",
  });
  assert.deepEqual(parseListQuery("status", new URLSearchParams("tag=study+notes&cursor=mock%3Astatus%3A1")), {
    tag: "study notes", cursor: "mock:status:1",
  });
});

test("strict query parser rejects unsupported, duplicate, empty, and malformed input", () => {
  const invalid = [
    "limit=0", "limit=51", "limit=-1", "limit=1.5", "limit=1e1", "limit=01", "limit=",
    "limit=2&limit=3", "unknown=1", "status=read", "semester=26S2", "type=note",
    "order=newest", "order=", "tag=", "tag=+", "tag=%00", "cursor=",
    `tag=${"x".repeat(257)}`, `cursor=${"x".repeat(1025)}`,
  ];
  for (const query of invalid) {
    assert.throws(() => parseListQuery("status", new URLSearchParams(query)), invalidQuery, query);
  }
  assert.throws(() => parseListQuery("game", new URLSearchParams("status=invalid")), invalidQuery);
});

test("facade validates direct callers and rejects malformed or cross-kind cursors", async () => {
  const repository = createContentService().repository;
  const invalid = [
    { limit: 0 }, { limit: Number.NaN }, { tag: "" }, { order: "wrong" }, { platform: "PC" },
    { cursor: "mock:course:1" }, { cursor: "mock:status:-1" }, { cursor: "mock:status:9007199254740992" },
  ];
  for (const query of invalid) {
    await assert.rejects(repository.list("status", query as unknown as ListQuery), invalidQuery);
  }
});

test("HTTP list returns data and no-store headers", async () => {
  const response = await contentListResponse(request("?limit=1"), "status", createContentService().repository);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const body = await response.json();
  assert.equal(body.data.items.length, 1);
  assert.equal(body.data.hasMore, true);
});

test("HTTP unknown and disabled kinds return 404 before touching provider data", async () => {
  const repository = {
    ...createMockRepository(),
    async list() { throw new Error("Should not read provider"); },
    async get() { throw new Error("Should not read provider"); },
  };
  for (const kind of ["unknown", "post", "album", "book", "movie", "game"]) {
    const list = await contentListResponse(request(), kind, repository);
    const detail = await contentDetailResponse(request(), kind, "anything", repository);
    for (const response of [list, detail]) {
      assert.equal(response.status, 404);
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      assert.equal((await response.json()).error.code, "NOT_FOUND");
    }
  }
});

test("HTTP invalid queries have a 400 error envelope", async () => {
  const response = await contentListResponse(request("?limit=2&limit=3"), "status", createContentService().repository);
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.deepEqual(Object.keys(body), ["error"]);
  assert.equal(body.error.code, "INVALID_QUERY");
});

test("HTTP misconfigured provider has a controlled 503 error envelope", async () => {
  const repository = {
    ...createMockRepository(),
    async list() {
      createContentService({ provider: "notion" });
      throw new Error("Unreachable");
    },
  };
  const response = await contentListResponse(request(), "status", repository);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "MISCONFIGURED");
});

test("HTTP unexpected provider errors hide private exception details", async () => {
  const repository = {
    ...createMockRepository(),
    async list() { throw new Error("private-source-or-credential"); },
  };
  const response = await contentListResponse(request(), "status", repository);
  assert.equal(response.status, 503);
  assert.ok(!(await response.text()).includes("private-source-or-credential"));
});

test("HTTP detail preserves missing values and uses 404 for a missing public record", async () => {
  const repository = createContentService().repository;
  const detail = await contentDetailResponse(request(), "status", "untitled", repository);
  assert.equal(detail.status, 200);
  const body = await detail.json();
  assert.equal(body.data.item.recordedAt, null);
  assert.equal(body.data.document, null);
  const missing = await contentDetailResponse(request(), "status", "missing", repository);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, "NOT_FOUND");
  const invalid = await contentDetailResponse(request("?limit=1"), "status", "untitled", repository);
  assert.equal(invalid.status, 400);
});

test("mock responses are detached from shared fixtures", async () => {
  const repository = createContentService().repository;
  const page = await repository.list("status");
  page.items[0]!.title = "Local mutation";
  assert.notEqual((await repository.list("status")).items[0]?.title, "Local mutation");
});

test("course directory uses validated metadata without fetching a body and applies feature gates", async () => {
  const adapter = createMockRepository();
  adapter.get = async () => { throw new Error("Unexpected full course body read"); };
  const repository = createFeatureGatedRepository(adapter);
  assert.equal((await repository.getCourseMetadata!("demo101"))?.id, "mock-course-demo101");
  assert.ok(await repository.getCourseTree("demo101"));
  assert.equal(await repository.getCourseMetadata!("missing"), null);
  const disabled = createFeatureGatedRepository(adapter, { ...contentFeatures, course: false });
  assert.equal(await disabled.getCourseMetadata!("demo101"), null);
  assert.equal(await disabled.getCourseTree("demo101"), null);
});

test("legacy course adapters retain their detail fallback when metadata capability is absent", async () => {
  const adapter = createMockRepository();
  adapter.getCourseMetadata = undefined;
  const original = adapter.get;
  let reads = 0;
  adapter.get = async (kind, slug) => { reads++; return original(kind, slug); };
  const repository = createFeatureGatedRepository(adapter);
  assert.ok(await repository.getCourseTree("demo101"));
  assert.equal(reads, 1);
  assert.equal((await repository.getCourseMetadata!("demo101"))?.kind, "course");
  assert.equal(reads, 2);
});
