import { performance } from "node:perf_hooks";
import type { RunLease } from "../../contracts/sync.ts";
import { ContentServiceError } from "../../contracts/repository.ts";
import { createWebsiteWriter } from "../../src/server/database/website-writer.ts";
import { callSql, type SqlExecutor } from "../../src/server/database/sql.ts";
import { configDigest } from "../../src/server/database/website-validation.ts";
import { parseWebsiteNotionConfig } from "../../src/server/notion/website-config.ts";
import type { NotionReadClient } from "../../src/server/notion/types.ts";
import { readCollectionCaptureForRevalidation, type CaptureIdentity, type CollectedPage } from "./collection-capture.ts";
import { runWebsiteSync } from "./worker.ts";
import { assertCourseRatingRemoval, type CourseRatingRemoval } from "./mapped-capture.ts";
import { readCaptureRecoveryAdmission, type CaptureRecoveryAdmission } from "./capture-recovery-admission.ts";

export type ResumeQualification = "original" | "fresh";
interface DeadlineReceipt {
  qualification?: ResumeQualification;
  runId: string; previousRunId: string; configDigest: string; fence: string; revision: string;
  validUntil: string; previousValidUntil: string; serverNow: string;
  previousConfigDigest?: string;
}
const fail = (): never => { throw new ContentServiceError("CONTENT_UNAVAILABLE", "Saved collection cannot be revalidated under the current qualification."); };

/** Only the database's existing run rows can establish this deadline. The local
 * monotonic check saves wasted reads; SQL assert_lease remains authoritative. */
export async function bindCollectionDeadline(db: SqlExecutor, lease: RunLease, previous: RunLease) {
  const sent = performance.now();
  const receipt = await callSql<DeadlineReceipt>(db,
    "SELECT nb_revalidation_api.bind_run($1,$2,$3,$4,$5) AS result",
    [lease.runId, lease.fence, previous.runId, previous.fence, previous.revision]);
  const serverNow = Date.parse(receipt.serverNow), until = Date.parse(receipt.validUntil), oldUntil = Date.parse(receipt.previousValidUntil);
  if (receipt.runId !== lease.runId || receipt.previousRunId !== previous.runId || receipt.configDigest !== lease.configDigest ||
      receipt.fence !== lease.fence || receipt.revision !== lease.revision || !Number.isFinite(serverNow) ||
      !Number.isFinite(until) || !Number.isFinite(oldUntil) || until > oldUntil || until <= serverNow) fail();
  const deadline = sent + until - serverNow;
  const check = () => { if (performance.now() >= deadline) fail(); };
  check();
  return { receipt, check };
}

/** Fresh source verification uses a NEW ordinary run's server qualification.
 * This RPC inspects provenance and the current lease; it never updates either
 * run's deadline. Old content remains untrusted until every source proof matches.
 */
export async function bindFreshCollectionDeadline(db: SqlExecutor, lease: RunLease, previous: RunLease, mapping?: CourseRatingRemoval) {
  if (mapping) {
    assertCourseRatingRemoval(mapping);
    if (previous.configDigest !== mapping.previousConfigDigest || lease.configDigest !== mapping.currentConfigDigest) fail();
  }
  const sent = performance.now();
  const receipt = await callSql<DeadlineReceipt>(db,
    mapping ? "SELECT nb_revalidation_api.inspect_mapped_fresh_run($1,$2,$3,$4,$5,$6) AS result" :
      "SELECT nb_revalidation_api.inspect_fresh_run($1,$2,$3,$4,$5) AS result",
    [lease.runId, lease.fence, previous.runId, previous.fence, previous.revision, ...(mapping ? [mapping.previousConfigDigest] : [])]);
  const serverNow = Date.parse(receipt.serverNow), until = Date.parse(receipt.validUntil);
  if (receipt.qualification !== "fresh" || receipt.runId !== lease.runId || receipt.previousRunId !== previous.runId ||
      receipt.configDigest !== lease.configDigest || receipt.fence !== lease.fence || receipt.revision !== lease.revision ||
      (mapping && receipt.previousConfigDigest !== mapping.previousConfigDigest) ||
      !Number.isFinite(serverNow) || !Number.isFinite(until) || !Number.isFinite(Date.parse(receipt.previousValidUntil)) || until <= serverNow) fail();
  const deadline = sent + until - serverNow;
  const check = () => { if (performance.now() >= deadline) fail(); };
  check(); return { receipt, check };
}

function samePage(old: CollectedPage, fresh: CollectedPage) {
  // New sibling membership may change ordering. Always use the fresh ordinal;
  // every other field, including actual parent, dates and complete body, matches.
  if (old.record.detail.document?.completeness !== "complete" || fresh.record.detail.document?.completeness !== "complete") return false;
  const projection = (p: CollectedPage) => ({ record: { ...p.record, evidence: { ...p.record.evidence, ordinal: 0 } },
    media: [...p.media].sort((a, b) => a.assetId.localeCompare(b.assetId)),
    bindings: [...p.bindings].sort((a, b) => a.assetId.localeCompare(b.assetId)) });
  return configDigest(projection(old)) === configDigest(projection(fresh));
}

type Options = Omit<Parameters<typeof runWebsiteSync>[0], "writer" | "mode" | "onIncrementalBaseline" | "revalidateCollectionOwners"> & {
  db: SqlExecutor; directory: string; identity: CaptureIdentity; publicationMode: "qualified"; mode: "stage" | "publish";
};

