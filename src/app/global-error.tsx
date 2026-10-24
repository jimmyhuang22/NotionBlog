"use client";

import "./globals.css";
import { PageUnavailable } from "../components/page-unavailable";

type Recover = () => void;

/**
 * When the root layout itself fails to render (for instance unreadable site settings), the site still answers
 * with its own notice, in its own colours, instead of the framework's bare page. Errors below the layout,
 * metadata included, are already caught by error.tsx with the header in place. This replaces the root layout,
 * so it brings its own html and body; the upstream reason is never shown.
 */
export default function GlobalError({ retry, unstable_retry, reset }: { error: Error; retry?: Recover; unstable_retry?: Recover; reset?: Recover }) {
  return (
    <html lang="zh-CN">
      <head>
        <title>页面暂时打不开</title>
      </head>
      <body>
        <main id="main">
          <PageUnavailable onRetry={retry ?? unstable_retry ?? reset ?? (() => window.location.reload())} />
        </main>
      </body>
    </html>
  );
}
