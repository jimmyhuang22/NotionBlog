import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { gzipSync, brotliCompressSync } from "node:zlib";
import type { ContentByKind, ContentDetail, ContentKind, Course, CourseTree, ListQuery, Page, StatusEntry, StudyNote } from "../contracts/content.ts";
import { ContentServiceError, type ContentRepository } from "../contracts/repository.ts";
import { SYNC_SCHEMA_DIGEST, type StoredMedia } from "../contracts/sync.ts";
import { contentDetailResponse, contentListResponse, courseTreeResponse, statusYearsResponse } from "../src/lib/content/http.ts";
import { statusPreview, statusYear, statusYears } from "../src/lib/content/status.ts";
import { databaseMediaResponse } from "../src/server/database/media.ts";
import { mediaIdentity } from "../src/server/database/validation.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";
import { checkWebsite, parseWebsiteCheckArgs, websiteOrigin } from "../scripts/check-website.ts";

const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZL98AAAAASUVORK5CYII=", "base64");
const sha = createHash("sha256").update(bytes).digest("hex");
const media: StoredMedia = { assetId: mediaIdentity("status-a", "body", sha), ownerPageId: "status-a", objectKey: `sha256/${sha}`, sha256: sha, byteSize: bytes.length, mime: "image/png", width: 1, height: 1 };
const image = { id: media.assetId, src: `/media/${media.assetId}`, alt: "Fixture", width: 1, height: 1 };
const empty = { blocks: [], toc: [], completeness: "complete" as const };
function base(id: string, kind: "status" | "course" | "study-note") {
  return { id, kind, slug: id, href: kind === "status" ? `/status#${id}` : kind === "course" ? `/study/${id}` : `/study/course-a/notes/${id}`, title: "Private fixture title", summary: null, tags: [], cover: null, updatedAt: null };
}
const statuses: StatusEntry[] = [
  { ...base("status-a", "status"), kind: "status", recordedAt: { start: "2025-12-31T14:30:00Z", end: null, precision: "datetime" }, text: [{ text: "Private fixture body" }] },
  { ...base("status-b", "status"), kind: "status", recordedAt: { start: "2025-12-31", end: null, precision: "date" }, text: [] },
  { ...base("status-c", "status"), kind: "status", recordedAt: null, text: [] },
];
const course: Course = { ...base("course-a", "course"), kind: "course", code: "FIX", semester: null, ratings: { experience: null, usefulness: null, recommendation: null, difficulty: null } };
const notes: StudyNote[] = [
  { ...base("note-a", "study-note"), kind: "study-note", courseId: course.id, parentId: null, noteType: "note", date: null, breadcrumbs: [] },
  { ...base("note-b", "study-note"), kind: "study-note", courseId: course.id, parentId: "note-a", noteType: "summary", date: null, breadcrumbs: [{ title: course.title, href: course.href }, { title: "Parent", href: "/study/course-a/notes/note-a" }] },
];
const tree: CourseTree = { courseId: course.id, nodes: [{ id: "note-a", title: "Parent", href: notes[0].href, hasChildren: true, children: [{ id: "note-b", title: "Child", href: notes[1].href, hasChildren: false, children: [] }] }] };

