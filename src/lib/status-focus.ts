/** A public status key, never a URL, path or arbitrary query fragment. */
export function readStatusFocus(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value) ? value : null;
}

export function statusFocusHref(id: string): string {
  if (!readStatusFocus(id)) throw new Error("Invalid status focus key");
  return `/status?${new URLSearchParams({ focus: id })}#${encodeURIComponent(id)}`;
}

/** Older stored DTOs retain fragment links; a bookmark can upgrade without rewriting the snapshot. */
export function readStatusHash(hash: string): string | null {
  // "#top" is the page's own way back up (the footer's link); it names the top of the page, never a status.
  if (!hash.startsWith("#") || hash === "#top") return null;
  try { return readStatusFocus(decodeURIComponent(hash.slice(1))); }
  catch { return null; }
}
