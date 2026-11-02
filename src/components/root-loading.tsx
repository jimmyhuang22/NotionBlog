"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/**
 * The root loading state wraps every section, and on a first visit it is the first thing the server sends for
 * any address, before that section's own loading state arrives. Only the home page may draw the introduction;
 * every other address gets the plain loading state, so a slow first response never shows the home page (F54).
 */
export function RootLoading({ home, other }: { home: ReactNode; other: ReactNode }) {
  return usePathname() === "/" ? home : other;
}
