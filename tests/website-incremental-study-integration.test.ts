import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { fixtureItems } from "../fixtures/content.ts";
import type { WebsiteRecord } from "../contracts/website-sync.ts";
import { WEBSITE_SCHEMA_DIGEST } from "../contracts/website-sync.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";
import { publicationWriter } from "../src/server/database/publication.ts";
import { preparePublicationDelta, readPublicationState, type PreparedPublicationDelta } from "../src/server/database/incremental-publication.ts";
import { installPublication } from "../scripts/website-sync/publication-migration.ts";
import { installIncrementalPublication } from "../scripts/website-sync/incremental-migration.ts";
import { installIncrementalReader } from "../scripts/website-sync/incremental-reader-migration.ts";
import { createDatabasePublicationPort, createDatabasePublishedPageReader } from "../scripts/website-incremental-sync/publication-port.ts";
import { openIncrementalQueue, type QueueTicket } from "../scripts/website-incremental-sync/queue.ts";
import { runIncrementalCycle, type IncrementalPorts } from "../scripts/website-incremental-sync/executor.ts";
import { openStudyCheckpoint } from "../scripts/website-incremental-sync/study-checkpoint.ts";
import { createStudyDomainPort } from "../scripts/website-incremental-sync/study-domain.ts";
import { studyFixture, studyId } from "./helpers/study-runtime.ts";
import studyProtocol from "../database/website-study-protocol.json" with { type: "json" };

async function setup(t: TestContext) {
  const f = studyFixture(), directory = await realpath(await mkdtemp(join(tmpdir(), "queue-study-sql-"))), db = await PGlite.create();
  const closeLocal: (() => void)[] = [];
  t.after(async () => { closeLocal.forEach(close => close()); await db.close(); await rm(directory, { recursive: true, force: true }); });
  await db.exec(await readFile(new URL("../database/website-migrations/001_website.sql", import.meta.url), "utf8"));
  await db.query("UPDATE nb_v2.state SET schema_digest=$1", [WEBSITE_SCHEMA_DIGEST]);
  await db.exec(await readFile(new URL("../database/website-study-migrations/001_automatic_study.sql", import.meta.url), "utf8"));
  await db.query("UPDATE nb_v2.migrations SET digest=$1 WHERE version=$2", [studyProtocol.migration.sha256, studyProtocol.migration.version]);
  const operator: SqlExecutor = { query: async <T>(sql: string, values?: unknown[]) => {
    if (sql.startsWith("--")) { await db.exec(sql); return { rows: [] as T[] }; } return db.query<T>(sql, values);
  } };
  await installPublication(operator); await installIncrementalPublication(operator); await installIncrementalReader(operator);
  const role = (name: "nb_reader" | "nb_writer"): SqlExecutor => ({ query: <T>(sql: string, values?: unknown[]) => db.transaction(async tx => {
    await tx.exec(`SET LOCAL ROLE ${name}`); return tx.query<T>(sql, values);
  }) });
  const reader = role("nb_reader"), writer = role("nb_writer"), publication = createDatabasePublicationPort(writer, reader);
  const sources = [{ key: "courses", kind: "course", mode: "all", dataSourceId: studyId(10), databaseParentId: null, pageId: null },
    { key: "notes", kind: "study-note", mode: "course-descendants", dataSourceId: studyId(10), databaseParentId: null, pageId: null },
    { key: "status", kind: "status", mode: "all", dataSourceId: studyId(11), databaseParentId: null, pageId: null }];
  await db.query("SELECT nb_v2_api.configure_policy($1,600,$2::jsonb,'[]')", [f.checkpoint.sourceDigest, JSON.stringify(sources)]);
  const status = structuredClone(fixtureItems.status[0]);
  delete (status as unknown as Record<string, unknown>).images;
  delete (status as unknown as Record<string, unknown>).hasMoreBody;
  Object.assign(status, { id: studyId(20), slug: studyId(20), href: `/status#${studyId(20)}`, cover: null });
  const statusRecord: WebsiteRecord = { detail: { item: status, document: { blocks: [], toc: [], completeness: "complete" } },
    evidence: { sourceKey: "status", dataSourceId: studyId(11), databaseParentId: null, courseId: null, parentId: null, ordinal: 0 } };
  const full = publicationWriter(writer, "published"); await full.verifyStudy!(); const lease = await full.begin(randomUUID(), f.checkpoint.sourceDigest);
  await full.stage(lease, [...f.checkpoint.entries.map(e => e.record), statusRecord], []); await full.promote(lease, { records: 3, media: 0, complete: true });
  f.checkpoint.version = (await readPublicationState(reader)).publicationRevision;
  const scope = { digest: f.checkpoint.sourceDigest, sourceKeys: ["courses", "notes", "status"] };
  let queue = await openIncrementalQueue(directory, scope), store = await openStudyCheckpoint(directory, scope.digest);
  store.initialize(f.checkpoint, { publicationRevision: f.checkpoint.version, configDigest: scope.digest, readerVerified: true });
  closeLocal.push(() => { queue.close(); store.close(); });
  function domain(recovery = false) {
    return createStudyDomainPort<QueueTicket>({ store, sourceKeys: ["courses", "notes"], assertPreparing: ticket => queue.assertPreparing(ticket),
      source: () => recovery ? assert.fail("Recovery must not recollect study") : f.source, verify: publication.verify,
      incomingLinks: async (_changes, state) => ({ records: [], ...state, verified: true }), assets: async () => ({ media: [], verified: true }) });
  }
  function ports(recovery = false): IncrementalPorts<PreparedPublicationDelta> {
    const study = domain(recovery);
    return { ...publication, ...study, prepare: async (ticket, state, signal) => {
      if (ticket.sourceKey !== "status") return study.prepare(ticket, state, signal);
      const delta = preparePublicationDelta({ expectedRevision: state.publicationRevision, configDigest: state.configDigest, upserts: [statusRecord], media: [], withdrawals: [] });
      signal.throwIfAborted(); queue.assertPreparing(ticket); store.stageOtherPublication(ticket.operationId, delta);
      return { outcome: "prepared", delta };
    }, retire: async (proof, signal) => { assert.deepEqual(queue.attemptClosure(proof.ticket.operationId), proof); await study.retire(proof, signal); } };
  }
  return { f, reader, publication, statusRecord, get queue() { return queue; }, get store() { return store; }, domain, ports,
    enqueue: (id: string, sourceKey = "notes", pageKey = studyId(2)) => queue.enqueue([{ eventId: id, sourceKey, pageKey, reason: "content", observedAt: 1000 }]),
    run: (p: IncrementalPorts<PreparedPublicationDelta>, extra = {}) => runIncrementalCycle({ queue, schemaDigest: WEBSITE_SCHEMA_DIGEST, ...extra }, p),
    reopen: async () => { queue.close(); store.close(); queue = await openIncrementalQueue(directory, scope); store = await openStudyCheckpoint(directory, scope.digest); },
  };
}

