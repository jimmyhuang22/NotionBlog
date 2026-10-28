import assert from "node:assert/strict";
import test from "node:test";
import { createSearchLimiter, searchClientKey, SearchRateLimitedError, SEARCH_LIMITS } from "../src/server/search-rate-limit.ts";
import { websiteQueryResponse } from "../src/lib/content/website-http.ts";
import type { ContentRepository } from "../contracts/repository.ts";

const ok = async () => "done";
const refused = (seconds: number) => (error: unknown) =>
  error instanceof SearchRateLimitedError && error.code === "RATE_LIMITED" && error.retryAfterSeconds === seconds;

test("one client gets a burst of 12, then one search every two seconds", async () => {
  let now = 0;
  const limiter = createSearchLimiter(SEARCH_LIMITS, () => now);
  for (let i = 0; i < 12; i++) assert.equal(await limiter.run("a", ok), "done");
  let ran = false;
  await assert.rejects(limiter.run("a", async () => { ran = true; }), refused(2));
  assert.equal(ran, false, "a refused search never reaches the repository");
  now = 1000;
  await assert.rejects(limiter.run("a", ok), refused(1));
  now = 2000;
  assert.equal(await limiter.run("a", ok), "done");
  await assert.rejects(limiter.run("a", ok), refused(2));
  // Another client is not affected.
  assert.equal(await limiter.run("b", ok), "done");
});

test("one instance stops at 60 searches at once, then three a second, across clients", async () => {
  let now = 0;
  const limiter = createSearchLimiter(SEARCH_LIMITS, () => now);
  for (let i = 0; i < 60; i++) await limiter.run(`client-${i}`, ok);
  await assert.rejects(limiter.run("fresh", ok), refused(1));
  now = 1000;
  for (let i = 0; i < 3; i++) await limiter.run(`later-${i}`, ok);
  await assert.rejects(limiter.run("fresh", ok), refused(1));
});

test("no more than eight searches run at the same time, and a failed one frees its place", async () => {
  const limiter = createSearchLimiter(SEARCH_LIMITS, () => 0);
  const gates: Array<() => void> = [];
  const pending = Array.from({ length: 8 }, (_, i) => limiter.run(`c${i}`, () => new Promise<string>(resolve => gates.push(() => resolve("late")))));
  assert.equal(limiter.running, 8);
  await assert.rejects(limiter.run("c8", ok), refused(1));
  gates.shift()!();
  assert.equal(await pending[0], "late");
  await assert.rejects(limiter.run("c9", async () => { throw new Error("database down"); }), /database down/);
  assert.equal(limiter.running, 7);
  assert.equal(await limiter.run("c10", ok), "done");
  for (const open of gates) open();
  await Promise.all(pending);
  assert.equal(limiter.running, 0);
});

test("memory stays bounded: the least recently seen client is forgotten first", async () => {
  const limiter = createSearchLimiter({ ...SEARCH_LIMITS, maxClients: 3, instance: { capacity: 1000, refillPerSecond: 0 } }, () => 0);
  for (const client of ["a", "b", "c", "a", "d"]) await limiter.run(client, ok);
  assert.equal(limiter.clients, 3);
  // "b" was the oldest and was dropped, so it starts again with a full burst.
  for (let i = 0; i < 12; i++) await limiter.run("b", ok);
  await assert.rejects(limiter.run("b", ok), refused(2));
});

test("clients are keyed by IPv4 address or IPv6 /64, from the proxy's address headers", () => {
  const key = (init: Record<string, string>) => searchClientKey(new Headers(init));
  assert.equal(key({ "x-real-ip": "203.0.113.7" }), "203.0.113.7");
  assert.equal(key({ "x-forwarded-for": "203.0.113.8, 10.0.0.1" }), "203.0.113.8");
  assert.equal(key({ "x-real-ip": "203.0.113.9", "x-forwarded-for": "198.51.100.1" }), "203.0.113.9");
  assert.equal(key({ "x-real-ip": "2001:db8:0:12:aaaa::1" }), "2001:db8:0:12::/64");
  assert.equal(key({ "x-real-ip": "2001:0db8:0000:0012:bbbb:cccc:dddd:eeee" }), "2001:db8:0:12::/64");
  assert.equal(key({ "x-real-ip": "2001:db8::5" }), "2001:db8:0:0::/64");
  assert.equal(key({ "x-real-ip": "[2001:db8::5]" }), "2001:db8:0:0::/64");
  assert.equal(key({ "x-real-ip": "::ffff:203.0.113.7" }), "203.0.113.7");
  assert.equal(key({ "x-real-ip": "not-an-address" }), null);
  assert.equal(key({}), null);
});

test("without a client address only the instance limits apply", async () => {
  let now = 0;
  const limiter = createSearchLimiter(SEARCH_LIMITS, () => now);
  for (let i = 0; i < 60; i++) await limiter.run(null, ok);
  assert.equal(limiter.clients, 0);
  await assert.rejects(limiter.run(null, ok), refused(1));
});

test("separately bundled copies share one count, and each raises its own refusal class", async () => {
  // Next gives the route handler and the search page separate copies of the module.
  const module = new URL("../src/server/search-rate-limit.ts", import.meta.url).href;
  const routeCopy = await import(`${module}?copy=route`) as typeof import("../src/server/search-rate-limit.ts");
  const pageCopy = await import(`${module}?copy=page`) as typeof import("../src/server/search-rate-limit.ts");
  assert.notEqual(routeCopy.SearchRateLimitedError, pageCopy.SearchRateLimitedError);
  const headers = new Headers({ "x-real-ip": "192.0.2.150" });
  for (let i = 0; i < 12; i++) await routeCopy.limitSearch(headers, ok);
  await assert.rejects(pageCopy.limitSearch(headers, ok), error => error instanceof pageCopy.SearchRateLimitedError && error.retryAfterSeconds === 2);
});

test("/api/search answers a refused search with RATE_LIMITED and Retry-After, without reading", async () => {
  let reads = 0;
  const repository = { search: async () => { reads++; return { items: [], nextCursor: null, total: 0 }; } } as unknown as ContentRepository;
  const request = () => new Request("https://example.test/api/search?q=word", { headers: { "x-real-ip": "192.0.2.201" } });
  for (let i = 0; i < 12; i++) assert.equal((await websiteQueryResponse(request(), repository, "search")).status, 200);
  const response = await websiteQueryResponse(request(), repository, "search");
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Retry-After"), "2");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal((await response.json()).error.code, "RATE_LIMITED");
  assert.equal(reads, 12);
  // The timeline endpoint shares the wrapper but is not limited.
  const timeline = { getTimeline: async () => ({ items: [], nextCursor: null }) } as unknown as ContentRepository;
  for (let i = 0; i < 20; i++) assert.equal((await websiteQueryResponse(new Request("https://example.test/api/timeline", { headers: { "x-real-ip": "192.0.2.201" } }), timeline, "timeline")).status, 200);
});
