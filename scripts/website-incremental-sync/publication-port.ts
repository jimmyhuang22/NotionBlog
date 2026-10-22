import type { CommitReceipt, PreparedDelta, PublicationState, Submission } from "./executor.ts";
import { createIncrementalPublisher, PublicationDeltaError } from "../../src/server/database/incremental-publication.ts";
import type { SqlExecutor } from "../../src/server/database/sql.ts";
import { readPublishedRecord, verifyPublishedDelta } from "../../src/server/database/incremental-reader.ts";
import { normalizeId } from "../../src/server/notion/config.ts";
import type { QueueTicket } from "./queue.ts";

/** Structural match for the separately owned createIncrementalPublisher helper. */
export interface DeltaPublisher<T extends PreparedDelta> {
  state(): Promise<PublicationState>;
  lookup(operationId: string, payloadDigest: string): Promise<CommitReceipt | null>;
  publish(operationId: string, delta: T): Promise<CommitReceipt>;
}
const REJECTIONS = new Map([
  ["DELTA_VERSION_CHANGED", true], ["BUSY", true],
  ["DELTA_POLICY_CHANGED", false], ["DELTA_OPERATION_CONFLICT", false],
  ["DELTA_WITHDRAWAL_INVALID", false], ["DELTA_INPUT_INVALID", false],
  ["DELTA_DEPENDENCY_MISSING", false],
]);
function guard(signal: AbortSignal) { if (signal.aborted) throw new Error("CANCELLED"); }

/** Transport errors or malformed post-commit replies never become definitive rejection. */
export function createIncrementalPublicationPort<T extends PreparedDelta>(publisher: DeltaPublisher<T>,
  verifyReader: (receipt: CommitReceipt, signal: AbortSignal) => Promise<boolean>) {
  return {
    async state(signal: AbortSignal) { guard(signal); return publisher.state(); },
    async lookup(operationId: string, payloadDigest: string, signal: AbortSignal) {
      guard(signal); return publisher.lookup(operationId, payloadDigest);
    },
    async submit(operationId: string, delta: T, signal: AbortSignal): Promise<Submission> {
      guard(signal);
      try { return { outcome: "committed", receipt: await publisher.publish(operationId, delta) }; }
      catch (error) {
        if (error instanceof PublicationDeltaError && REJECTIONS.has(error.code)) {
          return { outcome: "rejected", code: error.code, retryable: REJECTIONS.get(error.code)! };
        }
        throw error;
      }
    },
    async verify(receipt: CommitReceipt, signal: AbortSignal) { guard(signal); return verifyReader(receipt, signal); },
  };
}

/** Explicit reviewed SQL bindings. Caller owns separate role/TLS-verified connections. */
export function createDatabasePublicationPort(writer: SqlExecutor, reader: SqlExecutor) {
  return createIncrementalPublicationPort(createIncrementalPublisher(writer), (receipt, signal) => verifyPublishedDelta(reader, receipt, signal));
}
export function createDatabasePublishedPageReader(reader: SqlExecutor) {
  return (ticket: QueueTicket, state: PublicationState, signal: AbortSignal) => readPublishedRecord(reader,
    { pageId: normalizeId(ticket.pageKey), sourceKey: ticket.sourceKey, expectedRevision: state.publicationRevision }, signal);
}
