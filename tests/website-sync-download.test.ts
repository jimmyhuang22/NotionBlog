import assert from "node:assert/strict";
import test from "node:test";
import { createWebsiteImageDownloader } from "../scripts/website-sync/download.ts";
import { WorkerError } from "../scripts/notion-sync/errors.ts";
import { DEMO_PNG } from "../scripts/notion-sync/demo.ts";
import type { ImageResponse } from "../scripts/notion-sync/download.ts";
const dns = async () => [{ address: "8.8.8.8", family: 4 }];
const url = "https://images.example.test/image.png";
const code = (expected: string) => (error: unknown) => error instanceof WorkerError && error.code === expected;
const failure = (code: string) => Object.assign(new Error("private transport details"), { code });
function response(status = 200, bytes: AsyncIterable<Uint8Array> = (async function* () { yield DEMO_PNG; })(), headers: Record<string, string | undefined> = { "content-type": "image/png" }): ImageResponse {
  return { status, headers, bytes, cancel() {} };
}
test("v2 gives slow headers a longer retry window while keeping the image deadline", async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const download = createWebsiteImageDownloader({ resolve: dns, timeoutMs: 1000, headerTimeoutMs: 20,
    request: async (_url, _address, signal) => {
      if (++calls === 3) return response();
      return new Promise<ImageResponse>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(failure('ABORT_ERR')), { once: true });
      });
    },
  }, { wait: async () => {} });
  const flush = async () => { for (let n = 0; n < 30; n++) await Promise.resolve(); };
  const pending = download(url);
  await flush(); assert.equal(calls, 1);
  t.mock.timers.tick(20); await flush(); assert.equal(calls, 2);
  t.mock.timers.tick(20); await flush(); assert.equal(calls, 2);
  t.mock.timers.tick(20); await flush();
  assert.deepEqual(Buffer.from((await pending).bytes), DEMO_PNG);
  assert.equal(calls, 3);
});
test("an image's own deadline is unavailable while caller cancellation remains cancelled", async () => {
  let calls = 0;
  const controller = new AbortController();
  const download = createWebsiteImageDownloader({ resolve: dns, timeoutMs: 20, headerTimeoutMs: 20,
    request: async (_url, _address, signal) => {
      calls++;
      return new Promise<ImageResponse>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(failure('ABORT_ERR')), { once: true });
      });
    },
  }, { wait: async () => {} });
  // AbortSignal.timeout is unref'd. Keep this isolated mock transport alive.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(download(url, controller.signal), code('IMAGE_UNAVAILABLE'));
    assert.equal(controller.signal.aborted, false);
    assert.equal(calls, 3);
    assert.equal(download.failure()?.phase, 'headers');
    controller.abort();
    await assert.rejects(download(url, controller.signal), code('CANCELLED'));
    assert.equal(calls, 3);
  } finally { clearInterval(keepAlive); }
});

