import test from "node:test";
import assert from "node:assert/strict";
import { createWebsiteImageDownloader, websiteImageFailure, addWebsiteImageContext } from "../scripts/website-sync/download.ts";
import { finalizeWebsiteRun } from "../scripts/website-sync/finalize-run.ts";
import { WorkerError } from "../scripts/notion-sync/errors.ts";
import { DEMO_PNG, demoId } from "../scripts/notion-sync/demo.ts";
import { mapBounded } from "../src/server/notion/bounded-work.ts";
import type { ImageResponse } from "../scripts/notion-sync/download.ts";

const origin = "https://images.example.test";
const dns = async () => [{ address: "8.8.8.8", family: 4 }];
const response = (status = 200): ImageResponse => ({ status, headers: { "content-type": "image/png" },
  bytes: (async function* () { yield DEMO_PNG; })(), cancel() {} });
const unavailable = (error: unknown) => error instanceof WorkerError && error.code === "IMAGE_UNAVAILABLE";

test("the escaping image error retains its private diagnostic across a gap in peer image work", async t => {
  const bad = `${origin}/bad.png?signed=fixture-only`;
  let release!: () => void;
  const peer = new Promise<void>(resolve => { release = resolve; });
  const context = { ownerPageId: demoId(1), locator: { kind: "block" as const, id: demoId(2) } };
  const download = createWebsiteImageDownloader({ resolve: dns, request: async url => response(url.pathname === "/bad.png" ? 403 : 200) }, { now: () => 50 });
  t.after(download.close);
  let escaped: unknown;
  try {
    await mapBounded(["bad", "peer"], 2, async page => {
      if (page === "bad") {
        try { await download(bad); }
        catch (error) { addWebsiteImageContext(error, context); release(); throw error; }
      } else {
        await peer;
        await download(`${origin}/ok.png`);
      }
    });
    assert.fail("A partial collection must fail");
  } catch (error) { escaped = error; }
  assert.ok(unavailable(escaped));
  assert.equal(download.failure(), undefined, "An independent later image still clears the old compatibility slot");
  const diagnostic = websiteImageFailure(escaped)!;
  assert.equal(diagnostic.inputUrl, bad);
  assert.deepEqual(diagnostic.context, context);
  diagnostic.context!.ownerPageId = demoId(3);
  assert.equal(websiteImageFailure(escaped)!.context!.ownerPageId, demoId(1), "Callers cannot mutate stored diagnostics");
  const saved = new Map<string, unknown>();
  const report: Record<string, unknown> = { published: false, code: "IMAGE_UNAVAILABLE", runId: "fixture-run" };
  await finalizeWebsiteRun({ report, imageFailure: websiteImageFailure(escaped), save: async (name, value) => { saved.set(name, structuredClone(value)); } });
  assert.equal((saved.get("image-failure-private.json") as { inputUrl: string }).inputUrl, bad);
  assert.deepEqual((saved.get("image-failure-private.json") as { context: unknown }).context, context);
  const summary = JSON.stringify(saved.get("receipt-private.json"));
  for (const secret of ["signed", "example.test", demoId(1), demoId(2)]) assert.equal(summary.includes(secret), false);
});

test("temporary DNS failures retry within three attempts while permanent DNS failures stop", async t => {
  for (const code of ["EAI_AGAIN", "ENOTFOUND"]) {
    let lookups = 0, requests = 0;
    const download = createWebsiteImageDownloader({ resolve: async () => {
      if (++lookups < 3) throw Object.assign(new Error("private DNS details"), { code });
      return dns();
    }, request: async () => { requests++; return response(); } }, { wait: async () => {} });
    t.after(download.close);
    if (code === "EAI_AGAIN") {
      assert.deepEqual(Buffer.from((await download(`${origin}/a.png`)).bytes), DEMO_PNG);
      assert.equal(lookups, 3); assert.equal(requests, 1);
    } else {
      let escaped: unknown;
      await assert.rejects(download(`${origin}/a.png`), error => { escaped = error; return unavailable(error); });
      assert.equal(lookups, 1); assert.equal(requests, 0);
      assert.equal(websiteImageFailure(escaped)?.phase, "dns");
      assert.equal(websiteImageFailure(escaped)?.transportCode, "ENOTFOUND");
    }
  }
});

