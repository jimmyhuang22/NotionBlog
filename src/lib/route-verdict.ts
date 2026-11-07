import type { ContentFeatures } from "../../config/features.ts";
import type { ContentRepository } from "../../contracts/repository.ts";
import { qualifyRoute, type RouteLookups } from "./qualify-route.ts";

export type RouteVerdict = "found" | "missing" | "unknown";

/**
 * What the request entry may conclude about an address. A check that fails says nothing about the
 * page: it is neither there nor missing, so it is never turned into a 404 and never left to crash
 * the request.
 */
/**
 * What the entry answers with. A page that is there goes through untouched. For the other two the
 * address is kept and a stand-in page is shown with the matching status. The stand-in is a fixed
 * address on purpose: where the site is hosted, a status put on a pass-through reaches the visitor
 * only when the address has no parameters — for a course, a work, an album or a note the platform
 * answered with its own bare error text instead of the page (seen during the 2026-10-13 outage).
 * A rewrite to a fixed address carries its status for every address, as the 404 always has.
 */
export function routeAnswer(verdict: RouteVerdict): { standIn: string; status: number } | null {
  if (verdict === "found") return null;
  return verdict === "unknown" ? { standIn: "/content-unavailable", status: 503 } : { standIn: "/content-not-found", status: 404 };
}

/** The stand-in pages asked for by their own address answer with their own status. */
export function standInStatus(pathname: string): number | null {
  return pathname === "/content-not-found" ? 404 : pathname === "/content-unavailable" ? 503 : null;
}

export async function routeVerdict(pathname: string, features: ContentFeatures, repository: ContentRepository, query?: URLSearchParams, lookups?: RouteLookups): Promise<RouteVerdict> {
  try {
    return await qualifyRoute(pathname, features, repository, query, lookups) ? "found" : "missing";
  } catch {
    return "unknown";
  }
}

/** Thrown by the stand-in below the moment an answer would need stored content. */
class NeedsLookup extends Error {}

/**
 * The verdict for an address the rules decide from configuration alone: a section's own page (/status,
 * /photos, /study, /library/movies), a disabled section, a malformed address. null when the answer needs
 * stored content (a detail page, a focused status, a note, the about page); the caller then asks the
 * provider or the cached route lookup as before. It runs the same rules (qualifyRoute) against a stand-in
 * that refuses every read, so no address can be decided differently here than there.
 */
export async function routeVerdictFromConfig(pathname: string, features: ContentFeatures, query?: URLSearchParams): Promise<RouteVerdict | null> {
  const refuse = () => { throw new NeedsLookup(); };
  const repository = new Proxy({}, { get: () => refuse }) as unknown as ContentRepository;
  try {
    return await qualifyRoute(pathname, features, repository, query, { studyProject: refuse }) ? "found" : "missing";
  } catch {
    // A read was needed (or anything unexpected happened): leave the address to the full check.
    return null;
  }
}