test("v2 retries transient gateways with bounded backoff and identical verified bytes", async t => {
  for (const status of [502, 503, 504]) await t.test(String(status), async () => {
    let calls = 0; const waits: number[] = [], events: number[] = [];
    const download = createWebsiteImageDownloader({ resolve: dns, request: async (_url, address, _signal, headers) => {
      assert.equal(address.address, "8.8.8.8"); assert.equal(headers.Host, "images.example.test");
      assert.equal(headers["User-Agent"], "NotionBlogSyncBot/1.0");
      return response(++calls < 3 ? status : 200);
    } }, { wait: async ms => { waits.push(ms); }, onRetry: event => { events.push(event.attempt); } });
    assert.deepEqual(Buffer.from((await download(url)).bytes), DEMO_PNG);
    assert.equal(calls, 3); assert.deepEqual(waits, [2000, 5000]); assert.deepEqual(events, [1, 2]);
  });
});
test("v2 retries observed socket or body interruptions and stops after three rounds", async t => {
  for (const transportCode of ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "ABORT_ERR"]) await t.test(transportCode, async () => {
    let calls = 0;
    const download = createWebsiteImageDownloader({ resolve: dns, request: async () => {
      if (++calls === 1) throw failure(transportCode); return response();
    } }, { wait: async () => {} });
    assert.deepEqual(Buffer.from((await download(url)).bytes), DEMO_PNG); assert.equal(calls, 2);
  });
  let calls = 0; const waits: number[] = [];
  const body = createWebsiteImageDownloader({ resolve: dns, request: async () => {
    calls++; return response(200, (async function* () { yield DEMO_PNG.subarray(0, 8); throw failure("ECONNRESET"); })());
  } }, { wait: async ms => { waits.push(ms); } });
  await assert.rejects(body(url), code("IMAGE_UNAVAILABLE")); assert.equal(calls, 3); assert.deepEqual(waits, [2000, 5000]);
  let recoveredCalls = 0;
  const recovered = createWebsiteImageDownloader({ resolve: dns, request: async () => ++recoveredCalls === 1 ?
    response(200, (async function* () { yield DEMO_PNG.subarray(0, 8); throw failure("ECONNRESET"); })()) : response()
  }, { wait: async () => {} });
  assert.deepEqual(Buffer.from((await recovered(url)).bytes), DEMO_PNG); assert.equal(recoveredCalls, 2);
});
test("v2 does not retry denials, other HTTP failures, TLS or unclassified errors", async t => {
  for (const status of [401, 403, 404, 410, 500, 501]) await t.test(String(status), async () => {
    let calls = 0;
    const download = createWebsiteImageDownloader({ resolve: dns, request: async () => { calls++; return response(status); } }, { wait: async () => assert.fail("No retry") });
    await assert.rejects(download(url), code("IMAGE_UNAVAILABLE")); assert.equal(calls, 1);
  });
  for (const transportCode of ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ERR_TLS_CERT_ALTNAME_INVALID", "UNCLASSIFIED"]) {
    let calls = 0;
    const download = createWebsiteImageDownloader({ resolve: dns, request: async () => { calls++; throw failure(transportCode); } }, { wait: async () => assert.fail("No retry") });
    await assert.rejects(download(url), code("IMAGE_UNAVAILABLE")); assert.equal(calls, 1);
  }
});
test("v2 obeys image Retry-After before bounded retries without trying another checked IP", async () => {
  for (const status of [429, 529]) {
    let calls = 0; const waits: number[] = [];
    const download = createWebsiteImageDownloader({ resolve: async () => [...await dns(), { address: "1.1.1.1", family: 4 }],
      request: async () => ++calls < 3 ? response(status, (async function* () {})(), { "retry-after": "10" }) : response()
    }, { wait: async ms => { waits.push(ms); } });
    assert.deepEqual(Buffer.from((await download(url)).bytes), DEMO_PNG);
    assert.equal(calls, 3); assert.deepEqual(waits, [10_000, 10_000]);
    assert.equal(download.statistics().rateLimitResponses, 2);
  }
  for (const [header, delay] of [[undefined, 60_000], ["invalid", 60_000], ["-1", 60_000], ["600", 600_000]] as const) {
    let calls = 0; const waits: number[] = [];
    const download = createWebsiteImageDownloader({ resolve: dns, request: async () => {
      calls++; return response(429, (async function* () {})(), { "retry-after": header });
    } }, { wait: async ms => { waits.push(ms); } });
    await assert.rejects(download(url), code("RATE_LIMITED"));
    assert.equal(calls, 3); assert.deepEqual(waits, [delay, delay]);
    assert.equal(download.failure()?.retryAfterSeconds, delay / 1000);
  }
});
test("v2 honors dated Retry-After independently of request scheduling delays", async t => {
  const now = Date.UTC(2026, 0, 1, 0, 0, 0, 250);
  t.mock.timers.enable({ apis: ['Date'], now });
  for (const elapsed of [0, 3500]) {
    t.mock.timers.setTime(now);
    const waits: number[] = []; let calls = 0;
    // HTTP dates have second precision; keep the fractional origin explicit.
    const date = new Date(Date.now() + 120_000).toUTCString();
    const dated = createWebsiteImageDownloader({ resolve: dns, request: async () => {
      if (++calls !== 1) return response();
      t.mock.timers.setTime(now + elapsed);
      return response(429, (async function* () {})(), { "retry-after": date });
    } }, { wait: async ms => { waits.push(ms); } });
    await dated(url);
    assert.equal(calls, 2);
    assert.deepEqual(waits, [119_750 - elapsed]);
  }
});
test("v2 rejects timer overflow and cancels rate cooldowns", async () => {
  let calls = 0;
  const overflow = createWebsiteImageDownloader({ resolve: dns, request: async () => {
    calls++; return response(429, (async function* () {})(), { "retry-after": "999999999999999999999" });
  } }, { wait: async () => assert.fail("An overflow must never cause an early retry") });
  await assert.rejects(overflow(url), code("RATE_LIMITED")); assert.equal(calls, 1);
  const controller = new AbortController(); calls = 0;
  const cancelled = createWebsiteImageDownloader({ resolve: dns, request: async () => { calls++; return response(429); } });
  const timer = setTimeout(() => controller.abort(), 10), started = Date.now();
  try { await assert.rejects(cancelled(url, controller.signal), code("CANCELLED")); } finally { clearTimeout(timer); }
  assert.equal(calls, 1); assert.ok(Date.now() - started < 1500);
});
test("v2 scopes a validated Wikimedia identity without changing other image cache identities", async () => {
  const agents: string[] = [];
  const options = { resolve: dns, wikimediaUserAgent: "NotionBlogSyncBot/1.0 (https://example.test/)",
    request: async (_url: URL, _address: unknown, _signal: unknown, headers: Readonly<Record<string, string>>) => {
      agents.push(headers["User-Agent"]); return response();
    } };
  const download = createWebsiteImageDownloader(options);
  await download(url); await download("https://upload.wikimedia.org/image.png"); await download(url);
  assert.deepEqual(agents, ["NotionBlogSyncBot/1.0", options.wikimediaUserAgent, "NotionBlogSyncBot/1.0"]);
  assert.throws(() => createWebsiteImageDownloader({ wikimediaUserAgent: "bad\r\nHost: localhost" }), code("MISCONFIGURED"));
});
test("v2 keeps byte, DNS and redirect rejection guards without retry", async () => {
  let calls = 0;
  const malformed = createWebsiteImageDownloader({ resolve: dns, request: async () => { calls++; return response(200, (async function* () { yield Buffer.from("not an image"); })()); } }, { wait: async () => assert.fail("No retry") });
  await assert.rejects(malformed(url), code("IMAGE_REJECTED")); assert.equal(calls, 1);
  const oversized = createWebsiteImageDownloader({ resolve: dns, maxBytes: 2, request: async () => response() }, { wait: async () => assert.fail("No retry") });
  await assert.rejects(oversized(url), code("IMAGE_REJECTED"));
  const privateDns = createWebsiteImageDownloader({ resolve: async () => [...await dns(), { address: "10.0.0.1", family: 4 }], request: async () => assert.fail("No private socket") });
  await assert.rejects(privateDns(url), code("IMAGE_REJECTED"));
  const redirect = createWebsiteImageDownloader({ resolve: dns, request: async () => response(302, (async function* () {})(), { "content-type": "image/png", location: "https://127.0.0.1/" }) }, { wait: async () => assert.fail("No retry") });
  await assert.rejects(redirect(url), code("IMAGE_REJECTED"));
  assert.throws(() => createWebsiteImageDownloader({ userAgent: "bot\r\nHost: localhost" }), code("MISCONFIGURED"));
});
test("v2 honors caller cancellation during a request and during backoff", async () => {
  const controller = new AbortController(); let calls = 0, waits = 0;
  const request = createWebsiteImageDownloader({ resolve: dns, request: async () => { calls++; controller.abort(); throw failure("ABORT_ERR"); } }, { wait: async () => { waits++; } });
  await assert.rejects(request(url, controller.signal), code("CANCELLED")); assert.equal(calls, 1); assert.equal(waits, 0);
  const backoffController = new AbortController(); calls = 0;
  const backoff = createWebsiteImageDownloader({ resolve: dns, request: async () => { calls++; return response(503); } }, { wait: async () => { backoffController.abort(); throw failure("ABORT_ERR"); } });
  await assert.rejects(backoff(url, backoffController.signal), code("CANCELLED")); assert.equal(calls, 1);
});
test("v2 does not reuse an earlier address failure to retry a later denial or bad body", async () => {
  for (const status of [403, 200]) {
    let calls = 0;
    const download = createWebsiteImageDownloader({ resolve: async () => [...await dns(), { address: "1.1.1.1", family: 4 }], request: async () => {
      if (++calls === 1) throw failure("ECONNRESET");
      return response(status, (async function* () { if (status === 200) throw new Error("not a transport interruption"); })());
    } }, { wait: async () => assert.fail("The last request is not retryable") });
    await assert.rejects(download(url), code("IMAGE_UNAVAILABLE")); assert.equal(calls, 2);
  }
});
test("v2 native backoff is interrupted by caller cancellation", async () => {
  const controller = new AbortController(); let calls = 0;
  const download = createWebsiteImageDownloader({ resolve: dns, request: async () => { calls++; return response(503); } });
  const timer = setTimeout(() => controller.abort(), 10), began = Date.now();
  try { await assert.rejects(download(url, controller.signal), code("CANCELLED")); }
  finally { clearTimeout(timer); }
  assert.equal(calls, 1); assert.ok(Date.now() - began < 1500, "Cancellation must interrupt the two-second backoff");
});

