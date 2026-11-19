import Link from "next/link";
import type { NavItem } from "../lib/nav.ts";

/** The search field as the search page draws it, sending to /search. */
export function SearchField({ autoFocus = false }: { autoFocus?: boolean }) {
  return (
    <form className="search__form" role="search" action="/search" method="get">
      <button type="submit" className="search__submit" aria-label="搜索">
        <svg aria-hidden="true" width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><circle cx="8" cy="8" r="5" /><path d="m12 12 3.5 3.5" /></svg>
      </button>
      <input className="search__input" type="search" name="q" maxLength={128} placeholder="搜标题和正文" aria-label="搜索内容" autoComplete="off" enterKeyHint="search" autoFocus={autoFocus} />
    </form>
  );
}

/** The site's sections as a row of quiet links (2026-11-19: the empty search page and the 404 page). */
export function SectionLinks({ items, home = false, label }: { items: NavItem[]; home?: boolean; label: string }) {
  const links = home ? [{ href: "/", label: "首页" }, ...items] : items;
  return (
    <nav className="section-links" aria-label={label}>
      {links.map(item => <Link key={item.href} className="section-links__item" href={item.href} prefetch={false}>{item.label}</Link>)}
    </nav>
  );
}
