import { performance } from "node:perf_hooks";
import { ContentServiceError } from "../../contracts/repository.ts";
import type { RunLease } from "../../contracts/sync.ts";
import { WEBSITE_PROTOCOL, WEBSITE_SCHEMA_DIGEST, type WebsiteWriter } from "../../contracts/website-sync.ts";
import type { SqlExecutor } from "../../src/server/database/sql.ts";
import { configDigest } from "../../src/server/database/website-validation.ts";
import { parseWebsiteNotionConfig } from "../../src/server/notion/website-config.ts";
import type { NotionReadClient } from "../../src/server/notion/types.ts";
import { runWebsiteSync } from "./worker.ts";

const fail = (): never => { throw new ContentServiceError("CONTENT_UNAVAILABLE", "Full collection qualification is unavailable."); };
const invalid = (): never => { throw new ContentServiceError("MISCONFIGURED", "Invalid full collection preparation."); };
const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const counter = (value: unknown): value is string => typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value);

/** Explicit metadata projection on a separately supplied owner connection.
 * No row lock, stored DTO, old capture, previous-run API or privilege change.
 * The actual operator must bound this query and use a fresh statement snapshot.
 */
export const FULL_COLLECTION_LEASE_SQL = `SELECT
 s.protocol,s.schema_digest,s.config_digest,s.revision::text AS state_revision,s.epoch::text AS state_epoch,
 s.current_run::text,s.lease_run::text,s.fence::text AS state_fence,s.lease_until::text,s.freshness_seconds,
 r.id::text AS run_id,r.status AS run_status,r.fence::text AS run_fence,r.revision::text AS run_revision,
 r.epoch::text AS run_epoch,r.config_digest AS run_digest,r.started_at::text,r.finished_at::text,r.valid_until::text,
 clock_timestamp()::text AS server_now,
 (EXISTS(SELECT 1 FROM nb_v2.records WHERE run_id=r.id)
  OR EXISTS(SELECT 1 FROM nb_v2.media WHERE run_id=r.id)
  OR EXISTS(SELECT 1 FROM nb_v2.tombstones WHERE run_id=r.id)) AS has_payload
 FROM nb_v2.state s JOIN nb_v2.runs r ON r.id=$1::uuid WHERE s.singleton`;

export interface FullCollectionExpectation {
  configDigest: string; revision: string; epoch: string; currentRun: string | null;
  freshnessSeconds: number; minimumRemainingSeconds: number;
}
export interface FullCollectionQualification {
  readonly format: "website-full-collection-qualification-v1";
  readonly qualification: "full-collection";
  readonly runId: string; readonly fence: string; readonly revision: string; readonly epoch: string;
  readonly configDigest: string; readonly currentRun: string | null;
  readonly serverNow: string; readonly validUntil: string;
}
interface LeaseRow {
  protocol: string; schema_digest: string; config_digest: string; state_revision: string; state_epoch: string;
  current_run: string | null; lease_run: string | null; state_fence: string; lease_until: string;
  freshness_seconds: number; run_id: string; run_status: string; run_fence: string; run_revision: string;
  run_epoch: string; run_digest: string; started_at: string; finished_at: string | null; valid_until: string;
  server_now: string; has_payload: boolean;
}
function expectation(input: FullCollectionExpectation): FullCollectionExpectation {
  let value: FullCollectionExpectation;
  try { value = structuredClone(input); } catch { return invalid(); }
  if (!value || !/^[a-f0-9]{64}$/.test(value.configDigest) || !counter(value.revision) || !counter(value.epoch) ||
      value.currentRun !== null && !uuid(value.currentRun) ||
      !Number.isSafeInteger(value.freshnessSeconds) || value.freshnessSeconds < 1 || value.freshnessSeconds > 86400 ||
      !Number.isSafeInteger(value.minimumRemainingSeconds) || value.minimumRemainingSeconds < 1 ||
      value.minimumRemainingSeconds > value.freshnessSeconds) invalid();
  return Object.freeze(value);
}

/** One read after begin, before any source/body/media/stage operation. A
 * deadline only stops local work; every writer call still enforces SQL leases.
 * Returned closures are process-local. A serialized receipt grants no access.
 */
