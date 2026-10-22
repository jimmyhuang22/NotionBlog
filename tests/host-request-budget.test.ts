import test from "node:test";
import assert from "node:assert/strict";
import https, { request as namedRequest, get as namedGet } from "node:https";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { createRequestBudget, createBudgetRequest, installRequestBudget } from "../scripts/website-incremental-sync/request-budget.ts";

const storageOrigin = "https://fiction.cos.example.test";
const options = () => ({ limits: { notion: 2, storage: 2, imageOrigin: 2, total: 3 }, storageOrigin, deadline: Date.now() + 10000 });
test("concurrent reservations and aggregate limits prevent excess transports, including failed attempts", async () => {
  let calls = 0;
  const budget = createRequestBudget({ ...options(), transport: async () => { calls++; return new Response(); } });
  try {
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => budget.fetch(storageOrigin)));
    assert.equal(calls, 2); assert.equal(results.filter(r => r.status === "rejected").length, 4);
    assert.equal(budget.statistics().storage, 2); assert.equal(budget.statistics().total, 2);
  } finally { budget.close(); }
  const failed = createRequestBudget({ ...options(), transport: async () => { throw Error("Synthetic transport failure"); } });
  try { await assert.rejects(failed.fetch(storageOrigin)); assert.equal(failed.statistics().total, 1); }
  finally { failed.close(); }
});
test("fetch and pinned native HTTPS share one ceiling and preserve TLS/Host/SNI/callback", async () => {
  const budget = createRequestBudget({ ...options(), transport: async () => new Response() });
  let calls = 0;
  const callback = () => {};
  const request = createBudgetRequest(budget, ((opts: https.RequestOptions, cb: unknown) => {
    calls++; assert.equal(opts.hostname, "8.8.8.8"); assert.equal(opts.servername, "images.example.test");
    assert.equal((opts.headers as Record<string, string>).Host, "images.example.test");
    assert.equal(opts.rejectUnauthorized, true); assert.equal(cb, callback); assert.equal(opts.signal?.aborted, false);
    return {};
  }) as unknown as typeof https.request);
  try {
    await budget.fetch("https://api.notion.com/v1/fiction"); await budget.fetch(storageOrigin);
    const opts = { hostname: "8.8.8.8", servername: "images.example.test", headers: { Host: "images.example.test" }, rejectUnauthorized: true };
    request(opts, callback);
    assert.throws(() => request(opts, callback), { code: "HTTP_BUDGET_REQUEST_LIMIT" });
    assert.equal(calls, 1); assert.equal(budget.statistics().total, 3);
  } finally { budget.close(); }
});
test("zero-source recovery ceilings, unsafe URLs and source mutations stop before transport", async () => {
  let calls = 0;
  for (const [url, method, limits] of [
    ["https://api.notion.com/v1/fiction", "GET", { notion: 0, storage: 0, imageOrigin: 0, total: 0 }],
    ["http://images.example.test/fiction", "GET", options().limits],
    ["https://images.example.test/fiction", "PUT", options().limits],
  ] as const) {
    const budget = createRequestBudget({ ...options(), limits, transport: async () => { calls++; return new Response(); } });
    try { await assert.rejects(budget.fetch(url, { method })); } finally { budget.close(); }
  }
  assert.equal(calls, 0);
});
test("hidden fetch redirects are refused and caller cancellation reaches the transport", async () => {
  const controller = new AbortController();
  const budget = createRequestBudget({ ...options(), transport: async (_input, init) => {
    assert.equal(init?.redirect, "error");
    return new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(Error("Synthetic abort")), { once: true }));
  } });
  try { const pending = budget.fetch(storageOrigin, { redirect: "follow", signal: controller.signal }); controller.abort();
    await assert.rejects(pending); assert.equal(budget.statistics().total, 1); } finally { budget.close(); }
});
test("expired and in-flight deadline requests stop without a retry", async () => {
  let calls = 0;
  const expired = createRequestBudget({ ...options(), deadline: Date.now() - 1, transport: async () => { calls++; return new Response(); } });
  try { await assert.rejects(expired.fetch(storageOrigin), { code: "HTTP_BUDGET_DEADLINE" }); assert.equal(calls, 0); } finally { expired.close(); }
  const running = createRequestBudget({ ...options(), deadline: Date.now() + 20, transport: async (_input, init) => {
    calls++; return new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(Error("Synthetic abort")), { once: true }));
  } });
  try { await Promise.all([assert.rejects(running.fetch(storageOrigin)), new Promise(resolve => setTimeout(resolve, 40))]);
    assert.equal(calls, 1); assert.equal(running.statistics().failure, "HTTP_BUDGET_DEADLINE"); } finally { running.close(); }
});
test("native named request/get imports are counted once and all bindings restore", () => {
  const original = { request: https.request, get: https.get, fetch: globalThis.fetch }; let calls = 0, ended = 0;
  const budget = installRequestBudget({ ...options(), nativeTransport: (() => { calls++; return { end() { ended++; } }; }) as unknown as typeof https.request });
  try { namedRequest("https://images.example.test/fiction"); namedGet("https://images.example.test/fiction2");
    assert.equal(calls, 2); assert.equal(ended, 1); assert.equal(budget.statistics().imageOrigin, 2); }
  finally { budget.restore(); }
  assert.equal(namedRequest, original.request); assert.equal(namedGet, original.get); assert.equal(globalThis.fetch, original.fetch);
});
test("actual website downloader follows counted native requests without changing pinned TLS", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  let calls = 0;
  const budget = installRequestBudget({ ...options(), limits: { ...options().limits, imageOrigin: 1 }, nativeTransport: ((opts: https.RequestOptions, cb: (r: unknown) => void) => {
    calls++; assert.equal(opts.hostname, "8.8.8.8"); assert.equal(opts.servername, "images.example.test"); assert.equal(opts.rejectUnauthorized, true);
    const request = new EventEmitter() as EventEmitter & { end(): void };
    request.end = () => queueMicrotask(() => { const response = Object.assign(Readable.from([png]), { statusCode: 200,
      headers: { "content-type": "image/png", "content-length": String(png.length) } }); cb(response); }); return request;
  }) as unknown as typeof https.request });
  try {
    const { createWebsiteImageDownloader } = await import("../scripts/website-sync/download.ts");
    const download = createWebsiteImageDownloader({ resolve: async () => [{ address: "8.8.8.8", family: 4 }] });
    assert.deepEqual((await download("https://images.example.test/fiction.png")).bytes, png);
    await assert.rejects(download("https://images.example.test/other.png")); assert.equal(calls, 1);
  } finally { budget.restore(); }
});
