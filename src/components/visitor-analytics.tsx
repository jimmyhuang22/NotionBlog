"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { createVisitorTracker } from "../lib/visitor-analytics.ts";

export function VisitorAnalytics() {
  const pathname = usePathname();
  const tracker = useRef<ReturnType<typeof createVisitorTracker> | null>(null);
  useEffect(() => {
    tracker.current ??= createVisitorTracker(window, document.referrer);
    tracker.current(pathname);
  }, [pathname]);
  return null;
}
