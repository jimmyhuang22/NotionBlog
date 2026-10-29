import type { Post } from "../../contracts/content.ts";
import { dateParts, dayLabel } from "./format.ts";
import { runsBy } from "./runs.ts";

export interface PostGroup {
  key: string;
  /** The year, "日期未记录", or null when the list has no dates at all and needs no heading. */
  label: string | null;
  items: { post: Post; year: number | null; day: string | null }[];
}

/** Posts arrive newest first with undated ones last; year headings follow that order. */
export function postGroups(posts: readonly Post[], timeZone: string): PostGroup[] {
  const dated = posts.map(post => {
    const parts = post.publishedAt ? dateParts(post.publishedAt.start, post.publishedAt.precision, timeZone) : null;
    // The list shows the day only; the time of day belongs to short status entries, not articles.
    return { post, year: parts?.year ?? null, day: parts ? dayLabel({ ...parts, time: null }) : null };
  });
  const groups: PostGroup[] = runsBy(dated, ({ year }) => year === null ? { key: "unknown", label: "日期未记录" } : { key: String(year), label: String(year) });
  // A list with no dates at all needs no heading, as in the library (library-grid.tsx).
  if (groups.length === 1 && groups[0]!.key === "unknown") groups[0]!.label = null;
  return groups;
}
