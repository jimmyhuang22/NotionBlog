import type { LibraryKind } from "../../../contracts/content.ts";

const notionId = /^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/iu;

export function isLibraryTitleSlug(slug: string): boolean {
  return [...slug].length <= 96 && !notionId.test(slug)
    && /^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u.test(slug);
}

/** Next can pass an encoded path segment to the page while route qualification
 * receives the decoded segment. Both must look up the same stored name. */
export function readLibraryTitleSlug(segment: string): string | null {
  try {
    const decoded = decodeURIComponent(segment);
    return isLibraryTitleSlug(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

export function libraryDetailHref(kind: LibraryKind, slug: string): string {
  return `/library/${kind === "movie" ? "movies" : `${kind}s`}/${encodeURIComponent(slug)}`;
}
