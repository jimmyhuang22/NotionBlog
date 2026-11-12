import type { Metadata } from "next";
import { PageUnavailableReload } from "@/components/page-unavailable";
import { alwaysFresh } from "@/lib/page-freshness";

export const metadata: Metadata = { title: "页面暂时打不开", robots: { index: false, follow: false } };

/**
 * Internal rewrite target for an address that could not be checked; the proxy also gives direct visits a 503 status.
 * Rendered per request, like the 404 page, so it carries the running site's name, sections and footer.
 */
export default async function ContentUnavailable() {
  await alwaysFresh();
  return <PageUnavailableReload />;
}
