import { setTimeout as delay } from "node:timers/promises";
import { collectCollection, collectionKey } from "./collection.ts";
import type { CollectionSnapshot, CollectionTarget } from "./collection.ts";
import type { CollectionStore } from "./collection-store.ts";
import { SocialSyncError } from "./model.ts";

export async function collectCollections(targets: CollectionTarget[], store: CollectionStore, options: {
  signal?: AbortSignal; spacingMs?: number;
  collect?: (target: CollectionTarget, signal?: AbortSignal) => Promise<CollectionSnapshot>;
} = {}) {
  const report = { baseline: 0, updated: 0, duplicate: 0, older: 0, addedVideos: 0, addedParts: 0, failed: 0, cancelled: false };
  for (const [index, target] of targets.entries()) {
    if (options.signal?.aborted) { report.cancelled = true; break; }
    if (index) {
      try { await delay(options.spacingMs ?? 1000, undefined, { signal: options.signal }); }
      catch { report.cancelled = true; break; }
    }
    try {
      const row = await (options.collect ?? collectCollection)(target, options.signal);
      if (options.signal?.aborted) throw new SocialSyncError("COLLECT_CANCELLED");
      if (collectionKey(row.target) !== collectionKey(target) || row.target.representativeUrl !== target.representativeUrl) throw new SocialSyncError("IDENTITY_MISMATCH");
      const result = store.ingest(row);
      report[result.status]++; report.addedVideos += result.addedVideos; report.addedParts += result.addedParts;
      store.recordAttempt(target, new Date().toISOString(), "OK");
    } catch (error) {
      store.recordAttempt(target, new Date().toISOString(), error instanceof SocialSyncError ? error.code : "COLLECT_FAILED");
      report.failed++;
      if (options.signal?.aborted) { report.cancelled = true; break; }
    }
  }
  return report;
}
