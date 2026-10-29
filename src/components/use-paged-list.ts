"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Page } from "../../contracts/content.ts";
import { resumeAfter, resumeBudget } from "../lib/paging-resume.ts";
import { canRestoreList, initialPageIdentity } from "../lib/paging-cache.ts";

export type PagingProblem = "busy" | "failed" | null;

async function fetchPage<T>(endpoint: string, query: Record<string, string>, cursor: string | null, signal?: AbortSignal): Promise<{ page?: Page<T>; code?: string }> {
  const params = new URLSearchParams(query);
  if (cursor) params.set("cursor", cursor);
  const response = await fetch(`${endpoint}?${params}`, { cache: "no-store", signal });
  const body = await response.json().catch(() => null);
  if (response.ok && body?.data) return { page: body.data as Page<T> };
  return { code: body?.error?.code ?? "CONTENT_UNAVAILABLE" };
}

/**
 * What a list had loaded, and how far down the reader was, when they left it. Going back or forward
 * to that address puts both back. Opted-in lists also reuse an ordinary navigation when its fresh server
 * first page agrees exactly. Kept in memory
 * for this visit only, and only for the last few lists.
 */
interface Snapshot { address: string; initialPage: string; items: unknown[]; cursor: string | null; hasMore: boolean; total: number | null; scrollY: number }
const snapshots = new Map<string, Snapshot>();
const KEPT = 6;
const address = () => window.location.pathname + window.location.search;
// The address the browser's back or forward last landed on. A list restores only there, so a link to the same page starts afresh.
let traversedTo: string | null = null;
if (typeof window !== "undefined") window.addEventListener("popstate", () => { traversedTo = address(); });

function recall(key: string, initialPage: string, reuseOnNavigation: boolean): Snapshot | null {
  if (typeof window === "undefined") return null;
  const snapshot = snapshots.get(key);
  return canRestoreList(snapshot, address(), traversedTo, initialPage, reuseOnNavigation) ? snapshot! : null;
}

/** Lists on screen, told when the published content changes (forgetPagedLists). */
const mounted = new Set<() => void>();

/**
 * The published content changed: drop every remembered list, and tell every list on screen to give up
 * what it has loaded and start again from the first page the server sends next. That holds whether or
 * not the first page changed (only a later page may have), and whatever the list does on navigation.
 */
export function forgetPagedLists() {
  snapshots.clear();
  for (const reset of mounted) reset();
}

function remember(key: string, snapshot: Snapshot) {
  snapshots.delete(key);
  snapshots.set(key, snapshot);
  for (const oldest of snapshots.keys()) {
    if (snapshots.size <= KEPT) break;
    snapshots.delete(oldest);
  }
}

/**
 * Cursor paging against a content list endpoint. One request at a time and no duplicate rows. A void
 * cursor (the list changed upstream, which social figures do every few minutes) first tries to find
 * the reader's place again and continue after it, twice; only when that fails does the list restart
 * from the first page instead of looping.
 */
