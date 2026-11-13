import test from "node:test";
import assert from "node:assert/strict";
import { createVisitorTracker, analyticsPath, analyticsReferrer, type AnalyticsBrowser } from "../src/lib/visitor-analytics.ts";
import { parseVisitorAnalyticsConfig, visitorAnalyticsConfig } from "../src/server/analytics/config.ts";
import { collectVisitor } from "../src/server/analytics/collect.ts";

const config = { websiteId: "11111111-1111-4111-8111-111111111111", hostname: "site.example.invalid",
  origins: ["https://site.example.invalid", "https://regional.example.invalid"], node: "region-a",
  endpoint: "https://analytics.example.invalid/collect", secret: "a".repeat(64), clientIpHeader: "x-real-ip" };
const env = { NODE_ENV: "production", NOTIONBLOG_DEVELOPMENT_MODE: "self-hosted", SELF_HOSTED_DEPLOYMENT: "public-website",
  CONTENT_PROVIDER: "database", SITE_ANALYTICS_JSON: JSON.stringify(config) };
const payload = { path: "/study/example?search=private#fragment", referrer: "https://external.example.invalid/private?token=private", language: "zh-CN" };
const request = (body: unknown = payload, headers: Record<string, string> = {}) => new Request("https://site.example.invalid/api/visitor-analytics", {
  method: "POST", headers: { "Content-Type": "application/json", Origin: config.origins[0], "Sec-Fetch-Site": "same-origin",
    "X-Real-IP": "192.0.2.10", "User-Agent": "Browser fixture", ...headers }, body: JSON.stringify(body),
});

test("analytics requires an explicit production profile and stays disabled in builds, demos and previews", () => {
  assert.deepEqual(visitorAnalyticsConfig(env), config);
  for (const overrides of [{ NODE_ENV: "test" }, { CONTENT_PROVIDER: "mock" }, { NOTIONBLOG_DEVELOPMENT_MODE: "offline" },
    { SELF_HOSTED_DEPLOYMENT: "" }, { SITE_ANALYTICS_JSON: "" }, { SITE_ANALYTICS_JSON: "malformed" },
    { PREVIEW_ACCESS_CONFIG: "configured" }, { PREVIEW_DATA_DATE: "2026-10-30" }]) assert.equal(visitorAnalyticsConfig({ ...env, ...overrides }), null);
  for (const overrides of [{ endpoint: "http://remote.example.invalid/collect" }, { endpoint: "https://user:password@example.invalid/collect" },
    { endpoint: "https://example.invalid/collect?secret=value" }, { clientIpHeader: "x-forwarded-for" },
    { origins: ["https://example.invalid/path"] }, { origins: [] }, { node: 123 }, { secret: "placeholder" }, { unexpected: true }]) {
    assert.throws(() => parseVisitorAnalyticsConfig(JSON.stringify({ ...config, ...overrides })), { message: "VISITOR_ANALYTICS_CONFIG_INVALID" });
  }
});

test("paths and referrals exclude searches, fragments, internal routes and foreign path details", () => {
  assert.equal(analyticsPath(payload.path), "/study/example");
  for (const path of ["//evil.invalid", "/api/internal", "/_next/static/file", "/study/../api/private", "/study/\\evil", "https://evil.invalid"]) assert.equal(analyticsPath(path), null);
  assert.equal(analyticsReferrer(payload.referrer, config.origins[0]), "https://external.example.invalid");
  assert.equal(analyticsReferrer("/study/example?private=x", config.origins[0]), "/study/example");
  assert.equal(analyticsReferrer("https://name:password@example.invalid", config.origins[0]), "");
  assert.equal(analyticsReferrer("", config.origins[0]), "");
});

test("the relay sends only approved fields, server-selected node, canonical hostname and trusted client address", async () => {
  let calls = 0;
  const send = (async (url, init) => {
    calls++; assert.equal(url, config.endpoint); assert.equal(init?.redirect, "error");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("x-analytics-key"), config.secret);
    assert.equal(headers.get("x-analytics-client-ip"), "192.0.2.10");
    assert.equal(headers.get("cookie"), null); assert.equal(headers.get("cf-ipcountry"), null);
    assert.deepEqual(JSON.parse(String(init?.body)), { type: "event", payload: { website: config.websiteId,
      hostname: config.hostname, url: "/study/example", referrer: "https://external.example.invalid", language: "zh-CN", tag: "region-a" } });
    return Response.json({ cache: "signed.fixture.cache", sessionId: "not-returned", visitId: "not-returned" });
  }) as typeof fetch;
  const response = await collectVisitor(request(payload, { Cookie: "secret=value", "CF-IPCountry": "XX", "X-Forwarded-For": "198.51.100.3" }), env, send);
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { cache: "signed.fixture.cache" }); assert.equal(calls, 1);
});

test("invalid, opted-out, cross-site, oversized and disabled requests do not reach the collector", async () => {
  const send = (() => { throw Error("UNEXPECTED_NETWORK"); }) as typeof fetch;
  for (const [req, expected] of [
    [request(payload, { Origin: "https://other.example.invalid" }), 403],
    [request(payload, { "Sec-Fetch-Site": "cross-site" }), 403],
    [request(payload, { "X-Real-IP": "not-an-ip" }), 400],
    [request(payload, { DNT: "1" }), 204], [request(payload, { "Sec-GPC": "1" }), 204],
    [request({ ...payload, ip: "198.51.100.1" }), 400],
    [request({ ...payload, path: "/api/private" }), 400],
    [request({ ...payload, cache: "x".repeat(9000) }), 400],
    [request(payload, { "Content-Length": "9000" }), 413],
  ] as const) assert.equal((await collectVisitor(req, env, send)).status, expected);
  assert.equal((await collectVisitor(request(), {}, send)).status, 404);
});

test("collector errors and oversized replies stay bounded, private and are never retried", async () => {
  for (const reply of [() => { throw Error("private failure"); }, () => new Response("private failure", { status: 500 }),
    () => new Response("x".repeat(10000))]) {
    let calls = 0;
    const response = await collectVisitor(request(), env, (async () => { calls++; return reply(); }) as typeof fetch);
    assert.equal(response.status, 503); assert.equal(await response.text(), ""); assert.equal(calls, 1);
  }
});

test("browser tracker counts committed pathname changes once, ignores query-only changes and honors opt-out", async () => {
  const sent: Record<string, unknown>[] = [];
  const browser: AnalyticsBrowser = { location: { origin: config.origins[0], pathname: "/" },
    navigator: { language: "en-AU" }, localStorage: { getItem: () => null }, fetch: (async (_url, init) => {
      assert.equal(init?.credentials, "omit"); sent.push(JSON.parse(String(init?.body))); return Response.json({ cache: "signed.fixture" });
    }) as typeof fetch };
  const track = createVisitorTracker(browser, payload.referrer);
  track("/"); track("/"); track("/?private=value"); track("/study"); track("/");
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(sent.map(v => v.path), ["/", "/study", "/"]);
  assert.deepEqual(sent.map(v => v.referrer), ["https://external.example.invalid", "/", "/study"]);
  browser.navigator.globalPrivacyControl = true; track("/status");
  browser.navigator.globalPrivacyControl = false; browser.localStorage.getItem = () => "1"; track("/status");
  assert.equal(sent.length, 3);
});