export async function qualifyFullCollectionLease(owner: SqlExecutor, input: RunLease, requested: FullCollectionExpectation) {
  const expected = expectation(requested);
  let lease: RunLease;
  try { lease = structuredClone(input); } catch { return invalid(); }
  if (!lease || !uuid(lease.runId) || !counter(lease.fence) || !counter(lease.revision) ||
      lease.configDigest !== expected.configDigest || lease.revision !== expected.revision || !Array.isArray(lease.deniedPageIds)) invalid();
  const sent = performance.now();
  let rows: LeaseRow[];
  try { rows = (await owner.query<LeaseRow>(FULL_COLLECTION_LEASE_SQL, [lease.runId])).rows; }
  catch { return fail(); }
  const row = rows?.[0];
  if (rows?.length !== 1 || !row || row.protocol !== WEBSITE_PROTOCOL || row.schema_digest !== WEBSITE_SCHEMA_DIGEST ||
      row.config_digest !== expected.configDigest || row.state_revision !== expected.revision || row.state_epoch !== expected.epoch ||
      row.current_run !== expected.currentRun || row.current_run === lease.runId || row.lease_run !== lease.runId ||
      row.state_fence !== lease.fence || row.freshness_seconds !== expected.freshnessSeconds ||
      row.run_id !== lease.runId || row.run_status !== "staging" || row.run_fence !== lease.fence ||
      row.run_revision !== expected.revision || row.run_epoch !== expected.epoch || row.run_digest !== expected.configDigest ||
      row.finished_at !== null || row.has_payload !== false) fail();
  const now = Date.parse(row.server_now), until = Date.parse(row.valid_until), started = Date.parse(row.started_at), leaseUntil = Date.parse(row.lease_until);
  if (![now, until, started, leaseUntil].every(Number.isFinite) || started > now || until <= now || leaseUntil <= now ||
      until - now > expected.freshnessSeconds * 1000 + 1 || leaseUntil - now > 900001) fail();
  // Charge the whole round trip conservatively; do not use the workstation's wall clock.
  const deadline = sent + until - now;
  const check = (reserveSeconds = 0) => {
    if (!Number.isSafeInteger(reserveSeconds) || reserveSeconds < 0 || reserveSeconds > 86400) invalid();
    if (performance.now() + reserveSeconds * 1000 >= deadline) fail();
  };
  check(expected.minimumRemainingSeconds);
  const receipt: FullCollectionQualification = Object.freeze({ format: "website-full-collection-qualification-v1",
    qualification: "full-collection", runId: lease.runId, fence: lease.fence, revision: lease.revision, epoch: expected.epoch,
    configDigest: expected.configDigest, currentRun: expected.currentRun, serverNow: row.server_now, validUntil: row.valid_until });
  return { receipt, check };
}

type WorkerOptions = Parameters<typeof runWebsiteSync>[0];
type FullCollectionOptions = Omit<WorkerOptions, "writer" | "mode" | "resumeCollection" | "onResumePlan" | "onResumeProgress" | "onIncrementalBaseline"> & {
  mode: "stage" | "publish"; writer: WebsiteWriter; publicationMode: "qualified"; owner: SqlExecutor;
  expectation: FullCollectionExpectation; onQualified?: (receipt: FullCollectionQualification) => Promise<void>;
};
const allowed = new Set(["client", "config", "mode", "writer", "storage", "download", "mediaSources", "maxMediaBytes", "maxCollectionBytes",
  "signal", "onStudyDiscoveryProgress", "collectionConcurrency", "onCollectionProgress", "revalidateCollectionOwners",
  "publicationRepair", "onPublicationRevalidation", "captureCollection", "publicationMode", "owner", "expectation", "onQualified"]);

/** Engineering entry only: no CLI, scheduler or host imports this module.
 * All records use the ordinary collector, with no saved-page input. Existing
 * source/image verification, writer fencing, limits and failure semantics stay.
 */
