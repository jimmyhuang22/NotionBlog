import { NextResponse, type NextRequest } from "next/server";
import { contentRepository } from "./lib/content";
import { contentFeatures } from "../config/features.ts";
import { getStudyProjects } from "./lib/content/study";
import { routeAnswer, routeVerdict, standInStatus } from "./lib/route-verdict.ts";
import { publicCacheEnabled, publicCacheSecret } from "./server/public-cache/policy.ts";
import { fetchCachedRouteVerdict } from "./server/public-cache/route-lookup.ts";
import { cacheRouteCaller } from "./server/public-cache/deployment.ts";

const noStore = { "Cache-Control": "no-store" };

/** Resolve metadata only, before any page loading boundary commits HTTP 200. */
export async function middleware(request: NextRequest) {
  const direct = standInStatus(request.nextUrl.pathname);
  if (direct !== null) return NextResponse.next({ status: direct, headers: noStore });
  let verdict: Awaited<ReturnType<typeof routeVerdict>>;
  try {
    verdict = publicCacheEnabled() ? await fetchCachedRouteVerdict(request.nextUrl.pathname + request.nextUrl.search,
      { ...await cacheRouteCaller(), siteKey: process.env.PUBLIC_CACHE_SITE_KEY ?? "", secret: publicCacheSecret() ?? "" })
      : await routeVerdict(request.nextUrl.pathname, contentFeatures, contentRepository, request.nextUrl.searchParams,
        { studyProject: async slug => (await getStudyProjects()).some(project => project.slug === slug) });
  } catch { verdict = "unknown"; }
  const answer = routeAnswer(verdict);
  if (!answer) return NextResponse.next();
  // Missing, or the check itself failed and nothing is known about this address: either way the
  // visitor gets a whole page with the right status, never an error thrown from here, which would
  // arrive as a bare "Internal Server Error" with no page around it.
  const target = request.nextUrl.clone();
  target.pathname = answer.standIn;
  target.search = "";
  return NextResponse.rewrite(target, { status: answer.status, headers: noStore });
}

// Temporary Vercel compatibility: its function validator does not yet accept proxy.ts.
// Keep Node.js explicit while the deprecated middleware filename remains in use.
export const config = {
  runtime: "nodejs",
  matcher: ["/about", "/blog/:path*", "/photos/:path*", "/projects/:path*", "/library/:path*", "/study/:path*", "/status/:path*", "/content-not-found", "/content-unavailable"],
};
