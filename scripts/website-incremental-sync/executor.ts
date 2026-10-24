import { IncrementalQueueError, type AttemptClosure, type IncrementalQueue, type QueueTicket } from "./queue.ts";

export interface PublicationState {
  publicationRevision: string; configDigest: string; schemaDigest: string; policyEpoch: string;
}
export interface PreparedDelta { expectedRevision: string; configDigest: string; payloadDigest: string }
export interface CommitReceipt { operationId: string; payloadDigest: string; publicationRevision: string; committed: true }
export type Preparation<T extends PreparedDelta> = { outcome: "unchanged" } | { outcome: "review"; code: string } |
  { outcome: "retry"; code: string } | { outcome: "prepared"; delta: T };
export type Submission = { outcome: "committed"; receipt: CommitReceipt } | { outcome: "rejected"; code: string; retryable: boolean };
export interface IncrementalPorts<T extends PreparedDelta> {
  state(signal: AbortSignal): Promise<PublicationState>;
  /** Prepare complete current content, necessary dependencies and verified media. */
  prepare(ticket: QueueTicket, state: PublicationState, signal: AbortSignal): Promise<Preparation<T>>;
  submit(operationId: string, delta: T, signal: AbortSignal): Promise<Submission>;
  lookup(operationId: string, payloadDigest: string, signal: AbortSignal): Promise<CommitReceipt | null>;
  /** Must use the independent reader and prove this exact operation's result. */
  verify(receipt: CommitReceipt, signal: AbortSignal): Promise<boolean>;
  /** Atomically save dependent local checkpoints before acknowledging the queue. */
  finalize?(receipt: CommitReceipt, signal: AbortSignal): Promise<void>;
  /** Retire staged domain data only after a durable queue terminal proof. Must be idempotent. */
  retire?(proof: AttemptClosure, signal: AbortSignal): Promise<void>;
}
export interface CycleOptions {
  queue: IncrementalQueue; schemaDigest: string; signal?: AbortSignal;
  maxTasks?: number; maxDurationMs?: number; retryDelayMs?: number;
}
class Cancelled extends Error {}
function guard(signal: AbortSignal) { if (signal.aborted) throw new Cancelled(); }
function opaque(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(value); }
function digest(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function bounded<T>(call: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
  guard(signal);
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Cancelled());
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => { guard(signal); return call(signal); }).then(value => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) reject(new Cancelled()); else resolve(value);
    }, error => { signal.removeEventListener("abort", abort); reject(error); });
  });
}
function receiptMatches(receipt: CommitReceipt, operationId: string, payloadDigest: string) {
  return receipt?.committed === true && receipt.operationId === operationId && receipt.payloadDigest === payloadDigest && opaque(receipt.publicationRevision);
}

