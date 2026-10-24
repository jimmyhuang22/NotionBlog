"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { isCurrentSection, splitNav, type NavItem } from "../lib/nav.ts";
import { closeOnLeave, useMenuDismiss } from "./use-dismiss";

export type { NavItem };

/**
 * The header's sections. Hobby sections fold under "更多" once the row would hold more than fits a
 * phone. Folding is only for rows that cannot hold everything: on a wide screen the same entries
 * stand in the row and the menu is gone. Both sets are in the page and the stylesheet shows one, so
 * the server and the browser agree without knowing the width.
 */
export function NavLinks({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  // A Proxy rewrite can give SSR a different pathname from the browser URL.
  // Keep the first render identical; apply the section marker after mounting.
  const [clientPathname, setClientPathname] = useState("");
  // The section pressed, shown as current at the press while its page is on its way (F43).
  const [going, setGoing] = useState<string | null>(null);
  const selected = going ?? clientPathname;
  const { primary, more } = splitNav(items);
  const currentMore = more.find(item => isCurrentSection(selected, item.href));
  const [open, setOpen] = useState(false);
  const group = useRef<HTMLLIElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const nav = useRef<HTMLElement>(null);
  const mark = useRef<HTMLSpanElement>(null);

  // The ink stroke under the current section is one mark that moves (2026-10-20): it glides to a section
  // as soon as it is pressed (motion.css), once it has first been placed without moving.
  const at = going ?? pathname;
  useLayoutEffect(() => {
    const place = () => {
      const box = nav.current?.getBoundingClientRect();
      const current = items.find(item => isCurrentSection(at, item.href));
      const shown = [...(nav.current?.querySelectorAll<HTMLElement>(".site-nav__list > li > a, .site-nav__more > button") ?? [])]
        .find(element => element.offsetParent !== null && (current ? element.getAttribute("href") === current.href || (element.tagName === "BUTTON" && more.includes(current)) : false));
      if (!mark.current || !box) return;
      if (!shown) { mark.current.hidden = true; return; }
      const spot = shown.getBoundingClientRect();
      mark.current.hidden = false;
      mark.current.style.transform = `translate(${spot.left - box.left + spot.width / 2 - 13}px, ${spot.bottom - box.top - 11}px)`;
      const placed = mark.current;
      if (!placed.classList.contains("is-placed")) requestAnimationFrame(() => placed.classList.add("is-placed"));
    };
    place();
    const fonts = document.fonts?.ready.then(place);
    window.addEventListener("resize", place);
    return () => { window.removeEventListener("resize", place); void fonts; };
  }, [at, items, more]);

  // Following a link closes the menu; so do Escape (focus returns to the button) and a press outside.
  useEffect(() => { setClientPathname(pathname); setGoing(null); setOpen(false); }, [pathname]);
  useMenuDismiss(open, () => setOpen(false), group, button);

  const link = (item: NavItem) => <Link href={item.href} aria-current={isCurrentSection(selected, item.href) ? "page" : undefined}
    onClick={event => { if (!event.defaultPrevented && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.button === 0 && !isCurrentSection(pathname, item.href)) setGoing(item.href); }}>{item.label}</Link>;
  return (
    <nav ref={nav} className="site-nav" aria-label="主要导航">
      <span ref={mark} className="site-nav__mark" aria-hidden="true" hidden />
      <ul className="site-nav__list">
        {/* In the sections' own order: a folded one keeps its place and only shows on a wide screen. */}
        {items.map(item => <li key={item.href} className={more.includes(item) ? "site-nav__wide" : undefined}>{link(item)}</li>)}
        {more.length ? (
          // Tabbing past the last entry leaves the group, which closes it as well.
          <li className="site-nav__more" ref={group} onBlur={closeOnLeave(() => setOpen(false))}>
            <button type="button" ref={button} className={currentMore ? "is-current" : undefined} aria-expanded={open} aria-controls="site-nav-more" onClick={() => setOpen(!open)}>
              更多{currentMore ? <span className="visually-hidden">（当前：{currentMore.label}）</span> : null}
            </button>
            <ul id="site-nav-more" className="site-nav__menu" hidden={!open}>
              {more.map(item => <li key={item.href}>{link(item)}</li>)}
            </ul>
          </li>
        ) : null}
      </ul>
    </nav>
  );
}
