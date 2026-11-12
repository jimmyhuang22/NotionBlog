"use client";

import { Suspense, useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import type { OutlineEntry } from "../lib/headings.ts";
import { CourseTreeNav } from "./course-tree";
import { DirectoryRetry } from "./directory-retry";
import { markArrival, useCurrentHeading } from "./reading-outline";
import { useStudyReadingTree } from "./study-reading-context";
import { closeOnBackdrop, useModal } from "./use-dismiss";

/** An article shorter than this many screens is read without help. */
const LONG_SCREENS = 2.5;
/** A single heading is no outline. */
const FEWEST = 2;
/** From here the course directory stands beside the note (study.css), so the sheet needs no course tab. */
const COURSE_COLUMN = "(min-width: 1100px)";
/** From here the outline opens as a small panel growing from its button instead of a sheet from the foot (X-17). */
const PANEL = "(min-width: 700px)";

type Tab = "page" | "course";

/**
 * The outline of a long note, opened where the reader is (the owner's choice, 2026-11-11). Where the outline
 * does not stand beside the article (below 1180, study.css), a button appears once the outline at the top has
 * gone out of view: it names the chapter being read and opens the same list. On a phone it is a sheet that
 * slides up whole from the foot of the screen; from 700 a panel grows up from the button with no shade behind
 * it (design review 5, M-17 and X-17). Below 1100, where the course directory is not on screen, the sheet
 * has a second tab with the course directory, so the reader can change notes from the middle of one (X-16).
 * Picking a chapter closes it, brings that heading under the header and puts focus on it; Escape, the close
 * button or a press outside leave the page where it was, focus back on the button. A short note, or one with
 * a single heading, never shows it.
 */
export function PageOutline({ toc }: { toc: OutlineEntry[] }) {
  const [active] = useCurrentHeading(toc);
  const [shown, setShown] = useState(false);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("page");
  const [courseTab, setCourseTab] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const tabsId = useId();
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

  // The course tab only where the course directory is not already on screen.
  useEffect(() => {
    const column = window.matchMedia(COURSE_COLUMN);
    const settle = () => { setCourseTab(!column.matches); if (column.matches) setTab("page"); };
    settle();
    column.addEventListener("change", settle);
    return () => column.removeEventListener("change", settle);
  }, []);

  // Another note, or a width where the outline stands beside the article: an open sheet has no place any more.
  useEffect(() => { if (!shown) dialog.current?.close(); }, [shown]);
  useEffect(() => {
    const element = dialog.current;
    return () => element?.close();
  }, [toc]);

  // The panel grows from the button: it stands just above it, on the button's side of the screen.
  function place() {
    const element = dialog.current, opener = button.current;
    if (!element || !opener) return;
    const box = opener.getBoundingClientRect();
    element.style.setProperty("--from-bottom", `${window.innerHeight - box.top + 8}px`);
    element.style.setProperty("--from-left", `${box.left}px`);
    element.style.setProperty("--from-right", `${document.documentElement.clientWidth - box.right}px`);
    element.dataset.side = box.left + box.width / 2 > window.innerWidth / 2 ? "right" : "left";
  }

  // The current chapter is in view when the sheet opens, however long the list.
  useEffect(() => {
    if (open && tab === "page") dialog.current?.querySelector<HTMLElement>('[aria-current="location"]')?.scrollIntoView({ block: "nearest" });
  }, [open, tab]);

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

  // The tabs follow the arrow keys, as a tab list does; Tab moves on to the open panel.
  function turn(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const next: Tab = event.key === "Home" ? "page" : event.key === "End" ? "course" : tab === "page" ? "course" : "page";
    setTab(next);
    dialog.current?.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)?.focus();
  }

  if (toc.length < FEWEST) return null;
  const base = Math.min(...toc.map(entry => entry.level));
  const current = toc.find(entry => entry.id === active);
  const tabs = courseTab;
  return (
    <>
      <button ref={button} type="button" className="page-outline__open" hidden={!shown} aria-haspopup="dialog" aria-expanded={open}
        aria-label={current ? `本页目录，当前章节：${current.title}` : "本页目录"} onClick={() => { place(); setTab("page"); setOpen(true); }}>
        <svg aria-hidden="true" width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M6.5 4.5h8M6.5 9h8M6.5 13.5h8M3.2 4.5h.1M3.2 9h.1M3.2 13.5h.1" /></svg>
        <span className="page-outline__label">本页目录{current ? <span className="page-outline__current">{current.title}</span> : null}</span>
      </button>
      <dialog ref={dialog} className="page-outline" aria-labelledby={titleId} onClick={closeOnBackdrop} onClose={() => setOpen(false)}>
        <div className="page-outline__sheet">
          <div className="page-outline__head">
            {tabs ? (
              <>
                <h2 id={titleId} className="visually-hidden">目录</h2>
                <div className="page-outline__tabs" role="tablist" aria-label="目录">
                  {(["page", "course"] as const).map(value => (
                    <button key={value} type="button" role="tab" data-tab={value} id={`${tabsId}-${value}`} aria-controls={`${tabsId}-${value}-panel`}
                      aria-selected={tab === value} tabIndex={tab === value ? 0 : -1} onClick={() => setTab(value)} onKeyDown={turn}>
                      {value === "page" ? "本页" : "课程"}
                    </button>
                  ))}
                </div>
              </>
            ) : <h2 id={titleId}>本页目录</h2>}
            <button type="button" className="page-outline__close" aria-label="关闭目录" onClick={() => dialog.current?.close()}>
              <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M4 4l8 8M12 4l-8 8" /></svg>
            </button>
          </div>
          <nav aria-label="本页章节" hidden={tab !== "page"} {...(tabs ? { id: `${tabsId}-page-panel`, role: "tabpanel", "aria-labelledby": `${tabsId}-page` } : {})}>
            <ul className="page-outline__list">
              {toc.map(entry => (
                <li key={entry.id} className={`page-outline__item page-outline__item--${Math.min(entry.level - base + 1, 3)}`}>
                  <a href={`#${entry.id}`} aria-current={entry.id === active ? "location" : undefined} onClick={event => pick(event, entry.id)}>{entry.title}</a>
                </li>
              ))}
            </ul>
          </nav>
          {tabs && tab === "course" ? (
            <div className="page-outline__course" id={`${tabsId}-course-panel`} role="tabpanel" aria-labelledby={`${tabsId}-course`}
              onClick={event => {
                // The note being read needs no move; choosing it still goes back to reading.
                if ((event.target as Element).closest("a[aria-current='page']")) dialog.current?.close();
              }}>
              <Suspense fallback={<div className="state" role="status"><p>正在加载课程目录，请稍候…</p></div>}>
                <CourseDirectory />
              </Suspense>
            </div>
          ) : null}
        </div>
      </dialog>
    </>
  );
}

/** The same course directory as the drawer's, from the course layout's one read of it (no read of its own). */
function CourseDirectory() {
  const tree = useStudyReadingTree();
  if (!tree) return <DirectoryRetry />;
  return tree.nodes.length ? <CourseTreeNav nodes={tree.nodes} /> : <div className="state"><p>这门课还没有笔记。</p></div>;
}
