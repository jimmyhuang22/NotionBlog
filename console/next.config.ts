import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// The repository root, so the console can share contracts and the root's node_modules.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const config: NextConfig = {
  poweredByHeader: false,
  devIndicators: false,
  // Next writes an AGENTS.md beside the app otherwise; the repository has its own.
  agentRules: false,
  turbopack: { root },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'; form-action 'self'; base-uri 'none'" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
    ];
  },
};

export default config;
