import assert from "node:assert/strict";
import test from "node:test";
import { NotionRequestScheduler, RequestCooldownError, sharedNotionScheduler, type SchedulerClock } from "../src/server/notion/request-scheduler.ts";

class VirtualClock implements SchedulerClock {
  private time = 0;
  private id = 0;
  private timers = new Map<number, { at: number; callback: () => void }>();
  now() { return this.time; }
  setTimeout(callback: () => void, delayMs: number) {
    const id = ++this.id;
    this.timers.set(id, { at: this.time + delayMs, callback });
    return id;
  }
  clearTimeout(handle: unknown) { this.timers.delete(handle as number); }
  async advance(ms: number) {
    const target = this.time + ms;
    while (true) {
      const next = [...this.timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      this.time = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
      await flush();
    }
    this.time = target;
    await flush();
  }
}
async function flush() { for (let i = 0; i < 8; i += 1) await Promise.resolve(); }

test("concurrent request starts are spaced without waiting for prior response bodies", async () => {
  const clock = new VirtualClock();
  const scheduler = new NotionRequestScheduler({ clock });
  const starts: number[] = [];
  let finishFirst: () => void = () => {};
  const first = scheduler.run(async () => { starts.push(clock.now()); await new Promise<void>(resolve => { finishFirst = resolve; }); });
  const second = scheduler.run(async () => { starts.push(clock.now()); });
  const third = scheduler.run(async () => { starts.push(clock.now()); });
  await clock.advance(349);
  assert.deepEqual(starts, [0]);
  await clock.advance(1);
  assert.deepEqual(starts, [0, 350]);
  await clock.advance(350);
  assert.deepEqual(starts, [0, 350, 700]);
  finishFirst();
  await Promise.all([first, second, third]);
});

test("complete Retry-After cooldowns exceed sixty seconds and never shorten an existing pause", async () => {
  const clock = new VirtualClock();
  const scheduler = new NotionRequestScheduler({ clock });
  await scheduler.run(async () => {});
  await clock.advance(100);
  scheduler.defer("120");
  scheduler.defer("1");
  let startedAt: number | null = null;
  const delayed = scheduler.run(async () => { startedAt = clock.now(); }, { timeoutMs: 200_000 });
  await clock.advance(119_999);
  assert.equal(startedAt, null);
  await clock.advance(1);
  await delayed;
  assert.equal(startedAt, 120_100);
});

test("invalid cooldown headers cannot become a request delay", async () => {
  const clock = new VirtualClock();
  const scheduler = new NotionRequestScheduler({ clock, intervalMs: 0 });
  for (const header of [null, "", "-1", "1.5", "1second", "Infinity"]) scheduler.defer(header);
  let startedAt = -1;
  await scheduler.run(async () => { startedAt = clock.now(); });
  assert.equal(startedAt, 0);
});

test("queued cancellation removes the request and does not consume a request start", async () => {
  const clock = new VirtualClock();
  const scheduler = new NotionRequestScheduler({ clock });
  await scheduler.run(async () => {});
  const controller = new AbortController();
  let cancelledStarted = false;
  const cancelled = scheduler.run(async () => { cancelledStarted = true; }, { signal: controller.signal });
  const rejected = assert.rejects(cancelled, { name: "AbortError" });
  controller.abort();
  let nextStarted = -1;
  const next = scheduler.run(async () => { nextStarted = clock.now(); });
  await clock.advance(350);
  await Promise.all([rejected, next]);
  assert.equal(cancelledStarted, false);
  assert.equal(nextStarted, 350);
  const preAborted = new AbortController();
  preAborted.abort();
  await assert.rejects(scheduler.run(async () => assert.fail("must not start"), { signal: preAborted.signal }), { name: "AbortError" });
});

test("timed-out queued requests never run later and report an upstream cooldown", async () => {
  const clock = new VirtualClock();
  const scheduler = new NotionRequestScheduler({ clock });
  scheduler.defer("120");
  let started = false;
  const queued = scheduler.run(async () => { started = true; });
  const rejected = assert.rejects(queued, RequestCooldownError);
  await clock.advance(9_000);
  await rejected;
  await clock.advance(111_000);
  assert.equal(started, false);
  await scheduler.run(async () => { started = true; });
  assert.equal(started, true);
});

test("active timeout aborts transport and both timeout and failure leave the queue usable", async () => {
  const clock = new VirtualClock();
  const scheduler = new NotionRequestScheduler({ clock });
  let signal: AbortSignal | undefined;
  const stalled = scheduler.run(async requestSignal => { signal = requestSignal; return new Promise<void>(() => {}); }, { timeoutMs: 100 });
  const rejected = assert.rejects(stalled, { name: "TimeoutError" });
  await clock.advance(100);
  await rejected;
  assert.equal(signal?.aborted, true);
  const failed = scheduler.run(async () => { throw new Error("offline failure"); });
  const failure = assert.rejects(failed, /offline failure/u);
  await clock.advance(250);
  await failure;
  const recovered = scheduler.run(async () => "recovered");
  await clock.advance(350);
  assert.equal(await recovered, "recovered");
});

test("connection timing state is shared across instances and isolated by token", () => {
  const first = sharedNotionScheduler("scheduler-offline-connection-one");
  assert.equal(first, sharedNotionScheduler("scheduler-offline-connection-one"));
  assert.notEqual(first, sharedNotionScheduler("scheduler-offline-connection-two"));
});


test("long and overflowing cooldowns reject queued work without shortening the upstream pause", async () => {
  for (const header of ["3600", "9".repeat(400), new Date(3_600_000).toUTCString()]) {
    const clock = new VirtualClock(), scheduler = new NotionRequestScheduler({ clock });
    await scheduler.run(async () => {});
    const queued = assert.rejects(scheduler.run(async () => assert.fail("No early start")), RequestCooldownError);
    scheduler.defer(header); await queued;
    scheduler.defer("1");
    await assert.rejects(scheduler.run(async () => assert.fail("Cooldown survives rejection")), RequestCooldownError);
    await clock.advance(120_001);
    await assert.rejects(scheduler.run(async () => assert.fail("Cooldown was not capped")), RequestCooldownError);
  }
});

test("HTTP date cooldown resumes at the advertised deadline", async () => {
  const clock = new VirtualClock(), scheduler = new NotionRequestScheduler({ clock });
  scheduler.defer(new Date(120_000).toUTCString());
  let started = false;
  const pending = scheduler.run(async () => { started = true; }, { timeoutMs: 130_000 });
  await clock.advance(119_999); assert.equal(started, false);
  await clock.advance(1); await pending; assert.equal(started, true);
});
