"use client";

import { useEffect, useRef, useState } from "react";
import type { PagingProblem } from "./use-paged-list";

export interface Paging { hasMore: boolean; pending: boolean; problem: PagingProblem; held: boolean; loadMore(): void | Promise<void>; retry?(): void }

/** How long a page may take before the reader is told it is slow and offered a fresh try (S12). */
const SLOW_MS = 8000;

/**
 * Whether the next page is asked for by itself as the reader nears the end. On since library covers
 * have 400px previews on the live site (checked 2026-10-17: 74 of 75 first-page covers, the other an
 * original smaller than a preview). Switching it off brings back the plain button everywhere; see
 * docs/decisions/2026-10-17-scroll-loading-on.md.
 */
const LOADS_BY_ITSELF: boolean = true;

/**
 * How far ahead of the end the next page is asked for: about one and a half screens (at least 1200px),
 * so it is usually there before the reader reaches the end (F36). Pictures still load lazily.
 */
const ahead = () => Math.max(1200, Math.round(1.5 * (typeof window === "undefined" ? 800 : window.innerHeight)));

/**
 * The end of a paged list. With LOADS_BY_ITSELF on, the next page is asked for as the reader nears
 * it, one page at a time; that stops after a failure, a restart or a page that added nothing. The
 * control is then a plain button, which is also what the keyboard and a browser without the observer
 * use, and what every reader gets while LOADS_BY_ITSELF is off.
 */
export function ListTail({ className, paging, label, status, end }: {
  className: string; paging: Paging;
  /** What the control says while it waits to be reached or pressed, e.g. "加载更早的内容". */
  label: string;
  /** How much is shown, or what went wrong; announced to screen readers. */
  status: string;
  /** Said in place of the control once everything is shown. */
  end?: string;
}) {
  const { hasMore, pending, problem, held, loadMore, retry } = paging;
  // The wait on show: a round begins each time a page is asked for or arrives, and with each press on
  // "重新加载" (which keeps the list pending, so the wait must start again by itself); `slow` is set once the
  // round has taken SLOW_MS. A new round starts unmarked, so a slow page never makes the next one look slow.
  const [wait, setWait] = useState({ pending, round: 0, slow: false });
  if (wait.pending !== pending) setWait({ pending, round: wait.round + 1, slow: false });
  useEffect(() => {
    if (!pending) return;
    const round = wait.round;
    const timer = setTimeout(() => setWait(current => current.round === round ? { ...current, slow: true } : current), SLOW_MS);
    return () => clearTimeout(timer);
  }, [pending, wait.round]);
  const slow = pending && wait.slow;
  const mark = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const load = useRef(loadMore);
  useEffect(() => { load.current = loadMore; });

  useEffect(() => {
    if (!LOADS_BY_ITSELF || !mark.current || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(entries => setNear(entries.at(-1)!.isIntersecting), { rootMargin: `0px 0px ${ahead()}px 0px` });
    observer.observe(mark.current);
    return () => observer.disconnect();
  }, []);

  const auto = LOADS_BY_ITSELF && hasMore && !problem && !held;
  // Runs when the end comes into reach, and again when a page has arrived, so a short page does not strand the list.
  // The observer has not yet seen where that page pushed the end to, so the end is measured here.
  useEffect(() => {
    if (!auto || pending || !mark.current) return;
    if (mark.current.getBoundingClientRect().top <= window.innerHeight + ahead()) void load.current();
  }, [near, auto, pending]);

  return (
    <div ref={mark} className={className}>
      {hasMore
        // Not the disabled attribute: a button that loses it mid-press would drop the keyboard's place in the page.
        ? <button type="button" className={auto ? "list-tail__auto" : "pill-button"} onClick={() => void loadMore()} aria-disabled={pending}>{pending ? "正在加载…" : problem ? "重试加载" : label}</button>
        : end ? <span className="list-tail__end">{end}</span> : null}
      {slow ? (
        <span className="list-tail__slow" aria-live="polite">
          加载得有点慢
          <button type="button" className="list-tail__retry" onClick={() => { setWait(current => ({ ...current, round: current.round + 1, slow: false })); (retry ?? (() => void loadMore()))(); }}>重新加载</button>
        </span>
      ) : null}
      <span role="status">{status}</span>
    </div>
  );
}
