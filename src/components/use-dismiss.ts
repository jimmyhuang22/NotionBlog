"use client";

import { useEffect, useRef, type FocusEvent, type MouseEvent, type RefObject } from "react";

/**
 * How the site's overlays open and go away, in one place.
 *
 * Dialogs (the image viewer, the search palette, the about card) are native modal <dialog>s: they bring
 * their own focus trap, Escape and return of focus. Menus that hang from a button (the theme menu, "更多")
 * are plain panels, so they close here on Escape, which returns focus to their button, on a press outside
 * them, and when focus leaves them.
 */

let holds = 0;

/**
 * Keeps the page behind a modal still (globals.css, `html[data-held]`): wheel and touch over the backdrop no
 * longer scroll it. Where the scroll bar takes room, that room is kept as padding, so nothing moves sideways
 * (the gutter alone does not hold it in Chrome). Nested modals share one hold. Returns the release, safe to call twice.
 */
export function holdPage(): () => void {
  const root = document.documentElement;
  if (holds++ === 0) {
    root.style.setProperty("--held-bar", `${Math.max(0, window.innerWidth - root.clientWidth)}px`);
    root.dataset.held = "";
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--holds > 0) return;
    delete root.dataset.held;
    root.style.removeProperty("--held-bar");
  };
}

/** Shows the dialog as a modal whenever `open` turns true, holding the page still until it closes; closing stays with the dialog itself. */
export function useModal(dialog: RefObject<HTMLDialogElement | null>, open: boolean) {
  useEffect(() => {
    const element = dialog.current;
    if (!open || !element) return;
    // Development runs the effect twice; the second run finds the dialog open and only takes the hold again.
    const release = holdPage();
    if (!element.open) element.showModal();
    element.addEventListener("close", release, { once: true });
    return () => { element.removeEventListener("close", release); release(); };
  }, [dialog, open]);
}

/** A press on the backdrop, outside the dialog's own box, closes it. */
export function closeOnBackdrop(event: MouseEvent<HTMLDialogElement>) {
  if (event.target === event.currentTarget) event.currentTarget.close();
}

/** While a menu is open, Escape closes it and puts focus back on its button, and a press outside it closes it. */
export function useMenuDismiss(open: boolean, close: () => void, group: RefObject<HTMLElement | null>, button: RefObject<HTMLElement | null>) {
  // `close` is a fresh function on every render; the listeners read the latest one, so they are set up only when the menu opens.
  const latestClose = useRef(close);
  useEffect(() => { latestClose.current = close; });
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      latestClose.current();
      button.current?.focus();
    };
    const onDown = (event: PointerEvent) => { if (!group.current?.contains(event.target as Node)) latestClose.current(); };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("pointerdown", onDown); };
  }, [open, group, button]);
}

/** For a menu's onBlur: tabbing past its last entry leaves the group, which closes it as well. */
export function closeOnLeave(close: () => void) {
  return (event: FocusEvent<HTMLElement>) => { if (!event.currentTarget.contains(event.relatedTarget)) close(); };
}
