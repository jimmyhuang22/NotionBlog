import test from "node:test";
import assert from "node:assert/strict";
import { createSocialReadQueue, queueSocialWorksRepository } from "../src/server/social/read-queue.ts";
import { withContentReadBudget, contentReadBudgetIdentity, checkContentReadBudget } from "../src/server/content-read-budget.ts";
import { createSocialWorksRepository } from "../src/server/social/works-repository.ts";
import { exampleSocialWork } from "./helpers/home-feed-samples.ts";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
const budget = <T>(read: () => Promise<T>, signal = new AbortController().signal) => withContentReadBudget(signal, read);

test("burst reads finish all SQL stages before the next request takes the same pool slot", async () => {
  const queue = createSocialReadQueue(1), calls: string[] = [], gates = Array.from({ length: 9 }, deferred);
  const reads = ["first", "second", "third"].map(name => budget(() => queue.run(async () => {
    for (const phase of ["qualification", "snapshot", "covers"]) {
      const gate = gates[calls.length]; calls.push(`${name}:${phase}`); await gate.promise;
    }
    return name;
  })));
  for (let i = 0; i < gates.length; i++) {
    for (let turn = 0; turn < 20 && calls.length < i + 1; turn++) await Promise.resolve();
    assert.equal(calls.length, i + 1); gates[i].resolve();
  }
  assert.deepEqual(await Promise.all(reads), ["first", "second", "third"]);
  assert.deepEqual(calls, ["first", "second", "third"].flatMap(name => ["qualification", "snapshot", "covers"].map(phase => `${name}:${phase}`)));
});

test("a cancelled queued request issues no SQL and does not cancel or block its neighbours", async () => {
  const queue = createSocialReadQueue(1), held = deferred(), began = deferred(), calls: string[] = [];
  const first = budget(() => queue.run(async () => { calls.push("first"); began.resolve(); await held.promise; }));
  await began.promise;
  const controller = new AbortController();
  const cancelled = budget(() => queue.run(async () => { calls.push("cancelled"); }), controller.signal);
  const rejected = assert.rejects(cancelled, { code: "CONTENT_UNAVAILABLE" });
  const last = budget(() => queue.run(async () => { calls.push("last"); }));
  controller.abort("private fixture reason"); await rejected;
  assert.deepEqual(calls, ["first"]); held.resolve(); await Promise.all([first, last]);
  assert.deepEqual(calls, ["first", "last"]);
});

test("a one-slot six-query burst completes more pages before the same deadline without adding SQL capacity", async () => {
  async function burst(admit: boolean) {
    let elapsed = 0, sqlCalls = 0, tail = Promise.resolve();
    const queue = createSocialReadQueue(1);
    const query = () => {
      const result = tail.then(() => { checkContentReadBudget(); sqlCalls++; elapsed++; checkContentReadBudget(); });
      tail = result.catch(() => {}); return result;
    };
    const read = async () => { for (let stage = 0; stage < 6; stage++) await query(); };
    const results = await Promise.allSettled(Array.from({ length: 8 }, () =>
      withContentReadBudget(new AbortController().signal, () => admit ? queue.run(read) : read(), { timeoutMs: 30, now: () => elapsed })));
    return { finished: results.filter(result => result.status === "fulfilled").length, sqlCalls };
  }
  const before = await burst(false), after = await burst(true);
  assert.equal(before.finished, 0); assert.ok(after.finished > before.finished);
  assert.equal(before.sqlCalls, 30); assert.equal(after.sqlCalls, 30);
});

test("queued time consumes the caller's original deadline without starting another window", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const queue = createSocialReadQueue(1), held = deferred(), began = deferred(); let queuedReads = 0;
  const first = budget(() => queue.run(async () => { began.resolve(); await held.promise; })); await began.promise;
  const queued = withContentReadBudget(new AbortController().signal, () => queue.run(async () => { queuedReads++; }), { timeoutMs: 25 });
  const rejected = assert.rejects(queued, { code: "CONTENT_UNAVAILABLE" });
  t.mock.timers.tick(25); await rejected; assert.equal(queuedReads, 0);
  held.resolve(); await first;
});

