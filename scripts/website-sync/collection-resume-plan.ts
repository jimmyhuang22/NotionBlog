import type { CollectedPage } from "./collection-capture.ts";
import { validateSourceReadProof } from "./collection-source-proof.ts";
import { WorkerError } from "../notion-sync/errors.ts";

/** Planning estimates are not permission or an upper bound for unseen content.
 * Actual attempts (including SDK retries) remain charged by the shared ledger. */
export function collectionResumePlan(pages: CollectedPage[], currentIds?: string[], pendingVerificationRequests?: number) {
  // A reviewed recovery may discard every old course projection. Zero reusable
  // pages means all current members are unseen work, not an empty old capture.
  // Historical provenance and the new lease are enforced by the host/worker.
  const reads = new Map<string, number>(); let largestPageReads = 0, media = 0, converted = 0;
  for (const page of pages) {
    if (!page.sourceReads) throw new WorkerError("CHECKPOINT_FAILED");
    validateSourceReadProof(page.sourceReads);
    let count = 0;
    for (const read of page.sourceReads) {
      count += read.requestUpperBound;
      const key = `${read.method}:${read.id}`; reads.set(key, Math.max(reads.get(key) ?? 0, read.requestUpperBound));
    }
    largestPageReads = Math.max(largestPageReads, count);
    media += page.media.length; converted += page.bindings.filter(b => b.delivery === "storage").length;
  }
  const ids = new Set(pages.map(p => p.record.detail.item.id));
  const unseen = currentIds ? currentIds.filter(id => !ids.has(id)).length : null;
  const absent = currentIds ? pages.filter(p => !currentIds.includes(p.record.detail.item.id)).length : null;
  const verificationReads = [...reads.values()].reduce((a, b) => a + b, 0);
  const pendingReads = pendingVerificationRequests ?? verificationReads;
  if (!Number.isSafeInteger(pendingReads) || pendingReads < 0 || pendingReads > verificationReads) throw new WorkerError("CHECKPOINT_FAILED");
  // Include final independent owner checks and a conservative second pass for
  // changed pages. The largest saved page is a forecast, not a bound on new pages.
  const estimatedRemainingRequests = currentIds ? pendingReads + currentIds.length * Math.max(2, largestPageReads) : null;
  // The largest-page extrapolation is a scenario, not an admission requirement:
  // applying one pathological page to every existing page can reject feasible
  // recoveries. Admission reserves known proof work plus fresh owner reads and
  // the operator's explicit reserve; the durable ledger still caps ALL attempts.
  const knownWorkEstimate = currentIds ? pendingReads + currentIds.length : null;
  return { knownWorkEstimate, savedPages: pages.length, currentPages: currentIds?.length ?? null, unseenPages: unseen, absentSavedPages: absent,
    savedVerificationRequests: verificationReads, pendingVerificationRequests: pendingReads,
    alreadyReadVerificationRequests: verificationReads - pendingReads, largestSavedPageRequests: largestPageReads,
    estimatedRemainingRequests, retryCeilingForEstimate: estimatedRemainingRequests === null ? null : estimatedRemainingRequests * 9,
    savedMediaToVerify: media, savedStorageObjectsToRead: converted,
    discoveryIncluded: false, unseenCostBounded: false, guaranteedCompletion: false };
}
