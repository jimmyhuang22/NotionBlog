import test from "node:test";
import assert from "node:assert/strict";
import { POST } from "../src/app/api/render/snippets/route.ts";
import { createSearchLimiter } from "../src/server/search-rate-limit.ts";
import { RENDER_LIMITS } from "../src/server/render-rate-limit.ts";

const url = "http://127.0.0.1:3000/api/render/snippets";
const equation = { id: "formula", kind: "equation", expression: "a^2" };
const request = (body: unknown, headers: Record<string, string> = {}) => new Request(url, {
  method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
});
function streaming(body: ReadableStream<Uint8Array>, signal?: AbortSignal) {
  return new Request(url, {
    method: "POST", headers: { "Content-Type": "application/json" }, body, signal, duplex: "half",
  } as RequestInit & { duplex: "half" });
}

test("the POST route renders both kinds without reading content and refuses cross-origin requests", async () => {
  const response = await POST(request([equation, { id: "code", kind: "code", code: "const x = 1;", language: "javascript" }]));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const html = await response.json();
  assert.match(html.formula, /katex/);
  assert.match(html.code, /var\(--code-key\)/);
  const deniedHeaders: Record<string, string>[] = [
    { Origin: "http://other.example.invalid" },
    { Origin: "https://127.0.0.1:3000" },
    { "Sec-Fetch-Site": "cross-site" },
  ];
  for (const headers of deniedHeaders) assert.equal((await POST(request([equation], headers))).status, 403);
  assert.equal((await POST(request([], { Host: "blog.example.invalid", Origin: "https://blog.example.invalid", "X-Forwarded-Proto": "https" }))).status, 200);
});

test("invalid snippet shapes and source overflow return an uncached error instead of a successful empty result", async () => {
  for (const body of [
    {}, [null], [{ ...equation, expression: 1 }], Array(25).fill(equation), [{ ...equation, expression: "x".repeat(60_001) }],
  ]) {
    const response = await POST(request(body));
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal((await response.json()).error.code, "INVALID_QUERY");
  }
});

test("wire input is bounded even without Content-Length and UTF-8/JSON failures stay sanitized", async () => {
  const invalidHeaders: Record<string, string>[] = [
    { "Content-Length": String(400 * 1024 + 1) }, { "Content-Encoding": "gzip" }, { "Content-Length": "unknown" },
  ];
  for (const headers of invalidHeaders) assert.equal((await POST(request([], headers))).status, 400);
  let cancelled = false;
  const oversized = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(400 * 1024 + 1)); },
    cancel() { cancelled = true; },
  });
  assert.equal((await POST(streaming(oversized))).status, 400);
  assert.equal(cancelled, true);
  const invalidUtf8 = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(Uint8Array.of(0xff)); controller.close(); },
  });
  const response = await POST(streaming(invalidUtf8));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: { code: "INVALID_QUERY", message: "Invalid rendering request." } });
});

test("two admitted uploads bound concurrency, a rejected third has Retry-After, and aborts release both slots", async () => {
  const firstAbort = new AbortController(), secondAbort = new AbortController();
  const first = POST(streaming(new ReadableStream(), firstAbort.signal));
  const second = POST(streaming(new ReadableStream(), secondAbort.signal));
  const rejected = await POST(request([equation]));
  assert.equal(rejected.status, 503);
  assert.equal(rejected.headers.get("retry-after"), "1");
  assert.equal(rejected.headers.get("cache-control"), "no-store");
  assert.equal((await rejected.json()).error.code, "RATE_LIMITED");
  firstAbort.abort(); secondAbort.abort();
  assert.deepEqual((await Promise.all([first, second])).map(response => response.status), [400, 400]);
  assert.equal((await POST(request([equation]))).status, 200);
});

test("a stalled upload reaches its body deadline and releases its admission", async () => {
  const keepAlive = setTimeout(() => {}, 5000);
  try {
    const response = await POST(streaming(new ReadableStream()));
    assert.equal(response.status, 400);
    assert.equal((await POST(request([]))).status, 200);
  } finally {
    clearTimeout(keepAlive);
  }
});

test("fully JSON-escaped input still accepts the supported 24 snippets and 60,000 source characters", async () => {
  const snippets = Array.from({ length: 24 }, (_, index) => ({
    id: index + "\u0000".repeat(125), kind: "code", language: "\u0000".repeat(64), code: "\u0000".repeat(2500),
  }));
  const response = await POST(request(snippets));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {});
});

test("render policy has independent buckets with the proposed visitor, instance and concurrency bounds", () => {
  let now = 0;
  const visitor = createSearchLimiter(RENDER_LIMITS, () => now);
  for (let i = 0; i < 12; i++) {
    const admitted = visitor.admit("visitor");
    assert.ok("release" in admitted); admitted.release();
  }
  assert.deepEqual(visitor.admit("visitor"), { retryAfterSeconds: 2 });
  now = 2000;
  const refilled = visitor.admit("visitor");
  assert.ok("release" in refilled); refilled.release();
  const instance = createSearchLimiter(RENDER_LIMITS, () => 0);
  for (let i = 0; i < 24; i++) {
    const admitted = instance.admit(String(i));
    assert.ok("release" in admitted); admitted.release();
  }
  assert.deepEqual(instance.admit("another"), { retryAfterSeconds: 1 });
});