test("a cache read cancelled by the header deadline retries and records the correct deadline", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let reads = 0, requests = 0;
  const download = createWebsiteImageDownloader({ resolve: dns, timeoutMs: 1000, headerTimeoutMs: 20,
    request: async () => { requests++; return response(); } }, {
    cache: { read: async (_key, signal) => {
      reads++;
      return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(new WorkerError("CANCELLED")), { once: true }));
    }, write: async () => assert.fail("No image was downloaded") },
    wait: async () => {}, now: () => 0,
  });
  t.after(download.close);
  const parent = new AbortController();
  let escaped: unknown;
  const pending = assert.rejects(download(`${origin}/a.png`, parent.signal), error => { escaped = error; return unavailable(error); });
  const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
  for (const ms of [20, 40, 80]) { await flush(); t.mock.timers.tick(ms); }
  await pending;
  assert.equal(reads, 3); assert.equal(requests, 0); assert.equal(parent.signal.aborted, false);
  assert.equal(websiteImageFailure(escaped)?.timeoutKind, "headers");
  assert.equal(websiteImageFailure(escaped)?.phase, "cache");
  assert.equal(websiteImageFailure(escaped)?.attempt, 3);
  assert.equal(websiteImageFailure(escaped)?.attemptTimeoutMs, 1000);
});

test("an internal image deadline retries but caller cancellation never retries", async t => {
  let lookups = 0;
  const download = createWebsiteImageDownloader({ resolve: async () => {
    if (++lookups < 3) throw new WorkerError("CANCELLED");
    return dns();
  }, request: async () => response() }, { wait: async () => {} });
  t.after(download.close);
  await download(`${origin}/a.png`); assert.equal(lookups, 3);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(download(`${origin}/a.png`, cancelled.signal), { code: "CANCELLED" });
  assert.equal(lookups, 3);
});

test("diagnostic write failures preserve the original outcome, mandatory receipt and both closes", async () => {
  const calls: string[] = [];
  const report: Record<string, unknown> = { published: false, code: "IMAGE_UNAVAILABLE", outcome: "failed" };
  const diagnostic = { inputUrl: `${origin}/a.png`, attempt: 1, phase: "headers", elapsedMs: 10, attemptElapsedMs: 10, attemptTimeoutMs: 1000 };
  const clean = await finalizeWebsiteRun({ report, imageFailure: diagnostic,
    save: async name => { calls.push(name); if (name === "image-failure-private.json") throw Error("disk fault"); },
    closeImageTransport: () => { calls.push("transport"); },
    closeWriter: async () => { calls.push("writer"); }, closeReader: async () => { calls.push("reader"); },
  });
  assert.equal(clean, true); assert.equal(report.diagnosticWriteFailed, true);
  assert.equal(report.code, "IMAGE_UNAVAILABLE"); assert.equal(report.published, false);
  assert.equal(report.cleanupCompleted, true);
  assert.deepEqual(calls, ["image-failure-private.json", "receipt-private.json", "transport", "writer", "reader", "receipt-private.json"]);
});

test("failed cleanup and receipt writes still attempt every connection close without rewriting publication", async () => {
  const calls: string[] = [];
  const report: Record<string, unknown> = { published: true, readerVerified: true, outcome: "published-verified" };
  const clean = await finalizeWebsiteRun({ report, save: async () => { calls.push("receipt"); },
    closeImageTransport: () => { calls.push("transport"); throw Error("transport fault"); },
    closeWriter: async () => { calls.push("writer"); throw Error("writer fault"); }, closeReader: async () => { calls.push("reader"); },
  });
  assert.equal(clean, false); assert.deepEqual(report.cleanupFailures, ["image-transport", "writer"]);
  assert.equal(report.published, true); assert.equal(report.readerVerified, true);
  assert.deepEqual(calls, ["receipt", "transport", "writer", "reader", "receipt"]);
  calls.length = 0;
  await assert.rejects(finalizeWebsiteRun({ report, save: async () => { calls.push("receipt"); throw Error("receipt fault"); },
    closeWriter: async () => { calls.push("writer"); }, closeReader: async () => { calls.push("reader"); },
  }), /receipt fault/);
  assert.deepEqual(calls, ["receipt", "writer", "reader", "receipt"]);
});

test("publication truth is durable and reader closure starts even while writer closure is pending", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let readerClosed = false;
  const writes: unknown[] = [];
  const pending = finalizeWebsiteRun({ report: { published: true, readerVerified: true },
    save: async (_name, value) => { writes.push(structuredClone(value)); },
    closeWriter: async () => { await gate; }, closeReader: async () => { readerClosed = true; },
  });
  try {
    for (let i = 0; i < 20; i++) await Promise.resolve();
    assert.equal(readerClosed, true);
    assert.deepEqual(writes, [{ published: true, readerVerified: true, cleanupCompleted: false }]);
  } finally { release(); await pending; }
  assert.equal((writes.at(-1) as { cleanupCompleted: boolean }).cleanupCompleted, true);
});
