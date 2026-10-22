import { preparePublicationDelta, type PreparedPublicationDelta, type PublicationState } from "../../src/server/database/incremental-publication.ts";
import { canonicalJson } from "../../src/server/database/website-validation.ts";
import { WEBSITE_SCHEMA_DIGEST } from "../../contracts/website-sync.ts";

/** Structural ports allow separately owned queue and study modules to compose
 * without importing a second copy of either module or its local state. */
export interface CoordinatorTicket { operationId: string; sourceKey: string; pageKey: string }
export interface CoordinatorReceipt { operationId: string; payloadDigest: string; publicationRevision: string; committed: true }
export type CoordinatorClosure<T> = { ticket: T; disposition: "never_submitted"; payloadDigest: null } |
  { ticket: T; disposition: "definitively_rejected"; payloadDigest: string };
export type CoordinatorPreparation = { outcome: "unchanged" } | { outcome: "review" | "retry"; code: string } |
  { outcome: "prepared"; delta: PreparedPublicationDelta };
export type CoordinatorSubmission = { outcome: "committed"; receipt: CoordinatorReceipt } |
  { outcome: "rejected"; code: string; retryable: boolean };
export interface CoordinatorOptions<T extends CoordinatorTicket> {
  scopeDigest: string; sourceKeys: readonly string[]; studySourceKeys: readonly string[];
  queue: { assertPreparing(ticket: T): void; attemptClosure(operationId: string): CoordinatorClosure<T> | null };
  publication: {
    state(signal: AbortSignal): Promise<PublicationState>;
    submit(operationId: string, delta: PreparedPublicationDelta, signal: AbortSignal): Promise<CoordinatorSubmission>;
    lookup(operationId: string, payloadDigest: string, signal: AbortSignal): Promise<CoordinatorReceipt | null>;
  };
  regular: { prepare(ticket: T, state: PublicationState, signal: AbortSignal): Promise<CoordinatorPreparation> };
  checkpoint: {
    load(): { version: string; sourceDigest: string };
    stageOtherPublication(operationId: string, delta: PreparedPublicationDelta): void;
    ownsOperation(operationId: string, payloadDigest: string): boolean;
  };
  study: {
    prepare(ticket: T, state: PublicationState, signal: AbortSignal): Promise<CoordinatorPreparation>;
    /** This must call the independent reader and retain its exact proof for finalize. */
    verify(receipt: CoordinatorReceipt, signal: AbortSignal): Promise<boolean>;
    finalize(receipt: CoordinatorReceipt, signal: AbortSignal): Promise<void>;
    retire(proof: CoordinatorClosure<T>, signal: AbortSignal): Promise<void>;
  };
}
export class IncrementalCoordinatorError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = "IncrementalCoordinatorError"; this.code = code; }
}
function fail(code: string): never { throw new IncrementalCoordinatorError(code); }
function guard(signal: AbortSignal) { if (signal.aborted) fail("COORDINATOR_CANCELLED"); }
function sources(value: readonly string[]) {
  return Array.isArray(value) && value.length > 0 && value.length <= 50 && new Set(value).size === value.length &&
    value.every(s => typeof s === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(s));
}

/** Supply the returned ports to runIncrementalCycle. Every prepared publication,
 * including an ordinary status update, journals the next study checkpoint before
 * submission. Recovery never re-prepares content or sends the operation again. */
export function createIncrementalCoordinator<T extends CoordinatorTicket>(options: CoordinatorOptions<T>) {
  if (!/^[a-f0-9]{64}$/.test(options.scopeDigest) || !sources(options.sourceKeys) || !sources(options.studySourceKeys) ||
    options.studySourceKeys.some(s => !options.sourceKeys.includes(s))) fail("COORDINATOR_CONFIG_INVALID");
  const allowed = new Set(options.sourceKeys), studySources = new Set(options.studySourceKeys);
  function scope(state: PublicationState) {
    if (state.configDigest !== options.scopeDigest || state.schemaDigest !== WEBSITE_SCHEMA_DIGEST) fail("COORDINATOR_SCOPE_MISMATCH");
    const checkpoint = options.checkpoint.load();
    if (checkpoint.sourceDigest !== options.scopeDigest || checkpoint.version !== state.publicationRevision) fail("COORDINATOR_CHECKPOINT_VERSION_CHANGED");
  }
  function owned(operationId: string, digest: string) {
    if (!options.checkpoint.ownsOperation(operationId, digest)) fail("COORDINATOR_OPERATION_UNSTAGED");
  }
  return {
    async state(signal: AbortSignal) {
      guard(signal); const state = await options.publication.state(signal); guard(signal); scope(state); return state;
    },
    async prepare(ticket: T, state: PublicationState, signal: AbortSignal): Promise<CoordinatorPreparation> {
      guard(signal); scope(state);
      if (!allowed.has(ticket.sourceKey)) return { outcome: "review", code: "COORDINATOR_SOURCE_UNKNOWN" };
      options.queue.assertPreparing(ticket);
      const study = studySources.has(ticket.sourceKey);
      const result = await (study ? options.study : options.regular).prepare(ticket, state, signal); guard(signal);
      if (result.outcome !== "prepared") return result;
      const delta = preparePublicationDelta(result.delta);
      if (delta.payloadDigest !== result.delta.payloadDigest || delta.configDigest !== options.scopeDigest ||
        delta.expectedRevision !== state.publicationRevision || delta.upserts.some(r => !allowed.has(r.evidence.sourceKey)) ||
        delta.withdrawals.some(w => !allowed.has(w.sourceKey))) fail("COORDINATOR_PREPARED_MISMATCH");
      // Recheck the actual queue generation/lease after all asynchronous work.
      options.queue.assertPreparing(ticket); guard(signal);
      if (!study) options.checkpoint.stageOtherPublication(ticket.operationId, delta);
      owned(ticket.operationId, delta.payloadDigest); guard(signal);
      return { outcome: "prepared", delta };
    },
    async submit(operationId: string, delta: PreparedPublicationDelta, signal: AbortSignal) {
      guard(signal); owned(operationId, delta.payloadDigest);
      return options.publication.submit(operationId, delta, signal);
    },
    async lookup(operationId: string, digest: string, signal: AbortSignal) {
      guard(signal); owned(operationId, digest);
      return options.publication.lookup(operationId, digest, signal);
    },
    async verify(receipt: CoordinatorReceipt, signal: AbortSignal) {
      guard(signal); owned(receipt.operationId, receipt.payloadDigest);
      const verified = await options.study.verify(receipt, signal); guard(signal); return verified;
    },
    async finalize(receipt: CoordinatorReceipt, signal: AbortSignal) {
      guard(signal); owned(receipt.operationId, receipt.payloadDigest);
      await options.study.finalize(receipt, signal); guard(signal);
    },
    async retire(proof: CoordinatorClosure<T>, signal: AbortSignal) {
      guard(signal);
      // A caller-provided boolean, expired lease or missing SQL receipt is not
      // evidence. Re-read the queue's persisted terminal proof before cleanup.
      const stored = options.queue.attemptClosure(proof.ticket.operationId);
      if (!stored || canonicalJson(stored) !== canonicalJson(proof)) fail("COORDINATOR_TERMINAL_UNCONFIRMED");
      await options.study.retire(stored, signal); guard(signal);
    },
  };
}
