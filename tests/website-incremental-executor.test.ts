import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sqlite from "node:sqlite";
import { openIncrementalQueue } from "../scripts/website-incremental-sync/queue.ts";
import { runIncrementalCycle, type CommitReceipt, type IncrementalPorts, type PreparedDelta, type PublicationState } from "../scripts/website-incremental-sync/executor.ts";
import { createIncrementalPublicationPort } from "../scripts/website-incremental-sync/publication-port.ts";
import { PublicationDeltaError } from "../src/server/database/incremental-publication.ts";

const configDigest = "a".repeat(64), payloadDigest = "b".repeat(64), schemaDigest = "c".repeat(64);
const state: PublicationState = { publicationRevision: "revision-1", configDigest, schemaDigest, policyEpoch: "epoch-1" };
const delta: PreparedDelta = { expectedRevision: state.publicationRevision, configDigest, payloadDigest };
async function setup(t: TestContext, pages = 1, now = Date.now) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "incremental-executor-")));
  const q = await openIncrementalQueue(root, { digest: configDigest, sourceKeys: ["notes"] }, now);
  t.after(async () => { q.close(); await rm(root, { recursive: true, force: true }); });
  q.enqueue(Array.from({ length: pages }, (_, i) => ({ eventId: `event-${i}`, sourceKey: "notes", pageKey: `page-${i}`, reason: "content" as const, observedAt: 1000 })));
  const calls = { state: 0, prepare: 0, submit: 0, lookup: 0, verify: 0 };
  const receipt = (operationId: string): CommitReceipt => ({ operationId, payloadDigest, publicationRevision: "revision-2", committed: true });
  const ports: IncrementalPorts<PreparedDelta> = {
    state: async () => { calls.state++; return state; },
    prepare: async () => { calls.prepare++; return { outcome: "prepared", delta }; },
    submit: async id => { calls.submit++; return { outcome: "committed", receipt: receipt(id) }; },
    lookup: async () => { calls.lookup++; return null; },
    verify: async () => { calls.verify++; return true; },
  };
  const run = (extra = {}) => runIncrementalCycle({ queue: q, schemaDigest, ...extra }, ports);
  const failures = () => {
    const Constructor = (sqlite as unknown as { Database?: typeof sqlite.DatabaseSync }).Database ?? sqlite.DatabaseSync;
    const db = new Constructor(join(root, "incremental.sqlite"), { readOnly: true });
    try { return Number(db.prepare("SELECT count(*) AS n FROM attempts WHERE state='failed'").get()!.n); }
    finally { db.close(); }
  };
  return { q, ports, calls, receipt, run, failures };
}

test("one changed page is submitted after its durable marker and acknowledged only after independent readback", async t => {
  const s = await setup(t);
  s.ports.submit = async id => {
    s.calls.submit++;
    assert.equal(s.q.pendingVerifications()[0].ticket.operationId, id);
    assert.equal(s.q.status().done, 0);
    return { outcome: "committed", receipt: s.receipt(id) };
  };
  const result = await s.run();
  assert.equal(result.outcome, "updated"); assert.equal(result.published, 1);
  assert.deepEqual(s.calls, { state: 1, prepare: 1, submit: 1, lookup: 0, verify: 1 });
  assert.equal(s.q.status().done, 1);
});

test("unchanged preparation performs no publication, lookup or media fallback", async t => {
  const s = await setup(t); s.ports.prepare = async () => { s.calls.prepare++; return { outcome: "unchanged" }; };
  const result = await s.run(); assert.equal(result.outcome, "unchanged"); assert.equal(result.unchanged, 1);
  assert.equal(s.calls.submit + s.calls.lookup + s.calls.verify, 0);
});

test("a lost submission reply is recovered next cycle without preparing or resending the page", async t => {
  const s = await setup(t); s.ports.submit = async () => { s.calls.submit++; throw new Error("private transport detail"); };
  const first = await s.run(); assert.equal(first.outcome, "blocked"); assert.equal(first.errorCode, "SUBMISSION_UNCERTAIN");
  assert.equal(s.q.status().awaiting_verification, 1);
  s.ports.lookup = async id => { s.calls.lookup++; return s.receipt(id); };
  const second = await s.run(); assert.equal(second.recovered, 1); assert.equal(second.outcome, "updated");
  assert.equal(s.calls.submit, 1); assert.equal(s.calls.prepare, 1); assert.equal(s.calls.verify, 1);
});

test("missing operation lookup keeps unrelated pages pending and never proves safe retry", async t => {
  const s = await setup(t, 2); s.ports.submit = async () => { s.calls.submit++; throw new Error("lost response"); };
  await s.run(); const result = await s.run();
  assert.equal(result.outcome, "blocked"); assert.equal(s.calls.submit, 1); assert.equal(s.calls.prepare, 1);
  assert.equal(s.q.status().pending, 1); assert.equal(s.q.status().awaiting_verification, 1);
});

