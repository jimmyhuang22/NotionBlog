import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { CONTENT_KINDS, type ContentFeatures } from "../config/features.ts";
import type { ContentRepository } from "../contracts/repository.ts";
import { qualifyRoute } from "../src/lib/qualify-route.ts";
import { canonicalRouteTarget, classifyRouteTarget, fetchCachedRouteVerdict, routeCacheLookupResponse } from "../src/server/public-cache/route-lookup.ts";

const config = { siteKey: "fixture-site", secret: "ab".repeat(32), origin: "https://fixture.example" };
const all = Object.fromEntries(CONTENT_KINDS.map(kind => [kind, true])) as ContentFeatures;
const repository = {
  getContentMetadata: async (_kind: string, slug: string) => ({ id: slug, courseId: "course" }),
  isStudyNoteAvailable: async () => true,
} as unknown as ContentRepository;

function signed(target: string, options: { time?: number; deploymentId?: string; signature?: string } = {}) {
  const at = String(options.time ?? Date.now()), deployment = options.deploymentId;
  const signature = options.signature ?? createHmac("sha256", Buffer.from(config.secret, "hex"))
    .update(`nb-route-cache-v2\n${config.siteKey}\n${deployment ?? "local-fixed"}\n${at}\n${target}`).digest("hex");
  return new Request(`${config.origin}/api/internal/cache/route?${new URLSearchParams({ target })}`, {
    headers: { "x-nb-route-time": at, "x-nb-route-signature": signature, ...(deployment ? { "x-nb-route-deployment": deployment } : {}) },
  });
}

test("equivalent encoding and empty path segments share a stable target without extra decoding", () => {
  for (const target of ["/study/course", "/study/%63ourse", "/study/co%75rse/", "/study//course///", "/st%75dy/%63ourse?noise=1"]) {
    assert.deepEqual(classifyRouteTarget(target), { kind: "managed", target: "/study/course" });
  }
  for (const target of ["/study/%252F", "/study/%252f", "/study/Course", "/study/course", "/study/%E8%AF%BE%E7%A8%8B", "/study/a%20b", "/study/a%3Fb", "/study/a%23b"]) {
    const parsed = classifyRouteTarget(target);
    assert.equal(parsed.kind, "managed"); assert.deepEqual(classifyRouteTarget(parsed.target), parsed);
  }
  assert.equal(canonicalRouteTarget("/study/%252F"), "/study/%252F");
  assert.notEqual(canonicalRouteTarget("/study/%252F"), canonicalRouteTarget("/study/%252f"));
  assert.notEqual(canonicalRouteTarget("/study/Course"), canonicalRouteTarget("/study/course"));
  assert.notEqual(canonicalRouteTarget("/study/%C3%A9"), canonicalRouteTarget("/study/e%CC%81"));
});

test("managed grammar matches the existing qualification shapes including study reserved slugs", async () => {
  for (const target of ["/about", "/blog", "/blog/post", "/photos", "/photos/album", "/projects", "/projects/work", "/library/games", "/library/movies/movie", "/library/books/book", "/study", "/study/course", "/study/course/notes/note", "/study/projects/final-project", "/study/projects", "/study/projects/notes/note", "/status", "/status?focus=valid_key-1"]) {
    const parsed = classifyRouteTarget(target), url = new URL(parsed.target, config.origin);
    assert.equal(parsed.kind, "managed", target);
    assert.equal(await qualifyRoute(url.pathname, all, repository, url.searchParams, { studyProject: async () => true }), true, target);
  }
  for (const target of ["/", "/unknown", "/about/child", "/blog/a/b", "/photos/a/b", "/projects/a/b", "/library", "/library/unknown", "/library/toString", "/library/books/a/b", "/study/course/extra", "/study/course/other/note", "/study/projects/Bad_Project", "/status/child"]) {
    assert.equal(classifyRouteTarget(target).kind, "missing", target);
  }
});