function repository(): ContentRepository {
  return {
    async list<K extends ContentKind>(kind: K, query: ListQuery = {}): Promise<Page<ContentByKind[K]>> {
      const all = kind === "status" ? statuses.filter(item => query.year === undefined || statusYear(item, "Australia/Melbourne") === (query.year === "undated" ? null : query.year)).map(item => statusPreview(item, empty)) : kind === "course" ? [course] : kind === "study-note" ? notes : [];
      if (kind === "status") (all as StatusEntry[]).forEach(item => { if (item.id === "status-a") item.images = [image]; });
      const offset = query.cursor === "fixture-next" ? 2 : 0;
      const selected = all.slice(offset, offset + (query.limit ?? 12));
      const hasMore = offset + selected.length < all.length;
      return { items: selected as ContentByKind[K][], hasMore, nextCursor: hasMore ? "fixture-next" : null };
    },
    async get<K extends ContentKind>(kind: K, slug: string): Promise<ContentDetail<ContentByKind[K]> | null> {
      const item = kind === "status" ? statuses.find(item => item.slug === slug) : kind === "course" && slug === course.slug ? course : kind === "study-note" ? notes.find(item => item.slug === slug) : undefined;
      return item ? { item: structuredClone(item) as ContentByKind[K], document: item.id === "status-a" ? { ...empty, blocks: [{ id: "block-image", type: "image", image, caption: [] }] } : empty } : null;
    },
    async getStatusYears() { return statusYears(statuses, "Australia/Melbourne"); },
    async getCourseTree(slug, parentId) {
      if (slug !== course.slug) return null;
      if (parentId === undefined) return structuredClone(tree);
      if (parentId === "note-a") return { courseId: course.id, nodes: structuredClone(tree.nodes[0].children!) };
      if (parentId === "note-b") return { courseId: course.id, nodes: [] };
      return null;
    },
    async getHome() { return { featuredPosts: [], recentStatuses: [], latestAlbums: [], readingBooks: [], playingGames: [], featuredCourses: [] }; },
  };
}

type Rewrite = (url: URL, response: Response) => Promise<Response> | Response;
function transport(repo: ContentRepository = repository(), rewrite?: Rewrite) {
  const requests: { url: URL; init: RequestInit | undefined }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push({ url, init });
    assert.equal(url.origin, "http://127.0.0.1:3000");
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.cache, "no-store");
    assert.equal(init?.credentials, "omit");
    assert.ok(init?.signal);
    assert.equal(new Headers(init?.headers).get("Authorization"), null);
    const request = new Request(url, init);
    const parts = url.pathname.split("/").filter(Boolean);
    let response: Response;
    if (url.pathname === "/api/status/years") response = await statusYearsResponse(request, repo);
    else if (parts[0] === "api" && parts[1] === "content") response = parts.length === 3 ? await contentListResponse(request, parts[2], repo) : await contentDetailResponse(request, parts[2], parts[3], repo);
    else if (parts[0] === "api" && parts[1] === "study" && parts[3] === "tree") response = await courseTreeResponse(request, parts[2], repo);
    else if (parts[0] === "media") {
      const db: SqlExecutor = { async query<T>() { return { rows: [{ result: { schemaDigest: SYNC_SCHEMA_DIGEST, media: parts[1] === media.assetId ? media : null } } as T] }; } };
      response = await databaseMediaResponse(parts[1], db, () => ({ read: async () => bytes, put: async () => { assert.fail("Acceptance must never write storage"); } }));
    } else assert.fail("Unexpected route");
    return rewrite ? rewrite(url, response) : response;
  };
  return { fetch: fetcher, requests };
}

async function changedJson(response: Response, change: (value: any) => void): Promise<Response> {
  const body = await response.json();
  change(body);
  return Response.json(body, { status: response.status, headers: response.headers });
}

test("representative acceptance uses real HTTP envelopes, course ownership and verified database media without logging content", async () => {
  const network = transport();
  const report = await checkWebsite({ fetch: network.fetch });
  assert.equal(report.passed, true, JSON.stringify(report));
  assert.equal(report.providerVerified, false);
  assert.ok(report.requests <= 24);
  for (const name of ["status-pagination", "status-year-filter", "status-undated-filter", "course-tree", "note-detail-ownership", "course-parent-tree", "representative-media", "unknown-parent-denied", "unknown-media-denied"]) assert.equal(report.checks.find(check => check.name === name)?.outcome, "passed");
  assert.equal(report.checks.find(check => check.name === "representative-media")?.count, bytes.length);
  const text = JSON.stringify(report);
  for (const secret of ["Private fixture", course.id, notes[1].id, media.assetId, sha, "Australia/Melbourne", "127.0.0.1"]) assert.ok(!text.includes(secret));
  assert.ok(network.requests.some(request => request.url.searchParams.get("year") === "2026"));
  assert.ok(network.requests.some(request => request.url.searchParams.get("year") === "undated"));
});

