import "server-only";
import { readFileSync } from "node:fs";
import { parseSiteConfig, type SiteConfig } from "./parse.ts";

export type { SiteConfig, SocialLink, SocialPlatform } from "./parse.ts";

/** Read on every request so replacing the avatar or a link needs no rebuild. */
export function getSiteConfig(): SiteConfig {
  let input: unknown = {};
  try {
    // Private file or hosting secret; never traced into a deployment bundle.
    input = JSON.parse(process.env.SITE_CONFIG_JSON || readFileSync(/* turbopackIgnore: true */ process.env.SITE_CONFIG || "config/site.json", "utf8"));
  } catch {
    // A missing or unreadable private file means the generic identity, not an error page.
  }
  return parseSiteConfig(input, process.env.SITE_NAME);
}
