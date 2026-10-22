import { createHash } from "node:crypto";

export interface SchedulerClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export class RequestCooldownError extends Error {
  constructor() {
    super("The content service is waiting for the upstream request limit.");
    this.name = "NotionRequestCooldownError";
  }
}

interface QueueEntry { start(): void; cancel(error: Error): void }
const realClock: SchedulerClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Spaces HTTP starts and shares upstream cooldowns; it never caches content. */
export class NotionRequestScheduler {
  private readonly clock: SchedulerClock;
  private readonly intervalMs: number;
  private readonly queue: QueueEntry[] = [];
  private lastStartAt = -Infinity;
  private blockedUntil = 0;
  private timer: unknown;

  constructor(options: { intervalMs?: number; clock?: SchedulerClock } = {}) {
    this.clock = options.clock ?? realClock;
    this.intervalMs = options.intervalMs ?? 350;
    if (!Number.isFinite(this.intervalMs) || this.intervalMs < 0) throw new Error("Invalid request interval.");
  }

  /** Integer Retry-After is seconds. Long cooldowns are checked in bounded timer chunks. */
  defer(retryAfter: string | null): void {
    if (!retryAfter || !/^\d+$/u.test(retryAfter.trim())) return;
    const seconds = Number(retryAfter.trim());
    if (!Number.isFinite(seconds)) return;
    this.blockedUntil = Math.max(this.blockedUntil, this.clock.now() + Math.min(seconds * 1_000, Number.MAX_SAFE_INTEGER));
    this.pump();
  }

  run<T>(task: (signal: AbortSignal) => Promise<T>, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
    const timeoutMs = options.timeoutMs ?? 9_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new Error("Invalid request timeout."));
    if (options.signal?.aborted) return Promise.reject(new DOMException("The request was cancelled.", "AbortError"));
    return new Promise<T>((resolve, reject) => {
      const controller = new AbortController();
      let started = false;
      let settled = false;
      let deadline: unknown;
      const cleanup = () => {
        this.clock.clearTimeout(deadline);
        options.signal?.removeEventListener("abort", abort);
      };
      const cancel = (error: Error) => {
        if (settled) return;
        settled = true;
        controller.abort(error);
        const index = this.queue.indexOf(entry);
        if (index >= 0) this.queue.splice(index, 1);
        cleanup();
        reject(error);
        this.pump();
      };
      const abort = () => cancel(new DOMException("The request was cancelled.", "AbortError"));
      const entry: QueueEntry = {
        cancel,
        start: () => {
          if (settled) return;
          started = true;
          let pending: Promise<T>;
          try { pending = task(controller.signal); } catch (error) { pending = Promise.reject(error); }
          pending.then(value => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(value);
          }, error => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
          });
        },
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      deadline = this.clock.setTimeout(() => cancel(!started && this.blockedUntil > this.clock.now()
        ? new RequestCooldownError()
        : new DOMException("The content request timed out.", "TimeoutError")), timeoutMs);
      this.queue.push(entry);
      this.pump();
    });
  }

  private pump(): void {
    if (this.timer !== undefined) {
      this.clock.clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.queue.length) return;
    const wait = Math.max(this.lastStartAt + this.intervalMs, this.blockedUntil) - this.clock.now();
    if (wait > 0) {
      this.timer = this.clock.setTimeout(() => { this.timer = undefined; this.pump(); }, Math.min(wait, 60_000));
      return;
    }
    const entry = this.queue.shift()!;
    this.lastStartAt = this.clock.now();
    entry.start();
    this.pump();
  }
}

// Process-wide, including separate createNotionClient instances. Keys are hashes,
// never credentials; only timing state survives between repository operations.
const storeKey = Symbol.for("notionblog.request-schedulers");
const processState = globalThis as typeof globalThis & { [storeKey]?: Map<string, NotionRequestScheduler> };
const schedulers = processState[storeKey] ??= new Map<string, NotionRequestScheduler>();
export function sharedNotionScheduler(token: string): NotionRequestScheduler {
  const key = createHash("sha256").update(token).digest("hex");
  let scheduler = schedulers.get(key);
  if (!scheduler) { scheduler = new NotionRequestScheduler(); schedulers.set(key, scheduler); }
  return scheduler;
}
