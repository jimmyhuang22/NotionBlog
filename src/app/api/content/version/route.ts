import { getDatabaseRuntime } from "../../../../server/database/runtime.ts";
import { publicCacheEnabled, publicCacheHash, publicCacheTag } from "../../../../server/public-cache/policy.ts";
import { validatePublicCacheStamp } from "../../../../server/public-cache/read.ts";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  const headers = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow" };
  if (!publicCacheEnabled()) return new Response(null, { status: 404, headers });
  try {
    const result = await getDatabaseRuntime().cacheStateDb.query<{ result: unknown }>("SELECT nb_cache_api.read_stamp() AS result");
    const state = validatePublicCacheStamp(result.rows[0]?.result);
    // No source identity, publication UUID, credential or private metadata reaches the browser.
    return Response.json({ version: 1, revision: publicCacheHash(state.stamp) }, { headers: {
      ...headers, "Vercel-CDN-Cache-Control": "public, max-age=15, must-revalidate", "CDN-Cache-Control": "no-store",
      "Vercel-Cache-Tag": (["content", "social", "home", "media"] as const).map(publicCacheTag).join(","),
    } });
  } catch { return new Response(null, { status: 503, headers }); }
}
