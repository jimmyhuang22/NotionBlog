import { installOfflineNetworkGuard } from "./offline-network.cjs";

/** Called after dotenv and in fresh runtime workers; production bypasses this. */
export function configureDevelopmentEnvironment(env: NodeJS.ProcessEnv, now = Date.now()): "offline" | "cloud" {
  if (env.NOTIONBLOG_DEVELOPMENT_MODE === "cloud") {
    const expires = Number(env.NOTIONBLOG_CLOUD_PREVIEW_EXPIRES);
    if (!Number.isSafeInteger(expires) || expires <= now || expires > now + 900_000) throw new Error("Cloud development requires a new bounded dev:real session.");
    const keys = env.NOTIONBLOG_CLOUD_PREVIEW_KEYS;
    if (!keys) throw new Error("Cloud development requires an explicit reader profile.");
    let selected: unknown;
    try { selected = JSON.parse(keys); } catch { throw new Error("Invalid cloud development profile."); }
    if (!Array.isArray(selected) || selected.some(key => typeof key !== "string")) throw new Error("Invalid cloud development profile.");
    if (!env.NOTIONBLOG_CLOUD_RELAY) throw new Error("A metered cloud relay is required.");
    const allowed = new Set<string>(selected);
    for (const key of Object.keys(env)) if (/^(DATABASE_|SOCIAL_|NOTION_|STORAGE_|COS_|SYNC_|MEDIA_|CONTENT_|SITE_|NEXT_PUBLIC_|VERCEL_|PUBLIC_CACHE_|PUBLIC_CONTENT_CACHE$)/.test(key) && !allowed.has(key)) delete env[key];
    return "cloud";
  }
  // An explicit demo profile, never an error fallback from a failing real provider.
  // Empty strings prevent a later dotenv load from restoring private credentials.
  for (const key of Object.keys(env)) if (/^(DATABASE_|SOCIAL_|NOTION_|STORAGE_|COS_|SYNC_|MEDIA_|CONTENT_|SITE_|NEXT_PUBLIC_|VERCEL_|PUBLIC_CACHE_|PUBLIC_CONTENT_CACHE$)/.test(key)) env[key] = "";
  Object.assign(env, {
    NOTIONBLOG_DEVELOPMENT_MODE: "offline", CONTENT_PROVIDER: "mock", SOCIAL_PROVIDER: "mock",
    PUBLIC_CONTENT_CACHE: "disabled",
    SOCIAL_DISPLAY_MODE: "trial", SOCIAL_MEDIA_ENABLED: "false", SOCIAL_COLLECTION_PLAYBACK: "false",
    SOCIAL_COLLECTION_DAY_ADDITIONS: "false", DATABASE_CONTENT_VERSION: "1", DATABASE_READ_PROJECTION: "legacy",
    DATABASE_PUBLICATION_MODE: "qualified", MEDIA_PROVIDER: "storage", MEDIA_THUMBNAILS: "disabled",
    MEDIA_THUMBNAIL_QUALIFICATION: "live-notion", STORAGE_PROVIDER: "supabase", THUMBNAIL_STORAGE_PROVIDER: "supabase",
    COS_READ_TRANSPORT: "fetch", COS_READ_ENDPOINT: "regional", SITE_CONFIG_JSON: "{}", SITE_CONFIG: "",
    CONTENT_FEATURES_JSON: "{}", SITE_INDEXING_ENABLED: "false", SITE_DISCOVERY_KINDS_JSON: '["status","course","study-note"]',
    SITE_URL: `http://127.0.0.1:${env.PORT || "3000"}`, NEXT_TELEMETRY_DISABLED: "1",
  });
  installOfflineNetworkGuard();
  return "offline";
}
