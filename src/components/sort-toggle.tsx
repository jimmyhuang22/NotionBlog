"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { LinkPending } from "@/components/link-pending";
import { FILTER_TRANSITION } from "@/lib/transitions";

type Mark = "down" | "up" | "swap";

const paths: Record<Mark, string> = {
  down: "M6 2v8M2.5 6.5 6 10l3.5-3.5",
  up: "M6 10V2M2.5 5.5 6 2l3.5 3.5",
  // Two orders that are not each other's reverse: a plain switch between them.
  swap: "M4 2v8M1.5 4.5 4 2l2.5 2.5M8 10V2M5.5 7.5 8 10l2.5-2.5",
};

function SortMark({ mark }: { mark: Mark }) {
  return <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d={paths[mark]} /></svg>;
}

/**
 * The order of a list as one button that switches to the other order (the owner's choice, F34): it names
 * the order in use and, pressed, already shows the one it leads to while that list is on its way.
 */
export function SortToggle({ href, now, next }: { href: string; now: { label: string; mark: Mark }; next: { label: string; mark: Mark } }) {
  // Pressed, it turns over (2026-10-20): the old name fades as its arrow turns away and the new one turns in,
  // carried on from where it was if the new list arrives part-way. Reduced motion simply swaps the words.
  const link = useRef<HTMLAnchorElement>(null);
  const pressed = useRef<{ at: number; label: string } | null>(null);
  const [turning, setTurning] = useState(false);
  const turnIn = (span: Element | null, elapsed: number) => {
    if (!span) return;
    const options = { duration: 220, easing: "cubic-bezier(0.3, 0.9, 0.3, 1)", fill: "backwards" as const };
    span.animate([{ opacity: 0 }, { opacity: 1 }], options).currentTime = elapsed;
    const arrow = span.querySelector("svg");
    if (arrow) arrow.animate([{ rotate: "-180deg" }, { rotate: "0deg" }], options).currentTime = elapsed;
  };
  function press() {
    const anchor = link.current;
    if (!anchor || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const old = anchor.querySelector(".library__sort-now");
    if (old) {
      const ghost = old.cloneNode(true) as HTMLElement;
      ghost.className = "library__sort-leaving";
      ghost.setAttribute("aria-hidden", "true");
      anchor.append(ghost);
      ghost.querySelector("svg")?.animate([{ rotate: "0deg" }, { rotate: "180deg" }], { duration: 220, easing: "cubic-bezier(0.3, 0.9, 0.3, 1)", fill: "forwards" });
      ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, easing: "ease-out", fill: "forwards" }).finished.then(() => ghost.remove(), () => ghost.remove());
    }
    pressed.current = { at: performance.now(), label: now.label };
    setTurning(true);
  }
  // The new name stands where the old one was at once; it turns in, and keeps turning when the page swaps it for the real one.
  useLayoutEffect(() => {
    const press = pressed.current, anchor = link.current;
    if (!press || !anchor) return;
    const elapsed = performance.now() - press.at;
    if (now.label !== press.label) {
      pressed.current = null;
      setTurning(false);
      if (elapsed < 220) turnIn(anchor.querySelector(".library__sort-now"), elapsed);
    } else if (turning) turnIn(anchor.querySelector(".library__sort-next"), elapsed);
  }, [now.label, turning]);
  useEffect(() => {
    if (!turning) return;
    const timer = setTimeout(() => { pressed.current = null; setTurning(false); }, 4000);
    return () => clearTimeout(timer);
  }, [turning]);
  return (
    <nav className="library__sort" aria-label="排序">
      <Link ref={link} href={href} aria-label={`排序：${now.label}，点按改为${next.label}`} transitionTypes={FILTER_TRANSITION} className={turning ? "is-turning" : undefined}
        onClick={event => { if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.button === 0) press(); }}>
        <span className="library__sort-now">{now.label}<SortMark mark={now.mark} /></span>
        <span className="library__sort-next" aria-hidden="true">{next.label}<SortMark mark={next.mark} /></span>
        <LinkPending />
      </Link>
    </nav>
  );
}
