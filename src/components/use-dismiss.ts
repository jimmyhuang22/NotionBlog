"use client";

import { useEffect, type FocusEvent, type MouseEvent, type RefObject } from "react";

/**
 * How the site's overlays open and go away, in one place.
 *
 * Dialogs (the image viewer, the search palette, the about card) are native modal <dialog>s: they bring
 * their own focus trap, Escape and return of focus. Menus that hang from a button (the theme menu, "更多")
 * are plain panels, so they close here on Escape, which returns focus to their button, on a press outside
 * them, and when focus leaves them.
 */

/** Shows the dialog as a modal whenever `open` turns true; closing stays with the dialog itself. */
export function useModal(dialog: RefObject<HTMLDialogElement | null>, open: boolean) {
  useEffect(() => {
    if (open && dialog.current && !dialog.current.open) dialog.current.showModal();
  }, [dialog, open]);
}

/** A press on the backdrop, outside the dialog's own box, closes it. */
export function closeOnBackdrop(event: MouseEvent<HTMLDialogElement>) {
  if (event.target === event.currentTarget) event.currentTarget.close();
}

/** While a menu is open, Escape closes it and puts focus back on its button, and a press outside it closes it. */
export function useMenuDismiss(open: boolean, close: () => void, group: RefObject<HTMLElement | null>, button: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      close();
      button.current?.focus();
    };
    const onDown = (event: PointerEvent) => { if (!group.current?.contains(event.target as Node)) close(); };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("pointerdown", onDown); };
    // `close` is a fresh function on every render that only closes the menu; opening and closing are what matter here.
  }, [open]);
}

/** For a menu's onBlur: tabbing past its last entry leaves the group, which closes it as well. */
export function closeOnLeave(close: () => void) {
  return (event: FocusEvent<HTMLElement>) => { if (!event.currentTarget.contains(event.relatedTarget)) close(); };
}
