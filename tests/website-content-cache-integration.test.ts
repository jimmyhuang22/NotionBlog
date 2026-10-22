import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { WEBSITE_SCHEMA_DIGEST } from "../contracts/website-sync.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";
import { publicationWriter } from "../src/server/database/publication.ts";
import { preparePublicationDelta, readPublicationState, type PreparedPublicationDelta } from "../src/server/database/incremental-publication.ts";
import { readPublishedRecord } from "../src/server/database/incremental-reader.ts";
import { canonicalJson } from "../src/server/database/website-validation.ts";
import { installPublication } from "../scripts/website-sync/publication-migration.ts";
import { installIncrementalPublication } from "../scripts/website-sync/incremental-migration.ts";
import { installIncrementalReader } from "../scripts/website-sync/incremental-reader-migration.ts";
import { createDatabasePublicationPort } from "../scripts/website-incremental-sync/publication-port.ts";
import { openIncrementalQueue, type IncrementalQueue, type QueueTicket } from "../scripts/website-incremental-sync/queue.ts";
import { runIncrementalCycle, type IncrementalPorts } from "../scripts/website-incremental-sync/executor.ts";
import { openStudyCheckpoint, type StudyCheckpointStore } from "../scripts/website-incremental-sync/study-checkpoint.ts";
import { createStudyDomainPort } from "../scripts/website-incremental-sync/study-domain.ts";
import { createIncrementalCoordinator } from "../scripts/website-incremental-sync/coordinator.ts";
import { openContentCache, type ContentCacheStore } from "../scripts/website-incremental-sync/content-cache.ts";
import { withContentCache } from "../scripts/website-incremental-sync/content-cache-ports.ts";
import { cacheFixture, cacheProof } from "./helpers/content-cache.ts";
import { studyId } from "./helpers/study-runtime.ts";
import studyProtocol from "../database/website-study-protocol.json" with { type: "json" };

