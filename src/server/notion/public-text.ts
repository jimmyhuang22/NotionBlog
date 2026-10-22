export function isNotionPageHost(value: string): boolean {
  const hostname = value.toLowerCase().replace(/\.$/, "");
  return ["notion.so", "notion.site", "notion.com"].some(host => hostname === host || hostname.endsWith(`.${host}`));
}

export function isTemporaryMediaUrl(url: URL): boolean {
  return [...url.searchParams.keys()].some(key => ["x-amz-signature", "x-amz-credential", "x-goog-signature", "signature"].includes(key.toLowerCase()));
}

/** Apply the same location policy to body text and metadata without fetching targets. */
export function sanitizePublicText(value: string): string {
  return value.replace(/https?:\/\/[^\s<>"']+/giu, candidate => {
    try {
      const url = new URL(candidate);
      if (isNotionPageHost(url.hostname)) return "Notion page";
      if (isTemporaryMediaUrl(url)) return "Media";
      return candidate;
    } catch { return candidate; }
  });
}
