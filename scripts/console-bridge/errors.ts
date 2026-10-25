import type { BackendErrorCode } from "../../console/lib/types.ts";

/** An error the console shows: a fixed code plus a short message with no private detail. */
export class BridgeError extends Error {
  readonly code: BackendErrorCode;
  readonly runningOperationId: string | undefined;

  constructor(code: BackendErrorCode, message: string, runningOperationId?: string) {
    super(message);
    this.code = code;
    this.runningOperationId = runningOperationId;
  }
}
