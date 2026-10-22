"use client";

import { useParams } from "next/navigation";
import { librarySections } from "../lib/library.ts";

/**
 * A work's page while it is on its way, in the page's own shape: the cover in its place and
 * proportions, then the title and a few facts. It shows the moment a card is pressed (the cards
 * fetch this much on hover, focus or touch), so the press answers at once even when the page itself
 * takes a few seconds.
 */
export function LibraryDetailLoading() {
  const { type } = useParams<{ type: string }>();
  const kind = librarySections[type]?.kind ?? "movie";
  return (
    <div className="wrap page-loading" role="status" aria-label="正在加载">
      <nav className="crumbs" aria-hidden="true"><span className="skeleton work-loading__crumb" /></nav>
      <div className={`work work--${kind} work-loading`}>
        <div className="work__cover"><span className="skeleton cover work-loading__cover" /></div>
        <div className="work__info">
          <span className="skeleton work-loading__title" />
          {[42, 64, 56, 48].map(width => <span key={width} className="skeleton work-loading__line" style={{ width: `${width}%` }} />)}
        </div>
      </div>
    </div>
  );
}
