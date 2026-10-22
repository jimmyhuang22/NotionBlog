"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { usePathname } from "next/navigation";

/** Lists on screen by page, and the last one to leave: a filter renders the next list while the old one is still there. */
const showing = new Map<string, number>();
let leaving: { path: string; group: string; at: number } | null = null;

/**
 * True when this list replaces another on the same page, that is when a filter, a year, a kind or a new
 * search was chosen; never on a first visit or on arriving from another page. Its first-screen rows then
 * come in quietly (motion.css `.is-arriving`), the light switch the owner chose on 2026-10-20.
 */
export function useFilterArrival(group = ""): boolean {
  const path = usePathname();
  // A group limits it to lists of the same kind: the works page's order change, not its platform switch (F40 has its own).
  const place = `${path}|${group}`;
  const [arrived] = useState(() => (showing.get(place) ?? 0) > 0 || (!!leaving && leaving.path === path && leaving.group === group && Date.now() - leaving.at < 1500));
  useEffect(() => {
    showing.set(place, (showing.get(place) ?? 0) + 1);
    return () => { showing.set(place, (showing.get(place) ?? 1) - 1); leaving = { path, group, at: Date.now() }; };
  }, [path, group, place]);
  return arrived;
}

/** How many rows of a fresh list take part, and the inline index each one gets. */
export const ARRIVING_ROWS = 12;
export const arrivalStyle = (index: number) => ({ "--i": index }) as CSSProperties;