test("actual queue, SQL and domain checkpoint stay aligned across status, study and status updates", async t => {
  const s = await setup(t);
  s.statusRecord.detail.item.title = "First status update"; s.enqueue("status-one", "status", studyId(20));
  assert.equal((await s.run(s.ports(), { maxTasks: 1 })).outcome, "updated"); assert.equal(s.f.reads(), 0);
  assert.equal(s.store.load().version, (await readPublicationState(s.reader)).publicationRevision);
  s.f.current.get(studyId(2))!.record.detail.document!.blocks = [{ id: "changed", type: "paragraph", text: [{ text: "Changed study body" }] }];
  s.enqueue("study-one"); assert.equal((await s.run(s.ports(), { maxTasks: 1 })).outcome, "updated");
  assert.equal(s.store.load().version, (await readPublicationState(s.reader)).publicationRevision);
  const reads = s.f.reads(); s.statusRecord.detail.item.title = "Second status update"; s.enqueue("status-two", "status", studyId(20));
  assert.equal((await s.run(s.ports(), { maxTasks: 1 })).outcome, "updated"); assert.equal(s.f.reads(), reads);
  const state = await readPublicationState(s.reader), published = await createDatabasePublishedPageReader(s.reader)({ operationId: "unused", sourceKey: "notes", pageKey: studyId(2), generation: 1, reasons: [] }, state, new AbortController().signal);
  assert.equal(s.store.load().version, state.publicationRevision); assert.deepEqual(s.store.load().entries[1].record, published!.record);
  assert.equal(s.queue.status().done, 2); assert.equal(s.queue.status().needs_review, 0);
});

test("after-stage cancellation retires the actual SQLite preparation before any new study read", async t => {
  const s = await setup(t); s.f.current.get(studyId(2))!.record.detail.document!.blocks = []; s.enqueue("cancel-after-stage");
  const controller = new AbortController(), p = s.ports(); let operationId = "", payloadDigest = "";
  const prepare = p.prepare; p.prepare = async (ticket, state, signal) => {
    const prepared = await prepare(ticket, state, signal); assert.equal(prepared.outcome, "prepared");
    if (prepared.outcome === "prepared") { operationId = ticket.operationId; payloadDigest = prepared.delta.payloadDigest; }
    controller.abort(); return prepared;
  };
  p.submit = async () => assert.fail("Cancelled prepared state must not submit");
  assert.equal((await s.run(p, { signal: controller.signal })).outcome, "cancelled"); assert.ok(s.store.ownsOperation(operationId, payloadDigest));
  const reads = s.f.reads(); await s.reopen();
  assert.equal((await s.run(s.ports(true), { maxTasks: 1 })).retired, 1); assert.equal(s.f.reads(), reads);
  assert.throws(() => s.store.install({ operationId, payloadDigest, publicationRevision: `${randomUUID()}:1`, readerVerified: true }), { message: "STUDY_OPERATION_RETIRED" });
  assert.equal(s.queue.status().retirement_pending, 0);
});

test("lost actual SQL reply and lost local install reply recover without preparing or submitting again", async t => {
  const s = await setup(t); s.f.current.get(studyId(2))!.record.detail.document!.blocks = []; s.enqueue("lost-replies");
  const p = s.ports(), submit = p.submit;
  p.submit = async (id, delta, signal) => { await submit(id, delta, signal); throw new Error("Reply lost after commit"); };
  assert.equal((await s.run(p)).outcome, "blocked"); const reads = s.f.reads(); await s.reopen();
  const recovering = s.ports(true), finalize = recovering.finalize!;
  recovering.submit = async () => assert.fail("Recovery cannot resend");
  recovering.finalize = async (receipt, signal) => { await finalize(receipt, signal); throw new Error("Reply lost after local install"); };
  assert.equal((await s.run(recovering)).errorCode, "CHECKPOINT_UNSAVED"); await s.reopen();
  const recovered = s.ports(true); recovered.submit = async () => assert.fail("Repeated recovery cannot resend");
  const result = await s.run(recovered); assert.equal(result.outcome, "updated"); assert.equal(result.recovered, 1); assert.equal(s.f.reads(), reads);
  assert.equal(s.store.load().version, (await readPublicationState(s.reader)).publicationRevision);
  assert.equal(s.queue.status().done, 1); assert.equal(s.queue.status().retirement_pending, 0);
});
