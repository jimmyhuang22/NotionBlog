import { displayAssetId } from "../self-hosted-media/manifest.ts";
import { contentReadBudgetIdentity, withContentReadBudget } from "../content-read-budget.ts";
import { DisplayError, readDisplayMedia, readPublishedDisplayAssets, type DisplayProjection } from "./display.ts";
import type { SqlExecutor } from "./sql.ts";

type Projection = DisplayProjection | null;
type Batch = { controller: AbortController; waiting: number };
interface PendingRead {
  id: string;
  signal?: AbortSignal;
  batch?: Batch;
  settled: boolean;
  resolve(value: Projection): void;
  reject(error: DisplayError): void;
  abort(): void;
}

/** One in-flight batch leaves the other reader connection available to pages.
 * Each read joins a new statement, including the call made after reading bytes. */
export function createPublishedDisplayMediaReader(db: SqlExecutor) {
  const pending = new Set<PendingRead>();
  let scheduled = false;
  let active = false;

  function finish(read: PendingRead, result: Projection | DisplayError) {
    if (read.settled) return;
    read.settled = true;
    read.signal?.removeEventListener("abort", read.abort);
    if (read.batch) read.batch.waiting--;
    if (result instanceof DisplayError) read.reject(result);
    else read.resolve(result);
  }

  function schedule() {
    if (active || scheduled || !pending.size) return;
    scheduled = true;
    setTimeout(() => { scheduled = false; void flush(); }, 2);
  }

  async function flush() {
    const reads = [...pending].slice(0, 32);
    if (!reads.length) return;
    active = true;
    const batch = { controller: new AbortController(), waiting: reads.length };
    const byId = new Map<string, PendingRead[]>();
    for (const read of reads) {
      pending.delete(read);
      read.batch = batch;
      const matching = byId.get(read.id);
      if (matching) matching.push(read);
      else byId.set(read.id, [read]);
    }

    try {
      // The request that opened the batching window does not own the group's
      // checkout or deadline. A cancelled caller cannot cancel other reads.
      const signal = AbortSignal.any([batch.controller.signal, AbortSignal.timeout(8_000)]);
      await withContentReadBudget(signal, async () => {
        if (byId.size > 1) {
          const { runId, revision, assets } = await readPublishedDisplayAssets(db, [...byId.keys()]);
          for (const asset of assets) {
            const projection = { runId, revision, asset };
            for (const read of byId.get(asset.assetId)!) finish(read, projection);
            byId.delete(asset.assetId);
          }
        }
        // Missing from the bulk result can mean ineligible or not yet rendered.
        // Run the original RPC for those IDs to preserve their distinct status.
        for (const [id, matching] of byId) {
          if (matching.every(read => read.settled)) continue;
          const result = await readDisplayMedia(db, id, "published").catch(displayError);
          for (const read of matching) finish(read, result);
        }
      }, { timeoutMs: 8_000, maxResponseBytes: 2 * 1024 * 1024 });
    } catch (error) {
      for (const read of reads) finish(read, displayError(error));
    } finally {
      active = false;
      schedule();
    }
  }

  return function readDisplay(id: string): Promise<Projection> {
    if (!displayAssetId(id)) return Promise.resolve(null);
    const signal = contentReadBudgetIdentity()?.signal;
    if (signal?.aborted || pending.size >= 128) return Promise.reject(new DisplayError("DISPLAY_UNAVAILABLE"));
    return new Promise((resolve, reject) => {
      const read: PendingRead = { id, signal, resolve, reject, settled: false, abort() {
        pending.delete(read);
        finish(read, new DisplayError("DISPLAY_UNAVAILABLE"));
        if (read.batch?.waiting === 0) read.batch.controller.abort();
      } };
      pending.add(read);
      signal?.addEventListener("abort", read.abort, { once: true });
      schedule();
    });
  };
}

function displayError(error: unknown) {
  return error instanceof DisplayError ? error : new DisplayError("DISPLAY_UNAVAILABLE");
}
