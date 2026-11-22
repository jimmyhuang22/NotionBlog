import Link from "next/link";
import { rangeLabel } from "../lib/format.ts";
import { itemDate, type LibraryItem } from "../lib/library.ts";
import { Cover } from "./library-grid";
import { NeighbourKeys } from "./neighbour-keys";

/**
 * A game's neighbours at the screen's edges and on the arrow keys (乙, 2026-11-22): a small handle on each side that
 * opens into a card under the pointer or the keyboard's focus. Where the handles show (wide windows with a pointer
 * that hovers), they replace the cards at the foot of the page (2026-11-23, the owner's call); everywhere else the
 * cards stay and the handles are not drawn. The stylesheet shows one of the two, so a screen reader or the Tab key
 * meets the neighbours once.
 */
export function WorkEdges({ newer, older, measure, timeZone }: { newer: LibraryItem | null; older: LibraryItem | null; measure: string; timeZone: string }) {
  const edge = (entry: LibraryItem, side: "prev" | "next") => (
    <Link prefetch={false} className={`work__edge work__edge--${side}`} href={entry.href}>
      <span className="work__edge-arrow" aria-hidden="true">{side === "prev" ? "‹" : "›"}</span>
      <span className="work__edge-body">
        <span className="work__edge-cover" aria-hidden="true"><Cover image={entry.cover} title={entry.title} previewWidth={400} /></span>
        <span className="work__edge-text">
          <small>{side === "prev" ? <><kbd>←</kbd> 上一{measure}</> : <>下一{measure} <kbd>→</kbd></>}</small>
          <b>{entry.title}</b>
          <small>{rangeLabel(itemDate(entry), timeZone) ?? "日期未记录"}</small>
        </span>
      </span>
    </Link>
  );
  return (
    <>
      <nav className="work__edges" aria-label={`上一${measure}和下一${measure}`}>{newer ? edge(newer, "prev") : null}{older ? edge(older, "next") : null}</nav>
      <NeighbourKeys />
    </>
  );
}
