import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sqlite from "node:sqlite";
import { openIncrementalQueue, IncrementalQueueError } from "../scripts/website-incremental-sync/queue.ts";
import { runIncrementalCycle, type IncrementalPorts, type PreparedDelta } from "../scripts/website-incremental-sync/executor.ts";

const configDigest = "a".repeat(64), payloadDigest = "b".repeat(64), schemaDigest = "c".repeat(64);
const state = { publicationRevision: "revision-1", configDigest, schemaDigest, policyEpoch: "epoch-1" };
const delta = { expectedRevision: state.publicationRevision, configDigest, payloadDigest };
const error = (code: string) => (e: unknown) => e instanceof IncrementalQueueError && e.code === code;
async function setup(t: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "incremental-lifecycle-"))), time = { now: 2000 };
  let q = await openIncrementalQueue(directory, { digest: configDigest, sourceKeys: ["notes"] }, () => time.now);
  t.after(async () => { q.close(); await rm(directory, { recursive: true, force: true }); });
  q.enqueue([{ eventId: "one", sourceKey: "notes", pageKey: "page-1", reason: "content", observedAt: 1000 }]);
  const ports: IncrementalPorts<PreparedDelta> = {
    state: async () => state, prepare: async () => ({ outcome: "prepared", delta }),
    submit: async operationId => ({ outcome: "committed", receipt: { operationId, payloadDigest, publicationRevision: "revision-2", committed: true } }),
    lookup: async () => null, verify: async () => true,
  };
  return { directory, time, ports, get q() { return q; },
    reopen: async (alreadyClosed = false) => { if (!alreadyClosed) q.close(); q = await openIncrementalQueue(directory, { digest: configDigest, sourceKeys: ["notes"] }, () => time.now); },
    run: (extra = {}) => runIncrementalCycle({ queue: q, schemaDigest, retryDelayMs: 0, ...extra }, ports) };
}

test("only a fenced terminal attempt proves it was never submitted", async t => {
  const s = await setup(t), [ticket] = s.q.claim(1, 1000);
  assert.equal(s.q.attemptClosure(ticket.operationId), null); s.time.now += 1000;
  assert.equal(s.q.attemptClosure(ticket.operationId), null);
  assert.deepEqual(s.q.claim(1, 1000, { requireRetirement: true }), []);
  const proof = s.q.attemptClosure(ticket.operationId)!;
  assert.equal(proof.disposition, "never_submitted"); assert.equal(proof.payloadDigest, null);
  assert.throws(() => s.q.markSubmitting(ticket, delta), error("QUEUE_STALE_TICKET"));
  assert.throws(() => s.q.assertPreparing(ticket), error("QUEUE_STALE_TICKET"));
  await s.reopen(); assert.deepEqual(s.q.pendingRetirements(), [proof]);
  s.q.acknowledgeRetirement(proof); assert.equal(s.q.status().retirement_pending, 0);
  assert.equal(s.q.claim(1, 1000, { requireRetirement: true }).length, 1);
});

test("unknown or confirmed successful submissions cannot produce retirement proof", async t => {
  const s = await setup(t), [ticket] = s.q.claim(); s.q.markSubmitting(ticket, delta);
  s.time.now += 1_000_000;
  assert.equal(s.q.attemptClosure(ticket.operationId), null); assert.deepEqual(s.q.pendingRetirements(), []);
  s.q.confirmCommit(ticket, { operationId: ticket.operationId, payloadDigest, publicationRevision: "revision-2", readerVerified: true });
  assert.equal(s.q.attemptClosure(ticket.operationId), null); assert.deepEqual(s.q.pendingRetirements(), []);
});

test("definitive rejection keeps the exact digest and cannot be acknowledged with a forged proof", async t => {
  const s = await setup(t), [ticket] = s.q.claim(); s.q.markSubmitting(ticket, delta);
  s.q.confirmRejected(ticket, { operationId: ticket.operationId, payloadDigest, definitivelyRejected: true, code: "BUSY" }, 0);
  const [proof] = s.q.pendingRetirements(); assert.equal(proof.disposition, "definitively_rejected");
  assert.throws(() => s.q.acknowledgeRetirement({ ...proof, payloadDigest: "d".repeat(64) }), error("QUEUE_PROOF_MISMATCH"));
  assert.throws(() => s.q.acknowledgeRetirement({ ...proof, disposition: "never_submitted", payloadDigest: null }), error("QUEUE_PROOF_MISMATCH"));
  assert.deepEqual(s.q.claim(1, 1000, { requireRetirement: true }), []);
  s.q.acknowledgeRetirement(proof); s.q.acknowledgeRetirement(proof);
  assert.equal(s.q.claim(1, 1000, { requireRetirement: true }).length, 1);
});

test("v2 upgrade recovers a closure lost before its callback without altering the job", async t => {
  const s = await setup(t), [ticket] = s.q.claim(); s.q.retryPreparation(ticket, "PREPARATION_UNAVAILABLE", 0);
  s.q.close();
  const Constructor = (sqlite as unknown as { Database?: typeof sqlite.DatabaseSync }).Database ?? sqlite.DatabaseSync;
  const db = new Constructor(join(s.directory, "incremental.sqlite")); db.exec("DROP INDEX attempt_history; DROP TABLE directory_baseline; DROP TABLE retirements; PRAGMA user_version=2;"); db.close();
  await s.reopen(true);
  assert.equal(s.q.pendingRetirements()[0].ticket.operationId, ticket.operationId);
  assert.equal(s.q.status().retry, 1); assert.equal(s.q.status().events, 1);
});

