"use client";

import { createContext, use, useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import type { CourseTree } from "../../contracts/content.ts";

const ReadingTree = createContext<Promise<CourseTree | null> | null>(null);
const emptyContexts: Record<string, string> = {};
const LinkContexts = createContext<Record<string, string>>(emptyContexts);
const RegisterContexts = createContext<((owner: string, labels: Record<string, string>) => void) | null>(null);
const subscribeHydration = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

/** The layout keeps this qualified directory promise while navigating between notes. */
export function StudyReadingProvider({ tree, children }: { tree: Promise<CourseTree | null>; children: ReactNode }) {
  const [pages, setPages] = useState<Record<string, Record<string, string>>>({});
  const register = useCallback((owner: string, labels: Record<string, string>) => {
    setPages(previous => {
      const old = previous[owner];
      if (!old && Object.keys(labels).length === 0) return previous;
      if (old && Object.keys(old).length === Object.keys(labels).length && Object.keys(labels).every(key => old[key] === labels[key])) return previous;
      return { ...previous, [owner]: labels };
    });
  }, []);
  const labels = useMemo(() => Object.assign({}, ...Object.values(pages)) as Record<string, string>, [pages]);
  return <ReadingTree value={tree}><RegisterContexts value={register}><LinkContexts value={labels}>{children}</LinkContexts></RegisterContexts></ReadingTree>;
}

/** Remembers only headings in already-read, qualified documents; never fetches extra note bodies. */
export function StudyLinkContexts({ owner, labels }: { owner: string; labels: Record<string, string> }) {
  const register = use(RegisterContexts);
  useEffect(() => { register?.(owner, labels); }, [register, owner, labels]);
  return null;
}

export function useStudyLinkContexts() {
  const labels = use(LinkContexts);
  // A streamed pager can hydrate after the page has registered labels. Its first client render
  // must still match the empty server snapshot; annotations appear as soon as it is interactive.
  const hydrated = useSyncExternalStore(subscribeHydration, clientSnapshot, serverSnapshot);
  return hydrated ? labels : emptyContexts;
}

export function useStudyReadingTree() {
  const tree = use(ReadingTree);
  return tree ? use(tree) : null;
}
