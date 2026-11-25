"use client";

/**
 * How the games list changes when a status or platform is chosen (乙, the owner's pick, 2026-11-25). At the press the old list dims while
 * the new one is read (library.css). When it arrives, each case that was already on screen glides from where it stood
 * to its new place, and the cases new to the screen rise in one after another; the year rings fade up from the dim.
 * Only what is on screen moves, and nothing at all when the reader asks for less motion.
 *
 * `recordWall` is called at the press (game-tools.tsx) and keeps where each case stood, in page coordinates, so a
 * scroll between the press and the arrival (the dock's glide back to the list) does not throw the glide off.
 */
let snapshot: { at: number; boxes: Map<string, { x: number; y: number }> } | null = null;
const EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";

const caseOf = (item: Element) => item.querySelector<HTMLElement>(".game-case") ?? (item as HTMLElement);

export function recordWall() {
  const boxes = new Map<string, { x: number; y: number }>();
  for (const item of document.querySelectorAll(".game-page:not(.page-loading) .game-line .library__item")) {
    const href = item.getAttribute("href");
    if (!href) continue;
    const box = caseOf(item).getBoundingClientRect();
    if (box.bottom < 0 || box.top > window.innerHeight) continue;
    boxes.set(href, { x: box.left + window.scrollX, y: box.top + window.scrollY });
  }
  snapshot = { at: Date.now(), boxes };
}

/** Plays the change on a list just put on the page. */
export function playWall(line: HTMLElement) {
  const shot = snapshot && Date.now() - snapshot.at < 8000 ? snapshot : null;
  snapshot = null;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  let order = 0;
  for (const item of line.querySelectorAll<HTMLElement>(".library__item")) {
    const box = caseOf(item).getBoundingClientRect();
    if (box.bottom < 0 || box.top > window.innerHeight) continue;
    const was = shot?.boxes.get(item.getAttribute("href") ?? "");
    if (was) {
      const dx = was.x - (box.left + window.scrollX), dy = was.y - (box.top + window.scrollY);
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) item.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: 460, easing: EASE });
      continue;
    }
    item.animate([{ opacity: 0, transform: "translateY(14px) scale(0.97)" }, { opacity: 1, transform: "none" }],
      { duration: 420, easing: EASE, delay: Math.min(order++ * 28, 336), fill: "backwards" });
  }
  for (const mark of line.querySelectorAll<HTMLElement>(".game-year__mark")) {
    const box = mark.getBoundingClientRect();
    if (box.bottom < 0 || box.top > window.innerHeight) continue;
    mark.animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: 360, easing: EASE });
  }
}
