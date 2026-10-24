import { contentErrorResponse } from "../../../../../lib/content/http-error.ts";
import { contentFeatures } from "../../../../../../config/features.ts";
import { contentRepository } from "../../../../../lib/content/index.ts";
import { getStudyProjects } from "../../../../../lib/content/study.ts";
import { routeVerdict } from "../../../../../lib/route-verdict.ts";
import { publicProjection } from "../../../../../server/public-cache/runtime.ts";
import { publicCacheEnabled, publicCacheSecret } from "../../../../../server/public-cache/policy.ts";
import { routeCacheLookupResponse } from "../../../../../server/public-cache/route-lookup.ts";
import { withContentReadBudget } from "../../../../../server/content-read-budget.ts";
import { cacheRouteDeployment } from "../../../../../server/public-cache/deployment.ts";
export const runtime = "nodejs";
export const maxDuration = 10;
export async function GET(request: Request) {
  try {
    if (!publicCacheEnabled()) return new Response(null, { status: 404, headers: { "Cache-Control": "private, no-store" } });
    return await routeCacheLookupResponse(request, { ...cacheRouteDeployment(), siteKey: process.env.PUBLIC_CACHE_SITE_KEY ?? "", secret: publicCacheSecret() ?? "" },
      (path, params) => withContentReadBudget(AbortSignal.any([request.signal, AbortSignal.timeout(5000)]), () =>
        publicProjection("content", "route-verdict", [path, [...params]], async () => {
          const verdict = await routeVerdict(path, contentFeatures, contentRepository, params,
            { studyProject: async slug => (await getStudyProjects()).some(project => project.slug === slug) });
          if (verdict === "unknown") throw Error("ROUTE_UNAVAILABLE");
          return verdict;
        }), { timeoutMs: 5000 }));
  } catch (cause) { return contentErrorResponse(cause); }
}