/** Explicit engineering entry, not enabled by host config or scheduler.
 * Saved pages are comparison inputs, NEVER staged. The regular worker discovers
 * current membership, rereads complete bodies and verifies current image bytes
 * (including its existing strong-validator cache path). Every saved member must
 * still exist unchanged, or the whole attempt fails before staging. New members
 * are collected normally. No automatic retries or fallback to old content.
 */
export async function runRevalidatedWebsiteSync(options: Options) {
  if (options.publicationMode !== "qualified" || !["stage", "publish"].includes(options.mode) ||
      configDigest(parseWebsiteNotionConfig(options.config)) !== options.identity.configDigest) fail();
  const saved = await readCollectionCaptureForRevalidation(options.directory, options.identity);
  const previous = saved.pages[0]?.lease;
  if (!previous || !/^[0-9]+$/.test(previous.fence) || !/^[0-9]+$/.test(previous.revision) ||
      saved.pages.some(page => !page.lease || configDigest(page.lease) !== configDigest(previous))) fail();
  const pending = new Map(saved.pages.map(page => [page.record.detail.item.id, page]));
  let bound: Awaited<ReturnType<typeof bindCollectionDeadline>> | undefined;
  const check = () => { options.signal?.throwIfAborted(); if (!bound) fail(); bound!.check(); };
  const writer = createWebsiteWriter(options.db);
  const guarded = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) => async (...args: A) => {
    check(); const result = await fn(...args); check(); return result;
  };
  const client: NotionReadClient = { ...options.client,
    getPage: guarded(options.client.getPage.bind(options.client)), getBlock: guarded(options.client.getBlock.bind(options.client)),
    getDataSource: guarded(options.client.getDataSource.bind(options.client)), listBlocks: guarded(options.client.listBlocks.bind(options.client)),
    ...(options.client.listPages ? { listPages: guarded(options.client.listPages.bind(options.client)) } : {}),
    ...(options.client.getDatabase ? { getDatabase: guarded(options.client.getDatabase.bind(options.client)) } : {}),
  };
  const result = await runWebsiteSync({ ...options, client, revalidateCollectionOwners: true,
    writer: { ...writer, async begin(id, digest, seconds) {
      const lease = await writer.begin(id, digest, seconds);
      try {
        bound = await bindCollectionDeadline(options.db, lease, previous!);
        return lease;
      } catch (error) { await writer.fail(lease).catch(() => {}); throw error; }
    }, stage: guarded(writer.stage), promote: async (lease, receipt) => { check(); await writer.promote(lease, receipt); } },
    captureCollection: {
      async save(fresh) {
        check(); const id = fresh.record.detail.item.id, old = pending.get(id);
        if (old && !samePage(old, fresh)) fail();
        pending.delete(id);
        await options.captureCollection?.save(fresh); check();
      },
      async seal(order) {
        check(); if (pending.size) fail();
        await options.captureCollection?.seal(order); check();
      },
    },
  });
  return { ...result, revalidatedPages: saved.pages.length, qualification: bound!.receipt };
}

/** Host-facing resume preparation. No network until the worker has acquired its
 * fixed new lease; its existing host writer retains receipts and run identity. */
export async function prepareCollectionResume(input: {
  directory: string; identity: CaptureIdentity; db: SqlExecutor;
  qualification?: ResumeQualification;
  recovery?: {
    admission: CaptureRecoveryAdmission; mapping?: CourseRatingRemoval;
    current: Pick<CaptureIdentity, "sourceSha256" | "configDigest" | "releaseCommit">;
  };
  onBound?: (receipt: DeadlineReceipt) => Promise<void>;
}) {
  if (input.qualification !== undefined && !["original", "fresh"].includes(input.qualification)) fail();
  if (input.recovery) {
    if (input.qualification !== "fresh") fail();
    const { admission: token, mapping, current } = input.recovery;
    const admission = readCaptureRecoveryAdmission(token);
    if (admission.producerReleaseCommit !== input.identity.releaseCommit || admission.consumerReleaseCommit !== current.releaseCommit) fail();
    if (admission.kind === "course-rating-removal") {
      if (!mapping) fail();
      assertCourseRatingRemoval(mapping!);
      if (mapping!.previousSourceSha256 !== input.identity.sourceSha256 || mapping!.previousConfigDigest !== input.identity.configDigest ||
          mapping!.currentSourceSha256 !== current.sourceSha256 || mapping!.currentConfigDigest !== current.configDigest) fail();
    } else if (mapping || current.sourceSha256 !== input.identity.sourceSha256 || current.configDigest !== input.identity.configDigest) fail();
  }
  const saved = await readCollectionCaptureForRevalidation(input.directory, input.identity);
  const previous = saved.pages[0]?.lease;
  if (!previous || !/^[0-9]+$/.test(previous.fence) || !/^[0-9]+$/.test(previous.revision) ||
      saved.pages.some(p => !p.sourceReads || !p.lease || configDigest(p.lease) !== configDigest(previous))) fail();
  const pages = input.recovery ? saved.pages.filter(page => page.record.detail.item.kind !== "course") : saved.pages;
  return { pages,
    courseProjectionRefresh: input.recovery ? { forcedCoursePages: saved.pages.length - pages.length, preservedPages: pages.length, originalCaptureUnchanged: true } : undefined,
    async bind(lease: RunLease) {
    if (input.recovery && lease.configDigest !== input.recovery.current.configDigest) fail();
    const bound = input.qualification === "fresh" ? await bindFreshCollectionDeadline(input.db, lease, previous!, input.recovery?.mapping) :
      await bindCollectionDeadline(input.db, lease, previous!);
    await input.onBound?.(bound.receipt); bound.check(); return bound.check;
  } };
}