test("active cancellation keeps its turn until its SQL cleanup finishes and preserves request context", async () => {
  const queue = createSocialReadQueue(1), cleanup = deferred(), began = deferred();
  const controller = new AbortController(); let nextStarted = false;
  const first = budget(() => queue.run(async () => {
    const scope = contentReadBudgetIdentity()!; began.resolve(); await cleanup.promise;
    assert.equal(contentReadBudgetIdentity(), scope); assert.equal(scope.signal.aborted, true);
  }), controller.signal);
  await began.promise;
  const next = budget(() => queue.run(async () => { nextStarted = true; assert.equal(contentReadBudgetIdentity()!.signal.aborted, false); }));
  controller.abort(); await Promise.resolve(); assert.equal(nextStarted, false);
  const rejected = assert.rejects(first, { code: "CONTENT_UNAVAILABLE" });
  cleanup.resolve(); await rejected; await next; assert.equal(nextStarted, true);
});

test("failure releases the turn and configured two-slot pools keep two reads in progress", async () => {
  const queue = createSocialReadQueue(2), held = deferred(), began = [deferred(), deferred()], calls: number[] = [];
  const reads = [0, 1, 2].map(i => budget(() => queue.run(async () => {
    calls.push(i); began[i]?.resolve(); if (i < 2) await held.promise;
    if (i === 0) throw Error("fixture SQL failure"); return i;
  })));
  const rejected = assert.rejects(reads[0], /fixture SQL failure/);
  await Promise.all(began.map(gate => gate.promise)); assert.deepEqual(calls, [0, 1]);
  held.resolve(); await rejected; assert.deepEqual(await Promise.all(reads.slice(1)), [1, 2]); assert.deepEqual(calls, [0, 1, 2]);
});

test("every admitted page rechecks the current snapshot and cover eligibility; no result is reused", async () => {
  const work = { ...exampleSocialWork("fixture", "2026-01-01T00:00:00.000Z"), collection: null };
  let reads = 0, coverReads = 0;
  const repo = queueSocialWorksRepository(createSocialWorksRepository(async () => {
    const call = ++reads;
    return { version: `fresh-${call}`, items: call === 1 ? [work] : [], hydrateCovers: async items => { coverReads++; return items; } };
  }), createSocialReadQueue(1));
  const [first, withdrawn] = await Promise.all([budget(() => repo.listWorks()), budget(() => repo.listWorks())]);
  assert.equal(first.items.length, 1); assert.equal(withdrawn.items.length, 0);
  assert.equal(reads, 2); assert.equal(coverReads, 1);
});

test("invalid filters fail before waiting for a busy turn or reading the provider", async () => {
  const queue = createSocialReadQueue(1), held = deferred(), began = deferred(); let reads = 0;
  const first = budget(() => queue.run(async () => { began.resolve(); await held.promise; })); await began.promise;
  const repo = queueSocialWorksRepository({ async listWorks() { reads++; return { items: [], total: 0, hasMore: false, nextCursor: null }; } }, queue);
  await assert.rejects(budget(() => repo.listWorks({ order: "views" })), { code: "INVALID_QUERY" });
  assert.equal(reads, 0); held.resolve(); await first;
});

test("unbudgeted callers bypass admission and invalid capacities are rejected", async () => {
  for (const value of [0, -1, 1.5, NaN, Infinity]) assert.throws(() => createSocialReadQueue(value));
  const queue = createSocialReadQueue(1), held = deferred(), began = deferred();
  const first = budget(() => queue.run(async () => { began.resolve(); await held.promise; })); await began.promise;
  assert.equal(await queue.run(async () => "legacy"), "legacy"); held.resolve(); await first;
});
