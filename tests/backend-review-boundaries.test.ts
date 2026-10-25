import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { getContentProvider } from "../src/lib/content/provider.ts";
import { configureExecutionEnvironment } from "../scripts/development/execution.ts";
import { canonicalRouteTarget, fetchCachedRouteVerdict, routeCacheLookupResponse } from "../src/server/public-cache/route-lookup.ts";
import { rewriteStudyLinks } from "../src/server/notion/rewrite-study-links.ts";

test("production requires an explicit provider at startup and on reads", () => {
  for (const provider of [undefined, "", "typo"]) {
    const env = { NODE_ENV: "production" as const, VERCEL: "1", VERCEL_ENV: "production", CONTENT_PROVIDER: provider };
    assert.throws(() => getContentProvider(env), { code: "MISCONFIGURED" });
    assert.throws(() => configureExecutionEnvironment(env), { code: "MISCONFIGURED" });
  }
  assert.equal(getContentProvider({ NODE_ENV: "test" }), "mock");
  for (const provider of ["database", "notion", "mock"]) assert.equal(getContentProvider({ NODE_ENV: "production", VERCEL_ENV: "production", CONTENT_PROVIDER: provider }), provider);
});

test("route keys drop tracking noise but preserve invalid and distinct focus verdicts", async () => {
  for (const query of ["?utm_source=a", "?r=b", "?focus=a&focus=b", ""]) assert.equal(canonicalRouteTarget(`/study/course${query}`), "/study/course");
  assert.equal(canonicalRouteTarget("/status?utm=a&focus=item"), "/status?focus=item");
  for (const target of ["/status?focus=a&focus=b", "/status?focus=", "/status?focus=%2Fprivate"]) assert.equal(canonicalRouteTarget(target), "/status?focus=");
  assert.equal(canonicalRouteTarget("/status/?focus=item&x=1"), "/status?focus=item");
  const config = { siteKey: "fixture-site", secret: "ab".repeat(32), origin: "https://fixture.example" };
  const targets: string[] = [];
  const transport: typeof fetch = async (url, init) => {
    targets.push(new URL(String(url)).searchParams.get("target")!);
    return routeCacheLookupResponse(new Request(url, init), config, async (path, params) => {
      assert.equal(path, "/study/course"); assert.equal(params.size, 0); return "found";
    });
  };
  await fetchCachedRouteVerdict("/study/course?random=a", config, transport);
  await fetchCachedRouteVerdict("/study/course?random=b", config, transport);
  assert.deepEqual(targets, ["/study/course", "/study/course"]);
  // An older, correctly signed caller cannot bypass normalization in the endpoint.
  const target = "/study/course?random=legacy", at = String(Date.now());
  const sig = createHmac("sha256", Buffer.from(config.secret, "hex")).update(`nb-route-cache-v2\n${config.siteKey}\nlocal-fixed\n${at}\n${target}`).digest("hex");
  const response = await routeCacheLookupResponse(new Request(`${config.origin}/api/internal/cache/route?${new URLSearchParams({ target })}`, {
    headers: { "x-nb-route-time": at, "x-nb-route-signature": sig },
  }), config, async (_path, params) => { assert.equal(params.size, 0); return "found"; });
  assert.equal(response.status, 200);
});

test("withdrawal and rename scrub both child labels and nested navigation targets", () => {
  const href = "/study/course/notes/child", child = { id: "block", type: "child-page", title: "Private title", target: { href, title: "Private title" } };
  assert.deepEqual(rewriteStudyLinks({ nested: [child] }, new Map([[href, null]])), { nested: [{ id: "block", type: "child-page", title: "Unavailable page", target: null }] });
  assert.deepEqual(rewriteStudyLinks(child, new Map([[href, { href, title: "Renamed" }]])), { ...child, title: "Renamed", target: { href, title: "Renamed" } });
  assert.deepEqual(rewriteStudyLinks({ ...child, target: null }, new Map()), { id: "block", type: "child-page", title: "Unavailable page", target: null });
});
