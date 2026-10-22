import { hasSafeMediaCachePolicy } from "../src/server/media/cache.ts";
import { performance } from "node:perf_hooks";
import type { ContentDetail, Course, CourseTree, ImageAsset, Page, StatusEntry, StatusYears, StudyNode, StudyNote } from "../contracts/content.ts";
import type { SyncRecord } from "../contracts/sync.ts";
import { validateSyncRecord } from "../src/server/database/validation.ts";
import { statusYear } from "../src/lib/content/status.ts";

const DEFAULT_ORIGIN = "http://127.0.0.1:3000";
const JSON_LIMIT = 8 * 1024 * 1024;
const IMAGE_LIMIT = 20 * 1024 * 1024;
const REQUEST_LIMIT = 24;
const TOTAL_TIMEOUT = 60_000;
// Static public messages emitted by the sampled HTTP routes and their providers.
// A recognized code alone must not make raw driver/upstream text acceptable.
const PUBLIC_ERROR_MESSAGES: Record<string, readonly string[]> = {
  CONTENT_UNAVAILABLE: ["Content is temporarily unavailable.", "Database content is temporarily unavailable.",
    "Database schema is incompatible.", "Database reader is incompatible.", "Status years are unavailable.",
    "The Notion content is currently unavailable."],
  MISCONFIGURED: ["The server-side database connection is not configured.", "Unsupported content provider configuration.",
    "The server-side database adapter is not configured.", "The server-side Notion adapter is not configured.",
    "Invalid site time zone.", "The Notion source configuration is invalid.", "A server-side Notion Integration Token is required.",
    "Private Notion source configuration could not be read.", "The Notion connection is not configured for access.",
    "A valid Notion connection token is required.", "The Notion API version configuration is invalid.",
    "Source publication requires the query adapter.", "Only Status supports source publication.",
    "Configured content source is unavailable.", "The study source does not belong to its configured course."],
  RATE_LIMITED: ["A synchronization run is already active.", "The Notion service is busy. Try again later."],
  INVALID_QUERY: ["Invalid year filter."],
  NOT_FOUND: ["Content kind is not available.", "Content is not available.", "Course tree is not available."],
};
type Kind = "status" | "course" | "study-note";
type Failure = "INVALID_TARGET" | "INVALID_OPTIONS" | "REQUEST_FAILED" | "TIMEOUT" | "REQUEST_LIMIT" | "BODY_LIMIT" | "HTTP_STATUS" | "CACHE_HEADERS" | "INVALID_DTO" | "OWNERSHIP" | "PAGINATION" | "YEAR_FILTER" | "MEDIA_BYTES" | "MISSING_SAMPLE";

class CheckFailure extends Error {
  readonly code: Failure;
  constructor(code: Failure) { super(code); this.code = code; }
}
function fail(code: Failure): never { throw new CheckFailure(code); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("INVALID_DTO");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) fail("INVALID_DTO");
}
function identity(value: unknown): value is string { return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value); }

