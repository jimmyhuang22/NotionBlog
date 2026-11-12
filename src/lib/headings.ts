import type { TableOfContentsEntry } from "../../contracts/content.ts";

export type HeadingTag = "h2" | "h3" | "h4" | "h5" | "h6";

/**
 * How far a body's source heading levels move so its shallowest heading becomes `top`. Writers
 * often start at level 2 or 3; the outline should still continue directly from the heading above
 * the body. Sizes follow the source level through a class, so this changes structure, not looks.
 */
export function headingShift(toc: TableOfContentsEntry[], top: number): number {
  return top - toc.reduce((shallowest, entry) => Math.min(shallowest, entry.level), toc.length ? 3 : 1);
}

/** The page title owns h1, and there is nothing below h6. */
export function headingTag(level: number, shift: number): HeadingTag {
  return `h${Math.min(6, Math.max(2, level + shift))}` as HeadingTag;
}

/** An outline entry; `covers` lists headings folded into it, which count as reading this entry. */
export type OutlineEntry = TableOfContentsEntry & { covers?: string[] };

/** A heading that is only a number, as when "1." and its title were written as two headings. */
const NUMBER_ONLY = /^[\s\p{P}]*[\d一二三四五六七八九十百]+(?:[\s\p{P}]*[\d一二三四五六七八九十百]+)*[\s\p{P}]*$/u;

/**
 * The outline as a reader wants it (design review 5, X-15): a heading that is only a number joins the heading
 * right after it ("1." and "Datalink Layer" become "1. Datalink Layer"), and the entry leads to the number, where
 * the chapter starts. The heading folded in is listed in `covers`, so following along still marks this entry.
 * A number with nothing after it, or followed by another number, stays as it is.
 */
export function mergeNumberedHeadings(toc: TableOfContentsEntry[]): OutlineEntry[] {
  const merged: OutlineEntry[] = [];
  for (let index = 0; index < toc.length; index++) {
    const entry = toc[index]!;
    const next = toc[index + 1];
    if (NUMBER_ONLY.test(entry.title) && next && !NUMBER_ONLY.test(next.title)) {
      merged.push({ id: entry.id, title: `${entry.title.trim()} ${next.title.trim()}`, level: Math.min(entry.level, next.level) as TableOfContentsEntry["level"], covers: [next.id] });
      index++;
    } else merged.push(entry);
  }
  return merged;
}
