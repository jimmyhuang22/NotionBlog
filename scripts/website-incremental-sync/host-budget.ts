export class IncrementalHostError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = "IncrementalHostError"; this.code = code; }
}
export function hostFail(code: string): never { throw new IncrementalHostError(code); }
export interface HostBudgetOptions { durationMs?: number; sourceRequests?: number; sourceBytes?: number; mediaBytes?: number; signal?: AbortSignal }
function createBudget(options: HostBudgetOptions, full: boolean) {
  const limits = { durationMs: options.durationMs ?? (full ? 3600000 : 120000), sourceRequests: options.sourceRequests ?? (full ? 5000 : 400),
    sourceBytes: options.sourceBytes ?? (full ? 256 * 1024 * 1024 : 32 * 1024 * 1024), mediaBytes: options.mediaBytes ?? (full ? 8 * 1024 ** 3 : 64 * 1024 * 1024) };
  if (!Number.isInteger(limits.durationMs) || limits.durationMs < 10 || limits.durationMs > (full ? 5400000 : 899000) ||
    !Number.isInteger(limits.sourceRequests) || limits.sourceRequests < 1 || limits.sourceRequests > (full ? 20000 : 5000) ||
    !Number.isSafeInteger(limits.sourceBytes) || limits.sourceBytes < 1 || limits.sourceBytes > 2 * 1024 ** 3 ||
    !Number.isSafeInteger(limits.mediaBytes) || limits.mediaBytes < 1 || limits.mediaBytes > (full ? 16 : 2) * 1024 ** 3) hostFail("HOST_INPUT_INVALID");
  const controller = new AbortController(), started = performance.now();
  let sourceRequests = 0, sourceBytes = 0, mediaBytes = 0, code: string | null = null, closed = false;
  const abort = (reason: string) => { code ??= reason; controller.abort(); };
  const external = () => abort("HOST_CANCELLED");
  options.signal?.addEventListener("abort", external, { once: true });
  if (options.signal?.aborted) external();
  const timer = setTimeout(() => abort("HOST_DEADLINE"), limits.durationMs);
  function guard() {
    if (closed) hostFail("HOST_CLOSED");
    if (performance.now() - started >= limits.durationMs) abort("HOST_DEADLINE");
    if (controller.signal.aborted) hostFail(code ?? "HOST_CANCELLED");
  }
  function add(kind: "sourceRequests" | "sourceBytes" | "mediaBytes", n: number) {
    if (!Number.isSafeInteger(n) || n < 0) hostFail("HOST_INPUT_INVALID");
    if (kind === "sourceRequests") sourceRequests += n;
    if (kind === "sourceBytes") sourceBytes += n;
    if (kind === "mediaBytes") mediaBytes += n;
    const total = { sourceRequests, sourceBytes, mediaBytes }[kind];
    if (!Number.isSafeInteger(total) || total > limits[kind]) { abort(`HOST_${kind === "mediaBytes" ? "MEDIA" : "SOURCE"}_BUDGET`); guard(); }
  }
  const charge = (kind: "sourceRequests" | "sourceBytes" | "mediaBytes", n: number) => { guard(); add(kind, n); };
  const observe = (kind: "sourceBytes" | "mediaBytes", n: number) => { add(kind, n); guard(); };
  return { signal: controller.signal, guard, charge, observe,
    cancel(reason: "FULL_BASELINE_LEASE_UNCONFIRMED") { abort(reason); },
    remainingMs: () => Math.max(0, Math.floor(limits.durationMs - (performance.now() - started))),
    statistics: () => ({ sourceRequests, sourceBytes, mediaBytes, errorCode: code }),
    close() { closed = true; clearTimeout(timer); options.signal?.removeEventListener("abort", external); controller.abort(); } };
}
export const createHostBudget = (options: HostBudgetOptions = {}) => createBudget(options, false);
/** First full collection only: larger explicit bounds; daily limits unchanged. */
export const createFullBaselineBudget = (options: HostBudgetOptions = {}) => createBudget(options, true);
export type HostBudget = ReturnType<typeof createHostBudget>;

/** Bound waiting and reject late callbacks. Side-effecting adapters must also
 * pass budget.signal to their transports and check it before their mutation. */
export async function hostAwait<T>(budget: HostBudget, call: () => Promise<T>, operationSignal?: AbortSignal): Promise<T> {
  budget.guard(); const signal = operationSignal ? AbortSignal.any([budget.signal, operationSignal]) : budget.signal;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(new IncrementalHostError(budget.statistics().errorCode ?? "HOST_CANCELLED"));
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve().then(() => { budget.guard(); return call(); }).then(value => {
      signal.removeEventListener("abort", aborted); if (signal.aborted) aborted(); else resolve(value);
    }, error => { signal.removeEventListener("abort", aborted); reject(error); });
  });
}