/** An explicit HTTPS origin is permitted; plaintext HTTP is limited to loopback. */
export function websiteOrigin(value = DEFAULT_ORIGIN): URL {
  try {
    if (value.trim() !== value || /[\u0000-\u0020\u007f\\]/.test(value) || !/^https?:\/\/[^/?#]+\/?$/i.test(value)) fail("INVALID_TARGET");
    const url = new URL(value);
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.search || url.hash || url.pathname !== "/") fail("INVALID_TARGET");
    return url;
  } catch { return fail("INVALID_TARGET"); }
}

export interface WebsiteCheckOptions {
  baseUrl?: string;
  expectUnavailable?: boolean;
  fetch?: typeof fetch;
  /** A smaller per-request budget can be used by offline tests. Maximum 15 seconds. */
  timeoutMs?: number;
}
export interface WebsiteCheckResult {
  name: string;
  outcome: "passed" | "failed" | "skipped";
  durationMs: number;
  count?: number;
  reason?: Failure | "NO_NEXT_PAGE" | "NO_DATED_STATUS" | "NO_UNDATED_STATUS" | "NO_REPRESENTATIVE_IMAGE" | "DEPENDENCY_FAILED";
}
export interface WebsiteCheckReport {
  mode: "available" | "expect-unavailable";
  passed: boolean;
  /** DTO/error responses alone cannot establish the running server's provider. */
  providerVerified: false;
  requests: number;
  durationMs: number;
  checks: WebsiteCheckResult[];
}

function validateImage(value: unknown): ImageAsset {
  const image = object(value);
  keys(image, ["id", "src", "alt", "width", "height"]);
  if (typeof image.id !== "string" || !/^a1\.[a-f0-9]{64}$/.test(image.id) || image.src !== `/media/${image.id}` || typeof image.alt !== "string" || ![image.width, image.height].every(n => n === null || typeof n === "number" && Number.isFinite(n) && n >= 0)) fail("INVALID_DTO");
  return image as unknown as ImageAsset;
}

function validateItem(value: unknown, kind: Kind, list = false): StatusEntry | Course | StudyNote {
  const original = object(value);
  if (original.kind !== kind) fail("INVALID_DTO");
  const item = { ...original };
  if (kind === "status" && list) {
    if (!Array.isArray(item.images) || item.images.length > 9 || typeof item.hasMoreBody !== "boolean") fail("INVALID_DTO");
    item.images.forEach(validateImage);
    delete item.images;
    delete item.hasMoreBody;
  }
  // Reuse the database's strict public DTO/AST validation. Neutral evidence is
  // validation scaffolding only: no source evidence is inferred or requested.
  const evidence = { sourceKey: "website-check", dataSourceId: null, databaseParentId: null, courseId: null, parentId: null, ordinal: 0 };
  try { validateSyncRecord({ detail: { item, document: null }, evidence } as unknown as SyncRecord); }
  catch { fail("INVALID_DTO"); }
  return original as unknown as StatusEntry | Course | StudyNote;
}

function validatePage<T extends StatusEntry | Course | StudyNote>(value: unknown, kind: Kind): Page<T> {
  const page = object(value);
  keys(page, ["items", "hasMore", "nextCursor"]);
  if (!Array.isArray(page.items) || page.items.length > 2 || typeof page.hasMore !== "boolean" || !(page.nextCursor === null || typeof page.nextCursor === "string" && page.nextCursor.length > 0 && page.nextCursor.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(page.nextCursor))) fail("INVALID_DTO");
  if (page.hasMore !== (page.nextCursor !== null) || page.hasMore && page.items.length === 0) fail("PAGINATION");
  page.items.forEach(item => validateItem(item, kind, true));
  if (new Set(page.items.map(item => object(item).id)).size !== page.items.length) fail("PAGINATION");
  return page as unknown as Page<T>;
}

function validateDetail<T extends StatusEntry | Course | StudyNote>(value: unknown, kind: Kind): ContentDetail<T> {
  const detail = object(value);
  keys(detail, ["item", "document"]);
  validateItem(detail.item, kind);
  try {
    validateSyncRecord({ detail, evidence: { sourceKey: "website-check", dataSourceId: null, databaseParentId: null, courseId: null, parentId: null, ordinal: 0 } } as unknown as SyncRecord);
  } catch { fail("INVALID_DTO"); }
  return detail as unknown as ContentDetail<T>;
}

function validateYears(value: unknown): StatusYears {
  const years = object(value);
  keys(years, ["years", "undatedCount", "timeZone"]);
  if (!Array.isArray(years.years) || years.years.length > 9999 || !Number.isSafeInteger(years.undatedCount) || (years.undatedCount as number) < 0 || typeof years.timeZone !== "string") fail("INVALID_DTO");
  try { new Intl.DateTimeFormat("en", { timeZone: years.timeZone }); } catch { fail("INVALID_DTO"); }
  let previous = 10000;
  for (const value of years.years) {
    const year = object(value);
    keys(year, ["year", "count"]);
    if (!Number.isInteger(year.year) || (year.year as number) < 1 || (year.year as number) >= previous || !Number.isSafeInteger(year.count) || (year.count as number) < 1) fail("INVALID_DTO");
    previous = year.year as number;
  }
  return years as unknown as StatusYears;
}

function validateTree(value: unknown, course: Course): CourseTree {
  const tree = object(value);
  keys(tree, ["courseId", "nodes"]);
  if (tree.courseId !== course.id || !Array.isArray(tree.nodes)) fail("OWNERSHIP");
  const ids = new Set<string>();
  function visit(nodes: unknown[], depth: number) {
    if (depth > 32) fail("INVALID_DTO");
    for (const value of nodes) {
      const node = object(value);
      keys(node, ["id", "title", "href", "hasChildren", "children"]);
      if (!identity(node.id) || typeof node.title !== "string" || typeof node.href !== "string" || typeof node.hasChildren !== "boolean" || node.children !== undefined && !Array.isArray(node.children)) fail("INVALID_DTO");
      if (!node.href.startsWith(`${course.href}/notes/`) || !identity(node.href.slice(`${course.href}/notes/`.length))) fail("OWNERSHIP");
      if (ids.has(node.id) || ids.size >= 5000) fail("INVALID_DTO");
      ids.add(node.id);
      if (Array.isArray(node.children)) {
        if (!node.hasChildren && node.children.length > 0) fail("INVALID_DTO");
        visit(node.children, depth + 1);
      }
    }
  }
  visit(tree.nodes, 0);
  return tree as unknown as CourseTree;
}

function firstNode(nodes: StudyNode[]): { node: StudyNode; parentId: string | null } | undefined {
  const root = nodes[0];
  if (!root) return undefined;
  // Prefer a nested note so the representative exercises its parent binding.
  return root.children?.[0] ? { node: root.children[0], parentId: root.id } : { node: root, parentId: null };
}

function collectImages(detail: ContentDetail): ImageAsset[] {
  const images = detail.item.cover ? [detail.item.cover] : [];
  function visit(blocks: NonNullable<ContentDetail["document"]>["blocks"]) {
    for (const block of blocks) {
      if (block.type === "image") images.push(block.image);
      if ("children" in block) visit(block.children);
      if (block.type === "list") block.items.forEach(item => visit(item.children));
      if (block.type === "columns") block.columns.forEach(column => visit(column.blocks));
    }
  }
  if (detail.document) visit(detail.document.blocks);
  return images;
}

function imageMime(bytes: Uint8Array): string | null {
  const b = Buffer.from(bytes);
  if (b.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return "image/jpeg";
  if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (["GIF87a", "GIF89a"].includes(b.subarray(0, 6).toString())) return "image/gif";
  if (b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP") return "image/webp";
  if (b.subarray(4, 8).toString() === "ftyp" && ["avif", "avis"].includes(b.subarray(8, 12).toString())) return "image/avif";
  return null;
}

/** Read-only, bounded representative checks. Reports never include URLs, IDs or bodies. */
export async function checkWebsite(options: WebsiteCheckOptions = {}): Promise<WebsiteCheckReport> {
  const origin = websiteOrigin(options.baseUrl);
  const timeout = options.timeoutMs ?? 10_000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 15_000) fail("INVALID_OPTIONS");
  const fetcher = options.fetch ?? fetch;
  const started = performance.now();
  const checks: WebsiteCheckResult[] = [];
  let requests = 0;
  const elapsed = () => Math.round(performance.now() - started);
  async function request(path: string, maxBytes = JSON_LIMIT): Promise<{ response: Response; bytes: Uint8Array }> {
    const url = new URL(path, origin);
    if (url.origin !== origin.origin || url.username || url.password || url.hash) fail("INVALID_TARGET");
    if (++requests > REQUEST_LIMIT) fail("REQUEST_LIMIT");
    const remaining = TOTAL_TIMEOUT - elapsed();
    if (remaining <= 0) fail("TIMEOUT");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new CheckFailure("TIMEOUT")); }, Math.min(timeout, remaining));
    });
    const operation = (async () => {
      const response = await fetcher(url.href, { method: "GET", cache: "no-store", credentials: "omit", redirect: "error", signal: controller.signal, headers: { Accept: path.startsWith("/media/") ? "image/*" : "application/json" } });
      if (response.redirected || response.url && new URL(response.url).origin !== origin.origin || response.status >= 300 && response.status < 400) fail("HTTP_STATUS");
      if (!hasSafeMediaCachePolicy(response, path)) fail("CACHE_HEADERS");
      const declared = response.headers.get("Content-Length");
      // Fetch exposes decoded gzip/br bodies, while Content-Length describes the
      // encoded wire representation. Bound decoded bytes as the stream is read.
      const encoding = response.headers.get("Content-Encoding")?.trim().toLowerCase();
      const encoded = Boolean(encoding && encoding !== "identity");
      if (declared !== null && (!/^\d+$/.test(declared) || !encoded && Number(declared) > maxBytes)) fail("BODY_LIMIT");
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (response.body) {
        const reader = response.body.getReader();
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > maxBytes) fail("BODY_LIMIT");
            chunks.push(value);
          }
        } catch (error) { void reader.cancel().catch(() => {}); throw error; }
        finally { reader.releaseLock(); }
      }
      if (declared !== null && !encoded && Number(declared) !== size) fail("BODY_LIMIT");
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return { response, bytes };
    })();
    try { return await Promise.race([operation, deadline]); }
    catch (error) { controller.abort(); throw error instanceof CheckFailure ? error : new CheckFailure("REQUEST_FAILED"); }
    finally { clearTimeout(timer!); }
  }
  async function json(path: string, status = 200): Promise<unknown> {
    const { response, bytes } = await request(path);
    if (response.status !== status) fail("HTTP_STATUS");
    if (response.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") fail("INVALID_DTO");
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { return fail("INVALID_DTO"); }
  }
  async function data(path: string): Promise<unknown> {
    const envelope = object(await json(path));
    keys(envelope, ["data"]);
    if (!Object.hasOwn(envelope, "data")) fail("INVALID_DTO");
    return envelope.data;
  }
  async function errorResponse(path: string, status: number, allowed: string[]): Promise<void> {
    const envelope = object(await json(path, status));
    keys(envelope, ["error"]);
    const error = object(envelope.error);
    keys(error, ["code", "message"]);
    if (typeof error.code !== "string" || !allowed.includes(error.code) || typeof error.message !== "string" ||
        !PUBLIC_ERROR_MESSAGES[error.code]?.includes(error.message)) fail("INVALID_DTO");
  }
  async function check<T>(name: string, operation: () => Promise<T>, count?: (value: T) => number): Promise<T | undefined> {
    const start = performance.now();
    try {
      const result = await operation();
      checks.push({ name, outcome: "passed", durationMs: Math.round(performance.now() - start), ...(count ? { count: count(result) } : {}) });
      return result;
    } catch (error) {
      checks.push({ name, outcome: "failed", durationMs: Math.round(performance.now() - start), reason: error instanceof CheckFailure ? error.code : "INVALID_DTO" });
      return undefined;
    }
  }
  function skip(name: string, reason: WebsiteCheckResult["reason"]) { checks.push({ name, outcome: "skipped", durationMs: 0, reason }); }

  if (options.expectUnavailable) {
    for (const [name, path] of [["status-unavailable", "/api/content/status?limit=2"], ["years-unavailable", "/api/status/years"], ["course-unavailable", "/api/content/course?limit=2"], ["note-unavailable", "/api/content/study-note?limit=2"]]) {
      await check(name, () => errorResponse(path, 503, ["CONTENT_UNAVAILABLE", "MISCONFIGURED", "RATE_LIMITED"]));
    }
  } else {
    const images: ImageAsset[] = [];
    const years = await check("status-years", async () => validateYears(await data("/api/status/years")), value => value.years.reduce((sum, year) => sum + year.count, value.undatedCount));
    const statuses = await check("status-list", async () => {
      const page = validatePage<StatusEntry>(await data("/api/content/status?limit=2"), "status");
      if (!page.items.length) fail("MISSING_SAMPLE");
      images.push(...page.items.flatMap(item => [...item.images ?? [], ...item.cover ? [item.cover] : []]));
      if (years) {
        const total = years.years.reduce((sum, year) => sum + year.count, years.undatedCount);
        if (page.items.length !== Math.min(2, total) || page.hasMore !== (total > 2)) fail("YEAR_FILTER");
      }
      return page;
    }, page => page.items.length);
    if (statuses?.nextCursor) {
      await check("status-pagination", async () => {
        const page = validatePage<StatusEntry>(await data(`/api/content/status?${new URLSearchParams({ limit: "2", cursor: statuses.nextCursor! })}`), "status");
        if (!page.items.length || page.nextCursor === statuses.nextCursor || page.items.some(item => statuses.items.some(first => first.id === item.id))) fail("PAGINATION");
        if (years) {
          const total = years.years.reduce((sum, year) => sum + year.count, years.undatedCount);
          if (page.items.length !== Math.min(2, total - statuses.items.length) ||
              page.hasMore !== (total > statuses.items.length + page.items.length)) fail("PAGINATION");
        }
        return page;
      }, page => page.items.length);
    } else skip("status-pagination", statuses ? "NO_NEXT_PAGE" : "DEPENDENCY_FAILED");
    for (const [name, year, count] of [["status-year-filter", years?.years[0]?.year, years?.years[0]?.count], ["status-undated-filter", "undated" as const, years?.undatedCount]] as const) {
      if (!years) { skip(name, "DEPENDENCY_FAILED"); continue; }
      if (!count || year === undefined) { skip(name, year === "undated" ? "NO_UNDATED_STATUS" : "NO_DATED_STATUS"); continue; }
      await check(name, async () => {
        const page = validatePage<StatusEntry>(await data(`/api/content/status?${new URLSearchParams({ limit: "2", year: String(year) })}`), "status");
        if (page.items.length !== Math.min(2, count) || page.hasMore !== (count > 2) || page.items.some(item => statusYear(item, years.timeZone) !== (year === "undated" ? null : year))) fail("YEAR_FILTER");
        return page;
      }, page => page.items.length);
    }
    if (statuses) await check("status-detail", async () => {
      const detail = validateDetail<StatusEntry>(await data(`/api/content/status/${encodeURIComponent(statuses.items[0].slug)}`), "status");
      if (detail.item.id !== statuses.items[0].id) fail("OWNERSHIP");
      images.push(...collectImages(detail));
      return detail;
    }); else skip("status-detail", "DEPENDENCY_FAILED");

    const courses = await check("course-list", async () => {
      const page = validatePage<Course>(await data("/api/content/course?limit=2"), "course");
      if (!page.items.length) fail("MISSING_SAMPLE");
      return page;
    }, page => page.items.length);
    await check("note-list", async () => {
      const page = validatePage<StudyNote>(await data("/api/content/study-note?limit=2"), "study-note");
      if (!page.items.length) fail("MISSING_SAMPLE");
      return page;
    }, page => page.items.length);
    const course = courses?.items[0];
    if (course) {
      await check("course-detail", async () => {
        const detail = validateDetail<Course>(await data(`/api/content/course/${encodeURIComponent(course.slug)}`), "course");
        if (detail.item.id !== course.id) fail("OWNERSHIP");
        images.push(...collectImages(detail));
      });
      const treePath = `/api/study/${encodeURIComponent(course.slug)}/tree`;
      const tree = await check("course-tree", async () => validateTree(await data(treePath), course), value => value.nodes.length);
      const selected = tree && firstNode(tree.nodes);
      if (selected) {
        const slug = selected.node.href.slice(`${course.href}/notes/`.length);
        await check("note-detail-ownership", async () => {
          const detail = validateDetail<StudyNote>(await data(`/api/content/study-note/${encodeURIComponent(slug)}`), "study-note");
          if (detail.item.id !== selected.node.id || detail.item.courseId !== course.id || detail.item.parentId !== selected.parentId || detail.item.href !== selected.node.href) fail("OWNERSHIP");
          images.push(...collectImages(detail));
        });
        await check("course-parent-tree", async () => {
          const subtree = validateTree(await data(`${treePath}?${new URLSearchParams({ parentId: selected.node.id })}`), course);
          if (subtree.nodes.some(node => node.id === selected.node.id)) fail("OWNERSHIP");
          if (selected.node.children && JSON.stringify(subtree.nodes.map(node => node.id)) !== JSON.stringify(selected.node.children.map(node => node.id))) fail("OWNERSHIP");
          return subtree;
        }, value => value.nodes.length);
      } else await check("note-detail-ownership", async () => fail("MISSING_SAMPLE"));
      await check("unknown-parent-denied", () => errorResponse(`${treePath}?parentId=website-check-missing-parent`, 404, ["NOT_FOUND"]));
    } else skip("course-tree", "DEPENDENCY_FAILED");
    await check("invalid-query-controlled", () => errorResponse("/api/content/status?year=invalid", 400, ["INVALID_QUERY"]));
    await check("unknown-detail-denied", () => errorResponse("/api/content/study-note/website-check-missing-note", 404, ["NOT_FOUND"]));
    await check("disabled-kind-denied", () => errorResponse("/api/content/post?limit=2", 404, ["NOT_FOUND"]));

    const image = images[0];
    if (image) await check("representative-media", async () => {
      validateImage(image);
      const { response, bytes } = await request(image.src, IMAGE_LIMIT);
      if (response.status !== 200) fail("HTTP_STATUS");
      if (response.headers.get("X-Content-Type-Options")?.toLowerCase() !== "nosniff" || response.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase() !== imageMime(bytes) || !bytes.length) fail("MEDIA_BYTES");
      // Public ImageAsset has no hash or byte size; MIME/magic is observable here.
      // Authoritative stored size/hash verification remains server-side.
      return bytes.length;
    }, bytes => bytes); else skip("representative-media", "NO_REPRESENTATIVE_IMAGE");
    await check("unknown-media-denied", async () => {
      const { response } = await request("/media/website-check-missing-media");
      if (response.status !== 404) fail("HTTP_STATUS");
    });
  }
  return { mode: options.expectUnavailable ? "expect-unavailable" : "available", passed: checks.every(check => check.outcome !== "failed"), providerVerified: false, requests, durationMs: elapsed(), checks };
}

export function parseWebsiteCheckArgs(args: string[]): WebsiteCheckOptions {
  const options: WebsiteCheckOptions = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--expect-unavailable" && options.expectUnavailable === undefined) options.expectUnavailable = true;
    else if (args[i] === "--base-url" && options.baseUrl === undefined && args[i + 1] && !args[i + 1].startsWith("--")) options.baseUrl = websiteOrigin(args[++i]).origin;
    else fail("INVALID_OPTIONS");
  }
  return options;
}

if (import.meta.main) {
  if (process.argv.slice(2).includes("--help")) {
    console.log("Usage: node scripts/check-website.ts [--base-url HTTPS_OR_LOOPBACK_ORIGIN] [--expect-unavailable]");
    console.log("Read-only representative API/media checks; default http://127.0.0.1:3000. No source IDs, URLs or bodies are reported. Responses do not prove which provider is configured.");
  } else {
    try {
      const report = await checkWebsite(parseWebsiteCheckArgs(process.argv.slice(2)));
      console.log(JSON.stringify(report, null, 2));
      if (!report.passed) process.exitCode = 1;
    } catch (error) {
      console.error(error instanceof CheckFailure ? error.code : "REQUEST_FAILED");
      process.exitCode = 1;
    }
  }
}
