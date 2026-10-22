"use client";

import { usePathname } from "next/navigation";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";

/** Where the directory stands beside the note instead of waiting behind its button (study.css says the same). */
const COLUMN = "(min-width: 1100px)";

/**
 * The course directory (the owner's choice of 2026-10-21, replacing the on-demand dialog of 10-19). On a
 * wide screen it is a column on the left of the note, sticky and scrolling on its own, so the reader sees
 * where the note sits in the course. On a narrower one the same element is a drawer from the left, opened
 * by the button and modal while open: everything outside it is inert, Escape or the backdrop closes it.
 * One element serves both, so the server sends the directory once and nothing moves after hydration.
 */
export function StudyReadingDirectory({ children }: { children: ReactNode }) {
  const panel = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const pathname = usePathname();
  const titleId = useId();
  const panelId = useId();
  const [open, setOpen] = useState(false);

  // Close only after navigation commits; while waiting the selected link can show its pending state.
  useEffect(() => { setOpen(false); }, [pathname]);

  // Widened past the column's width, an open drawer simply becomes the column.
  useEffect(() => {
    const column = window.matchMedia(COLUMN);
    const settle = () => { if (column.matches) setOpen(false); };
    column.addEventListener("change", settle);
    return () => column.removeEventListener("change", settle);
  }, []);

  useLayoutEffect(() => {
    const drawer = panel.current;
    if (!open || !drawer) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // Out of reach while the drawer is open, as behind a modal dialog: every branch of the page beside the drawer's own path.
    const outside: HTMLElement[] = [];
    for (let node: HTMLElement | null = drawer; node && node !== document.body; node = node.parentElement) {
      for (const sibling of node.parentElement?.children ?? []) {
        if (sibling === node || !(sibling instanceof HTMLElement) || sibling.inert || sibling.classList.contains("reading__backdrop")) continue;
        sibling.inert = true;
        outside.push(sibling);
      }
    }
    drawer.querySelector<HTMLButtonElement>(".reading-directory-head button")?.focus({ preventScroll: true });
    const pane = drawer.querySelector<HTMLElement>(".course-directory__scroll");
    const current = drawer.querySelector<HTMLElement>('[aria-current="page"]');
    if (pane && current && current.getClientRects().length) {
      const box = pane.getBoundingClientRect(), row = current.getBoundingClientRect();
      pane.scrollTop += row.top - box.top - (pane.clientHeight - row.height) / 2;
    }
    // Escape first clears a search in the finder (course-tree.tsx), then closes.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || (event.target instanceof HTMLInputElement && event.target.value)) return;
      event.preventDefault();
      setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
      for (const element of outside) element.inert = false;
      if (drawer.contains(document.activeElement)) trigger.current?.focus({ preventScroll: true });
    };
  }, [open]);

  return <>
    <button ref={trigger} className="reading-directory-trigger" type="button" aria-controls={panelId} aria-expanded={open} onClick={() => setOpen(true)}>
      <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M7 5h10M7 10h10M7 15h10M3 5h.5M3 10h.5M3 15h.5" /></svg>课程目录
    </button>
    <div className="reading__backdrop" hidden={!open} onClick={() => setOpen(false)} />
    <aside ref={panel} id={panelId} className="reading__side" aria-labelledby={titleId} data-open={open || undefined}
      role={open ? "dialog" : undefined} aria-modal={open || undefined}
      onKeyDown={event => {
        if (!open || event.key !== "Tab" || !panel.current) return;
        const controls = [...panel.current.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), input:not(:disabled), [tabindex="0"]')].filter(control => control.getClientRects().length);
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}
      onClick={event => {
        // Selecting the current note needs no navigation, but should still return to reading.
        const link = (event.target as Element).closest("a[aria-current='page']");
        if (open && link && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.button === 0) setOpen(false);
      }}>
      <div className="reading-directory-head"><h2 id={titleId}>课程目录</h2><button type="button" className="icon-button" aria-label="关闭课程目录" onClick={() => setOpen(false)}><span aria-hidden="true">×</span></button></div>
      {children}
    </aside>
  </>;
}
