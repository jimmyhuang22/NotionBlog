import type { CoverMode } from "../../src/server/social/covers.ts";
import type { CoverQueue } from "./queue.ts";
import { sourcePlan, syncCovers } from "./worker.ts";
import { SocialSyncError } from "../social-sync/model.ts";

/** One shared batch budget, even though each item is checkpointed separately. */
export async function consumeCoverQueue(queue: CoverQueue, mode: CoverMode, ports: Parameters<typeof syncCovers>[2], now = () => Date.now()) {
  const jobs = queue.pending(mode), budget = sourcePlan(jobs.map(j => j.source)), started = now();
  const result = { selected: jobs.length, completed: 0, unchanged: 0, missing: 0, superseded: 0, deferred: 0, failed: 0,
    sourceRequests: 0, sourceBytes: 0, encoded: 0, reusedEncodings: 0, uploads: 0, objectReads: 0, objectOperations: 0, code: null as string | null };
  for (const job of jobs) {
    if (!queue.current(job)) { result.superseded++; continue; }
    const duration = budget.maxDurationMs - (now() - started);
    if (duration < 1 || ports.signal?.aborted) { result.code = ports.signal?.aborted ? "COVER_CANCELLED" : "COVER_BATCH_BUDGET"; break; }
    // Keep the hard deadline, but leave a useful dispatch window for the next item.
    // A normal yield must not turn an untouched item into a failed download.
    if (duration < 30000) { result.deferred = jobs.length - jobs.indexOf(job); break; }
    queue.attempt(job, new Date(now()).toISOString());
    try {
      const report = await syncCovers([job.source], mode, { ...ports, limits: {
        maxSourceBytes: budget.maxSourceBytes - result.sourceBytes,
        maxObjectOperations: budget.maxObjectOperations - result.objectOperations,
        maxDurationMs: duration,
      } });
      for (const key of ["sourceRequests", "sourceBytes", "encoded", "reusedEncodings", "uploads", "objectReads", "objectOperations"] as const) result[key] += report[key];
      if (report.failed) {
        const code = report.failures[0]?.code ?? "COVER_SYNC_FAILED";
        if (!queue.current(job)) { result.superseded++; continue; }
        queue.finish(job, "failed", code); result.failed++; result.code = code; break;
      }
      if (queue.finish(job, report.missing ? "missing" : "complete")) {
        result.completed++; result.unchanged += report.unchanged; result.missing += report.missing;
      } else result.superseded++;
    } catch (error) {
      const code = error instanceof SocialSyncError ? error.code : "COVER_QUEUE_WORKER_FAILED";
      if (!queue.current(job)) { result.superseded++; continue; }
      queue.finish(job, "failed", code); result.failed++; result.code = code; break;
    }
  }
  return result;
}