test("v2 terminal failure preserves the failing redirect only in a separate private diagnostic", async () => {
  let calls = 0;
  const privateUrl = "https://images.example.test/private.png?signed=fixture-only";
  const download = createWebsiteImageDownloader({ resolve: dns, request: async () => ++calls === 1 ?
    response(302, (async function* () {})(), { location: privateUrl }) : response(403)
  }, { wait: async () => assert.fail("A denial must stop"), now: () => 100 });
  await assert.rejects(download(url), code("IMAGE_UNAVAILABLE"));
  assert.equal(calls, 2);
  assert.deepEqual(download.failure(), { inputUrl: url, requestUrl: privateUrl, requestHost: "images.example.test", attempt: 1,
    httpStatus: 403, transportCode: undefined, phase: "response", elapsedMs: 0, attemptElapsedMs: 0, attemptTimeoutMs: 20000 });
  assert.equal(JSON.stringify(download.statistics()).includes("signed"), false);
  assert.equal(JSON.stringify(download.statistics()).includes("example.test"), false);
});

test("v2 identifies a truncated body without widening retries and clears stale failure on success", async () => {
  let calls = 0;
  const download = createWebsiteImageDownloader({ resolve: dns, request: async () => ++calls === 1 ?
    response(200, (async function* () { throw failure("ERR_STREAM_PREMATURE_CLOSE"); })()) : response()
  }, { wait: async () => assert.fail("Unclassified recovery remains closed") });
  await assert.rejects(download(url), code("IMAGE_UNAVAILABLE"));
  assert.equal(download.failure()?.transportCode, "ERR_STREAM_PREMATURE_CLOSE");
  assert.equal(download.failure()?.phase, "body");
  assert.deepEqual(Buffer.from((await download(url)).bytes), DEMO_PNG);
  assert.equal(download.failure(), undefined);
});

