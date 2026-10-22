import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { config, hash, publicationKey, SocialSyncError } from "../scripts/social-sync/model.ts";
import { collectVideo, observation } from "../scripts/social-sync/bilibili.ts";
import { openStore } from "../scripts/social-sync/store.ts";
import { executeRefresh, refreshRequest } from "../scripts/social-sync/refresh-executor.ts";
import { inspectRefresh } from "../scripts/social-sync/refresh-state.ts";
import { parseBilibiliHealth, runBilibiliCycle, trackedBilibiliRequest } from "../scripts/social-sync/bilibili-cycle.ts";
import type { BilibiliCyclePorts, BilibiliHealth, PreviousCycle } from "../scripts/social-sync/bilibili-cycle.ts";
import { runCycleCli } from "../scripts/social-sync/cycle-cli.ts";
import { emptyUploadCost } from "../scripts/social-sync/cycle-cloud.ts";

const initial = "2026-01-02T00:00:00.000Z", begin = "2026-01-03T00:00:00.000Z";
async function harness(t: { after: (f: () => Promise<void>) => void }, size = 1) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nb-bilibili-health-"))); await chmod(root, 0o700);
  const store = (await openStore(root))!; t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const targets = config({ version: 1, publications: Array.from({ length: size }, (_, i) => ({ platform: "bilibili", accountId: "10001",
    workId: `example-health-${i}`, url: `https://www.bilibili.com/video/BV${String(i + 1).padStart(10, "0")}/` })) });
  let clock = begin, calls = 0, previous: PreviousCycle | null = null, health: BilibiliHealth | null = null;
  const html = (target: typeof targets[number]) => `<script>window.__INITIAL_STATE__=${JSON.stringify({ videoData: { bvid: target.publicationId, owner: { mid: 10001 }, title: "Example", stat: { like: 5, reply: 0 } } })};</script>`;
  const sample = (target: typeof targets[number], at = clock) => observation(html(target), target, at);
  for (const target of targets) { const row = sample(target, initial); store.ingest(row); store.acknowledge(publicationKey(target), hash(JSON.stringify(row))); }
  const scope = { version: 1, reviewedAt: initial, cadence: { bilibiliHours: 6, xiaohongshuHours: 24 }, stateDirectories: { publications: root, collections: root },
    publications: targets.map(target => ({ target, kind: "video" })), collections: [] };
  await writeFile(join(root, "refresh-config.json"), JSON.stringify(scope), { mode: 0o600 });
  let fail: string | null = null, wrongReceipt = false, busy = false;
  const ports: BilibiliCyclePorts = {
    inspect: () => inspectRefresh(root, "bilibili", clock),
    execute: async (keys, _digest, observe) => {
      if (busy) throw Object.assign(Error("locked"), { code: "BUSY" });
      return executeRefresh(scope, { publications: store, collections: null, checkScope: async () => {}, saveReview: async () => {}, progress: async () => {},
        sendPublication: async item => ({ key: item.key, sha256: wrongReceipt ? "0".repeat(64) : item.sha256 }), sendCollection: async () => { throw Error("unexpected collection"); } },
      { platform: "bilibili", limit: 20, keys, observe, now: () => clock, spacingMs: 0,
        collectPublication: async target => { calls++; if (fail) throw new SocialSyncError(fail); return sample(target); } });
    },
    saveCycle: async cycle => { previous = structuredClone(cycle); }, saveHealth: async value => { health = structuredClone(value); },
  };
  return { root, store, scope, targets, sample, ports, calls: () => calls,
    run: (command: "run" | "resume" = "run", signal?: AbortSignal) => runBilibiliCycle(command, previous, health, ports, { now: () => clock, signal }),
    health: () => health!, previous: () => previous!, setPrevious: (value: PreviousCycle) => { previous = value; }, setHealth: (value: BilibiliHealth) => { health = value; },
    setFail: (value: string | null) => { fail = value; }, setWrongReceipt: (value: boolean) => { wrongReceipt = value; }, setBusy: (value: boolean) => { busy = value; },
    setTime: (value: string) => { clock = value; }, advance: (minutes: number) => { clock = new Date(Date.parse(clock) + minutes * 60000).toISOString(); } };
}

