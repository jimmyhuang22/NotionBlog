/** Only these codes may cross the operational logging boundary. */
export type WorkerCode = "MISCONFIGURED" | "CONTENT_UNAVAILABLE" | "RATE_LIMITED" |
  "SCOPE_INCOMPLETE" | "IMAGE_REJECTED" | "IMAGE_UNAVAILABLE" | "LIMIT_EXCEEDED" |
  "BUSY" | "CANCELLED" | "LEASE_INVALID" | "CHECKPOINT_FAILED";
export class WorkerError extends Error {
  readonly code: WorkerCode;
  constructor(code: WorkerCode) { super(code); this.code = code; }
}
export function errorCode(error: unknown): WorkerCode {
  if (error instanceof WorkerError) return error.code;
  if (error instanceof Error && "code" in error &&
      ["MISCONFIGURED", "CONTENT_UNAVAILABLE", "RATE_LIMITED"].includes(String(error.code))) {
    return error.code as WorkerCode;
  }
  return "CONTENT_UNAVAILABLE";
}
export function checkSignal(signal?: AbortSignal): void {
  if (signal?.aborted) throw new WorkerError("CANCELLED");
}
