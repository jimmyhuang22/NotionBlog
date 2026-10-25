import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, realpath, rm, stat, chmod, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import * as sqlite from "node:sqlite";
import { openIncrementalQueue, IncrementalQueueError, type ChangeHint, type QueueTicket } from "../scripts/website-incremental-sync/queue.ts";

const scope = { digest: "a".repeat(64), sourceKeys: ["notes", "status"] };
const payload = "b".repeat(64);
const error = (code: string) => (e: unknown) => e instanceof IncrementalQueueError && e.code === code;
function event(eventId = "event-1", pageKey = "page-1", reason: ChangeHint["reason"] = "content", observedAt = 1000): ChangeHint {
  return { eventId, sourceKey: "notes", pageKey, reason, observedAt };
}
async function setup(t: TestContext) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "incremental-queue-")));
  const time = { now: 2000 };
  const queues: Awaited<ReturnType<typeof openIncrementalQueue>>[] = [];
  const open = async (s = scope) => {
    const q = await openIncrementalQueue(dir, s, () => time.now); queues.push(q); return q;
  };
  const close = (q: typeof queues[number]) => { q.close(); queues.splice(queues.indexOf(q), 1); };
  t.after(async () => { for (const q of queues) q.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, time, open, close };
}
function proof(ticket: QueueTicket) { return { operationId: ticket.operationId, payloadDigest: payload, publicationRevision: "revision-2", readerVerified: true as const }; }

test("reopening retains event deduplication, cursor and private state permissions", async t => {
  const s = await setup(t); const q = await s.open();
  q.commitDiscovery({ sourceKey: "notes", name: "pages", expectedRevision: 0, nextCursor: "cursor-2", events: [event()] });
  s.close(q); const reopened = await s.open();
  assert.equal(reopened.enqueue([event()]), 0);
  assert.deepEqual(reopened.checkpoint("notes", "pages"), { revision: 1, cursor: "cursor-2" });
  assert.equal(reopened.status().events, 1); assert.equal(reopened.status().pending, 1);
  assert.equal((await stat(join(s.dir, "incremental.sqlite"))).mode & 0o077, 0);
});

test("a conflicting event rolls back the entire discovery page and cursor", async t => {
  const q = await (await setup(t)).open(); q.enqueue([event()]);
  assert.throws(() => q.commitDiscovery({ sourceKey: "notes", name: "pages", expectedRevision: 0, nextCursor: "cursor-2",
    events: [event("event-2", "page-2"), event("event-1", "different-page")] }), error("QUEUE_EVENT_CONFLICT"));
  assert.deepEqual(q.checkpoint("notes", "pages"), { revision: 0, cursor: null });
  assert.equal(q.status().events, 1); assert.equal(q.claim(10).length, 1);
});

test("two connections cannot advance a stale discovery cursor or claim the same page", async t => {
  const s = await setup(t); const first = await s.open(), second = await s.open();
  const prior = second.checkpoint("notes", "pages");
  first.commitDiscovery({ sourceKey: "notes", name: "pages", expectedRevision: prior.revision, nextCursor: "next", events: [event()] });
  assert.throws(() => second.commitDiscovery({ sourceKey: "notes", name: "pages", expectedRevision: prior.revision,
    nextCursor: "other", events: [event("event-2", "page-2")] }), error("QUEUE_CHECKPOINT_CONFLICT"));
  assert.equal(first.claim().length, 1); assert.deepEqual(second.claim(), []);
  assert.equal(second.status().events, 1);
});

test("out-of-order hints merge reasons without treating their timestamp as content", async t => {
  const q = await (await setup(t)).open();
  q.enqueue([event("new", "page-1", "properties", 3000), event("old", "page-1", "content", 1000), event("move", "page-1", "moved", 2000)]);
  const [ticket] = q.claim(); assert.equal(ticket.generation, 3);
  assert.deepEqual(ticket.reasons, ["content", "moved", "properties"]);
  assert.equal(q.status().leased, 1);
});

test("finishing old preparation does not discard an edit received during its lease", async t => {
  const q = await (await setup(t)).open(); q.enqueue([event()]); const [old] = q.claim();
  q.enqueue([event("edit-2", "page-1", "properties", 4000)]); q.completeUnchanged(old);
  assert.equal(q.status().pending, 1); assert.equal(q.status().done, 0);
  const [next] = q.claim(); assert.equal(next.generation, 2); assert.notEqual(next.operationId, old.operationId);
  assert.throws(() => q.completeUnchanged(old), error("QUEUE_STALE_TICKET"));
  q.completeUnchanged(next); assert.equal(q.status().done, 1);
});

