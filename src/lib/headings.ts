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
