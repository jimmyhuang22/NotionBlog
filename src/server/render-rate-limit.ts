import { ContentServiceError } from "../../contracts/repository.ts";
import { isSelfHostedRuntime } from "../../scripts/self-hosted/context.cjs";
import { createSearchLimiter, searchClientKey } from "./search-rate-limit.ts";

// Provisional rollout limits after browser batching. Confirm them against real page traffic
// before publication. Code and formulas share these buckets, independently of search.
export const RENDER_LIMITS = Object.freeze({
  perClient: Object.freeze({ capacity: 12, refillPerSecond: 0.5 }),
  instance: Object.freeze({ capacity: 24, refillPerSecond: 1 }),
  maxConcurrent: 2,
  maxClients: 5000,
});

export class RenderRateLimitedError extends ContentServiceError {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super("RATE_LIMITED", "Rendering is busy. Try again shortly.");
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

// Reuse the search bucket implementation with its own process-wide admission state. Plain
// admissions cross Next bundles; errors are constructed in the caller's bundle.
const key = Symbol.for("notionblog.render-rate-limit.v1");
type Limiter = Pick<ReturnType<typeof createSearchLimiter>, "admit">;
const holder = globalThis as typeof globalThis & { [key]?: Limiter };
const shared = holder[key] ??= createSearchLimiter(RENDER_LIMITS);

export async function limitRender<T>(headers: Headers, work: () => Promise<T>): Promise<T> {
  // The public self-hosted listener restores and overwrites both address headers. Other
  // environments have no verified proxy chain for this route and use instance limits only.
  const trustedProxy = isSelfHostedRuntime() && process.env.SELF_HOSTED_DEPLOYMENT === "public-website";
  const admission = shared.admit(trustedProxy ? searchClientKey(headers) : null);
  if ("retryAfterSeconds" in admission) throw new RenderRateLimitedError(admission.retryAfterSeconds);
  try {
    return await work();
  } finally {
    admission.release();
  }
}
