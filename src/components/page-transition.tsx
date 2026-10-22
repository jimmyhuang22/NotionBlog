"use client";

import { ViewTransition, useSyncExternalStore } from "react";
import { PageSwitch } from "./page-switch";
import { PublicCacheWatch } from "./public-cache-watch";

// Whether the visitor has done anything yet. Shared by the whole document; it only ever turns on.
let engaged = false;
const listeners = new Set<() => void>();
const signs = ["pointerdown", "keydown", "click"] as const;

function engage() {
  engaged = true;
  for (const type of signs) window.removeEventListener(type, engage, true);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  if (!engaged && listeners.size === 0) for (const type of signs) window.addEventListener(type, engage, true);
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * Lets named parts (the chosen filter segment) slide on a filter change (motion.css styles the "filter"
 * class). Moving to another page is not a view transition any more: page-switch.tsx keeps the old page
 * and cross-fades once the new one is there (F43, 2026-10-21). What arrives while a page loads — the
 * loading state giving way to the page, a section streaming in later — runs no view transition either,
 * unless it came from a filter link: one click once faded the whole page four times as the home page's
 * parts arrived.
 *
 * It stays switched off until the visitor first presses a key or a pointer, which always comes
 * before a navigation. Everything that happens on its own while a page loads — the loading state
 * giving way to the page, a section that streams in later — then appears without a view transition.
 * With the transition on from the start, each of those ran as a view transition while the page was
 * still becoming interactive, which made it interactive later and now and then tripped a hydration
 * error.
 */
export function PageTransition({ children }: { children: React.ReactNode }) {
  const active = useSyncExternalStore(subscribe, () => engaged, () => false);
  return (
    <>
    {/* Mounted here, inside every page, so the root layout stays as it is; they render nothing. */}
    <PublicCacheWatch />
    <PageSwitch />
    <ViewTransition enter="none" exit="none"
      update={active ? { filter: "filter", default: "none" } : "none"} share="none" default="none">
      {children}
    </ViewTransition>
    </>
  );
}