test("unpublished mode verifies controlled 503/no-store, refuses mock success and does not infer provider from an error", async () => {
  const broken = repository();
  broken.list = async () => { throw new ContentServiceError("CONTENT_UNAVAILABLE", "Database content is temporarily unavailable."); };
  broken.getStatusYears = async () => { throw Error("Private driver credential"); };
  const report = await checkWebsite({ fetch: transport(broken).fetch, expectUnavailable: true });
  assert.equal(report.passed, true);
  assert.equal(report.requests, 4);
  assert.equal(report.providerVerified, false);
  assert.ok(!JSON.stringify(report).includes("Private"));
  const fallback = await checkWebsite({ fetch: transport().fetch, expectUnavailable: true });
  assert.equal(fallback.passed, false);
  assert.equal(fallback.checks.filter(check => check.reason === "HTTP_STATUS").length, 4);
});

test("acceptance detects stale caching, leaked non-contract fields and error/data confusion without echoing responses", async (t) => {
  const broken = repository();
  broken.list = async () => { throw Error("Private fixture driver"); };
  broken.getStatusYears = async () => { throw Error("Private fixture driver"); };
  for (const variant of ["cache", "extra", "data"] as const) await t.test(variant, async () => {
    const network = transport(broken, async (_url, response) => {
      if (variant === "cache") { response.headers.set("Cache-Control", "public, max-age=3600"); return response; }
      return changedJson(response, body => { body[variant === "extra" ? "privateSnapshot" : "data"] = "Private response credential"; });
    });
    const report = await checkWebsite({ fetch: network.fetch, expectUnavailable: true });
    assert.equal(report.passed, false);
    assert.ok(report.checks.every(check => check.reason === (variant === "cache" ? "CACHE_HEADERS" : "INVALID_DTO")));
    assert.ok(!JSON.stringify(report).includes("Private"));
  });
});

test("recognized error codes cannot conceal private upstream messages", async () => {
  const broken = repository();
  broken.list = async () => { throw new ContentServiceError("CONTENT_UNAVAILABLE", "Private fixture credential and query"); };
  broken.getStatusYears = async () => { throw new ContentServiceError("MISCONFIGURED", "Private fixture database URL"); };
  const report = await checkWebsite({ fetch: transport(broken).fetch, expectUnavailable: true });
  assert.equal(report.passed, false);
  assert.ok(report.checks.every(check => check.reason === "INVALID_DTO"));
  assert.ok(!JSON.stringify(report).includes("Private fixture"));
});

test("compressed Fetch responses use decoded byte limits rather than encoded Content-Length", async t => {
  const text = JSON.stringify({ error: { code: "CONTENT_UNAVAILABLE", message: "Content is temporarily unavailable." } });
  for (const [encoding, encoded] of [["gzip", gzipSync(text)], ["br", brotliCompressSync(text)]] as const) {
    await t.test(encoding, async () => {
      assert.notEqual(encoded.length, Buffer.byteLength(text));
      // This is the native Fetch shape after HTTP decompression: decoded body
      // bytes with the origin's encoded Content-Length/Content-Encoding headers.
      const report = await checkWebsite({ expectUnavailable: true, fetch: async () => new Response(text, {
        status: 503, headers: { "Content-Type": "application/json", "Cache-Control": "no-store",
          "Content-Encoding": encoding, "Content-Length": String(encoded.length) },
      }) });
      assert.equal(report.passed, true); assert.equal(report.requests, 4);
    });
  }
  await t.test("decoded oversize still fails", async () => {
    const report = await checkWebsite({ expectUnavailable: true, fetch: async () => new Response(new Uint8Array(8 * 1024 * 1024 + 1), {
      status: 503, headers: { "Content-Type": "application/json", "Cache-Control": "no-store",
        "Content-Encoding": "gzip", "Content-Length": "1024" },
    }) });
    assert.equal(report.passed, false);
    assert.ok(report.checks.every(check => check.reason === "BODY_LIMIT"));
  });
});

