export type VisitorAnalyticsConfig = {
  websiteId: string;
  hostname: string;
  origins: string[];
  node: string;
  endpoint: string;
  secret: string;
  clientIpHeader: "x-real-ip" | "cf-connecting-ip";
};

const invalid = (): never => { throw new Error("VISITOR_ANALYTICS_CONFIG_INVALID"); };

/** Private runtime configuration; never pass this object to a client component. */
export function parseVisitorAnalyticsConfig(raw: string): VisitorAnalyticsConfig {
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== "object" || Array.isArray(v) ||
        Object.keys(v).sort().join(",") !== "clientIpHeader,endpoint,hostname,node,origins,secret,websiteId" ||
        ["websiteId", "hostname", "node", "endpoint", "secret", "clientIpHeader"].some(key => typeof v[key] !== "string") ||
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v.websiteId) ||
        !/^[a-z0-9][a-z0-9-]{0,31}$/.test(v.node) ||
        !/^[a-f0-9]{64}$/.test(v.secret) ||
        !["x-real-ip", "cf-connecting-ip"].includes(v.clientIpHeader) ||
        typeof v.hostname !== "string" || !/^[a-z0-9.-]+$/.test(v.hostname) ||
        new URL(`https://${v.hostname}`).hostname !== v.hostname ||
        !Array.isArray(v.origins) || v.origins.length < 1 || v.origins.length > 8) return invalid();
    for (const origin of v.origins) {
      const url = new URL(origin);
      if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password) return invalid();
    }
    const endpoint = new URL(v.endpoint);
    if ((endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && endpoint.hostname === "127.0.0.1")) ||
        endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/collect") return invalid();
    return v;
  } catch { return invalid(); }
}

/** Explicitly off in builds, demo, CI and protected previews, even with stale environment values. */
export function visitorAnalyticsConfig(env: Record<string, string | undefined> = process.env): VisitorAnalyticsConfig | null {
  if (env.NODE_ENV !== "production" || env.NOTIONBLOG_DEVELOPMENT_MODE !== "self-hosted" ||
      env.SELF_HOSTED_DEPLOYMENT !== "public-website" || env.CONTENT_PROVIDER !== "database" ||
      env.PREVIEW_ACCESS_CONFIG || env.PREVIEW_DATA_DATE || !env.SITE_ANALYTICS_JSON) return null;
  try { return parseVisitorAnalyticsConfig(env.SITE_ANALYTICS_JSON); }
  catch { return null; } // Optional analytics must never take the website down.
}
