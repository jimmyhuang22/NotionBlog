import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixtureItems } from "../fixtures/content.ts";
import { WEBSITE_SCHEMA_DIGEST } from "../contracts/website-sync.ts";
import { preparePublicationDelta } from "../src/server/database/incremental-publication.ts";
import { createIncrementalCoordinator, type CoordinatorOptions, type CoordinatorReceipt,
  type CoordinatorClosure } from "../scripts/website-incremental-sync/coordinator.ts";

function fixture() {
  const ticket = { operationId: randomUUID(), sourceKey: "status", pageKey: "demo", generation: 1, reasons: ["content"] };
  const state = { publicationRevision: `${randomUUID()}:0`, configDigest: "a".repeat(64), schemaDigest: WEBSITE_SCHEMA_DIGEST, policyEpoch: "0" };
  const item = structuredClone(fixtureItems.status[0]); Object.assign(item, { id: "demo", slug: "demo", href: "/status#demo" });
  const delta = preparePublicationDelta({ expectedRevision: state.publicationRevision, configDigest: state.configDigest, media: [], withdrawals: [],
    upserts: [{ detail: { item, document: { blocks: [], toc: [], completeness: "complete" } },
      evidence: { sourceKey: "status", dataSourceId: "demo-source", databaseParentId: null, courseId: null, parentId: null, ordinal: 0 } }] });
  const receipt: CoordinatorReceipt = { operationId: ticket.operationId, payloadDigest: delta.payloadDigest, publicationRevision: `${randomUUID()}:1`, committed: true };
  const trace: string[] = [], staged = new Map<string, string>(), proofs = new Set<string>();
  let closure: CoordinatorClosure<typeof ticket> | null = null, version = state.publicationRevision;
  const options: CoordinatorOptions<typeof ticket> = {
    scopeDigest: state.configDigest, sourceKeys: ["status", "courses", "notes"], studySourceKeys: ["courses", "notes"],
    queue: { assertPreparing: () => { trace.push("fence"); }, attemptClosure: () => closure },
    publication: { state: async () => state, submit: async () => { trace.push("submit"); return { outcome: "committed", receipt }; },
      lookup: async () => { trace.push("lookup"); return receipt; } },
    regular: { prepare: async () => { trace.push("regular"); return { outcome: "prepared", delta }; } },
    checkpoint: { load: () => ({ version, sourceDigest: state.configDigest }),
      stageOtherPublication: (id, next) => { trace.push("stage"); staged.set(id, next.payloadDigest); }, ownsOperation: (id, hash) => staged.get(id) === hash },
    study: { prepare: async t => { trace.push("study"); staged.set(t.operationId, delta.payloadDigest); return { outcome: "prepared", delta }; },
      verify: async r => { trace.push("reader"); proofs.add(JSON.stringify(r)); return true; },
      finalize: async r => { if (!proofs.has(JSON.stringify(r))) throw Error("No independent proof"); trace.push("install"); version = r.publicationRevision; },
      retire: async p => { trace.push("retire"); staged.delete(p.ticket.operationId); } },
  };
  const signal = new AbortController().signal;
  return { ticket, state, delta, receipt, trace, options, signal, staged, setClosure: (p: typeof closure) => { closure = p; } };
}
const code = (expected: string) => (e: unknown) => !!e && typeof e === "object" && "code" in e && e.code === expected;