test("sampled pagination and year filters fail when responses overlap or contain the wrong date", async (t) => {
  for (const variant of ["pagination", "filter", "phantom-next"] as const) await t.test(variant, async () => {
    const network = transport(repository(), async (url, response) => {
      if (variant === "pagination" && url.searchParams.has("cursor")) return changedJson(response, body => { body.data.items = [statusPreview(statuses[0], empty)]; });
      if (variant === "phantom-next" && url.searchParams.has("cursor")) return changedJson(response, body => { body.data.hasMore = true; body.data.nextCursor = "fixture-phantom"; });
      if (variant === "filter" && url.searchParams.get("year") === "undated") return changedJson(response, body => { body.data.items = [statusPreview(statuses[0], empty)]; });
      return response;
    });
    const report = await checkWebsite({ fetch: network.fetch });
    assert.equal(report.passed, false);
    assert.equal(report.checks.find(check => check.name === (variant === "filter" ? "status-undated-filter" : "status-pagination"))?.reason, variant === "filter" ? "YEAR_FILTER" : "PAGINATION");
  });
});

test("available acceptance rejects an empty note list even when tree and note detail are readable", async () => {
  const network = transport(repository(), async (url, response) => url.pathname === "/api/content/study-note"
    ? changedJson(response, body => { body.data = { items: [], hasMore: false, nextCursor: null }; }) : response);
  const report = await checkWebsite({ fetch: network.fetch });
  assert.equal(report.passed, false);
  assert.equal(report.checks.find(check => check.name === "note-list")?.reason, "MISSING_SAMPLE");
  assert.equal(report.checks.find(check => check.name === "note-detail-ownership")?.outcome, "passed");
});

test("first Status page count and continuation agree with the year totals", async t => {
  for (const variant of ["short-page", "unexpected-continuation"] as const) await t.test(variant, async () => {
    const network = transport(repository(), async (url, response) => {
      if (variant === "unexpected-continuation" && url.pathname === "/api/status/years") return changedJson(response, body => { body.data.undatedCount = 0; });
      if (variant === "short-page" && url.pathname === "/api/content/status" && !url.searchParams.has("cursor") && !url.searchParams.has("year")) {
        return changedJson(response, body => { body.data.items = body.data.items.slice(0, 1); });
      }
      return response;
    });
    const report = await checkWebsite({ fetch: network.fetch });
    assert.equal(report.passed, false);
    assert.equal(report.checks.find(check => check.name === "status-list")?.reason, "YEAR_FILTER");
  });
});

test("tree and note identity must match the selected course and parent before media is sampled", async (t) => {
  for (const variant of ["tree", "parent", "note"] as const) await t.test(variant, async () => {
    const network = transport(repository(), async (url, response) => {
      if (variant === "tree" && url.pathname.endsWith("/tree") && !url.search) return changedJson(response, body => { body.data.courseId = "foreign-course"; });
      if (url.pathname === "/api/content/study-note/note-b") return changedJson(response, body => {
        if (variant === "parent") body.data.item.parentId = null;
        if (variant === "note") body.data.item.id = "foreign-note";
      });
      return response;
    });
    const report = await checkWebsite({ fetch: network.fetch });
    assert.equal(report.passed, false);
    assert.equal(report.checks.find(check => check.name === (variant === "tree" ? "course-tree" : "note-detail-ownership"))?.reason, "OWNERSHIP");
  });
});

