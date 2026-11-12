import type { ReactNode } from "react";
import { librarySections } from "../lib/library.ts";
import { sectionLoadingTitle } from "../lib/section-loading.ts";
import { worksPlatforms } from "../lib/works.ts";
import { WorksPlatformIcon } from "./works-platform-icon";
import { WorksWaiting } from "./works-shell";

/**
 * A section's loading state drawn as the section itself (design review 5, M-15: the placeholder is the
 * content's outline). Its head, the tools that need no data (status, platform and order switches, in place
 * but not yet pressable), and faint shapes of its list in the list's own proportions. The same drawing serves
 * the frame shown on the click (page-switch.tsx), the root loading state of a first visit (app/loading.tsx)
 * and the section's own loading state, so one move shows one shape only and nothing moves when the page
 * arrives. The year row depends on data and keeps only its height. Covers wait in the same breathing slot the
 * real cards use until their picture arrives.
 *
 * Returns null for an address without a drawing of its own; PageLoading then draws its plain bars.
 * `heading` replaces the title: page-switch.tsx clones a copy without one and writes the heading in itself.
 */
export function SectionWaiting({ path, heading }: { path: string; heading?: ReactNode }) {
  const title = sectionLoadingTitle(path);
  if (title === undefined) return null;
  const head = heading ?? <h1>{title}</h1>;
  const label = `正在加载${title}`;
  const library = path.startsWith("/library/") ? librarySections[path.slice("/library/".length)] : undefined;

  if (library) return (
    <div className="wrap page-loading" role="status" aria-label={label}>
      <header className="page-head library__head">
        {head}
        <div className="segmented" aria-hidden="true">
          {library.tabs.map(([value, name]) => <a key={value} aria-current={value === library.defaultStatus ? "true" : undefined}>{name}</a>)}
        </div>
      </header>
      <div className="library__filters" aria-hidden="true">
        <span className="skeleton waiting__years" />
        <SortShell label="最近" />
      </div>
      <section className="library__group" aria-hidden="true">
        <div className="section-title"><span className="skeleton skeleton--text" style={{ width: 64 }} /></div>
        <div className={`library__grid library__grid--${library.kind}`}>
          {Array.from({ length: 12 }, (_, index) => (
            <div key={index} className="library__item">
              <span className="library__cover"><span className="cover-slot"><span className="cover cover--empty cover--waiting" /></span></span>
              <span className="library__title"><span className="skeleton skeleton--text" style={{ width: "72%" }} /></span>
              <span className="library__meta"><span className="skeleton skeleton--text" style={{ width: "48%" }} /></span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );

  if (path === "/works") return (
    <div className="wrap works page-loading">
      <header className="page-head library__head">
        {head}
        <div className="works__tools" aria-hidden="true">
          <div className="segmented works__platforms">
            {worksPlatforms.map((entry, index) => <a key={entry.value} aria-current={index === 0 ? "true" : undefined}><WorksPlatformIcon platform={entry.value} />{entry.label}</a>)}
          </div>
          <SortShell label="最近" swap />
        </div>
      </header>
      <WorksWaiting platform={worksPlatforms[0]!.value} />
    </div>
  );

  if (path === "/status") return (
    <div className="wrap status-page page-loading" role="status" aria-label={label}>
      <header className="page-head status-head">{head}</header>
      <div className="library__filters status-filters" aria-hidden="true"><span className="skeleton waiting__years" /></div>
      {/* The real timeline's classes, so its line, dots and cards stand exactly where the entries will. */}
      <section className="timeline" aria-hidden="true">
        <div>
          <h2 className="timeline__month timeline__month--first"><span className="timeline__month-name"><span className="skeleton skeleton--text" style={{ width: 44 }} /></span> <span className="timeline__month-year"><span className="skeleton skeleton--text" style={{ width: 40 }} /></span></h2>
          {[{ width: 520, lines: [40, 94, 72] }, { width: 380, lines: [52, 88] }].map(card => (
            <div key={card.width} className="entry">
              <span className="entry__time"><span className="skeleton skeleton--text" style={{ width: 120 }} /></span>
              <div className="card entry__card" style={{ width: `min(100%, ${card.width}px)` }}>
                <div className="entry__card-body">{card.lines.map(width => <span key={width} className="skeleton waiting__line" style={{ width: `${width}%` }} />)}</div>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );

  if (path === "/photos") return (
    <div className="wrap page-loading" role="status" aria-label={label}>
      <header className="page-head">{head}</header>
      <div className="album-grid" aria-hidden="true">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="album-card">
            <span className="cover-slot"><span className="album-card__cover album-card__cover--empty cover--empty cover--waiting" /></span>
            <span className="album-card__title"><span className="skeleton skeleton--text" style={{ width: "58%" }} /></span>
            <span className="album-card__meta"><span className="skeleton skeleton--text" style={{ width: "34%" }} /></span>
          </div>
        ))}
      </div>
    </div>
  );

  if (path === "/search") return (
    <div className="wrap search page-loading" role="status" aria-label={label}>
      <header className="page-head">{head}</header>
      <div className="search__form" aria-hidden="true">
        <span className="search__submit"><svg aria-hidden="true" width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><circle cx="8" cy="8" r="5" /><path d="m12 12 3.5 3.5" /></svg></span>
        <input className="search__input" type="search" placeholder="搜标题和正文" disabled tabIndex={-1} />
      </div>
    </div>
  );

  return null;
}

/** The sections that have a drawing of their own; page-switch.tsx keeps a copy of each ready for the click. */
export const waitingSections = ["/status", "/works", "/photos", "/search", "/library/movies", "/library/books", "/library/games"] as const;

/** The order switch as it stands before anything is chosen: newest first. */
function SortShell({ label, swap = false }: { label: string; swap?: boolean }) {
  return (
    <div className="library__sort">
      <a><span className="library__sort-now">{label}<svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d={swap ? "M4 2v8M1.5 4.5 4 2l2.5 2.5M8 10V2M5.5 7.5 8 10l2.5-2.5" : "M6 2v8M2.5 6.5 6 10l3.5-3.5"} /></svg></span></a>
    </div>
  );
}
