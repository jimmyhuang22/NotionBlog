"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { OutlineEntry } from "../lib/headings.ts";
import { prefersReducedMotion } from "../lib/dom.ts";

/**
 * The heading the reader is in: the last one above the line under the header, else the first. Shared by the
 * outline beside the article and the one opened from its button (page-outline.tsx). Only one of the two is on
 * screen at a time, so each follows the reading only while `enabled`; the other measures nothing as the page scrolls.
 */
export function useCurrentHeading(toc: OutlineEntry[], enabled = true) {
  const [active, setActive] = useState("");
  useEffect(() => {
    if (!enabled) return;
    // A heading folded into an entry (a number and its title, X-15) counts as reading that entry.
    const owner = new Map<Element, string>();
    const headings = toc.flatMap(entry => [entry.id, ...entry.covers ?? []].flatMap(id => {
      const element = document.getElementById(id);
      if (element) owner.set(element, entry.id);
      return element ? [element] : [];
    }));
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const header = document.querySelector(".site-header");
        const threshold = Math.max(0, header?.getBoundingClientRect().bottom ?? 0) + 40;
        const visible = headings.filter(heading => heading.getClientRects().length);
        const passed = visible.filter(heading => heading.getBoundingClientRect().top <= threshold);
        const heading = passed.at(-1) ?? visible[0];
        setActive(heading ? owner.get(heading) ?? "" : "");
      });
    };
    // Read once a frame while scrolling, against the one line above: an observer's fixed margin cannot follow a header
    // that is pinned on some skins and widths and scrolls away on others, and left the mark a chapter behind.
    // Setting the same id again does not render anything.
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    window.addEventListener("hashchange", update);
    update();
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      window.removeEventListener("hashchange", update);
      cancelAnimationFrame(frame);
    };
  }, [toc, enabled]);
  return [active, setActive] as const;
}

/** A chapter reached from an outline is marked once under its heading, so the eye knows where it landed. */
export function markArrival(id: string) {
  const heading = document.getElementById(id);
  if (!heading || prefersReducedMotion()) return;
  heading.classList.remove("is-arrived");
  void heading.offsetWidth;
  heading.classList.add("is-arrived");
  heading.addEventListener("animationend", () => heading.classList.remove("is-arrived"), { once: true });
}

/** The outline follows the article, showing detail only for the current chapter. */
export function ReadingOutline({ toc }: { toc: OutlineEntry[] }) {
  // The outline beside the article is hidden below its width (study.css); while hidden it follows nothing.
  const [onScreen, setOnScreen] = useState(false);
  const [active, setActive] = useCurrentHeading(toc, onScreen);
  const [expanded, setExpanded] = useState(false);
  const base = Math.min(...toc.map(entry => entry.level));
  const current = toc.findIndex(entry => entry.id === active);
  let chapter = 0;
  for (let i = 0; i <= current; i++) if (toc[i]?.level === base) chapter = i;


  // The current chapter's mark slides along the outline instead of jumping (2026-10-20); placed without motion the first time.
  const list = useRef<HTMLUListElement>(null);
  const mark = useRef<HTMLLIElement>(null);
  useEffect(() => {
    const element = list.current;
    if (!element) return;
    // A hidden list has no size: the observer reports when it is shown or hidden as the window changes width.
    const sizes = new ResizeObserver(() => setOnScreen(element.getClientRects().length > 0));
    sizes.observe(element);
    return () => sizes.disconnect();
  }, []);
  useLayoutEffect(() => {
    const link = list.current?.querySelector<HTMLElement>("a[aria-current]");
    if (!list.current || !mark.current) return;
    if (!link) { delete list.current.dataset.mark; return; }
    mark.current.style.transition = list.current.dataset.mark === undefined ? "none" : "";
    mark.current.style.height = `${link.offsetHeight}px`;
    mark.current.style.transform = `translateY(${link.offsetTop}px)`;
    list.current.dataset.mark = "";
  }, [active, expanded, chapter]);
  function arrive(id: string) {
    setActive(id);
    markArrival(id);
  }

  let owner = 0;
  return <>
    <div className="reading__toc-head"><p className="eyebrow">本页目录</p>{toc.some(entry => entry.level > base) ? <button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? "收起" : "展开全部"}</button> : null}</div>
    <ul ref={list} className="toc reading-outline">
      <li ref={mark} className="reading-outline__mark" aria-hidden="true" />
      {toc.map((entry, index) => {
        if (entry.level === base) owner = index;
        return <li key={entry.id} className={`toc__item toc__item--${entry.level - base + 1}`} hidden={!expanded && entry.level > base && owner !== chapter}>
          <a href={`#${entry.id}`} aria-current={entry.id === active ? "location" : undefined} onClick={() => arrive(entry.id)}>{entry.title}</a>
        </li>;
      })}
    </ul>
  </>;
}
