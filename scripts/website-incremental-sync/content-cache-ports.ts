import type { PreparedPublicationDelta, PublicationState } from "../../src/server/database/incremental-publication.ts";
import { canonicalJson } from "../../src/server/database/website-validation.ts";
import { ContentCacheError, type ContentCacheCommitProof, type ContentCacheStore } from "./content-cache.ts";
import type { CommitReceipt, IncrementalPorts } from "./executor.ts";
import type { AttemptClosure, QueueTicket } from "./queue.ts";

export interface ContentCachePortOptions {
  store: ContentCacheStore;
  ports: IncrementalPorts<PreparedPublicationDelta> & Required<Pick<IncrementalPorts<PreparedPublicationDelta>, "finalize" | "retire">>;
  queue: { assertPreparing(ticket: QueueTicket): void; attemptClosure(operationId: string): AttemptClosure | null };
  /** Current state from the independent reader connection, never the writer. */
  readVerifiedState(signal: AbortSignal): Promise<PublicationState>;
}
function guard(signal: AbortSignal) { signal.throwIfAborted(); }
function key(receipt: CommitReceipt) { return JSON.stringify([receipt.operationId, receipt.payloadDigest, receipt.publicationRevision]); }

/** Wrap the separately owned coordinator. Both local checkpoints finish before
 * queue acknowledgement; recovery only verifies/installs the staged request. */
export function withContentCache(options: ContentCachePortOptions): IncrementalPorts<PreparedPublicationDelta> {
  const { store, ports, queue } = options, verified = new Map<string, ContentCacheCommitProof>();
  function owned(operationId: string, digest: string) {
    if (!store.ownsOperation(operationId, digest)) throw new ContentCacheError("CONTENT_CACHE_OPERATION_UNSTAGED");
  }
  return {
    async state(signal) {
      guard(signal); const state = await ports.state(signal); guard(signal); store.assertState(state); return state;
    },
    async prepare(ticket, state, signal) {
      guard(signal);
      try {
        store.assertState(state); const result = await ports.prepare(ticket, state, signal); guard(signal);
        if (result.outcome !== "prepared") return result;
        queue.assertPreparing(ticket); guard(signal); store.stage(ticket.operationId, result.delta, state); guard(signal);
        return result;
      } catch (e) {
        guard(signal);
        if (e instanceof ContentCacheError) return { outcome: e.code === "CONTENT_CACHE_BUSY" ? "retry" : "review", code: e.code };
        throw e;
      }
    },
    async submit(operationId, delta, signal) {
      guard(signal); owned(operationId, delta.payloadDigest); return ports.submit(operationId, delta, signal);
    },
    async lookup(operationId, digest, signal) {
      guard(signal); owned(operationId, digest); return ports.lookup(operationId, digest, signal);
    },
    async verify(receipt, signal) {
      guard(signal); const k = key(receipt); verified.delete(k); owned(receipt.operationId, receipt.payloadDigest);
      if (receipt.committed !== true || !await ports.verify(receipt, signal)) return false;
      guard(signal); const state = await options.readVerifiedState(signal); guard(signal);
      if (state.publicationRevision !== receipt.publicationRevision || state.configDigest !== store.sourceDigest) return false;
      if (verified.size >= 50) throw new ContentCacheError("CONTENT_CACHE_BUDGET_REACHED");
      verified.set(k, { ...state, operationId: receipt.operationId, payloadDigest: receipt.payloadDigest, readerVerified: true }); return true;
    },
    async finalize(receipt, signal) {
      guard(signal); const k = key(receipt), proof = verified.get(k);
      if (!proof || receipt.committed !== true) throw new ContentCacheError("CONTENT_CACHE_READER_UNVERIFIED");
      // If the second install fails, the queue remains unknown. The first domain
      // install is idempotent when independent verification is repeated.
      await ports.finalize(receipt, signal); guard(signal); store.install(proof); verified.delete(k); guard(signal);
    },
    async retire(proof, signal) {
      guard(signal); const actual = queue.attemptClosure(proof.ticket.operationId);
      if (!actual || canonicalJson(actual) !== canonicalJson(proof)) throw new ContentCacheError("CONTENT_CACHE_TERMINAL_UNCONFIRMED");
      await ports.retire(actual, signal); guard(signal); store.retire(actual); guard(signal);
    },
  };
}
