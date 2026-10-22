import "server-only";
import { getDatabaseRuntime } from "../database/runtime.ts";
import { getSiteConfig } from "../../lib/site/index.ts";
import { contentFeatures } from "../../../config/features.ts";
import { publicCacheEnabled, publicCacheNamespace, type PublicCacheScope } from "./policy.ts";
import { readPublicProjection, validatePublicCacheStamp } from "./read.ts";
import { withListReadBudget } from "../list-read-budget.ts";

export async function publicProjection<T>(scope: PublicCacheScope, operation: string, args: unknown, load: () => Promise<T>): Promise<T> {
  if (!publicCacheEnabled()) return load();
  return readPublicProjection(scope, operation, args, publicCacheNamespace(process.env, getSiteConfig(), contentFeatures), {
    async stamp() {
      const result = await getDatabaseRuntime().cacheStateDb.query<{ result: unknown }>("SELECT nb_cache_api.read_stamp() AS result");
      return validatePublicCacheStamp(result.rows.length === 1 ? result.rows[0]!.result : null);
    },
    // Fixed day and publication generations are part of the key. No SWR extends the hard boundary.
    read: async (key, tags, load) => {
      // Also supported by the Node operator/route harness; do not load Next caching when disabled.
      const { unstable_cache } = await import("next/cache.js");
      return unstable_cache(load, [key], { tags, revalidate: false })();
    },
  }, load);
}

/** Keep the public DTO contracts intact; the search method deliberately remains live. */
export function publicRepository<T extends object>(scope: PublicCacheScope, name: string, repository: T): T {
  return Object.fromEntries(Object.entries(repository).map(([method, fn]) => [method,
    typeof fn !== "function" || method === "search" ? fn : (...args: unknown[]) => {
      const read = () => publicProjection(scope, `${name}:${method}`, args, async () => Reflect.apply(fn, repository, args));
      // Stamp lookup and DTO reuse belong to the same pre-existing SSR/API deadline.
      return scope === "home" || scope === "social" ? withListReadBudget(scope === "home" ? "home-feed" : "works", read) : read();
    }])) as T;
}