test("v2 prefers a working address only while it remains in fresh fully validated DNS answers", async () => {
  let resolutions = 0; const called: string[] = [];
  const download = createWebsiteImageDownloader({ resolve: async () => {
    resolutions++; return resolutions === 3 ? [{ address: "8.8.8.8", family: 4 }] :
      [{ address: "8.8.8.8", family: 4 }, { address: "1.1.1.1", family: 4 }];
  }, request: async (_url, address) => { called.push(address.address);
    if (called.length === 1) throw failure("ECONNRESET"); return response(); } });
  await download(url); await download(url + "?second=1"); await download(url + "?third=1");
  assert.equal(resolutions, 3); assert.deepEqual(called, ["8.8.8.8", "1.1.1.1", "1.1.1.1", "8.8.8.8"]);
  let privateAnswer = false;
  const guard = createWebsiteImageDownloader({ resolve: async () => privateAnswer ?
    [{ address: "1.1.1.1", family: 4 }, { address: "10.0.0.1", family: 4 }] : [{ address: "1.1.1.1", family: 4 }], request: async () => response() });
  await guard(url); privateAnswer = true; await assert.rejects(guard(url), code("IMAGE_REJECTED"));
});

test("the first terminal image failure remains available while other pages drain", async () => {
  let release!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  const download = createWebsiteImageDownloader({ resolve: dns, request: async address => {
    if(address.pathname === "/slow.png") await gate;
    return response(address.pathname === "/bad.png" ? 403 : 200);
  } });
  const slow = download("https://images.example.test/slow.png");
  try {
    const bad = "https://images.example.test/bad.png";
    await assert.rejects(download(bad));
    assert.equal(download.failure()?.inputUrl, bad);
    await download(url);
    assert.equal(download.failure()?.inputUrl, bad);
    release(); await slow;
    assert.equal(download.failure()?.inputUrl, bad);
    await download(url); assert.equal(download.failure(), undefined);
  } finally { release(); await slow; }
});