test("actual queue, cache, study checkpoint and SQL recover mixed updates without rereading unchanged bodies", async t => {
  const f = cacheFixture(true), directory = await realpath(await mkdtemp(join(tmpdir(), "content-cache-sql-"))), db = await PGlite.create();
  const local: (() => void)[] = [], closeLocal = () => { for (const close of local.splice(0)) close(); };
  t.after(async () => { closeLocal(); await db.close(); await rm(directory, { recursive: true, force: true }); });
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
  await db.query("SELECT nb_v2_api.configure_policy($1,600,$2::jsonb,'[]')", [f.state.configDigest, JSON.stringify(sources)]);
  const full = publicationWriter(writer, "published"); await full.verifyStudy!(); const lease = await full.begin(randomUUID(), f.state.configDigest);
  await full.stage(lease, f.baseline.records, f.baseline.media); await full.promote(lease, { records: 4, media: 1, complete: true });
  Object.assign(f.state, await readPublicationState(reader)); f.checkpoint.version = f.state.publicationRevision;
  // Independently prove complete cardinality plus every raw record/media projection.
  const snapshot = (await reader.query<{ result: { records: unknown[]; mediaIds: string[]; runId: string; revision: string } }>(
    "SELECT nb_publication_api.read_snapshot($1,false) AS result", [["status", "course", "study-note", "post", "album", "book", "movie", "game", "project", "page"]])).rows[0].result;
  assert.equal(`${snapshot.runId}:${snapshot.revision}`, f.state.publicationRevision); assert.equal(snapshot.records.length, 4); assert.equal(snapshot.mediaIds.length, 1);
  for (const record of f.baseline.records) {
    const published = await readPublishedRecord(reader, { pageId: record.detail.item.id, sourceKey: record.evidence.sourceKey, expectedRevision: f.state.publicationRevision });
    assert.equal(canonicalJson(published!.record), canonicalJson(record));
    assert.deepEqual(published!.media, f.baseline.media.filter(m => m.ownerPageId === record.detail.item.id));
  }
  let queue: IncrementalQueue, checkpoint: StudyCheckpointStore, cache: ContentCacheStore;
  async function reopen() {
    closeLocal(); queue = await openIncrementalQueue(directory, { digest: f.state.configDigest, sourceKeys: f.sourceKeys }); const q = queue; local.push(() => q.close());
    checkpoint = await openStudyCheckpoint(directory, f.state.configDigest); const s = checkpoint; local.push(() => s.close());
    cache = await openContentCache(directory, f.state.configDigest, f.sourceKeys); const c = cache; local.push(() => c.close());
  }
  await reopen(); cache!.initialize(f.baseline, cacheProof(f.baseline)); checkpoint!.initialize(f.checkpoint, { publicationRevision: f.state.publicationRevision, configDigest: f.state.configDigest, readerVerified: true });
  let ordinaryReads = 0, submissions = 0;
  function ports(recovery = false): IncrementalPorts<PreparedPublicationDelta> {
    const study = createStudyDomainPort<QueueTicket>({ store: checkpoint, sourceKeys: ["courses", "notes"], assertPreparing: ticket => queue.assertPreparing(ticket),
      source: () => recovery ? assert.fail("Recovery cannot read study source") : f.source, verify: publication.verify,
      incomingLinks: async (changes, state) => cache.incomingLinks(changes, state), assets: async (records, state) => cache.assets(records, state) });
    const coordinator = createIncrementalCoordinator<QueueTicket>({ scopeDigest: f.state.configDigest, sourceKeys: f.sourceKeys, studySourceKeys: ["courses", "notes"], queue,
      checkpoint, study, publication: { ...publication, submit: async (...args) => { submissions++; return publication.submit(...args); } }, regular: {
        prepare: async (ticket, state) => {
          if (recovery) assert.fail("Recovery cannot read ordinary source"); ordinaryReads++;
          const previous = cache.readPublished(ticket, state)!, record = structuredClone(previous.record); record.detail.item.title = `Changed ${ordinaryReads}`;
          return { outcome: "prepared", delta: preparePublicationDelta({ expectedRevision: state.publicationRevision, configDigest: state.configDigest, upserts: [record], media: [], withdrawals: [] }) };
        },
      } });
    return withContentCache({ store: cache, queue, ports: coordinator, readVerifiedState: async () => readPublicationState(reader) });
  }
  const enqueue = (id: string, sourceKey: string, eventId: string) => queue.enqueue([{ eventId, sourceKey, pageKey: id, reason: "content", observedAt: 1 }]);
  const run = (p: IncrementalPorts<PreparedPublicationDelta>) => runIncrementalCycle({ queue, schemaDigest: WEBSITE_SCHEMA_DIGEST, maxTasks: 1 }, p);
  enqueue(studyId(20), "status", "status-first"); assert.equal((await run(ports())).published, 1);
  const renamed = f.current.get(studyId(2))!.record.detail.item;
  Object.assign(renamed, { slug: "renamed", href: `/study/${studyId(1)}/notes/renamed`, title: "New note title", updatedAt: "2026-01-03T00:00:00.000Z" });
  enqueue(studyId(2), "notes", "note-change"); const lostReply = ports(), submit = lostReply.submit;
  lostReply.submit = async (...args) => { await submit(...args); throw new Error("Synthetic lost successful SQL reply"); };
  assert.equal((await run(lostReply)).unresolved, 1); assert.equal(queue!.status().awaiting_verification, 1);
  const readsAfterSend = f.reads(); await reopen();
  const recoverInstall = ports(true), install = cache!.install.bind(cache!);
  cache!.install = proof => { install(proof); throw new Error("Synthetic lost successful cache installation reply"); };
  assert.equal((await run(recoverInstall)).unresolved, 1); assert.equal(queue!.status().awaiting_verification, 1);
  await reopen(); assert.equal((await run(ports(true))).recovered, 1); assert.equal(queue!.status().awaiting_verification, 0);
  assert.equal(f.reads(), readsAfterSend); assert.equal(ordinaryReads, 1); assert.equal(submissions, 2);
  enqueue(studyId(20), "status", "status-last"); assert.equal((await run(ports())).published, 1); assert.equal(submissions, 3);
  const state = await readPublicationState(reader); cache!.assertState(state); assert.equal(checkpoint!.load().version, state.publicationRevision);
  for (const original of f.baseline.records) {
    const ticket = { sourceKey: original.evidence.sourceKey, pageKey: original.detail.item.id }, cached = cache!.readPublished(ticket, state)!;
    const actual = await readPublishedRecord(reader, { pageId: ticket.pageKey, sourceKey: ticket.sourceKey, expectedRevision: state.publicationRevision });
    assert.equal(canonicalJson(cached.record), canonicalJson(actual!.record)); assert.deepEqual(cached.media, actual!.media);
  }
  const ordinary = cache!.readPublished({ sourceKey: "status", pageKey: studyId(20) }, state)!;
  assert.ok(JSON.stringify(ordinary.record).includes("New note title")); assert.ok(JSON.stringify(ordinary.record).includes("/notes/renamed"));
  assert.deepEqual(ordinary.media, f.baseline.media); assert.equal(f.reads(), readsAfterSend);
});
