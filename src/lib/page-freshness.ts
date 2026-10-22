import { connection } from "next/server";
import { publicCacheEnabled } from "@/server/public-cache/policy";

/**
 * Cached pages declare `revalidate` so that, with the public cache switched on, their markup is kept
 * and dropped by the same tags as their data. With it off, nothing would ever drop that markup, so a
 * cached page would show old content for a day: the page asks for a fresh render on every request
 * instead, as all pages did before. Call it first thing in a cached page.
 */
export async function freshWhenUncached(): Promise<void> {
  if (!publicCacheEnabled()) await connection();
}

/**
 * For a page that shows its own notice when a read fails (a directory to retry, a timeline that did
 * not load): such a notice must never be kept as the page for a day, so the page is rendered per
 * request. Its data still comes from the shared cache when that is on.
 */
export async function alwaysFresh(): Promise<void> {
  await connection();
}
