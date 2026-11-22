"use client";

import { useEffect } from "react";

/**
 * The left and right arrow keys open the previous and next work (2026-11-22, with the edge handles of 乙): the key
 * presses whichever link is on screen, the edge handle or the card at the foot of the page, so the move goes through
 * the same link, pending state and page switch as a click. Left is "上一款", the work before this one in the list's
 * order, as it sits to the left on the shelf.
 *
 * The keys stay with whatever else wants them: nothing happens while typing, with a modifier held (back and forward,
 * selection), when something already handled the key (the trophy platform tabs), inside a widget that moves with
 * arrows or a box that scrolls sideways (a wide code block), or while a dialog (the image viewer, the search) is open.
 */
export function NeighbourKeys() {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const side = event.key === "ArrowLeft" ? "prev" : event.key === "ArrowRight" ? "next" : null;
      if (!side || event.defaultPrevented || event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (document.querySelector("dialog[open]")) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='tablist'], [role='slider'], [role='radiogroup'], [role='listbox'], [role='menu']")) return;
      for (let node = target; node && node !== document.body; node = node.parentElement) {
        if (node.scrollWidth > node.clientWidth + 1 && /auto|scroll/u.test(getComputedStyle(node).overflowX)) return;
      }
      const link = [...document.querySelectorAll<HTMLAnchorElement>(`.work__edge--${side}, .work__neighbours .pager__${side}`)].find(anchor => anchor.getClientRects().length > 0);
      if (!link) return;
      event.preventDefault();
      link.click();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return null;
}
