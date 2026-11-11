import { AsyncLocalStorage } from "node:async_hooks";
import { ContentServiceError } from "../../../contracts/repository.ts";
import { checkContentReadBudget } from "../content-read-budget.ts";
import { publicCacheKey, publicCacheTags, publicCacheWindow, type PublicCacheScope } from "./policy.ts";

export interface PublicCacheStamp { version: 1; enabled: true; stamp: string }
export function validatePublicCacheStamp(value: unknown): PublicCacheStamp {
  const v = value as PublicCacheStamp;
  if (!v || v.version !== 1 || v.enabled !== true || typeof v.stamp !== "string" || !/^[a-zA-Z0-9:._-]{1,512}$/.test(v.stamp))
    throw new ContentServiceError("CONTENT_UNAVAILABLE", "Public cache capability is not active.");
  return v;
}
export interface PublicCachePorts {
  stamp(): Promise<PublicCacheStamp>;
  read<T>(key: string, tags: string[], load: () => Promise<T>): Promise<T>;
  now?: () => number;
}
export interface ProjectionAdmission<T> {
  /** Change this marker when changing which results may be stored. */
  readonly policy: string;
  accepts(value: T): boolean;
}
// In-flight rows can be shared by separately bundled routes. These private control
// errors must be recognizable across module copies, unlike instanceof alone. A
// public provider code/message never grants retry or return-value semantics.
const projectionControl = Symbol.for("notionblog.public-projection-control.v1");
class ProjectionNotStored extends Error {
  readonly [projectionControl] = "not-stored";
  readonly value: unknown;
  constructor(value: unknown) { super("Public projection result must not be stored."); this.value = value; }
}
class OversizeProjection extends Error {
  readonly [projectionControl] = "oversize";
  readonly value: unknown;
  constructor(value: unknown) { super("Public projection is too large for the data cache."); this.value = value; }
}
class ProjectionChanged extends ContentServiceError {
  readonly [projectionControl] = "changed";
  constructor() { super("CONTENT_UNAVAILABLE", "Publication changed while preparing cached content."); }
}
function controlResult(error: unknown): { kind: "changed" } | { kind: "not-stored" | "oversize"; value: unknown } | null {
  if (!(error instanceof Error)) return null;
  const kind = Object.getOwnPropertyDescriptor(error, projectionControl)?.value;
  if (kind === "changed") return { kind };
  const value = Object.getOwnPropertyDescriptor(error, "value");
  return (kind === "not-stored" || kind === "oversize") && value && "value" in value ? { kind, value: value.value } : null;
}
const generation = new AsyncLocalStorage<string>();
/** Request-local service memos must not carry a rejected generation into a retry. */
export const publicProjectionGeneration = () => generation.getStore();
const MAX_ATTEMPTS = 3;

/** Retry only our generation/window guard, with a fresh key and full load each time.
 * Errors never become a cached success; continuous changes still fail closed. */
export async function readPublicProjection<T>(scope: PublicCacheScope, operation: string, args: unknown,
  namespace: string, ports: PublicCachePorts, load: () => Promise<T>, admission?: ProjectionAdmission<T>): Promise<T> {
  const now = ports.now ?? Date.now;
  for (let attempt = 1; ; attempt++) {
    checkContentReadBudget(); // A retry shares the caller's existing deadline and cancellation.
    try {
      const first = validatePublicCacheStamp(await ports.stamp()), window = publicCacheWindow(now());
      const key = publicCacheKey([namespace, scope, operation, args, first.stamp, window.bucket,
        ...(admission ? [{ admission: admission.policy }] : [])]);
      const entry = await ports.read(key, publicCacheTags(scope), async () => {
        const value = await generation.run(first.stamp, load);
        const current = validatePublicCacheStamp(await ports.stamp());
        checkContentReadBudget();
        if (current.stamp !== first.stamp || now() >= window.expiresAt) throw new ProjectionChanged();
        // Throw before the cache port stores a fulfilled result. The caller still
        // receives this guarded value; provider/cache errors keep propagating.
        if (admission && !admission.accepts(value)) throw new ProjectionNotStored(value);
        if (Buffer.byteLength(JSON.stringify(value)) > 2 * 1024 * 1024 - 4096) throw new OversizeProjection(value);
        return { value, stamp: first.stamp, expiresAt: window.expiresAt };
      });
      checkContentReadBudget();
      if (entry.stamp !== first.stamp || entry.expiresAt !== window.expiresAt)
        throw new ContentServiceError("CONTENT_UNAVAILABLE", "Public projection cache is out of date.");
      if (now() >= entry.expiresAt) throw new ProjectionChanged();
      if (admission && !admission.accepts(entry.value))
        throw new ContentServiceError("CONTENT_UNAVAILABLE", "Public projection cache result violates its admission policy.");
      return structuredClone(entry.value);
    } catch (error) {
      const control = controlResult(error);
      // Preserve large valid documents without storing them or weakening generation checks.
      if (control?.kind === "oversize" || control?.kind === "not-stored") {
        checkContentReadBudget();
        return structuredClone(control.value) as T;
      }
      if (control?.kind !== "changed" || attempt >= MAX_ATTEMPTS) throw error;
    }
  }
}
