import { setTimeout as delay } from "node:timers/promises";
import { collectVideo } from "./bilibili.ts";
import { SocialSyncError } from "./model.ts";
import type { Observation, Target } from "./model.ts";
import type { SocialStore } from "./store.ts";

export async function collectTargets(targets: Target[], store: SocialStore, options: {
  signal?: AbortSignal; collect?: (target: Target, signal?: AbortSignal) => Promise<Observation>; spacingMs?: number;
} = {}) {
  store.checkTargets(targets);
  const report = { inserted: 0, updated: 0, duplicate: 0, older: 0, failed: 0, cancelled: false };
  for (let i = 0; i < targets.length; i++) {
    if (options.signal?.aborted) { report.cancelled = true; break; }
    if (i) {
      try { await delay(options.spacingMs ?? 1000, undefined, { signal: options.signal }); }
      catch { report.cancelled = true; break; }
    }
    const target = targets[i];
    try {
      const row = await (options.collect ?? collectVideo)(target, options.signal);
      if (row.platform !== target.platform || row.publicationId !== target.publicationId || row.accountId !== target.accountId || row.workId !== target.workId) {
        throw new SocialSyncError("IDENTITY_MISMATCH");
      }
      report[store.ingest(row)]++;
      store.recordAttempt(target, new Date().toISOString(), "OK");
    } catch (error) {
      const code = error instanceof SocialSyncError ? error.code : "COLLECT_FAILED";
      store.recordAttempt(target, new Date().toISOString(), code); report.failed++;
      if (options.signal?.aborted) { report.cancelled = true; break; }
    }
  }
  return { ...report, pending: store.status().pending };
}