test("expired preparation is reclaimed with a new token and fences the abandoned process", async t => {
  const s = await setup(t); const q = await s.open(); q.enqueue([event()]); const [old] = q.claim(1, 1000);
  s.time.now += 1000; const [next] = q.claim();
  assert.notEqual(old.operationId, next.operationId);
  assert.throws(() => q.markSubmitting(old, { payloadDigest: payload, expectedRevision: "revision-1" }), error("QUEUE_STALE_TICKET"));
  assert.throws(() => q.retryPreparation(old, "NETWORK_ERROR", 0), error("QUEUE_STALE_TICKET"));
  q.completeUnchanged(next);
});

test("a persisted submission survives a crash and is never reclaimed for blind resend", async t => {
  const s = await setup(t); let q = await s.open(); q.enqueue([event()]); s.close(q);
  const module = new URL("../scripts/website-incremental-sync/queue.ts", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { openIncrementalQueue } from ${JSON.stringify(module)};
    const q = await openIncrementalQueue(process.env.QUEUE_TEST_ROOT, ${JSON.stringify(scope)}, () => 2000);
    const [ticket] = q.claim(1, 1000);
    q.markSubmitting(ticket, { payloadDigest: ${JSON.stringify(payload)}, expectedRevision: "revision-1" });
    process.exit(23);
  `], { env: { ...process.env, QUEUE_TEST_ROOT: s.dir }, timeout: 10_000, maxBuffer: 8192 });
  assert.equal(child.status, 23);
  s.time.now += 1_000_000; q = await s.open();
  const [pending] = q.pendingVerifications(); const ticket = pending.ticket;
  assert.deepEqual(q.claim(), []);
  assert.deepEqual(q.pendingVerifications(), [{ ticket, payloadDigest: payload, expectedRevision: "revision-1" }]);
  assert.throws(() => q.retryPreparation(ticket, "TIMEOUT", 0), error("QUEUE_STALE_TICKET"));
  assert.throws(() => q.completeUnchanged(ticket), error("QUEUE_STALE_TICKET"));
  q.confirmCommit(ticket, proof(ticket)); assert.equal(q.status().done, 1); assert.deepEqual(q.pendingVerifications(), []);
});

test("a lost reply can only be acknowledged by the matching operation, digest and reader proof", async t => {
  const q = await (await setup(t)).open(); q.enqueue([event()]); const [ticket] = q.claim();
  q.markSubmitting(ticket, { payloadDigest: payload, expectedRevision: "revision-1" });
  for (const bad of [{ ...proof(ticket), operationId: "wrong" }, { ...proof(ticket), payloadDigest: "c".repeat(64) },
    { ...proof(ticket), readerVerified: false }]) {
    assert.throws(() => q.confirmCommit(ticket, bad as ReturnType<typeof proof>), error("QUEUE_PROOF_MISMATCH"));
  }
  assert.equal(q.pendingVerifications().length, 1); q.confirmCommit(ticket, proof(ticket));
  assert.throws(() => q.confirmCommit(ticket, proof(ticket)), error("QUEUE_STALE_TICKET"));
});

test("an edit during unknown submission remains pending after the earlier commit is verified", async t => {
  const q = await (await setup(t)).open(); q.enqueue([event()]); const [ticket] = q.claim();
  q.markSubmitting(ticket, { payloadDigest: payload, expectedRevision: "revision-1" });
  q.enqueue([event("event-2", "page-1", "moved", 3000)]);
  assert.deepEqual(q.claim(), []); q.confirmCommit(ticket, proof(ticket));
  const [next] = q.claim(); assert.equal(next.generation, 2); assert.ok(next.reasons.includes("moved"));
});

test("only a definitive matching rejection permits a delayed new submission attempt", async t => {
  const s = await setup(t); const q = await s.open(); q.enqueue([event()]); const [ticket] = q.claim();
  q.markSubmitting(ticket, { payloadDigest: payload, expectedRevision: "revision-1" });
  const rejected = { operationId: ticket.operationId, payloadDigest: payload, definitivelyRejected: true as const, code: "REVISION_CONFLICT" };
  assert.throws(() => q.confirmRejected(ticket, { ...rejected, definitivelyRejected: false } as unknown as typeof rejected, 1000), error("QUEUE_PROOF_MISMATCH"));
  q.confirmRejected(ticket, rejected, 1000); assert.deepEqual(q.claim(), []);
  q.enqueue([event("event-2", "page-1", "content", 3000)]); assert.deepEqual(q.claim(), []);
  s.time.now += 1000; const [next] = q.claim(); assert.equal(next.generation, 2); assert.notEqual(next.operationId, ticket.operationId);
});

test("review holds cannot be bypassed by new events, but can be explicitly resumed", async t => {
  const q = await (await setup(t)).open(); q.enqueue([event()]); const [ticket] = q.claim();
  q.requireReview(ticket, "SOURCE_SCOPE_UNKNOWN"); q.enqueue([event("event-2", "page-1", "policy", 3000)]);
  assert.deepEqual(q.claim(), []); assert.equal(q.status().needs_review, 1);
  assert.equal(q.resume("notes", "page-1"), true); assert.equal(q.resume("notes", "page-1"), false);
  assert.equal(q.claim()[0].generation, 3);
});

test("scope drift and unknown sources fail closed without dropping existing work", async t => {
  const s = await setup(t); const q = await s.open(); q.enqueue([event()]);
  await assert.rejects(s.open({ ...scope, digest: "c".repeat(64) }), error("QUEUE_SCOPE_MISMATCH"));
  await assert.rejects(s.open({ ...scope, sourceKeys: ["notes"] }), error("QUEUE_SCOPE_MISMATCH"));
  assert.throws(() => q.enqueue([{ ...event("outside"), sourceKey: "outside" }]), error("QUEUE_SCOPE_MISMATCH"));
  assert.equal(q.status().events, 1); assert.equal(q.status().pending, 1);
});

test("discovery, claim and retry sizes are bounded before changing state", async t => {
  const q = await (await setup(t)).open();
  assert.throws(() => q.enqueue(Array.from({ length: 201 }, (_, i) => event(`event-${i}`))), error("QUEUE_INPUT_INVALID"));
  assert.throws(() => q.claim(51), error("QUEUE_INPUT_INVALID"));
  assert.throws(() => q.claim(1, 900001), error("QUEUE_INPUT_INVALID"));
  q.enqueue([event()]); const [ticket] = q.claim();
  assert.throws(() => q.retryPreparation(ticket, "raw private message", 1000), error("QUEUE_INPUT_INVALID"));
  assert.throws(() => q.retryPreparation(ticket, "TIMEOUT", 86400001), error("QUEUE_INPUT_INVALID"));
  assert.equal(q.status().leased, 1);
});

test("opening rejects symlink sidecars and public state files", async t => {
  const s = await setup(t); const q = await s.open(); s.close(q);
  await symlink(join(s.dir, "incremental.sqlite"), join(s.dir, "incremental.sqlite-wal"));
  await assert.rejects(s.open(), error("QUEUE_PRIVATE_STATE_INVALID"));
  await rm(join(s.dir, "incremental.sqlite-wal"));
  await chmod(join(s.dir, "incremental.sqlite"), 0o644);
  await assert.rejects(s.open(), error("QUEUE_PRIVATE_STATE_INVALID"));
});

test("opening an unrelated SQLite database does not install queue tables", async t => {
  const s = await setup(t), path = join(s.dir, "incremental.sqlite"); await writeFile(path, "", { mode: 0o600 });
  const Constructor = (sqlite as unknown as { Database?: typeof sqlite.DatabaseSync }).Database ?? sqlite.DatabaseSync;
  const foreign = new Constructor(path); foreign.exec("CREATE TABLE unrelated(value TEXT)"); foreign.close();
  await assert.rejects(s.open(), error("QUEUE_SCHEMA_MISMATCH"));
  const read = new Constructor(path, { readOnly: true });
  try { assert.equal(read.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='scope'").get()!.n, 0); }
  finally { read.close(); }
});

test("repeated preparation failures back off, require review and expose new hints until explicit resume", async t => {
  const s = await setup(t), q = await s.open(); q.enqueue([event()]);
  for (let attempt = 1; attempt <= 5; attempt++) {
    const [ticket] = q.claim(1); assert.ok(ticket);
    assert.equal(q.retryPreparation(ticket, "IMAGE_UNAVAILABLE", 1000), attempt === 5 ? "needs_review" : "retry");
    if (attempt < 5) {
      assert.deepEqual(q.claim(), []);
      s.time.now += 1000 * 2 ** (attempt - 1) - 1; assert.deepEqual(q.claim(), []);
      s.time.now++; assert.equal(q.status().retry, 1);
    }
  }
  assert.equal(q.status().needs_review, 1); assert.deepEqual(q.claim(), []);
  assert.equal(q.listReview()[0].newChanges, false);
  q.enqueue([event("edit-after-hold", "page-1", "removed", 999999)]);
  assert.equal(q.listReview()[0].newChanges, true); assert.equal(q.status().events, 2);
  assert.deepEqual(q.claim(), []);
  assert.equal(q.resume("notes", "page-1"), true);
  const [next] = q.claim(); assert.equal(next.generation, 3);
  assert.equal(q.retryPreparation(next, "TEMPORARY", 1000), "retry");
});

test("deferral survives reopening, fences unsent work and preserves existing failure history", async t => {
  const s = await setup(t); let q = await s.open(); q.enqueue([event()]);
  for (let n = 0; n < 2; n++) q.retryPreparation(q.claim(1)[0], "PAGE_TEMPORARY", 0);
  for (let n = 0; n < 6; n++) {
    const [ticket] = q.claim(1);
    q.deferPreparation(ticket, n % 2 ? "CANCELLED" : "PUBLICATION_UNAVAILABLE", 1000);
    const proof = q.attemptClosure(ticket.operationId)!;
    assert.equal(proof.disposition, "never_submitted"); assert.equal(proof.payloadDigest, null);
    assert.throws(() => q.assertPreparing(ticket), error("QUEUE_STALE_TICKET"));
    assert.throws(() => q.markSubmitting(ticket, { payloadDigest: payload, expectedRevision: "revision-1" }), error("QUEUE_STALE_TICKET"));
    s.close(q); q = await s.open(); assert.ok(q.pendingRetirements().some(p => p.ticket.operationId === ticket.operationId));
    s.time.now += 999; assert.deepEqual(q.claim(1), []); s.time.now++;
    assert.equal(q.status().retry, 1); assert.equal(q.status().needs_review, 0);
  }
  for (let n = 3; n <= 5; n++) {
    const [ticket] = q.claim(1); assert.equal(ticket.generation, 1); assert.deepEqual(ticket.reasons, ["content"]);
    assert.equal(q.retryPreparation(ticket, "PAGE_TEMPORARY", 0), n === 5 ? "needs_review" : "retry");
  }
  assert.equal(q.status().needs_review, 1);
});

test("deferral cannot release an expired, foreign or already submitted ticket", async t => {
  const s = await setup(t), q = await s.open(); q.enqueue([event()]);
  const [ticket] = q.claim(1, 1000);
  assert.throws(() => q.deferPreparation({ ...ticket, generation: 2 }, "CANCELLED", 0), error("QUEUE_STALE_TICKET"));
  s.time.now += 1000;
  assert.throws(() => q.deferPreparation(ticket, "CANCELLED", 0), error("QUEUE_STALE_TICKET"));
  const [next] = q.claim(1); q.markSubmitting(next, { payloadDigest: payload, expectedRevision: "revision-1" });
  assert.throws(() => q.deferPreparation(next, "CANCELLED", 0), error("QUEUE_STALE_TICKET"));
  assert.equal(q.pendingVerifications()[0].ticket.operationId, next.operationId);
});


test("history GC preserves current retries, unknown sends, unretired work and the latest commit proof", async t => {
  const s = await setup(t), q = await s.open();
  const done = (id: string, commit = false) => {
    q.enqueue([event(id)]); const ticket = q.claim(1)[0];
    if (commit) { q.markSubmitting(ticket, { payloadDigest: payload, expectedRevision: "revision-1" }); q.confirmCommit(ticket, proof(ticket)); }
    else q.completeUnchanged(ticket);
    return ticket;
  };
  const old = done("old-commit", true), unretired = done("old-unchanged");
  const latestCommit = done("new-commit", true);
  const recent = done("new-unchanged");
  q.enqueue([event("unknown", "page-unknown")]); const unknown = q.claim(1)[0];
  q.markSubmitting(unknown, { payloadDigest: payload, expectedRevision: "revision-1" });
  q.enqueue([event("retry", "page-retry")]);
  for (let n = 0; n < 4; n++) { q.retryPreparation(q.claim(1)[0], "TEMPORARY", 0); }
  const before = q.status();
  assert.deepEqual(q.compactHistory(1), { attempts: 1, retirements: 0 }); // only superseded commit
  assert.deepEqual(q.status(), before);
  assert.deepEqual(q.compactHistory(), { attempts: 0, retirements: 0 });
  const retirement = q.pendingRetirements().find(p => p.ticket.operationId === unretired.operationId)!;
  q.acknowledgeRetirement(retirement);
  assert.deepEqual(q.compactHistory(), { attempts: 1, retirements: 1 });
  assert.equal(q.attemptClosure(unretired.operationId), null);
  assert.ok(q.attemptClosure(recent.operationId));
  assert.equal(q.pendingVerifications()[0].ticket.operationId, unknown.operationId);
  assert.equal(q.retryPreparation(q.claim(1)[0], "TEMPORARY", 0), "needs_review");
  s.close(q);
  const Constructor = (sqlite as unknown as { Database?: typeof sqlite.DatabaseSync }).Database ?? sqlite.DatabaseSync;
  const db = new Constructor(join(s.dir, "incremental.sqlite"), { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT count(*) AS n FROM attempts WHERE id=?").get(old.operationId)!.n, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM attempts WHERE id=?").get(latestCommit.operationId)!.n, 1);
  } finally { db.close(); }
  const reopened = await s.open();
  assert.equal(reopened.enqueue([event("old-commit")]), 0);
  assert.throws(() => reopened.enqueue([event("old-commit", "different")]), error("QUEUE_EVENT_CONFLICT"));
  assert.equal(reopened.status().needs_review, 1);
  assert.throws(() => reopened.compactHistory(1001), error("QUEUE_INPUT_INVALID"));
});
