export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Public liveness only. Content readiness belongs to explicit acceptance runs. */
export function GET() {
  return new Response(null, {
    status: 204,
    headers: {
      "Cache-Control": "private, no-store",
      "CDN-Cache-Control": "no-store",
      "Vercel-CDN-Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}
