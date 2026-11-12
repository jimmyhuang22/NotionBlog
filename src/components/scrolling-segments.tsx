"use client";

import { useLayoutEffect, useRef, type MouseEvent, type ReactNode } from "react";

/** How long a pressed choice may stand before the block goes back to the one the page still shows (a move that never landed). */
const GIVE_BACK_AFTER = 8000;

/**
 * A row of filter links whose chosen look is one block that slides between them. It moves at the press, to the
 * link pressed, and the names change with it; the list follows when it arrives. Before, the block only moved
 * once the new list was in (a view transition of the chosen link, 2026-10-17): the name it carried rode along
 * with it and the name pressed went missing for a few frames. The page's `aria-current` stays the truth: when
 * the new page is in, the block is placed on whatever that says.
 *
 * `scroll` keeps the row on one line that scrolls sideways when it does not fit, with the chosen one brought
 * into view (the year row).
 */
export function Segments({ label, current, scroll = false, children }: { label: string; current: string | null; scroll?: boolean; children: ReactNode }) {
  const nav = useRef<HTMLElement>(null);
  const pill = useRef<HTMLSpanElement>(null);
  const giveBack = useRef<number | undefined>(undefined);

  function place(link: Element | null, animate: boolean) {
    const row = nav.current, block = pill.current;
    if (!row || !block) return;
    block.style.transition = animate ? "" : "none";
    if (!link) { block.style.width = "0px"; row.dataset.pill = ""; return; }
    const box = row.getBoundingClientRect(), at = link.getBoundingClientRect();
    Object.assign(block.style, { width: `${at.width}px`, height: `${at.height}px`, top: `${at.top - box.top + row.scrollTop}px`, transform: `translateX(${at.left - box.left + row.scrollLeft}px)` });
    row.dataset.pill = "";
  }

  function settle(animate: boolean) {
    const row = nav.current;
    if (!row) return;
    window.clearTimeout(giveBack.current);
    row.querySelectorAll("[data-picked]").forEach(link => link.removeAttribute("data-picked"));
    delete row.dataset.moving;
    place(row.querySelector("[aria-current]"), animate);
  }

  useLayoutEffect(() => {
    const row = nav.current;
    if (!row) return;
    settle(row.dataset.pill !== undefined);
    const chosen = row.querySelector<HTMLElement>("[aria-current]");
    if (scroll && chosen && row.scrollWidth > row.clientWidth) {
      const offset = chosen.getBoundingClientRect().left - row.getBoundingClientRect().left + row.scrollLeft;
      row.scrollLeft = offset - (row.clientWidth - chosen.offsetWidth) / 2;
    }
    // Names change width when the page's font arrives and when the row is resized; the block follows without a slide.
    const again = () => place(row.querySelector("[data-picked]") ?? row.querySelector("[aria-current]"), false);
    const watch = new ResizeObserver(again);
    watch.observe(row);
    let live = true;
    document.fonts?.ready.then(() => { if (live) again(); });
    return () => { live = false; watch.disconnect(); window.clearTimeout(giveBack.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, scroll]);

  // Another filter can change these links without changing the choice (a status with other years): keep the block on it.
  useLayoutEffect(() => {
    const row = nav.current;
    if (row && row.dataset.moving === undefined) place(row.querySelector("[aria-current]"), false);
  });

  function onClick(event: MouseEvent<HTMLElement>) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const row = nav.current;
    const link = (event.target as Element).closest("a[href]");
    if (!row || !link || !row.contains(link) || link.hasAttribute("aria-current")) return;
    row.querySelectorAll("[data-picked]").forEach(other => other.removeAttribute("data-picked"));
    link.setAttribute("data-picked", "");
    row.dataset.moving = "";
    place(link, true);
    window.clearTimeout(giveBack.current);
    giveBack.current = window.setTimeout(() => settle(true), GIVE_BACK_AFTER);
  }

  return (
    <nav ref={nav} className={scroll ? "segmented segmented--slide segmented--scroll" : "segmented segmented--slide"} aria-label={label} onClick={onClick}>
      <span ref={pill} className="segmented__pill" aria-hidden="true" />
      {children}
    </nav>
  );
}

/** The year row: one line, scrolling sideways when it does not fit. */
export function ScrollingSegments({ label, current, children }: { label: string; current: string | null; children: ReactNode }) {
  return <Segments label={label} current={current} scroll>{children}</Segments>;
}
