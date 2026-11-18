import type { SocialLink } from "./site/parse.ts";

/**
 * The site's email address, encoded for the contact card (contact-card.tsx): the page carries no plain address or
 * mailto link, so a crawler reading the markup for addresses does not find it; the card decodes it when opened.
 * It is a light guard, not a secret. Null when no email is configured, and then no contact entry is shown.
 */
export function contactCode(socials: readonly SocialLink[]): string | null {
  const email = socials.find(link => link.platform === "email");
  const address = email?.url.replace(/^mailto:/u, "");
  return address ? Buffer.from(address, "utf8").toString("base64") : null;
}
