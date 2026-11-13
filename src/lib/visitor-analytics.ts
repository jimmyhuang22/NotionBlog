/** No query strings, fragments, titles, search text or form contents leave this tracker. */
export function analyticsPath(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 1024 || !value.startsWith("/") ||
      value.startsWith("//") || /[\\\u0000-\u0020\u007f]/.test(value)) return null;
  const path = new URL(value, "https://site.invalid").pathname;
  return /^\/(?:$|(?:status|study|works|library|photos|about|blog|projects)(?:\/|$))/.test(path) ? path : null;
}

export function analyticsReferrer(value: unknown, origin: string): string {
  if (typeof value !== "string" || !value || value.length > 2048) return "";
  try {
    const url = new URL(value, origin);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return "";
    return url.origin === origin ? analyticsPath(url.pathname) ?? "" : url.origin;
  } catch { return ""; }
}

export type AnalyticsBrowser = {
  location: { origin: string; pathname: string };
  navigator: { doNotTrack?: string | null; globalPrivacyControl?: boolean; language: string };
  localStorage: Pick<Storage, "getItem">;
  fetch: typeof fetch;
};

/** One in-memory tracker for the root layout; no persistent identity and no delivery retries. */
export function createVisitorTracker(browser: AnalyticsBrowser, initialReferrer: string) {
  let previous: string | null = null;
  let cache: string | undefined;
  let sequence = 0;
  return (pathname: string) => {
    try {
      if (browser.navigator.doNotTrack === "1" || browser.navigator.globalPrivacyControl ||
          browser.localStorage.getItem("umami.disabled")) return;
    } catch { return; }
    const path = analyticsPath(pathname);
    if (!path || path === previous) return;
    const referrer = previous ?? analyticsReferrer(initialReferrer, browser.location.origin);
    previous = path;
    const sent = ++sequence;
    void browser.fetch("/api/visitor-analytics", {
      method: "POST", credentials: "omit", keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, referrer, language: browser.navigator.language.slice(0, 35), ...(cache ? { cache } : {}) }),
      signal: AbortSignal.timeout(4000),
    }).then(async response => {
      if (!response.ok) return;
      const result = await response.json();
      if (sent === sequence && typeof result.cache === "string" && result.cache.length <= 4096) cache = result.cache;
    }).catch(() => { /* Best effort: never block navigation or retry an ambiguously committed view. */ });
  };
}
