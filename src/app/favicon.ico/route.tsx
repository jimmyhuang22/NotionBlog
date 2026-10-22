import { siteIcon } from "@/lib/site/icon";

export const dynamic = "force-dynamic";

/** Browsers and crawlers that ask for the default address get the light icon (a PNG, which they accept here). */
export function GET() {
  return siteIcon("light");
}
