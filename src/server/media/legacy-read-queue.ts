import { ContentServiceError } from "../../../contracts/repository.ts";
import { withContentReadBudget } from "../content-read-budget.ts";

const unavailable = () => new ContentServiceError("CONTENT_UNAVAILABLE", "The image read was cancelled or exceeded its deadline.");
interface QueueState { active: number; pending: Array<{ start(): void }> }
const emptyState = (): QueueState => ({ active: 0, pending: [] });

/** Bound complete live-source reads, not individual Notion HTTP calls. Waiting
 * does not consume the active read deadline or hold a SQL connection. There is
 * no result/permission cache and the existing Notion rate limit still applies. */
export function createLegacyMediaReadQueue({ capacity = 4, maxWaiting = 64, waitMs = 30_000, readMs = 8_000 } = {}, state = emptyState()) {
  for (const value of [capacity, maxWaiting, waitMs, readMs]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error("Invalid legacy media queue limit.");
  }
  const { pending } = state;
  const drain = () => { while (state.active < capacity && pending.length) pending.shift()!.start(); };

  function enter(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted || (state.active >= capacity && pending.length >= maxWaiting)) return Promise.reject(unavailable());
    return new Promise((resolve, reject) => {
      let waiting = true;
      const deadline = performance.now() + waitMs;
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", cancel); };
      const cancel = () => {
        if (!waiting) return;
        waiting = false; cleanup();
        const index = pending.indexOf(entry);
        if (index !== -1) pending.splice(index, 1);
        reject(unavailable());
      };
      const entry = { start() {
        if (!waiting) return;
        if (signal.aborted || performance.now() >= deadline) { cancel(); return; }
        waiting = false; cleanup(); state.active++;
        let released = false;
        resolve(() => { if (!released) { released = true; state.active--; drain(); } });
      } };
      const timer = setTimeout(cancel, waitMs);
      signal.addEventListener("abort", cancel, { once: true });
      if (state.active < capacity) entry.start(); else pending.push(entry);
    });
  }

  return { async run<T>(signal: AbortSignal, read: () => Promise<T>): Promise<T> {
    const release = await enter(signal);
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timer = setTimeout(abort, readMs);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    let stop!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      stop = () => reject(unavailable());
      controller.signal.addEventListener("abort", stop, { once: true });
      if (controller.signal.aborted) stop();
    });
    // Cancellation returns promptly, but a driver that is still draining keeps
    // its slot. Otherwise repeated disconnects could exceed the concurrency cap.
    const work = withContentReadBudget(controller.signal, read, { timeoutMs: readMs }).finally(() => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", stop);
      release();
    });
    return Promise.race([work, cancelled]);
  } };
}

const key = Symbol.for("notionblog.legacy-media-read-queue.v1");
const shared = globalThis as typeof globalThis & { [key]?: QueueState };
// Share admission state, never a closure over another bundle's AsyncLocalStorage.
// Each caller installs the budget in the same module graph as its SQL/Notion readers.
export const legacyMediaReadQueue = createLegacyMediaReadQueue({}, shared[key] ??= emptyState());
