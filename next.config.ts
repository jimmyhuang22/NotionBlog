import type { NextConfig } from "next";
import { configureExecutionEnvironment, isolatedBrowserPolicy } from "./scripts/development/execution.ts";

const config: NextConfig = {
  poweredByHeader: false,
  // next dev restarted on a kept .next/dev cache can answer every page load with "HMR hash mismatch"
  // and reload the page forever, re-reading the content source each time. Start from a fresh build.
  experimental: {
    turbopackFileSystemCacheForDev: false,
    // Pages are rendered per request, and Next keeps none of them in the browser by default: coming back
    // to a page just seen showed the loading placeholder and fetched it again. Keep each for five minutes
    // (the user's choice, 2026-10-17); new or withdrawn content shows after that.
    staleTimes: { dynamic: 300 },
  },
  outputFileTracingExcludes: {
    "/*": ["./.local/**/*", "./*-development-kit/**/*", "./*-development-kit-*.zip", "./.env*", "./sources/**/*", "./private/**/*", "./exports/**/*", "./cache/**/*", "./config/notion-sources.json", "./config/site.json"],
  },
};

export default function nextConfig(phase: string): NextConfig {
  const mode = configureExecutionEnvironment(process.env, phase);
  const publicCaching = mode === 'production' && process.env.PUBLIC_CONTENT_CACHE === 'tagged-v1';
  return { ...config, ...(publicCaching ? {
    // A hard one-day ISR bound, rather than the default long SWR period.
    expireTime: 86400,
    experimental: { ...config.experimental, staleTimes: { dynamic: 0, static: 0 } },
  } : {}), ...(mode === 'production' ? {} : {
    // Pin demo choices in Preview middleware too, independently of its lifecycle.
    // These are non-secret constants; credentials are never part of next.env.
    env: mode === 'offline' ? {
      CONTENT_PROVIDER: 'mock', SOCIAL_PROVIDER: 'mock', SOCIAL_MEDIA_ENABLED: 'false',
      CONTENT_FEATURES_JSON: '{}', SITE_INDEXING_ENABLED: 'false', SITE_CONFIG_JSON: '{}',
    } : {},
    async headers() {
      return [{ source: '/:path*', headers: [
        { key: 'Content-Security-Policy', value: isolatedBrowserPolicy },
        { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
      ] }];
    },
  }) };
}
