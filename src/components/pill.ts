/**
 * The sliding block behind a row's chosen item (the year and status rows, the works platforms, the study
 * overview's kinds): one block that moves between the choices instead of each choice drawing its own.
 */

/** Puts the block over `target`, sliding there when `animate`; with no target it shrinks away. Marks the row as placed. */
export function placePill(row: HTMLElement, block: HTMLElement, target: Element | null, animate: boolean) {
  block.style.transition = animate ? "" : "none";
  if (!target) { block.style.width = "0px"; row.dataset.pill = ""; return; }
  const box = row.getBoundingClientRect(), at = target.getBoundingClientRect();
  Object.assign(block.style, { width: `${at.width}px`, height: `${at.height}px`, top: `${at.top - box.top + row.scrollTop}px`, transform: `translateX(${at.left - box.left + row.scrollLeft}px)` });
  row.dataset.pill = "";
}

/**
 * Keeps the block on `find()` without a slide when the names change width: the row is resized, or a web font
 * arrives (the island's rounded face loads only once that skin is chosen). The observer's first report, which
 * comes right after the block was placed, is skipped, so a slide just started is not cut short. Returns the stop.
 */
export function followPill(row: HTMLElement, block: HTMLElement, find: () => Element | null): () => void {
  const again = () => placePill(row, block, find(), false);
  let first = true;
  const watch = new ResizeObserver(() => { if (first) { first = false; return; } again(); });
  watch.observe(row);
  const fonts = document.fonts;
  fonts?.addEventListener("loadingdone", again);
  return () => { watch.disconnect(); fonts?.removeEventListener("loadingdone", again); };
}
