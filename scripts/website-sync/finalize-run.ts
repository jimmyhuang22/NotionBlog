import type { WebsiteImageFailure } from "./download.ts";

/** Diagnostic failures must not prevent final receipt writing or either close.
 * Raw image identities remain confined to their private sidecar. */
export async function finalizeWebsiteRun(options: {
  report: Record<string, unknown>;
  imageFailure?: WebsiteImageFailure;
  save(name: string, value: unknown): Promise<void>;
  closeImageTransport?: () => void;
  closeWriter?: () => Promise<void>;
  closeReader?: () => Promise<void>;
}): Promise<boolean> {
  const { report, imageFailure, save } = options;
  if (imageFailure) {
    try {
      await save("image-failure-private.json", { runId: report.runId, ...imageFailure });
      report.imageFailure = { path: "image-failure-private.json", phase: imageFailure.phase,
        attempt: imageFailure.attempt, httpStatus: imageFailure.httpStatus, transportCode: imageFailure.transportCode,
        elapsedMs: imageFailure.elapsedMs, attemptElapsedMs: imageFailure.attemptElapsedMs,
        attemptTimeoutMs: imageFailure.attemptTimeoutMs, timeoutKind: imageFailure.timeoutKind };
    } catch { report.diagnosticWriteFailed = true; }
  }
  // Persist publication truth before a potentially slow connection close. The
  // final mandatory write below records completed cleanup, even if this first
  // best-effort write failed. Neither write may skip closing either pool.
  report.cleanupCompleted = false;
  try { await save("receipt-private.json", report); }
  catch { report.interimReceiptWriteFailed = true; }
  const results = await Promise.all(([
    ["image-transport", options.closeImageTransport],
    ["writer", options.closeWriter], ["reader", options.closeReader],
  ] as const).map(async ([name, close]) => {
    try { await close?.(); return null; } catch { return name; }
  }));
  const cleanupFailures = results.filter(name => name !== null);
  if (cleanupFailures.length) report.cleanupFailures = cleanupFailures;
  report.cleanupCompleted = true;
  // Mandatory: a failure here still propagates, AFTER every connection close.
  await save("receipt-private.json", report);
  return cleanupFailures.length === 0;
}