test("unsafe decoded segments and invalid focus classify as missing without a transport call", async () => {
  let calls = 0;
  const transport: typeof fetch = async () => { calls++; assert.fail("Invalid targets must not leave the caller"); };
  for (const target of ["/study/%", "/study/%C0%AF", "/study/%FF", "/study/%2f", "/study/%5c", "/study/%00", "/study/%1f", "/study/%7f", "/study/%C2%80", `/study/${"课".repeat(300)}`, "/about/child", "/library/invalid", "/status?focus=", "/status?focus=a&focus=a", "/status?focus=%2f", "/status?focus=%2561", `/status?focus=${"a".repeat(129)}`, "/study/../../not-a-route"]) {
    const parsed = classifyRouteTarget(target);
    assert.equal(parsed.kind, "missing", target); assert.deepEqual(classifyRouteTarget(parsed.target), parsed);
    assert.equal(await fetchCachedRouteVerdict(target, config, transport), "missing", target);
  }
  assert.equal(calls, 0);
  assert.equal(canonicalRouteTarget("/status/?focus=a&focus=b"), "/status?focus=");
  assert.notEqual(canonicalRouteTarget("/status"), canonicalRouteTarget("/status?focus="));
  assert.notEqual(canonicalRouteTarget("/status?focus=a"), canonicalRouteTarget("/status?focus=b"));
});

test("dot normalization cannot let a signed old caller cache an unmanaged path as found", async () => {
  let reads = 0;
  for (const target of ["/study/../../not-a-route", "/study/%2e%2e/not-a-route", "/study/%", "/study/%2F", "/status/?focus=a&focus=b", "/study/projects/Bad_Project"]) {
    const response = await routeCacheLookupResponse(signed(target), config, async () => { reads++; return "found"; });
    assert.equal(response.status, 200); assert.equal((await response.json()).verdict, "missing");
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  }
  assert.equal(reads, 0);
  const response = await routeCacheLookupResponse(signed("/study/%2e%2e/status"), config, async (path, params) => {
    reads++; assert.equal(path, "/status"); assert.equal(params.size, 0); return "found";
  });
  assert.equal(response.status, 200); assert.equal(reads, 1);
});

test("new callers sign canonical targets and legacy callers authenticate raw targets before normalization", async () => {
  const received: string[] = [];
  const transport: typeof fetch = async (url, init) => {
    received.push(new URL(String(url)).searchParams.get("target")!);
    return routeCacheLookupResponse(new Request(url, init), config, async (path, params) => {
      assert.equal(path, "/study/course"); assert.equal(params.size, 0); return "found";
    });
  };
  assert.equal(await fetchCachedRouteVerdict("/study//%63ourse/?noise=1", config, transport), "found");
  assert.deepEqual(received, ["/study/course"]);
  let reads = 0;
  const raw = "/study//%63ourse/?noise=legacy";
  const legacy = await routeCacheLookupResponse(signed(raw), config, async (path, params) => {
    reads++; assert.equal(path, "/study/course"); assert.equal(params.size, 0); return "found";
  });
  assert.equal(legacy.status, 200); assert.equal(reads, 1);
  const time = Date.now(), canonicalSignature = signed("/study/course", { time }).headers.get("x-nb-route-signature")!;
  const mismatched = await routeCacheLookupResponse(signed(raw, { time, signature: canonicalSignature }), config, async () => { reads++; return "found"; });
  assert.equal(mismatched.status, 401); assert.equal(reads, 1);
});

test("target classification preserves auth, deployment, configuration and unavailable safeguards", async () => {
  let reads = 0, calls = 0;
  const read = async () => { reads++; return "found" as const; };
  for (const request of [signed("/status?focus=", { signature: "0".repeat(64) }), signed("/study/course", { time: Date.now() - 31_000 }), signed("/study/course", { deploymentId: "dpl_other12345678" })]) {
    assert.equal((await routeCacheLookupResponse(request, config, read)).status, 401);
  }
  assert.equal(reads, 0);
  assert.equal((await routeCacheLookupResponse(signed("/study/course"), config, async () => { throw Error("Synthetic unavailable"); })).status, 503);
  const transport: typeof fetch = async () => { calls++; return Response.json({ version: 1, verdict: "found" }); };
  for (const target of ["https://other.example/study/course", "//other.example/study/course", "/study\\course", "/study/course#fragment", "/study/a b", `/study/${"a".repeat(2048)}`]) {
    await assert.rejects(fetchCachedRouteVerdict(target, config, transport), /ROUTE_CACHE_TARGET/);
  }
  for (const invalid of [{ ...config, secret: "invalid" }, { ...config, origin: "https://fixture.example/path" }, { ...config, oidcToken: "unexpected" }, { ...config, deploymentId: "dpl_fixture12345678" }]) {
    await assert.rejects(fetchCachedRouteVerdict("/status?focus=", invalid, transport));
  }
  assert.equal(calls, 0);
});