/** No credentials or implicit adapters: publication, source and media ports are explicit. */
export async function runIncrementalCycle<T extends PreparedDelta>(options: CycleOptions, ports: IncrementalPorts<T>) {
  const maxTasks = options.maxTasks ?? 20, duration = options.maxDurationMs ?? 120_000, delay = options.retryDelayMs ?? 60_000;
  if (!digest(options.schemaDigest) || !Number.isInteger(maxTasks) || maxTasks < 1 || maxTasks > 50 ||
    !Number.isInteger(duration) || duration < 10 || duration > 899_000 || !Number.isInteger(delay) || delay < 0 || delay > 86_400_000) {
    throw new IncrementalQueueError("QUEUE_INPUT_INVALID");
  }
  const queue = options.queue, controller = new AbortController();
  const cancel = () => controller.abort();
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const timer = setTimeout(cancel, duration), signal = controller.signal;
  const stats = { claimed: 0, recovered: 0, published: 0, unchanged: 0, retried: 0, review: 0, unresolved: 0, retired: 0, cancelled: false,
    errorCode: null as string | null };
  let steps = 0;
  async function retireClosed() {
    if (!ports.retire) return true;
    const remaining = maxTasks - steps;
    for (const proof of remaining > 0 ? queue.pendingRetirements(remaining) : []) {
      steps++;
      try {
        await bounded(s => ports.retire!(proof, s), signal); guard(signal);
        queue.acknowledgeRetirement(proof); stats.retired++;
      } catch (error) {
        stats.errorCode = "RETIREMENT_PENDING";
        if (signal.aborted || error instanceof Cancelled) throw new Cancelled();
        return false;
      }
    }
    return queue.status().retirement_pending === 0;
  }
  async function verify(ticket: QueueTicket, payloadDigest: string, receipt: CommitReceipt) {
    if (!receiptMatches(receipt, ticket.operationId, payloadDigest)) { stats.errorCode = "COMMIT_RECEIPT_MISMATCH"; return false; }
    if (!await bounded(s => ports.verify(receipt, s), signal)) { stats.errorCode = "READER_UNVERIFIED"; return false; }
    if (ports.finalize) {
      try { await bounded(s => ports.finalize!(receipt, s), signal); }
      catch (error) { stats.errorCode = "CHECKPOINT_UNSAVED"; throw error; }
    }
    guard(signal);
    queue.confirmCommit(ticket, { operationId: ticket.operationId, payloadDigest, publicationRevision: receipt.publicationRevision, readerVerified: true });
    return true;
  }
  try {
    guard(signal);
    // A missing lookup result is uncertainty, never proof that a send is safe.
    for (const pending of queue.pendingVerifications(maxTasks)) {
      steps++;
      try {
        const receipt = await bounded(s => ports.lookup(pending.ticket.operationId, pending.payloadDigest, s), signal);
        if (receipt && await verify(pending.ticket, pending.payloadDigest, receipt)) stats.recovered++;
        else { stats.unresolved++; stats.errorCode ??= "SUBMISSION_UNRESOLVED"; }
      } catch (error) {
        if (signal.aborted || error instanceof Cancelled) throw new Cancelled();
        stats.unresolved++; stats.errorCode ??= "SUBMISSION_UNRESOLVED";
      }
    }
    // Keep a still-running or unknown commit from racing a new global revision.
    let retirementReady = await retireClosed();
    while (retirementReady && steps < maxTasks && queue.status().awaiting_verification === 0) {
      guard(signal);
      const [ticket] = queue.claim(1, duration + 1000, { requireRetirement: !!ports.retire });
      if (!ticket) {
        if (ports.retire && queue.status().retirement_pending) { retirementReady = await retireClosed(); continue; }
        break;
      }
      stats.claimed++; steps++;
      let submitted = false;
      let stage: "state" | "prepare" | "submit" | "verify" = "state";
      try {
        const state = await bounded(s => ports.state(s), signal);
        if (state?.configDigest !== queue.scopeDigest || state.schemaDigest !== options.schemaDigest || !opaque(state.publicationRevision) || !opaque(state.policyEpoch)) {
          queue.requireReview(ticket, "PUBLICATION_SCOPE_MISMATCH"); stats.review++; stats.errorCode = "PUBLICATION_SCOPE_MISMATCH"; break;
        }
        stage = "prepare";
        const prepared = await bounded(s => ports.prepare(ticket, state, s), signal);
        guard(signal);
        if (prepared.outcome === "review") {
          queue.requireReview(ticket, prepared.code); stats.review++; stats.errorCode = "PREPARATION_REQUIRES_REVIEW"; continue;
        }
        if (prepared.outcome === "retry") {
          if (prepared.code === "IMAGE_REJECTED") { queue.requireReview(ticket, prepared.code); stats.review++; }
          else if (queue.retryPreparation(ticket, prepared.code, delay) === "needs_review") stats.review++; else stats.retried++;
          stats.errorCode = "PREPARATION_PENDING"; continue;
        }
        if (prepared.outcome === "unchanged") { queue.completeUnchanged(ticket); stats.unchanged++; continue; }
        if (prepared.outcome !== "prepared" || prepared.delta.expectedRevision !== state.publicationRevision ||
          prepared.delta.configDigest !== queue.scopeDigest || !digest(prepared.delta.payloadDigest)) {
          queue.requireReview(ticket, "PREPARED_DELTA_MISMATCH"); stats.review++; stats.errorCode = "PREPARED_DELTA_MISMATCH"; continue;
        }
        queue.markSubmitting(ticket, prepared.delta); submitted = true;
        stage = "submit";
        const result = await bounded(s => ports.submit(ticket.operationId, prepared.delta, s), signal);
        guard(signal);
        if (result.outcome === "rejected") {
          queue.confirmRejected(ticket, { operationId: ticket.operationId, payloadDigest: prepared.delta.payloadDigest,
            definitivelyRejected: true, code: result.code }, delay, result.retryable ? "retry" : "needs_review");
          if (result.retryable) stats.retried++; else stats.review++;
          stats.errorCode = "SUBMISSION_REJECTED";
          break;
        } else {
          stage = "verify";
          if (result.outcome === "committed" && await verify(ticket, prepared.delta.payloadDigest, result.receipt)) stats.published++;
          else { stats.unresolved++; stats.errorCode ??= "SUBMISSION_UNRESOLVED"; }
        }
      } catch (error) {
        if (submitted) { stats.unresolved++; stats.errorCode = signal.aborted ? "CANCELLED" : stats.errorCode === "CHECKPOINT_UNSAVED" ? stats.errorCode :
          stage === "verify" ? "READER_UNVERIFIED" : "SUBMISSION_UNCERTAIN"; }
        else {
          try {
            const permanent = stage === "prepare" && (error as { code?: string })?.code === "IMAGE_REJECTED";
            if (permanent) { queue.requireReview(ticket, "IMAGE_REJECTED"); stats.review++; }
            else if (queue.retryPreparation(ticket, signal.aborted ? "CANCELLED" : "PREPARATION_UNAVAILABLE", signal.aborted ? 0 : delay) === "needs_review") stats.review++;
            else stats.retried++;
          }
          catch (failure) {
            if (!(failure instanceof IncrementalQueueError && failure.code === "QUEUE_STALE_TICKET")) throw failure;
          }
          stats.errorCode = signal.aborted ? "CANCELLED" : stage === "state" ? "PUBLICATION_UNAVAILABLE" : "PREPARATION_UNAVAILABLE";
        }
        if (signal.aborted || error instanceof Cancelled) throw new Cancelled();
        if (!submitted && stage === "prepare") continue;
        break;
      } finally {
        if (!signal.aborted && ports.retire) retirementReady = await retireClosed();
      }
    }
  } catch (error) {
    if (signal.aborted || error instanceof Cancelled) { stats.cancelled = true; stats.errorCode = "CANCELLED"; }
    else throw error;
  } finally {
    clearTimeout(timer); options.signal?.removeEventListener("abort", cancel);
  }
  const status = queue.status();
  const outcome = stats.cancelled ? "cancelled" : status.awaiting_verification || (ports.retire && status.retirement_pending) ? "blocked" : stats.retried ? "retry" : status.needs_review ? "needs_review" : status.pending + status.leased + status.retry ? "partial" : stats.published + stats.recovered ? "updated" : "unchanged";
  return { outcome, ...stats, queue: status };
}