export function usePagedList<T extends { id: string }>(endpoint: string, query: Record<string, string>, initial: Page<T>, reuseOnNavigation = false) {
  const key = `${endpoint}?${new URLSearchParams(query)}`;
  const firstPage = initialPageIdentity(initial);
  // Read on the first render only. While the server's markup is being taken over nothing is remembered yet, so both sides agree.
  const [restored] = useState(() => recall(key, firstPage, reuseOnNavigation));
  const [listIdentity, setListIdentity] = useState(`${key}\n${firstPage}`);
  const desiredIdentity = `${key}\n${firstPage}`;
  const [items, setItems] = useState(restored ? restored.items as T[] : initial.items);
  const [cursor, setCursor] = useState(restored ? restored.cursor : initial.nextCursor);
  const [hasMore, setHasMore] = useState(restored ? restored.hasMore : initial.hasMore && initial.nextCursor !== null);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<PagingProblem>(null);
  const [restarted, setRestarted] = useState(false);
  // Reported by adapters that can count; it follows the newest page because the list may change while paging.
  const [total, setTotal] = useState<number | null>(restored ? restored.total : initial.total ?? null);
  const inFlight = useRef(false);
  // Index of the first row added by the latest "load more", so lists can ease just those rows in.
  const [appendedFrom, setAppendedFrom] = useState<number | null>(null);
  // Set when the last page restarted the list or added nothing: loading by itself stops until the reader asks.
  const [held, setHeld] = useState(false);
  // Each attempt has a number; a retry raises it and aborts the old request, whose late answer then changes nothing (S12).
  const attempt = useRef(0);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!reuseOnNavigation || listIdentity === desiredIdentity) return;
    setListIdentity(desiredIdentity);
    attempt.current++;
    controller.current?.abort();
    inFlight.current = false;
    setItems(initial.items); setCursor(initial.nextCursor);
    setHasMore(initial.hasMore && initial.nextCursor !== null); setTotal(initial.total ?? null);
    setPending(false); setProblem(null); setRestarted(false); setHeld(false); setAppendedFrom(null);
  }, [desiredIdentity, listIdentity, initial, reuseOnNavigation]);

  useEffect(() => () => {
    attempt.current++;
    controller.current?.abort();
  }, []);

  // A new content version: stop any page on its way, return to the first page now and once more when the
  // refreshed one arrives, and remember nothing in between, so no old row or cursor is put back.
  // Two separate things: `awaiting` (a ref, no time limit) says the next first page from the server must be
  // taken however late it comes; `resyncing` only pauses remembering, and is given up after 15 seconds.
  const awaiting = useRef(false);
  const [resyncing, setResyncing] = useState(false);
  const latest = useRef(initial);
  latest.current = initial;
  const resetTo = useRef((page: Page<T>) => {});
  resetTo.current = (page: Page<T>) => {
    attempt.current++;
    controller.current?.abort();
    inFlight.current = false;
    setItems(page.items); setCursor(page.nextCursor);
    setHasMore(page.hasMore && page.nextCursor !== null); setTotal(page.total ?? null);
    setPending(false); setProblem(null); setRestarted(false); setHeld(false); setAppendedFrom(null);
  };
  useEffect(() => {
    const reset = () => { awaiting.current = true; setResyncing(true); resetTo.current(latest.current); };
    mounted.add(reset);
    return () => { mounted.delete(reset); };
  }, []);
  const seenInitial = useRef(initial);
  useEffect(() => {
    if (seenInitial.current === initial) return;
    seenInitial.current = initial;
    // Taken even after the 15 seconds below have passed: the wait for a new version's first page has no limit.
    if (!awaiting.current) return;
    awaiting.current = false;
    resetTo.current(initial);
    setListIdentity(`${key}\n${firstPage}`);
    setResyncing(false);
  }, [initial, key, firstPage]);
  // A refresh that never brings new props (the page failed to refresh) must not keep the list from remembering
  // for ever; the first page that does come later is still taken (awaiting above).
  useEffect(() => {
    if (!resyncing) return;
    const timer = window.setTimeout(() => setResyncing(false), 15_000);
    return () => window.clearTimeout(timer);
  }, [resyncing]);

  async function loadMore() {
    // The ref guards against a second request landing before React re-renders the pending state.
    if (inFlight.current) return;
    inFlight.current = true;
    const mine = ++attempt.current;
    const live = () => mine === attempt.current;
    const signal = (controller.current = new AbortController()).signal;
    setPending(true);
    setProblem(null);
    try {
      let result = await fetchPage<T>(endpoint, query, cursor, signal);
      if (!live()) return;
      let fresh = false;
      if (result.code === "INVALID_QUERY" && cursor) {
        const budget = resumeBudget(items.length, Number(query.limit) || 20);
        let resumed = await resumeAfter(items, next => fetchPage<T>(endpoint, query, next, signal), budget);
        // Writes come in bursts; one more try usually lands between them.
        if (resumed.kind === "lost" && live()) resumed = await resumeAfter(items, next => fetchPage<T>(endpoint, query, next, signal), budget);
        if (!live()) return;
        if (resumed.kind === "error") {
          setProblem(resumed.code === "RATE_LIMITED" ? "busy" : "failed");
          return;
        }
        if (resumed.kind === "resumed") {
          const page = resumed.page;
          setRestarted(false);
          setHeld(resumed.added.length === 0);
          setAppendedFrom(items.length);
          setItems([...items, ...resumed.added]);
          setCursor(page.nextCursor);
          setTotal(page.total ?? null);
          setHasMore(page.hasMore && page.nextCursor !== null);
          return;
        }
        result = await fetchPage<T>(endpoint, query, null, signal);
        if (!live()) return;
        fresh = true;
      }
      if (!result.page) {
        setProblem(result.code === "RATE_LIMITED" ? "busy" : "failed");
        return;
      }
      const page = result.page;
      const seen = new Set(fresh ? [] : items.map(item => item.id));
      const added = page.items.filter(item => !seen.has(item.id));
      setRestarted(fresh);
      setHeld(fresh || added.length === 0);
      setAppendedFrom(fresh ? null : items.length);
      setItems(fresh ? page.items : [...items, ...added]);
      setCursor(page.nextCursor);
      setTotal(page.total ?? null);
      setHasMore(page.hasMore && page.nextCursor !== null);
    } catch {
      if (live()) setProblem("failed");
    } finally {
      if (live()) {
        inFlight.current = false;
        setPending(false);
      }
    }
  }

  /** Gives up on a page that is taking too long and asks for it again (S12). */
  function retry() {
    attempt.current++;
    controller.current?.abort();
    inFlight.current = false;
    void loadMore();
  }

  // A list that fits on its first page needs no footer saying it has ended and how many rows it shows.
  const paged = initial.hasMore || appendedFrom !== null || restarted || restored !== null;

  // A back or forward is used up by the lists it brought on screen, whether or not they had anything to put back:
  // otherwise a later ordinary link to the same address would still read as that traversal and restore an old list.
  // After render, so every list mounted by the same traversal has read it first.
  useLayoutEffect(() => { traversedTo = null; }, []);
  // Before the first paint, so the page is never seen at the wrong height.
  useLayoutEffect(() => {
    if (!restored) return;
    window.scrollTo({ top: restored.scrollY, behavior: "instant" });
  }, [restored]);
  // Whether the remembered list for this key is this visit's own; a fresh visit must not move an older one's place.
  const owns = useRef(restored !== null);
  useEffect(() => {
    // Only a list that went past its first page has anything worth putting back; nothing while it starts again for a new version.
    if (resyncing) return;
    if (reuseOnNavigation && listIdentity !== desiredIdentity) return;
    if (!reuseOnNavigation && appendedFrom === null && !restored) {
      // On its first page again, by a fresh visit or a restart after the list changed: what an earlier visit (or this one
      // before the restart) left under this key is no longer this list, and going back here must not bring it back.
      if (snapshots.get(key)?.address === address()) snapshots.delete(key);
      return;
    }
    remember(key, { address: address(), initialPage: firstPage, items, cursor, hasMore, total, scrollY: window.scrollY });
    owns.current = true;
  }, [key, items, cursor, hasMore, total, appendedFrom, restored, firstPage, reuseOnNavigation, listIdentity, desiredIdentity, resyncing]);
  useEffect(() => {
    // The next page scrolls to its own top while this list is still being taken down; that is not this list's position.
    const onScroll = () => {
      if (!owns.current) return;
      const snapshot = snapshots.get(key);
      if (snapshot && snapshot.address === address()) snapshot.scrollY = window.scrollY;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [key]);

  return { items, hasMore, pending, problem, restarted, total, loadMore, retry, appendedFrom, paged, held };
}

export function pagingMessage(problem: PagingProblem, count: number, unit: string, total?: number | null): string {
  if (problem === "busy") return "暂时加载不出来，请稍后再试。";
  if (problem === "failed") return "这一页没有加载成功。";
  // The total can lag behind a list that changed while paging; never show fewer than what is on screen.
  return typeof total === "number" && total >= count ? `已显示 ${count} / ${total} ${unit}` : `已显示 ${count} ${unit}`;
}
