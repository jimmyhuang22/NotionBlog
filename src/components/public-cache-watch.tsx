"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { forgetPagedLists } from "./use-paged-list";

const EVERY = 30_000;
/** A version request that hangs is given up, so the page keeps asking later instead of never again. */
const GIVE_UP = 8_000;

/**
 * With the public cache on (the root element carries `data-public-cache="tagged-v1"`), pages are kept
 * for up to a day and dropped when the published content changes. A page already open would not know:
 * while it is visible, this asks the site's content version every 30 seconds, and once more when the
 * page is shown again. When the version moves on, the lists remembered for going back are dropped, every
 * list on screen starts again from its first page, and the page is fetched afresh, so no old row is kept or
 * put back. One request for the whole page, none per list or picture, given up after eight seconds; a 404
 * means the cache is off, and it stops asking. Nothing is refreshed once the watch has stopped.
 */
export function PublicCacheWatch() {
  const router = useRouter();
  useEffect(() => {
    if (document.documentElement.dataset.publicCache !== "tagged-v1") return;
    let known: string | null = null;
    let stopped = false;
    let asking: AbortController | null = null;
    const check = async () => {
      if (stopped || asking || document.visibilityState !== "visible") return;
      const request = new AbortController();
      asking = request;
      const timer = window.setTimeout(() => request.abort(), GIVE_UP);
      try {
        const response = await fetch("/api/content/version", { cache: "no-store", signal: request.signal });
        if (stopped) return;
        if (response.status === 404) { stop(); return; }
        if (!response.ok) return;
        const body = await response.json().catch(() => null) as { version?: unknown; revision?: unknown } | null;
        if (stopped || body?.version !== 1 || typeof body.revision !== "string") return;
        if (known !== null && body.revision !== known) {
          forgetPagedLists();
          router.refresh();
        }
        known = body.revision;
      } catch {
        // Offline, given up or the site briefly unreachable: ask again next time.
      } finally {
        window.clearTimeout(timer);
        if (asking === request) asking = null;
      }
    };
    const shown = () => { if (document.visibilityState === "visible") void check(); };
    const timer = window.setInterval(() => void check(), EVERY);
    document.addEventListener("visibilitychange", shown);
    function stop() {
      stopped = true;
      asking?.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", shown);
    }
    void check();
    return stop;
  }, [router]);
  return null;
}