test("external media DTOs and redirects never cause requests outside the selected origin", async (t) => {
  await t.test("external DTO", async () => {
    const network = transport(repository(), async (url, response) => url.pathname === "/api/content/status" ? changedJson(response, body => { body.data.items[0].images[0].src = "https://private.example.test/image?token=fixture"; }) : response);
    const report = await checkWebsite({ fetch: network.fetch });
    assert.equal(report.passed, false);
    assert.equal(report.checks.find(check => check.name === "status-list")?.reason, "INVALID_DTO");
    assert.ok(network.requests.every(request => request.url.origin === "http://127.0.0.1:3000"));
    assert.ok(!JSON.stringify(report).includes("private.example"));
  });
  await t.test("media redirect", async () => {
    const network = transport(repository(), (url, response) => url.pathname === image.src ? new Response(null, { status: 302, headers: { "Cache-Control": "no-store", Location: "https://private.example.test/image?token=fixture" } }) : response);
    const report = await checkWebsite({ fetch: network.fetch });
    assert.equal(report.checks.find(check => check.name === "representative-media")?.reason, "HTTP_STATUS");
    assert.ok(network.requests.every(request => request.url.origin === "http://127.0.0.1:3000"));
  });
});

test("media acceptance rejects wrong magic, MIME, nosniff and declared byte length", async (t) => {
  for (const variant of ["magic", "mime", "nosniff", "length"] as const) await t.test(variant, async () => {
    const network = transport(repository(), (url, response) => {
      if (url.pathname !== image.src) return response;
      const headers = new Headers(response.headers);
      if (variant === "mime") headers.set("Content-Type", "image/jpeg");
      if (variant === "nosniff") headers.delete("X-Content-Type-Options");
      if (variant === "length") headers.set("Content-Length", String(bytes.length + 1));
      return new Response(variant === "magic" ? Buffer.alloc(bytes.length) : bytes, { headers });
    });
    const report = await checkWebsite({ fetch: network.fetch });
    assert.equal(report.passed, false);
    assert.equal(report.checks.find(check => check.name === "representative-media")?.reason, variant === "length" ? "BODY_LIMIT" : "MEDIA_BYTES");
  });
});

test("body and time budgets are enforced even for streamed bodies or an injected fetch ignoring abort", async (t) => {
  await t.test("streamed oversize", async () => {
    const report = await checkWebsite({ expectUnavailable: true, fetch: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1)); controller.close(); } }), { status: 503, headers: { "Cache-Control": "no-store" } }) });
    assert.equal(report.passed, false);
    assert.ok(report.checks.every(check => check.reason === "BODY_LIMIT"));
  });
  await t.test("ignored abort", async () => {
    const report = await checkWebsite({ expectUnavailable: true, timeoutMs: 5, fetch: () => new Promise<Response>(() => {}) });
    assert.equal(report.requests, 4);
    assert.ok(report.checks.every(check => check.reason === "TIMEOUT"));
    assert.ok(report.durationMs < 2000);
  });
});

test("CLI target validation rejects credentials, non-origin inputs and plaintext non-loopback without printing them", () => {
  assert.equal(websiteOrigin().origin, "http://127.0.0.1:3000");
  assert.equal(websiteOrigin("https://preview.example.test").origin, "https://preview.example.test");
  assert.equal(websiteOrigin("http://[::1]:3000").origin, "http://[::1]:3000");
  for (const target of ["https://user:fixture-secret@preview.example.test", "https://preview.example.test/path", "https://preview.example.test/path/..", "https://preview.example.test?token=fixture", "https://preview.example.test?", "https://preview.example.test#fixture", "https://preview.example.test#", "http://preview.example.test", "ftp://preview.example.test", " https://preview.example.test", "https://preview.example.test\\private"]) assert.throws(() => websiteOrigin(target), { message: "INVALID_TARGET" });
  assert.throws(() => parseWebsiteCheckArgs(["--unexpected", "fixture-secret"]), { message: "INVALID_OPTIONS" });
  assert.throws(() => parseWebsiteCheckArgs(["--base-url"]), { message: "INVALID_OPTIONS" });
  const result = spawnSync(process.execPath, ["scripts/check-website.ts", "--base-url", "https://user:fixture-secret@preview.example.test"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.equal(result.stderr.trim(), "INVALID_TARGET");
  assert.ok(!result.stdout.includes("fixture-secret") && !result.stderr.includes("fixture-secret"));
});
