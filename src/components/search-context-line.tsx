import type { SearchContext } from "../../contracts/website.ts";

/** Display text inside the existing result link, without adding nested navigation. */
export function SearchContextLine({ context }: { context?: SearchContext | null }) {
  if (!context) return null;
  return <span className="search-context"><span className="search-context__course">{context.courseLabel}</span>{context.parentLabels.map((label, index) => <span key={index}><span aria-hidden="true"> › </span>{label}</span>)}</span>;
}
