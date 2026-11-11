"use client";

import { useEffect, useId, useRef, useState, type MouseEvent } from "react";
import type { TableOfContentsEntry } from "../../contracts/content.ts";
import { markArrival, useCurrentHeading } from "./reading-outline";
import { closeOnBackdrop, useModal } from "./use-dismiss";

/** An article shorter than this many screens is read without help. */
const LONG_SCREENS = 2.5;
/** A single heading is no outline. */
const FEWEST = 2;

/**
 * The outline of a long note, opened where the reader is (the owner's choice, 2026-11-11). Where the outline
 * does not stand beside the article (below 1180, study.css), a button appears once the outline at the top has
 * gone out of view: it names the chapter being read and opens the same list as a sheet from the bottom. Picking
 * a chapter closes the sheet, brings that heading under the header and puts focus on it; Escape, the close
 * button or the backdrop leave the page where it was, focus back on the button. A short note, or one with a
 * single heading, never shows it. It is not the course directory, which lists the other notes.
 */
export function PageOutline({ toc }: { toc: TableOfContentsEntry[] }) {
  const [active] = useCurrentHeading(toc);
  const [shown, setShown] = useState(false);
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useModal(dialog, open);

  useEffect(() => {
    if (toc.length < FEWEST) return;
    let frame = 0;
    const read = () => {
      frame = 0;
      const article = document.querySelector(".reading__article");
      const top = document.querySelector(".toc-drawer");
      const side = document.querySelector(".reading__toc");
      if (!article || !top) { setShown(false); return; }
      const header = Math.max(0, document.querySelector(".site-header")?.getBoundingClientRect().bottom ?? 0);
      const box = article.getBoundingClientRect();
      setShown(
        // The outline beside the article is showing: nothing to add.
        !side?.getClientRects().length
        && box.height > window.innerHeight * LONG_SCREENS
        && top.getBoundingClientRect().bottom < header
        // At the article's end the button would sit on its last lines and the links after it.
        && box.bottom > window.innerHeight,
      );
    };
    const update = () => { frame ||= requestAnimationFrame(read); };
    read();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    // Pictures arriving late make the article longer.
    const sizes = new ResizeObserver(update);
    const article = document.querySelector(".reading__article");
    if (article) sizes.observe(article);
    return () => { window.removeEventListener("scroll", update); window.removeEventListener("resize", update); sizes.disconnect(); cancelAnimationFrame(frame); };
  }, [toc]);

  // Another note, or a width where the outline stands beside the article: an open sheet has no place any more.
  useEffect(() => { if (!shown) dialog.current?.close(); }, [shown]);
  useEffect(() => {
    const element = dialog.current;
    return () => element?.close();
  }, [toc]);

  // The current chapter is in view when the sheet opens, however long the list.
  useEffect(() => {
    if (open) dialog.current?.querySelector<HTMLElement>('[aria-current="location"]')?.scrollIntoView({ block: "nearest" });
  }, [open]);

  function pick(event: MouseEvent<HTMLAnchorElement>, id: string) {
    event.preventDefault();
    const element = dialog.current;
    // After the sheet has let go of the page (its own close handler runs first), so the page can move again.
    const go = () => {
      const heading = document.getElementById(id);
      if (!heading) return;
      const header = Math.max(0, document.querySelector(".site-header")?.getBoundingClientRect().bottom ?? 0);
      if (location.hash !== `#${id}`) history.pushState(null, "", `#${id}`);
      // The page's own scroll behaviour decides between a glide and a jump (none with reduced motion).
      window.scrollTo({ top: heading.getBoundingClientRect().top + window.scrollY - header - 16 });
      if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
      heading.focus({ preventScroll: true });
      markArrival(id);
    };
    if (element?.open) { element.addEventListener("close", go, { once: true }); element.close(); } else go();
  }

  if (toc.length < FEWEST) return null;
  const base = Math.min(...toc.map(entry => entry.level));
  const current = toc.find(entry => entry.id === active);
  return (
    <>
      <button type="button" className="page-outline__open" hidden={!shown} aria-haspopup="dialog" aria-expanded={open}
        aria-label={current ? `本页目录，当前章节：${current.title}` : "本页目录"} onClick={() => setOpen(true)}>
        <svg aria-hidden="true" width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M6.5 4.5h8M6.5 9h8M6.5 13.5h8M3.2 4.5h.1M3.2 9h.1M3.2 13.5h.1" /></svg>
        <span className="page-outline__label">本页目录{current ? <span className="page-outline__current">{current.title}</span> : null}</span>
      </button>
      <dialog ref={dialog} className="page-outline" aria-labelledby={titleId} onClick={closeOnBackdrop} onClose={() => setOpen(false)}>
        <div className="page-outline__sheet">
          <div className="page-outline__head">
            <h2 id={titleId}>本页目录</h2>
            <button type="button" className="page-outline__close" aria-label="关闭本页目录" onClick={() => dialog.current?.close()}>
              <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M4 4l8 8M12 4l-8 8" /></svg>
            </button>
          </div>
          <nav aria-label="本页章节">
            <ul className="page-outline__list">
              {toc.map(entry => (
                <li key={entry.id} className={`page-outline__item page-outline__item--${Math.min(entry.level - base + 1, 3)}`}>
                  <a href={`#${entry.id}`} aria-current={entry.id === active ? "location" : undefined} onClick={event => pick(event, entry.id)}>{entry.title}</a>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </dialog>
    </>
  );
}
