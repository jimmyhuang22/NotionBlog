import type { Metadata } from "next";
import { PageUnavailableReload } from "@/components/page-unavailable";

export const metadata: Metadata = { title: "页面暂时打不开", robots: { index: false, follow: false } };

/** Internal rewrite target for an address that could not be checked; the proxy also gives direct visits a 503 status. */
export default function ContentUnavailable() {
  return <PageUnavailableReload />;
}