export async function runFullCollection(input: FullCollectionOptions) {
  if (!input || Object.keys(input).some(key => !allowed.has(key)) || input.publicationMode !== "qualified" ||
      !["stage", "publish"].includes(input.mode) || !input.writer || !input.storage ||
      !input.owner || typeof input.owner.query !== "function" ||
      input.onQualified !== undefined && typeof input.onQualified !== "function" ||
      ["begin", "renew", "stage", "promote", "fail"].some(key => typeof input.writer[key as keyof WebsiteWriter] !== "function") ||
      typeof input.storage.put !== "function" || typeof input.storage.read !== "function" || input.revalidateCollectionOwners === false) invalid();
  let config: unknown;
  try { config = structuredClone(input.config); } catch { return invalid(); }
  const options = { ...input, config }, expected = expectation(input.expectation);
  if (configDigest(parseWebsiteNotionConfig(options.config)) !== expected.configDigest) invalid();
  options.signal?.throwIfAborted();
  const writer = options.writer;
  let attempted = false, owned: RunLease | undefined, binding: Awaited<ReturnType<typeof qualifyFullCollectionLease>> | undefined;
  const check = () => { options.signal?.throwIfAborted(); if (!binding) fail(); binding!.check(); };
  const sameLease = (lease: RunLease) => {
    check();
    if (!owned || lease.runId !== owned.runId || lease.fence !== owned.fence || lease.revision !== owned.revision || lease.configDigest !== owned.configDigest) fail();
  };
  const guarded = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) => async (...args: A) => {
    check(); const result = await fn(...args); check(); return result;
  };
  const client = options.client;
  const guardedClient: NotionReadClient = {
    getPage: guarded(client.getPage.bind(client)), getDataSource: guarded(client.getDataSource.bind(client)),
    getBlock: guarded(client.getBlock.bind(client)), listBlocks: guarded(client.listBlocks.bind(client)),
    ...(client.listPages ? { listPages: guarded(client.listPages.bind(client)) } : {}),
    ...(client.getDatabase ? { getDatabase: guarded(client.getDatabase.bind(client)) } : {}),
  };
  const wrapped: WebsiteWriter = {
    ...(writer.verifyStudy ? { verifyStudy: writer.verifyStudy.bind(writer) } : {}),
    async begin(...args) {
      if (attempted) fail(); attempted = true;
      try {
        owned = structuredClone(await writer.begin(...args));
        binding = await qualifyFullCollectionLease(options.owner, owned, expected);
        await options.onQualified?.(binding.receipt);
        check(); binding.check(expected.minimumRemainingSeconds);
        Object.freeze(owned.deniedPageIds); return Object.freeze(owned);
      } catch {
        let cleanupFailed = false;
        if (owned) try { await writer.fail(owned); } catch { cleanupFailed = true; }
        // A failed bind occurs before the worker receives the lease, so cleanup is owned here.
        throw Object.assign(new ContentServiceError("CONTENT_UNAVAILABLE", "Full collection admission failed."), { cleanupFailed, leaseMayExist: true });
      }
    },
    async renew(lease, seconds) { sameLease(lease); await writer.renew(lease, seconds); check(); },
    async stage(lease, records, media) { sameLease(lease); await writer.stage(lease, records, media); check(); },
    async promote(lease, receipt) { sameLease(lease); await writer.promote(lease, receipt); },
    // Cleanup must remain possible after expiry/abort; SQL still validates ownership.
    fail: lease => writer.fail(lease),
  };
  const { publicationMode: _mode, owner: _owner, expectation: _expectation, onQualified: _qualified, ...worker } = options;
  const result = await runWebsiteSync({ ...worker, config: options.config, client: guardedClient, writer: wrapped,
    revalidateCollectionOwners: true,
    storage: { put: guarded(options.storage!.put.bind(options.storage)), read: guarded(options.storage!.read.bind(options.storage)) },
    ...(options.download ? { download: guarded(options.download) } : {}),
    ...(options.mediaSources ? { mediaSources: { async stage(lease, sources) { sameLease(lease); await options.mediaSources!.stage(lease, sources); check(); } } } : {}),
    ...(options.captureCollection ? { captureCollection: {
      save: guarded(options.captureCollection.save.bind(options.captureCollection)),
      seal: guarded(options.captureCollection.seal.bind(options.captureCollection)),
      ...(options.captureCollection.replace ? { replace: guarded(options.captureCollection.replace.bind(options.captureCollection)) } : {}),
    } } : {}),
  });
  return { ...result, fullCollectionQualification: binding!.receipt };
}
