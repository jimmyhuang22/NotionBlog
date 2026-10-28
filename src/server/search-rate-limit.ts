import { isIP } from "node:net";
import { ContentServiceError } from "../../contracts/repository.ts";

/**
 * Search runs SQL on every request and its results are never cached, so a burst of requests
 * goes straight to the database. These limits live in each server instance's memory: no shared
 * store, extra SQL or dependency. They bound what one instance sends to the database and slow a
 * single client down; they are not a global quota across all instances.
 */
type Rate = { capacity: number; refillPerSecond: number };
export type SearchLimits = { perClient: Rate; instance: Rate; maxConcurrent: number; maxClients: number };

// Typing in the search box sends at most one request per 280 ms pause, so a person stays well
// inside 12 at once and one every two seconds after that.
export const SEARCH_LIMITS: SearchLimits = Object.freeze({
  perClient: Object.freeze({ capacity: 12, refillPerSecond: 0.5 }),
  instance: Object.freeze({ capacity: 60, refillPerSecond: 3 }),
  maxConcurrent: 8,
  maxClients: 5000,
});

export class SearchRateLimitedError extends ContentServiceError {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super("RATE_LIMITED", "Search is busy. Try again shortly.");
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

type Bucket = { tokens: number; at: number };

function refill(bucket: Bucket, rate: Rate, now: number) {
  bucket.tokens = Math.min(rate.capacity, bucket.tokens + Math.max(0, now - bucket.at) / 1000 * rate.refillPerSecond);
  bucket.at = now;
}

const wait = (bucket: Bucket, rate: Rate) => Math.max(1, Math.ceil((1 - bucket.tokens) / rate.refillPerSecond));

/** Either a place to run (release it when done) or how long to wait. Plain data, so it can cross bundles. */
type Admission = { release: () => void } | { retryAfterSeconds: number };

export function createSearchLimiter(limits: SearchLimits = SEARCH_LIMITS, now: () => number = Date.now) {
  const clients = new Map<string, Bucket>();
  const instance: Bucket = { tokens: limits.instance.capacity, at: now() };
  let running = 0;
  const admit = (client: string | null): Admission => {
    const at = now();
    // Without a known client address only the instance limits apply: one shared allowance for
    // every such visitor would throttle the whole site behind a proxy that sends no address.
    let bucket: Bucket | null = null;
    if (client !== null) {
      bucket = clients.get(client) ?? { tokens: limits.perClient.capacity, at };
      clients.delete(client);
      // Most recently used last, so the oldest client is the first to be forgotten.
      clients.set(client, bucket);
      while (clients.size > limits.maxClients) clients.delete(clients.keys().next().value!);
      refill(bucket, limits.perClient, at);
    }
    refill(instance, limits.instance, at);
    if (bucket && bucket.tokens < 1) return { retryAfterSeconds: wait(bucket, limits.perClient) };
    if (instance.tokens < 1) return { retryAfterSeconds: wait(instance, limits.instance) };
    if (running >= limits.maxConcurrent) return { retryAfterSeconds: 1 };
    if (bucket) bucket.tokens -= 1;
    instance.tokens -= 1;
    running += 1;
    let released = false;
    return { release: () => { if (!released) { released = true; running -= 1; } } };
  };
  return {
    admit,
    async run<T>(client: string | null, work: () => Promise<T>): Promise<T> {
      return runAdmitted(admit(client), work);
    },
    get running() { return running; },
    get clients() { return clients.size; },
  };
}

/** One client per IPv4 address or IPv6 /64, from the address the hosting proxy reports; null when unknown. */
export function searchClientKey(headers: Headers): string | null {
  const raw = headers.get("x-real-ip") ?? headers.get("x-forwarded-for")?.split(",")[0];
  const address = raw?.trim().replace(/^\[|\]$/g, "") ?? "";
  const version = isIP(address);
  if (version === 4) return address;
  if (version === 6) {
    const lower = address.toLowerCase();
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return mapped[1];
    const [head, tail = ""] = lower.split("::");
    const left = head ? head.split(":") : [], right = tail ? tail.split(":") : [];
    const groups = lower.includes("::") ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right] : left;
    return groups.slice(0, 4).map(group => group.replace(/^0+(?=.)/, "")).join(":") + "::/64";
  }
  return null;
}

// The refusal is raised here, in the caller's copy of this module, so its `instanceof` checks hold.
async function runAdmitted<T>(admission: Admission, work: () => Promise<T>): Promise<T> {
  if ("retryAfterSeconds" in admission) throw new SearchRateLimitedError(admission.retryAfterSeconds);
  try {
    return await work();
  } finally {
    admission.release();
  }
}

// Next bundles the route handler and the search page separately, each with its own copy of this
// module. Keep one limiter per process so both share the same counts; only plain data crosses.
const key = Symbol.for("notionblog.search-rate-limit.v1");
const holder = globalThis as typeof globalThis & { [key]?: { admit: (client: string | null) => Admission } };
const shared = holder[key] ??= createSearchLimiter();
export const limitSearch = <T>(headers: Headers, work: () => Promise<T>) => runAdmitted(shared.admit(searchClientKey(headers)), work);
