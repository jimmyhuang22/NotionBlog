import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as turn } from "node:timers/promises";
import { ContentServiceError } from "../contracts/repository.ts";
import { contentReadBudgetIdentity } from "../src/server/content-read-budget.ts";
import { createLegacyMediaReadQueue } from "../src/server/media/legacy-read-queue.ts";

const signal = () => new AbortController().signal;
const unavailable = (error: unknown) => error instanceof ContentServiceError && error.code === "CONTENT_UNAVAILABLE";
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("admission limits complete reads, preserves FIFO and starts a fresh budget only after admission", async () => {
  const queue = createLegacyMediaReadQueue({ capacity: 2 });
  const gates = Array.from({ length: 6 }, gate), started: number[] = [];
  const jobs = gates.map((hold, index) => queue.run(signal(), async () => {
    started.push(index);
    const budget = contentReadBudgetIdentity()!;
    assert.ok(budget.deadline - budget.now() > 7_000);
    await hold.promise;
    return index;
  }));
  await turn(); assert.deepEqual(started, [0, 1]);
  for (let i = 0; i < gates.length; i++) {
    gates[i].resolve(); await turn();
    assert.deepEqual(started, Array.from({ length: Math.min(i + 3, gates.length) }, (_, n) => n));
  }
  assert.deepEqual(await Promise.all(jobs), [0, 1, 2, 3, 4, 5]);
});

test("cancelled waiters never start and release pending capacity; overflow fails without executing", async () => {
  const queue = createLegacyMediaReadQueue({ capacity: 1, maxWaiting: 1 });
  const hold = gate(), cancel = new AbortController();
  const active = queue.run(signal(), () => hold.promise);
  const waiting = assert.rejects(queue.run(cancel.signal, async () => assert.fail("cancelled waiter ran")), unavailable);
  await assert.rejects(queue.run(signal(), async () => assert.fail("overflow ran")), unavailable);
  cancel.abort(); await waiting;
  const replacement = queue.run(signal(), async () => "replacement");
  hold.resolve(); await active;
  assert.equal(await replacement, "replacement");
  await assert.rejects(queue.run(cancel.signal, async () => assert.fail("already cancelled")), unavailable);
});

test("waiting has its own deadline and cannot issue SQL or Notion work after expiry", async () => {
  const queue = createLegacyMediaReadQueue({ capacity: 1, waitMs: 30 });
  const hold = gate();
  const active = queue.run(signal(), () => hold.promise);
  await assert.rejects(queue.run(signal(), async () => assert.fail("expired waiter ran")), unavailable);
  hold.resolve(); await active;
  assert.equal(await queue.run(signal(), async () => 1), 1);
});

test("active timeout aborts the content budget but retains its slot until the driver drains", async () => {
  const queue = createLegacyMediaReadQueue({ capacity: 1, readMs: 30 });
  const hold = gate(); let activeSignal: AbortSignal | undefined, nextStarted = false;
  await assert.rejects(queue.run(signal(), async () => {
    activeSignal = contentReadBudgetIdentity()!.signal;
    await hold.promise;
  }), unavailable);
  assert.equal(activeSignal?.aborted, true);
  const next = queue.run(signal(), async () => { nextStarted = true; return "next"; });
  await turn(); assert.equal(nextStarted, false);
  hold.resolve(); assert.equal(await next, "next");
});

test("active visitor cancellation returns promptly without admitting another read until cleanup completes", async () => {
  const queue = createLegacyMediaReadQueue({ capacity: 1 });
  const hold = gate(), cancel = new AbortController(); let readSignal: AbortSignal | undefined, nextStarted = false;
  const active = assert.rejects(queue.run(cancel.signal, async () => {
    readSignal = contentReadBudgetIdentity()!.signal; await hold.promise;
  }), unavailable);
  await turn(); cancel.abort(); await active;
  assert.equal(readSignal?.aborted, true);
  const next = queue.run(signal(), async () => { nextStarted = true; });
  await turn(); assert.equal(nextStarted, false);
  hold.resolve(); await next;
});

test("upstream failure is not retried and releases the active slot", async () => {
  const queue = createLegacyMediaReadQueue({ capacity: 1 });
  let attempts = 0;
  await assert.rejects(queue.run(signal(), async () => { attempts++; throw new Error("fixture failure"); }), /fixture failure/);
  assert.equal(attempts, 1);
  assert.equal(await queue.run(signal(), async () => "healthy"), "healthy");
});

test("separate route handles share admission state and install a new budget for each reader", async () => {
  const state = { active: 0, pending: [] };
  const first = createLegacyMediaReadQueue({ capacity: 1 }, state);
  const second = createLegacyMediaReadQueue({ capacity: 1 }, state);
  const hold = gate(); let firstBudget: unknown, secondStarted = false;
  const one = first.run(signal(), async () => { firstBudget = contentReadBudgetIdentity(); await hold.promise; });
  const two = second.run(signal(), async () => {
    secondStarted = true;
    assert.ok(contentReadBudgetIdentity());
    assert.notEqual(contentReadBudgetIdentity(), firstBudget);
  });
  await turn(); assert.equal(state.active, 1); assert.equal(secondStarted, false);
  hold.resolve(); await Promise.all([one, two]);
  assert.equal(secondStarted, true); assert.equal(state.active, 0); assert.equal(state.pending.length, 0);
});