test("reader failure or mismatched commit identity cannot acknowledge or continue publishing", async t => {
  const s = await setup(t, 2); s.ports.verify = async () => { s.calls.verify++; return false; };
  const first = await s.run(); assert.equal(first.errorCode, "READER_UNVERIFIED"); assert.equal(first.outcome, "blocked");
  s.ports.lookup = async id => ({ ...s.receipt(id), payloadDigest: "d".repeat(64) });
  const next = await s.run(); assert.equal(next.errorCode, "COMMIT_RECEIPT_MISMATCH");
  assert.equal(s.calls.verify, 1); assert.equal(s.calls.submit, 1); assert.equal(s.q.status().pending, 1);
});

test("server revision conflict schedules retry once, even with a zero retry delay", async t => {
  const s = await setup(t); s.ports.submit = async () => { s.calls.submit++; return { outcome: "rejected", code: "DELTA_VERSION_CHANGED", retryable: true }; };
  const result = await s.run({ retryDelayMs: 0 });
  assert.equal(result.outcome, "retry"); assert.equal(result.retried, 1); assert.equal(s.calls.submit, 1);
  assert.equal(s.q.status().awaiting_verification, 0); assert.equal(s.q.status().retry, 1);
});

test("definitive policy rejection requires review instead of retrying with a new operation", async t => {
  const s = await setup(t); s.ports.submit = async () => ({ outcome: "rejected", code: "DELTA_POLICY_CHANGED", retryable: false });
  const result = await s.run(); assert.equal(result.outcome, "needs_review"); assert.equal(s.q.status().needs_review, 1);
  assert.equal(s.q.status().retry, 0); assert.equal(s.q.status().awaiting_verification, 0);
});

test("scope and prepared-version drift stop before calling submission", async t => {
  const s = await setup(t); s.ports.prepare = async () => ({ outcome: "prepared", delta: { ...delta, expectedRevision: "older" } });
  const first = await s.run(); assert.equal(first.errorCode, "PREPARED_DELTA_MISMATCH"); assert.equal(s.calls.submit, 0);
  s.q.resume("notes", "page-0"); s.ports.state = async () => ({ ...state, schemaDigest: "d".repeat(64) });
  const second = await s.run(); assert.equal(second.errorCode, "PUBLICATION_SCOPE_MISMATCH"); assert.equal(s.calls.submit, 0);
});

test("task cap only prepares the selected pages and leaves remaining work for the next cycle", async t => {
  const s = await setup(t, 3); const result = await s.run({ maxTasks: 1 });
  assert.equal(result.outcome, "partial"); assert.equal(result.published, 1); assert.equal(s.calls.prepare, 1);
  assert.equal(s.q.status().pending, 2); assert.equal(s.q.status().leased, 0);
});

test("time budget cancels stuck preparation and a late result cannot trigger submission", async t => {
  const s = await setup(t); let finish!: (value: { outcome: "prepared"; delta: PreparedDelta }) => void;
  s.ports.prepare = async () => new Promise(resolve => { finish = resolve; });
  const result = await s.run({ maxDurationMs: 30 }); assert.equal(result.outcome, "cancelled");
  assert.equal(s.calls.submit, 0); assert.equal(s.q.status().awaiting_verification, 0);
  if (finish) finish({ outcome: "prepared", delta });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(s.calls.submit, 0);
});

test("cancellation during submission retains unknown state rather than returning it to preparation", async t => {
  const s = await setup(t), cancel = new AbortController();
  s.ports.submit = async () => { s.calls.submit++; cancel.abort(); return new Promise(() => {}); };
  const result = await s.run({ signal: cancel.signal });
  assert.equal(result.outcome, "cancelled"); assert.equal(s.q.status().awaiting_verification, 1); assert.equal(s.q.status().retry, 0);
});

test("dependent checkpoint is saved after reader proof and before queue acknowledgement", async t => {
  const s = await setup(t); let saved = 0;
  s.ports.finalize = async receipt => {
    assert.equal(s.calls.verify, 1); assert.equal(s.q.status().done, 0);
    assert.equal(s.q.pendingVerifications()[0].ticket.operationId, receipt.operationId); saved++;
  };
  const result = await s.run(); assert.equal(result.outcome, "updated"); assert.equal(saved, 1); assert.equal(s.q.status().done, 1);
});

test("checkpoint failure retains the committed operation and retries only finalization after lookup", async t => {
  const s = await setup(t); let saves = 0;
  s.ports.finalize = async () => { saves++; throw new Error("private file error"); };
  const first = await s.run(); assert.equal(first.outcome, "blocked"); assert.equal(first.errorCode, "CHECKPOINT_UNSAVED");
  assert.equal(s.q.status().awaiting_verification, 1);
  s.ports.lookup = async id => s.receipt(id); s.ports.finalize = async () => { saves++; };
  const second = await s.run(); assert.equal(second.outcome, "updated"); assert.equal(second.recovered, 1);
  assert.equal(s.calls.submit, 1); assert.equal(s.calls.prepare, 1); assert.equal(saves, 2);
});

