import { revalidatePath, revalidateTag } from "next/cache.js";
import { dangerouslyDeleteByTag } from "@vercel/functions";
import { getDatabaseRuntime } from "../../../../../server/database/runtime.ts";
import { publicCacheEnabled, publicCacheSecret } from "../../../../../server/public-cache/policy.ts";
import { cachePurgeResponse } from "../../../../../server/public-cache/events.ts";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request) {
  return cachePurgeResponse(request, {
    enabled: publicCacheEnabled,
    config: { siteKey: process.env.PUBLIC_CACHE_SITE_KEY ?? "", secret: publicCacheSecret() ?? "" },
    async read(id) {
      const result = await getDatabaseRuntime().cacheStateDb.query<{ result: unknown }>("SELECT nb_cache_api.read_event($1) AS result", [id]);
      return result.rows.length === 1 ? result.rows[0]!.result : null;
    },
    async purge(tags) {
      for (const tag of tags) revalidateTag(tag, { expire: 0 });
      revalidatePath("/", "layout");
      await dangerouslyDeleteByTag(tags, { revalidationDeadlineSeconds: 0 });
    },
  });
}