test("after-stage cancellation persists closure and retires it before any next preparation", async t => {
  const s = await setup(t), staged = new Map<string, string>(), controller = new AbortController(), order: string[] = [];
  let oldId = "";
  s.ports.prepare = async ticket => { oldId = ticket.operationId; staged.set(oldId, payloadDigest); controller.abort(); return { outcome: "prepared", delta }; };
  s.ports.submit = async () => assert.fail("Cancelled preparation cannot submit");
  s.ports.retire = async proof => {
    order.push("retire"); assert.deepEqual(s.q.attemptClosure(proof.ticket.operationId), proof);
    assert.equal(proof.disposition, "never_submitted"); assert.equal(proof.payloadDigest, null);
    assert.equal(staged.get(proof.ticket.operationId), payloadDigest); staged.delete(proof.ticket.operationId);
  };
  assert.equal((await s.run({ signal: controller.signal })).outcome, "cancelled");
  assert.equal(staged.size, 1); await s.reopen();
  s.ports.prepare = async ticket => { order.push("prepare"); assert.notEqual(ticket.operationId, oldId); assert.equal(staged.size, 0); return { outcome: "unchanged" }; };
  // No staged data belongs to the subsequent unchanged attempt.
  const retire = s.ports.retire;
  s.ports.retire = async (proof, signal) => { if (proof.ticket.operationId === oldId) await retire!(proof, signal); };
  const result = await s.run(); assert.deepEqual(order, ["retire", "prepare"]);
  assert.equal(result.retired, 2); assert.equal(s.q.status().retirement_pending, 0);
});

test("retirement failure survives reopening and blocks new preparation until its idempotent retry", async t => {
  const s = await setup(t); let prepares = 0, retires = 0;
  s.ports.prepare = async () => { prepares++; return { outcome: "prepared", delta }; };
  s.ports.submit = async () => ({ outcome: "rejected", code: "BUSY", retryable: true });
  s.ports.retire = async proof => { retires++; assert.equal(proof.disposition, "definitively_rejected"); throw new Error("private domain failure"); };
  const failed = await s.run(); assert.equal(failed.outcome, "blocked"); assert.equal(failed.errorCode, "RETIREMENT_PENDING");
  await s.reopen(); assert.equal((await s.run()).outcome, "blocked"); assert.equal(prepares, 1); assert.equal(retires, 2);
  s.ports.retire = async () => { retires++; };
  s.ports.prepare = async () => { prepares++; return { outcome: "unchanged" }; };
  assert.equal((await s.run()).outcome, "unchanged"); assert.equal(prepares, 2);
  assert.equal(s.q.status().retirement_pending, 0); assert.equal(retires, 4);
});

test("a lost retirement reply repeats only cleanup, without preparing or submitting again", async t => {
  const s = await setup(t), [ticket] = s.q.claim(); s.q.completeUnchanged(ticket);
  let localApplied = false, calls = 0;
  s.ports.retire = async proof => { assert.equal(proof.ticket.operationId, ticket.operationId); calls++;
    if (!localApplied) { localApplied = true; throw new Error("reply lost"); }
  };
  s.ports.prepare = async () => assert.fail("Completed unchanged attempt has no new preparation");
  s.ports.submit = async () => assert.fail();
  assert.equal((await s.run()).outcome, "blocked"); await s.reopen();
  assert.equal((await s.run()).outcome, "unchanged"); assert.equal(calls, 2);
});

test("unknown publication lookup never retires its staged recovery state", async t => {
  const s = await setup(t); let retired = 0;
  s.ports.retire = async () => { retired++; };
  s.ports.submit = async () => { throw new Error("lost network reply"); };
  assert.equal((await s.run()).outcome, "blocked"); await s.reopen();
  assert.equal((await s.run()).outcome, "blocked"); assert.equal(retired, 0);
  assert.equal(s.q.pendingVerifications().length, 1); assert.equal(s.q.pendingRetirements().length, 0);
});

test("retirement consumes the cycle budget and cannot loop into a fresh attempt", async t => {
  const s = await setup(t); let retires = 0, prepares = 0;
  s.ports.prepare = async () => { prepares++; return { outcome: "prepared", delta }; };
  s.ports.submit = async () => ({ outcome: "rejected", code: "BUSY", retryable: true });
  s.ports.retire = async () => { retires++; };
  assert.equal((await s.run({ maxTasks: 1 })).outcome, "blocked"); assert.equal(retires, 0);
  assert.equal((await s.run({ maxTasks: 1 })).outcome, "partial"); assert.equal(retires, 1); assert.equal(prepares, 1);
});

test("a successfully verified publication keeps its applied domain identity and invokes no retirement", async t => {
  const s = await setup(t); const order: string[] = [];
  s.ports.finalize = async () => { order.push("install"); };
  s.ports.retire = async () => assert.fail("Applied publication must not be retired");
  const result = await s.run(); assert.equal(result.outcome, "updated"); assert.equal(result.retired, 0);
  assert.deepEqual(order, ["install"]); assert.equal(s.q.status().done, 1);
});