test("an idle Bilibili check keeps source dates and the last real upload, with no execution", async t => {
  const f = await harness(t); const good = await f.run(); assert.equal(good.state, "complete"); assert.equal(good.lastUploadedAt, begin);
  let inspections = 0; const inspect = f.ports.inspect; f.ports.inspect = () => { inspections++; return inspect(); };
  f.advance(15); const idle = await f.run(); assert.equal(idle.state, "idle"); assert.equal(f.calls(), 1); assert.equal(inspections, 1);
  assert.equal(idle.lastCollectedAt, begin); assert.equal(idle.lastUploadedAt, begin); assert.equal(idle.plan!.nextDueAt, "2026-01-03T06:00:00.000Z");
  assert.equal(idle.plan!.due, 0); assert.equal(idle.cost.captureMs, 0); assert.equal(idle.cost.uploadMs, 0); assert.equal(idle.cost.sourceRequests, 0);
  assert.equal(f.store.status().pending, 0); assert.equal(f.store.latest(f.targets[0]!)!.metrics.comments, 0);
  assert.deepEqual(parseBilibiliHealth({ ...idle, privateCredential: "not for stdout" }), idle);
});
test("capture and acknowledged upload are recorded separately and the post-run plan is fresh", async t => {
  const f = await harness(t, 2); const result = await f.run();
  assert.equal(result.cycle!.uploaded, 2); assert.equal(result.lastCollectedAt, begin); assert.equal(result.lastUploadedAt, begin);
  assert.equal(result.plan!.fresh, 2); assert.equal(result.plan!.pending, 0); assert(result.cost.captureMs > 0); assert(result.cost.uploadMs > 0);
  assert.equal(result.recovery.failures, 0); assert.equal(result.recovery.retryAt, null); assert.equal(f.store.status().samples, 4);
});
test("a source timeout waits for its persisted retry deadline before another request", async t => {
  const f = await harness(t); f.setFail("SOURCE_TIMEOUT"); const failed = await f.run();
  assert.equal(failed.state, "retry-wait"); assert.equal(failed.recovery.retryAt, "2026-01-03T00:15:00.000Z"); assert.equal(failed.recovery.failures, 1);
  assert.equal(f.store.latest(f.targets[0]!)!.observedAt, initial); assert.equal(failed.lastUploadedAt, null);
  f.advance(10); await f.run(); assert.equal(f.calls(), 1); assert.equal(f.health().recovery.failures, 1);
  f.advance(5); f.setFail(null); const recovered = await f.run(); assert.equal(recovered.state, "complete"); assert.equal(f.calls(), 2);
  assert.equal(recovered.lastCollectedAt, "2026-01-03T00:15:00.000Z"); assert.equal(recovered.recovery.failures, 0);
});
test("three delayed retries use 15/30/60 minutes and exhaustion requires manual recovery", async t => {
  const f = await harness(t); f.setFail("SOURCE_NETWORK_ERROR");
  for (const [i, minutes] of [15, 30, 60].entries()) {
    const result = await f.run(); assert.equal(result.recovery.failures, i + 1); assert.equal(result.recovery.manualRequired, false);
    const until = result.recovery.retryAt!; f.advance(minutes - 1); await f.run(); assert.equal(f.calls(), i + 1); f.setTime(until);
  }
  const last = await f.run(); assert.equal(last.recovery.failures, 4); assert.equal(last.recovery.manualRequired, true); assert.equal(last.recovery.retryAt, null);
  f.advance(120); await f.run(); assert.equal(f.calls(), 4); assert.equal(f.store.status().samples, 1);
});
test("verification, malformed data, cloud failures and cancellations never receive automatic retries", async t => {
  for (const code of ["SOURCE_BLOCKED", "RATE_LIMITED_LONG_COOLDOWN", "IDENTITY_MISMATCH", "PAGE_STATE_MISSING", "CLOUD_UPLOAD_FAILED", "ACK_MISMATCH"]) {
    const f = await harness(t); f.setFail(code); const result = await f.run(); assert.equal(result.recovery.manualRequired, true, code);
    f.advance(120); await f.run(); assert.equal(f.calls(), 1, code); assert.equal(f.store.latest(f.targets[0]!)!.observedAt, initial);
  }
  const f = await harness(t); const cancelled = await f.run("run", AbortSignal.abort()); assert.equal(cancelled.recovery.manualRequired, true); assert.equal(f.calls(), 0);
});
test("changed scope and a different paused cycle cannot inherit an automatic recovery", async t => {
  const f = await harness(t); f.setFail("SOURCE_TIMEOUT"); await f.run(); f.advance(30);
  f.setPrevious({ ...f.previous(), startedAt: "2026-01-03T00:01:00.000Z" }); const changedCycle = await f.run();
  assert.equal(changedCycle.recovery.manualRequired, true); assert.equal(f.calls(), 1);
  const g = await harness(t); g.setFail("SOURCE_TIMEOUT"); await g.run(); g.advance(30);
  await writeFile(join(g.root, "refresh-config.json"), JSON.stringify({ ...g.scope, reviewedAt: begin }), { mode: 0o600 });
  assert.equal((await g.run()).recovery.manualRequired, true); assert.equal(g.calls(), 1);
});
test("a shared-lock deferral consumes no retry allowance and does not clear an earlier source failure", async t => {
  const f = await harness(t); f.setFail("SOURCE_TIMEOUT"); await f.run(); f.advance(15); f.setBusy(true);
  const busy = await f.run(); assert.equal(busy.state, "deferred"); assert.equal(busy.recovery.failures, 1); assert.equal(f.calls(), 1);
  f.advance(15); f.setBusy(false); const next = await f.run(); assert.equal(next.recovery.failures, 2); assert.equal(f.calls(), 2);
});
test("manual resume reuses a captured pending payload without visiting the source again", async t => {
  const f = await harness(t); f.setWrongReceipt(true); const bad = await f.run();
  assert.equal(bad.recovery.code, "ACK_MISMATCH"); assert.equal(bad.lastUploadedAt, null); assert.equal(f.store.status().pending, 1);
  f.advance(15); f.setWrongReceipt(false); await f.run(); assert.equal(f.calls(), 1); assert.equal(f.store.status().pending, 1);
  const resumed = await f.run("resume"); assert.equal(resumed.state, "complete"); assert.equal(resumed.cycle!.uploaded, 1);
  assert.equal(f.calls(), 1); assert.equal(f.store.status().pending, 0); assert.equal(resumed.lastCollectedAt, begin);
  assert.equal(resumed.lastUploadedAt, "2026-01-03T00:15:00.000Z"); assert.equal(resumed.cost.captureMs, 0);
});
test("a legacy or fabricated paused receipt keeps the explicit manual latch", async t => {
  const f = await harness(t); f.setPrevious({ status: "paused" }); await f.run(); assert.equal(f.health().recovery.manualRequired, true); assert.equal(f.calls(), 0);
  const g = await harness(t); g.setFail("SOURCE_BLOCKED"); await g.run();
  const health = g.health(); health.recovery.manualRequired = false; health.recovery.retryAt = begin; g.setHealth(health); g.advance(30);
  await g.run(); assert.equal(g.health().recovery.manualRequired, true); assert.equal(g.calls(), 1);
});
test("HTTP 5xx is distinguished from verification and 4xx before any source record is replaced", async t => {
  const f = await harness(t);
  for (const [status, code] of [[503, "SOURCE_TEMPORARY_ERROR"], [412, "SOURCE_BLOCKED"], [429, "RATE_LIMITED"], [404, "SOURCE_HTTP_ERROR"]] as const) {
    const tracked = trackedBilibiliRequest(async () => new Response("failure", { status, headers: { "Content-Type": "text/html" } }));
    await assert.rejects(collectVideo(f.targets[0]!, undefined, tracked.request), { code }); assert.equal(tracked.cost.sourceRequests, 1); assert.equal(tracked.cost.sourceBytes, 0);
  }
  assert.equal(f.store.status().samples, 1); assert.equal(f.store.latest(f.targets[0]!)!.observedAt, initial);
});
test("streamed cost counters and the original global request/byte budgets remain coupled", async () => {
  let calls = 0; const tracked = trackedBilibiliRequest(async () => { calls++; return new Response("abcd", { headers: { "Content-Type": "text/html" } }); });
  const request = refreshRequest(tracked.request, { requests: 2, bytes: 7 });
  assert.equal(await (await request("https://example.com")).text(), "abcd");
  await assert.rejects((await request("https://example.com")).text(), { code: "REFRESH_BYTE_BUDGET" });
  await assert.rejects(request("https://example.com"), { code: "REFRESH_REQUEST_BUDGET" });
  assert.equal(calls, 2); assert.equal(tracked.cost.sourceRequests, 2); assert.equal(tracked.cost.sourceBytes, 8);
});
test("rate limits honor a longer Retry-After and excessive waits require operator review", async t => {
  const f = await harness(t); f.setFail("RATE_LIMITED");
  const until = "2026-01-03T02:00:00.000Z"; f.ports.retryNotBefore = () => until;
  assert.equal((await f.run()).recovery.retryAt, until); f.advance(60); await f.run(); assert.equal(f.calls(), 1);
  for (const header of ["7200", new Date(until).toUTCString()]) {
    const tracked = trackedBilibiliRequest(async () => new Response(null, { status: 429, headers: { "Retry-After": header } }), () => Date.parse(begin));
    await tracked.request("https://example.com"); assert.equal(tracked.retryNotBefore(), until);
  }
  for (const header of ["90000", "9".repeat(350)]) {
    const long = trackedBilibiliRequest(async () => new Response(null, { status: 429, headers: { "Retry-After": header } }), () => Date.parse(begin));
    await assert.rejects(long.request("https://example.com"), { code: "RATE_LIMITED_LONG_COOLDOWN" });
  }
  const blocked = await harness(t, 3); blocked.setFail("RATE_LIMITED_LONG_COOLDOWN");
  assert.equal((await blocked.run()).recovery.manualRequired, true); assert.equal(blocked.calls(), 1);
});
test("status is read-only, exposes no target or path, and reports unknown historical upload cost as null", async t => {
  const f = await harness(t); let stdout = ""; t.mock.method(console, "log", (value: string) => { stdout += value; });
  t.mock.method(globalThis, "fetch", async () => { throw Error("diagnostics must not call a source"); });
  const before = await readFile(join(f.root, "social.sqlite")); await runCycleCli(["status", f.root, "bilibili"]);
  const result = JSON.parse(stdout); assert.equal(result.executed, false); assert.equal(result.plan.configured, 1);
  assert.equal(result.lastUploadedAt, null); assert.equal(result.lastCost, null); assert.equal(result.lastCollectedAt, initial); assert.equal(result.scopeMatches, null);
  assert(!stdout.includes(f.root)); assert(!stdout.includes(f.targets[0]!.publicationId)); assert(!stdout.includes("10001"));
  assert.deepEqual(await readFile(join(f.root, "social.sqlite")), before);
  await assert.rejects(stat(join(f.root, "cycle-bilibili", "health.json")), { code: "ENOENT" }); await assert.rejects(stat(join(f.root, "worker.lock")), { code: "ENOENT" });
});
test("malformed recovery metadata fails closed instead of resetting its retry counter", async t => {
  const f = await harness(t); await f.run();
  assert.throws(() => parseBilibiliHealth({ ...f.health(), recovery: { ...f.health().recovery, failures: -1 } }));
  assert.throws(() => parseBilibiliHealth({ ...f.health(), recovery: { ...f.health().recovery, failures: 100 } }));
  assert.throws(() => parseBilibiliHealth({ ...f.health(), recovery: { ...f.health().recovery, retryAt: "bad" } }));
});

test("cycle cleanup completes before measured upload cost is saved, including idle cycles", async t => {
  const f = await harness(t), cost = emptyUploadCost(); let closed = 0;
  f.ports.finishUpload = async () => { closed++; cost.closeMs = 3; };
  f.ports.uploadCost = () => cost;
  const complete = await f.run(); assert.equal(closed, 1); assert.equal(complete.uploadCost!.closeMs, 3);
  assert.deepEqual(parseBilibiliHealth({ ...complete, uploadCost: { ...cost, password: "private" } }).uploadCost, cost);
  f.advance(15); const idle = await f.run(); assert.equal(idle.state, "idle"); assert.equal(closed, 2);
  assert.equal(idle.uploadCost!.connections, 0); assert.equal(f.calls(), 1);
});
test("a cleanup failure preserves completed ACKs but marks the cycle for manual attention", async t => {
  const f = await harness(t); f.ports.finishUpload = async () => { throw Error("driver detail"); };
  const result = await f.run(); assert.equal(result.cycle!.uploaded, 1); assert.equal(f.store.status().pending, 0);
  assert.equal(result.state, "manual-required"); assert.equal(result.recovery.code, "CLOUD_CLOSE_FAILED");
  assert.equal(f.health().recovery.manualRequired, true);
});
