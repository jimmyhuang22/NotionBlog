import { ContentServiceError } from "../../../contracts/repository.ts";
import { checkContentReadBudget, contentReadBudgetIdentity, withContentReadBudget } from "../content-read-budget.ts";
import { LIST_READ_TIMEOUT_MS } from "../list-read-budget.ts";
import type { PublicCachePorts } from "./read.ts";

const unavailable = () => new ContentServiceError("CONTENT_UNAVAILABLE", "The shared content read is unavailable.");
interface Stored { body: string; bytes: number; expiresAt: number; tags: string[] }
interface Pending {
  controller: AbortController; promise: Promise<unknown>; waiters: number; settled: boolean; tags: string[];
}
interface SharedProjectionOptions {
  maxEntries?: number; maxBytes?: number; maxInflight?: number; maxWaiters?: number; timeoutMs?: number; now?: () => number;
}
interface SharedProjectionState {
  stored: Map<string, Stored>; pending: Map<string, Pending>; active: Set<Pending>; storedBytes: number;
}
const createState = (): SharedProjectionState => ({ stored: new Map(), pending: new Map(), active: new Set(), storedBytes: 0 });

/** A process-local cache port for already guarded projection envelopes. Unlike nested
 * unstable_cache, it can reuse rows inside an outer page cache. The caller still reads
 * the publication stamp on every access and checks it again before storing a miss. */
export function createSharedProjectionCache(options: SharedProjectionOptions = {}, state = createState()) {
  const { maxEntries = 4, maxBytes = 8 * 1024 * 1024, maxInflight = 2, maxWaiters = 64,
    timeoutMs = LIST_READ_TIMEOUT_MS, now = Date.now } = options;
  if (![maxEntries, maxBytes, maxInflight, maxWaiters, timeoutMs].every(n => Number.isSafeInteger(n) && n > 0))
    throw new Error("Invalid shared projection cache limits.");
  const { stored, pending, active } = state;
  const remove = (key: string) => {
    const entry = stored.get(key);
    if (entry) { stored.delete(key); state.storedBytes -= entry.bytes; }
  };
  const expire = () => { for (const [key, entry] of stored) if (now() >= entry.expiresAt) remove(key); };
  const abandon = (key: string, entry: Pending) => {
    if (pending.get(key) === entry) pending.delete(key);
    entry.controller.abort();
  };

  function start<T>(key: string, tags: string[], load: () => Promise<T>): Pending {
    if (active.size >= maxInflight) throw unavailable();
    const controller = new AbortController();
    const entry: Pending = { controller, promise: undefined!, waiters: 0, settled: false, tags: [...tags] };
    active.add(entry); pending.set(key, entry);
    let abort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(unavailable());
      controller.signal.addEventListener("abort", abort, { once: true });
    });
    const timer = setTimeout(() => abandon(key, entry), timeoutMs);
    // Replace the leader's request budget (including its signal and SQL counters).
    // The raw loader is request-independent; generation.run in readPublicProjection
    // still installs the generation whose stamp will be checked after the load.
    const work = Promise.resolve().then(() => withContentReadBudget(controller.signal, load, { timeoutMs }));
    const result = work.then(value => {
      if (controller.signal.aborted || pending.get(key) !== entry) throw unavailable();
      const expiresAt = (value as { expiresAt?: unknown } | null)?.expiresAt;
      if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt) || expiresAt <= now()) throw unavailable();
      const body = JSON.stringify(value), bytes = Buffer.byteLength(body);
      expire();
      if (bytes <= maxBytes) {
        while (stored.size >= maxEntries || state.storedBytes + bytes > maxBytes) remove(stored.keys().next().value!);
        stored.set(key, { body, bytes, expiresAt, tags: [...tags] }); state.storedBytes += bytes;
      }
      return value;
    });
    entry.promise = Promise.race([result, cancelled]).finally(() => {
      entry.settled = true;
      if (pending.get(key) === entry) pending.delete(key);
    });
    // Keep the physical slot until the actual loader drains, even if it ignores
    // abort. A late result/failure cannot remove a replacement for the same key.
    void result.finally(() => {
      clearTimeout(timer); controller.signal.removeEventListener("abort", abort); active.delete(entry);
    }).catch(() => {});
    return entry;
  }

  function wait<T>(key: string, entry: Pending): Promise<T> {
    if (entry.waiters >= maxWaiters) throw unavailable();
    const budget = contentReadBudgetIdentity();
    entry.waiters++;
    return new Promise<T>((resolve, reject) => {
      let settled = false, timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (ok: boolean, value: unknown) => {
        if (settled) return;
        settled = true; clearTimeout(timer); budget?.signal.removeEventListener("abort", cancel);
        if (--entry.waiters === 0 && !entry.settled) abandon(key, entry);
        if (ok) resolve(value as T); else reject(value);
      };
      const cancel = () => finish(false, unavailable());
      if (budget) {
        timer = setTimeout(cancel, Math.max(1, Math.ceil(budget.deadline - budget.now())));
        budget.signal.addEventListener("abort", cancel, { once: true });
      }
      entry.promise.then(value => finish(true, value), error => finish(false, error));
      if (budget && (budget.signal.aborted || budget.now() >= budget.deadline)) cancel();
    });
  }

  const read: PublicCachePorts["read"] = async <T>(key: string, tags: string[], load: () => Promise<T>) => {
    checkContentReadBudget(); expire();
    const cached = stored.get(key);
    if (cached) { stored.delete(key); stored.set(key, cached); return JSON.parse(cached.body) as T; }
    return wait<T>(key, pending.get(key) ?? start(key, tags, load));
  };
  return {
    read,
    invalidate(tags: string[]) {
      const selected = new Set(tags), matches = (entry: { tags: string[] }) => entry.tags.some(tag => selected.has(tag));
      for (const [key, entry] of stored) if (matches(entry)) remove(key);
      for (const [key, entry] of pending) if (matches(entry)) abandon(key, entry);
    },
  };
}

/** Share data across separately bundled pages/API routes, including the purge route.
 * Keep the functions local: each bundle must consult its own request-budget ALS. */
const stateKey = Symbol.for("notionblog.shared-social-projection-state.v1");
const processState = globalThis as typeof globalThis & { [stateKey]?: SharedProjectionState };
export const sharedSocialProjectionCache = createSharedProjectionCache({}, processState[stateKey] ??= createState());
