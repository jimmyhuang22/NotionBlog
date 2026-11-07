import { contentErrorResponse } from "../../../../../lib/content/http-error.ts";
import { revalidatePath, revalidateTag } from "next/cache.js";
import { after } from "next/server.js";
import { dangerouslyDeleteByTag } from "@vercel/functions";
import { getDatabaseRuntime } from "../../../../../server/database/runtime.ts";
import { publicCacheEnabled, publicCacheSecret } from "../../../../../server/public-cache/policy.ts";
import { cachePurgeResponse } from "../../../../../server/public-cache/events.ts";
import { warmPublicPages } from "../../../../../server/public-cache/warm.ts";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request) {
  try {
    return await cachePurgeResponse(request, {
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
        // After the response: the self-hosted public server renders its first pages again for the new
        // generation (warm.ts). Elsewhere this does nothing. A failure leaves the pages cold, as before.
        after(() => warmPublicPages());
      },
    });
  } catch (cause) { return contentErrorResponse(cause); }
}
