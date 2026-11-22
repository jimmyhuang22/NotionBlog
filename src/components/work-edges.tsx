import Link from "next/link";
import { rangeLabel } from "../lib/format.ts";
import { itemDate, type LibraryItem } from "../lib/library.ts";
import { Cover } from "./library-grid";
import { NeighbourKeys } from "./neighbour-keys";

/**
 * A game's neighbours also at the screen's edges and on the arrow keys (乙, 2026-11-22): a small handle on each side
 * that opens into a card under the pointer. They repeat the cards at the foot of the page, so they stay out of the
 * tab order and away from screen readers; the keys press those cards.
 */
export function WorkEdges({ newer, older, measure, timeZone }: { newer: LibraryItem | null; older: LibraryItem | null; measure: string; timeZone: string }) {
  const edge = (entry: LibraryItem, side: "prev" | "next") => (
    <Link prefetch={false} tabIndex={-1} className={`work__edge work__edge--${side}`} href={entry.href}>
      <span className="work__edge-arrow">{side === "prev" ? "‹" : "›"}</span>
      <span className="work__edge-body">
        <span className="work__edge-cover"><Cover image={entry.cover} title={entry.title} previewWidth={400} /></span>
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
      <div className="work__edges" aria-hidden="true">{newer ? edge(newer, "prev") : null}{older ? edge(older, "next") : null}</div>
      <NeighbourKeys />
    </>
  );
}