test("ordinary publications journal study state before send and use the proof-retaining reader path", async () => {
  const f = fixture(), ports = createIncrementalCoordinator(f.options);
  assert.equal((await ports.prepare(f.ticket, await ports.state(f.signal), f.signal)).outcome, "prepared");
  await ports.submit(f.ticket.operationId, f.delta, f.signal);
  await assert.rejects(ports.finalize(f.receipt, f.signal), /No independent proof/);
  assert.equal(await ports.verify(f.receipt, f.signal), true); await ports.finalize(f.receipt, f.signal);
  assert.deepEqual(f.trace, ["fence", "regular", "fence", "stage", "submit", "reader", "install"]);
  assert.equal(f.options.checkpoint.load().version, f.receipt.publicationRevision);
});
test("study routes use their staged operation and do not stage an ordinary checkpoint over it", async () => {
  const f = fixture(), ports = createIncrementalCoordinator(f.options);
  await ports.prepare({ ...f.ticket, sourceKey: "notes" }, f.state, f.signal);
  assert.deepEqual(f.trace, ["fence", "study", "fence"]);
});
test("unknown outcomes recover by lookup and reader without preparation or another submission", async () => {
  const f = fixture(); f.staged.set(f.ticket.operationId, f.delta.payloadDigest);
  f.options.regular.prepare = async () => assert.fail("Recovery prepared content");
  f.options.study.prepare = async () => assert.fail("Recovery prepared study");
  f.options.publication.submit = async () => assert.fail("Recovery resent content");
  const ports = createIncrementalCoordinator(f.options), receipt = await ports.lookup(f.ticket.operationId, f.delta.payloadDigest, f.signal);
  assert.ok(receipt); assert.equal(await ports.verify(receipt, f.signal), true); await ports.finalize(receipt, f.signal);
  assert.deepEqual(f.trace, ["lookup", "reader", "install"]);
});
test("failed independent verification cannot install the ordinary publication checkpoint", async () => {
  const f = fixture(); f.staged.set(f.ticket.operationId, f.delta.payloadDigest);
  f.options.study.verify = async () => false;
  const ports = createIncrementalCoordinator(f.options);
  assert.equal(await ports.verify(f.receipt, f.signal), false);
  await assert.rejects(ports.finalize(f.receipt, f.signal), /No independent proof/);
  assert.equal(f.options.checkpoint.load().version, f.state.publicationRevision);
});
test("a missing operation or changed digest cannot use submit, recovery or proof installation", async () => {
  const f = fixture(), ports = createIncrementalCoordinator(f.options);
  await assert.rejects(ports.submit(f.ticket.operationId, f.delta, f.signal), code("COORDINATOR_OPERATION_UNSTAGED"));
  await assert.rejects(ports.lookup(f.ticket.operationId, f.delta.payloadDigest, f.signal), code("COORDINATOR_OPERATION_UNSTAGED"));
  await assert.rejects(ports.verify(f.receipt, f.signal), code("COORDINATOR_OPERATION_UNSTAGED"));
  await assert.rejects(ports.finalize(f.receipt, f.signal), code("COORDINATOR_OPERATION_UNSTAGED"));
  f.staged.set(f.ticket.operationId, "b".repeat(64));
  await assert.rejects(ports.verify(f.receipt, f.signal), code("COORDINATOR_OPERATION_UNSTAGED")); assert.deepEqual(f.trace, []);
});
test("unchanged, pending media and review outcomes do not journal or publish", async () => {
  for (const result of [{ outcome: "unchanged" }, { outcome: "retry", code: "MEDIA_PENDING" }, { outcome: "review", code: "SOURCE_SCOPE_UNKNOWN" }] as const) {
    const f = fixture(); f.options.regular.prepare = async () => result;
    assert.deepEqual(await createIncrementalCoordinator(f.options).prepare(f.ticket, f.state, f.signal), result);
    assert.equal(f.staged.size, 0); assert.deepEqual(f.trace, ["fence"]);
  }
});
test("changed scope or checkpoint version stops before source preparation", async () => {
  const f = fixture(), ports = createIncrementalCoordinator(f.options);
  await assert.rejects(ports.prepare(f.ticket, { ...f.state, configDigest: "b".repeat(64) }, f.signal), code("COORDINATOR_SCOPE_MISMATCH"));
  await assert.rejects(ports.prepare(f.ticket, { ...f.state, publicationRevision: `${randomUUID()}:9` }, f.signal), code("COORDINATOR_CHECKPOINT_VERSION_CHANGED"));
  assert.deepEqual(await ports.prepare({ ...f.ticket, sourceKey: "other" }, f.state, f.signal), { outcome: "review", code: "COORDINATOR_SOURCE_UNKNOWN" });
  assert.deepEqual(f.trace, []);
});
test("a generation change or cancellation while preparing cannot stage an ordinary next state", async () => {
  const f = fixture(); let fences = 0;
  f.options.queue.assertPreparing = () => { if (++fences > 1) throw Error("Superseded generation"); };
  await assert.rejects(createIncrementalCoordinator(f.options).prepare(f.ticket, f.state, f.signal), /Superseded generation/);
  assert.equal(f.staged.size, 0);
  const g = fixture(), abort = new AbortController();
  g.options.regular.prepare = async () => { abort.abort(); return { outcome: "prepared", delta: g.delta }; };
  await assert.rejects(createIncrementalCoordinator(g.options).prepare(g.ticket, g.state, abort.signal), code("COORDINATOR_CANCELLED"));
  assert.equal(g.staged.size, 0);
});
test("mutated payloads and undisclosed sources cannot be journaled", async () => {
  for (const foreign of [false, true]) {
    const f = fixture(), delta = structuredClone(f.delta);
    if (foreign) delta.upserts[0].evidence.sourceKey = "foreign"; else delta.upserts[0].detail.item.title = "Mutated";
    f.options.regular.prepare = async () => ({ outcome: "prepared", delta: foreign ? preparePublicationDelta(delta) : delta });
    await assert.rejects(createIncrementalCoordinator(f.options).prepare(f.ticket, f.state, f.signal), code("COORDINATOR_PREPARED_MISMATCH"));
    assert.equal(f.staged.size, 0);
  }
});
test("retirement needs the exact durable queue closure, including generation, before deleting staged state", async () => {
  const f = fixture(), ports = createIncrementalCoordinator(f.options);
  f.staged.set(f.ticket.operationId, f.delta.payloadDigest);
  const proof: CoordinatorClosure<typeof f.ticket> = { ticket: f.ticket, disposition: "never_submitted", payloadDigest: null };
  await assert.rejects(ports.retire(proof, f.signal), code("COORDINATOR_TERMINAL_UNCONFIRMED"));
  f.setClosure({ ...proof, ticket: { ...f.ticket, generation: 2 } });
  await assert.rejects(ports.retire(proof, f.signal), code("COORDINATOR_TERMINAL_UNCONFIRMED"));
  assert.equal(f.staged.size, 1); f.setClosure(proof); await ports.retire(proof, f.signal); await ports.retire(proof, f.signal);
  assert.equal(f.staged.size, 0);
});
test("scope configuration cannot route an unconfigured or duplicated study source", () => {
  const f = fixture();
  for (const change of [{ studySourceKeys: ["foreign"] }, { sourceKeys: ["status", "status"] }, { studySourceKeys: [] }, { scopeDigest: "private input" }])
    assert.throws(() => createIncrementalCoordinator({ ...f.options, ...change }), code("COORDINATOR_CONFIG_INVALID"));
});
