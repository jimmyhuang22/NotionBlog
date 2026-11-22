/** Small browser checks shared by the interactive components. Call them from event handlers and effects only. */

type ClickLike = { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean };

/** The main button with no modifier: the browser is not about to open the link in a new tab or window. */
export function isPlainClick(event: ClickLike): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/** The visitor asked for less motion. Read at the moment of use, so a change in the system setting applies at once. */
export function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