test("only the owned publication helper's known rejection codes become definitive", async () => {
  let failure: Error = new PublicationDeltaError("DELTA_VERSION_CHANGED");
  const port = createIncrementalPublicationPort({ state: async () => state, lookup: async () => null, publish: async () => { throw failure; } }, async () => true);
  const signal = new AbortController().signal;
  assert.deepEqual(await port.submit("operation", delta, signal), { outcome: "rejected", code: "DELTA_VERSION_CHANGED", retryable: true });
  failure = new PublicationDeltaError("DELTA_DEPENDENCY_MISSING");
  assert.deepEqual(await port.submit("operation", delta, signal), { outcome: "rejected", code: "DELTA_DEPENDENCY_MISSING", retryable: false });
  failure = Object.assign(new Error("lost network reply"), { code: "DELTA_VERSION_CHANGED" });
  await assert.rejects(port.submit("operation", delta, signal), failure);
  failure = Object.assign(new Error("malformed commit response"), { name: "PublicationDeltaError", code: "DELTA_UNAVAILABLE" });
  await assert.rejects(port.submit("operation", delta, signal), failure);
});

test("one failed preparation does not prevent another ready page from publishing", async t => {
  const s = await setup(t, 2);
  s.ports.prepare = async ticket => ticket.pageKey === "page-0" ? { outcome: "retry", code: "TEMPORARY" } : { outcome: "prepared", delta };
  const result = await s.run();
  assert.equal(result.retried, 1); assert.equal(result.published, 1); assert.equal(result.outcome, "retry");
  assert.equal(s.q.status().retry, 1); assert.equal(s.q.status().done, 1);
});

test("permanently rejected media is held without retrying or blocking another page", async t => {
  const s = await setup(t, 2);
  s.ports.prepare = async ticket => {
    if (ticket.pageKey === "page-0") throw Object.assign(new Error("private image diagnostic"), { code: "IMAGE_REJECTED" });
    return { outcome: "prepared", delta };
  };
  const result = await s.run();
  assert.equal(result.review, 1); assert.equal(result.retried, 0); assert.equal(result.published, 1);
  assert.equal(s.q.listReview()[0].errorCode, "IMAGE_REJECTED");
});

test("repeated publication outages defer work without spending the page failure allowance", async t => {
  const s = await setup(t);
  s.ports.state = async () => { throw Error("private database outage"); };
  for (let n = 0; n < 6; n++) {
    const result = await s.run({ retryDelayMs: 0, maxTasks: 1 });
    assert.equal(result.outcome, "retry"); assert.equal(result.errorCode, "PUBLICATION_UNAVAILABLE");
    assert.equal(result.review, 0); assert.equal(s.failures(), 0);
  }
  assert.equal(s.q.status().retry, 1); assert.equal(s.q.status().needs_review, 0);
  assert.equal(s.calls.prepare + s.calls.submit, 0);
  s.ports.state = async () => state;
  s.ports.prepare = async () => ({ outcome: "retry", code: "PAGE_TEMPORARY" });
  for (let n = 1; n <= 5; n++) {
    const result = await s.run({ retryDelayMs: 0, maxTasks: 1 });
    assert.equal(s.failures(), n); assert.equal(result.review, n === 5 ? 1 : 0);
  }
  assert.equal(s.q.status().needs_review, 1);
});

test("system outages use a fixed delay rather than page-failure exponential backoff", async t => {
  let now = 2000; const s = await setup(t, 1, () => now);
  s.ports.state = async () => { throw Error("unavailable"); };
  for (let n = 0; n < 6; n++) {
    assert.equal((await s.run({ retryDelayMs: 1000, maxTasks: 1 })).claimed, 1);
    now += 999; assert.equal((await s.run({ retryDelayMs: 1000, maxTasks: 1 })).claimed, 0);
    now++; assert.equal(s.failures(), 0);
  }
});

test("a system outage stops the cycle before claiming another ready page", async t => {
  const s = await setup(t, 2);
  s.ports.state = async () => { s.calls.state++; throw Error("unavailable"); };
  const result = await s.run({ retryDelayMs: 0, maxTasks: 50 });
  assert.equal(result.claimed, 1); assert.equal(s.calls.state, 1);
  assert.equal(s.q.status().pending, 1); assert.equal(s.q.status().retry, 1);
  assert.equal(s.failures(), 0); assert.equal(s.calls.prepare + s.calls.submit, 0);
});

test("pre-submission cancellation takes priority over a simultaneous permanent prepare error", async t => {
  const s = await setup(t); let cancel: AbortController;
  s.ports.prepare = async () => { cancel.abort(); throw Object.assign(Error("private converter error"), { code: "IMAGE_REJECTED" }); };
  for (let n = 0; n < 6; n++) {
    cancel = new AbortController();
    const result = await s.run({ signal: cancel.signal });
    assert.equal(result.outcome, "cancelled"); assert.equal(result.review, 0); assert.equal(s.failures(), 0);
  }
  assert.equal(s.q.status().retry, 1); assert.equal(s.q.status().needs_review, 0);
  assert.equal(s.calls.submit, 0);
});
