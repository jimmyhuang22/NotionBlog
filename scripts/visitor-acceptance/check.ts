import { hasSafeMediaCachePolicy } from "../../src/server/media/cache.ts";
import { createHash } from "node:crypto";
import { canonicalJson, validateWebsiteRecord } from "../../src/server/database/website-validation.ts";
import { visitorFail as fail, type VisitorPlan } from "./plan.ts";

function object(v: unknown): Record<string, any> {
  if (!v || typeof v !== "object" || Array.isArray(v)) fail("VISITOR_RESPONSE_INVALID"); return v as Record<string, any>;
}
function same(a: unknown, b: unknown) { if (canonicalJson(a) !== canonicalJson(b)) fail("VISITOR_RESPONSE_MISMATCH"); }
/** Fail fast: no automatic retries, pagination sweep or browser resource reload.
 * The supplied transport must count both local HTTP and its object/SQL work. */
export async function checkVisitorResponses(plan: VisitorPlan, fetcher: typeof fetch, localOrigin: string, nonce: string) {
  const { digest, ...bound } = plan;
  if (createHash("sha256").update(canonicalJson(bound)).digest("hex") !== digest) fail("VISITOR_PLAN_CHANGED");
  const checks: { name: string; passed: true; bytes: number }[] = [];
  for (const request of plan.requests) {
    const response = await fetcher(new URL(request.path, localOrigin), { method: "GET", headers: { "X-Visitor-Nonce": nonce } });
    const bytes = new Uint8Array(await response.arrayBuffer()), expected = request.expected;
    if (!(expected.type === "media" ? hasSafeMediaCachePolicy(response, request.path) : /(?:^|,)\s*no-store\s*(?:,|$)/i.test(response.headers.get("cache-control") ?? ""))) fail("VISITOR_CACHE_HEADERS");
    if (response.status !== (expected.type === "missing" ? 404 : 200)) fail("VISITOR_HTTP_STATUS");
    if (expected.type === "media") {
      if (bytes.length !== expected.byteSize || response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== expected.mime ||
        response.headers.get("content-length") !== String(expected.byteSize) || createHash("sha256").update(bytes).digest("hex") !== expected.sha256) fail("VISITOR_MEDIA_MISMATCH");
    } else if (expected.type === "html") {
      const html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const escaped = expected.text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#x27;");
      if (response.headers.get("content-type")?.split(";")[0].trim() !== "text/html" || !/<html[\s>]/i.test(html) || !/<main[\s>]/i.test(html) ||
        /NEXT_HTTP_ERROR_FALLBACK|__next_error__/.test(html) || escaped && !html.includes(escaped)) fail("VISITOR_HTML_INVALID");
    } else if (expected.type !== "missing" || expected.json) {
      if (response.headers.get("content-type")?.split(";")[0].trim() !== "application/json") fail("VISITOR_RESPONSE_INVALID");
      let envelope: Record<string, any>;
      try { envelope = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))); } catch { return fail("VISITOR_RESPONSE_INVALID"); }
      if (expected.type === "missing") same(envelope, { error: { code: "NOT_FOUND", message: "Content is not available." } });
      else {
        if (Object.keys(envelope).length !== 1 || !Object.hasOwn(envelope, "data")) fail("VISITOR_RESPONSE_INVALID");
        const data = object(envelope.data);
        if (expected.type === "health") same(data, { provider: "database", databaseVersion: "2" });
        else if (expected.type === "exact") same(data, expected.data);
        else if (expected.type === "list") {
          if (!Array.isArray(data.items) || data.items.length !== Math.min(2, expected.total) || data.total !== expected.total ||
            data.hasMore !== (expected.total > 2) || data.hasMore !== (typeof data.nextCursor === "string" && data.nextCursor.length > 0) ||
            !data.hasMore && data.nextCursor !== null || new Set(data.items.map((i: any) => i?.id)).size !== data.items.length ||
            data.items.some((i: any) => i?.kind !== expected.kind || !expected.ids.includes(i.id))) fail("VISITOR_LIST_MISMATCH");
        } else if (expected.type === "detail") {
          const item = object(data.item); object(data.document);
          for (const [k, v] of Object.entries(expected.item)) same(item[k], v);
          if (expected.courseId !== undefined) { same(item.courseId, expected.courseId); same(item.parentId, expected.parentId); }
          try { validateWebsiteRecord({ detail: data as any, evidence: { sourceKey: "visitor-fixture", dataSourceId: null, databaseParentId: null, courseId: null, parentId: null, ordinal: 0 } } as any); }
          catch { fail("VISITOR_RESPONSE_INVALID"); }
        } else if (expected.type === "about") {
          if (data.slug !== "about" || data.title !== expected.title || data.updatedAt !== expected.updatedAt || !data.document || !Array.isArray(data.document.blocks)) fail("VISITOR_RESPONSE_MISMATCH");
        }
      }
    }
    checks.push({ name: request.name, passed: true, bytes: bytes.length });
  }
  return { checks, mediaSampleAvailable: plan.mediaSampleAvailable, thumbnail400Verified: plan.thumbnail400SampleAvailable, browserHydrationVerified: false, regionalNetworkVerified: false };
}
