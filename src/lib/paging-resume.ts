import type { Page } from "../../contracts/content.ts";

export interface PageResult<T> { page?: Page<T>; code?: string }

/** Where a refused "load more" ends up: picked up after the last row on screen, unable to find it, or failed. */
export type Resumed<T> =
  | { kind: "resumed"; added: T[]; page: Page<T> }
  | { kind: "lost" }
  | { kind: "error"; code: string };

/**
 * Finds the reader's place again after the list changed under its cursor. The list is read afresh
 * from the top, a page at a time, until the last row on screen is met; what follows it and is not on
 * screen yet is what the reader asked for. Rows added above, and changes to rows already shown, are
 * left for the next visit, so nothing on screen moves. Gives up ("lost") when that row is no longer in
 * the list, when the list changes again on the way, or after `maxRequests` reads.
 */
export async function resumeAfter<T extends { id: string }>(shown: readonly T[], read: (cursor: string | null) => Promise<PageResult<T>>, maxRequests: number): Promise<Resumed<T>> {
  const last = shown.at(-1)?.id;
  if (last === undefined) return { kind: "lost" };
  const seen = new Set(shown.map(item => item.id));
  const added: T[] = [];
  let cursor: string | null = null, passed = false;
  for (let request = 0; request < maxRequests; request++) {
    const result = await read(cursor);
    if (!result.page) return result.code === "INVALID_QUERY" ? { kind: "lost" } : { kind: "error", code: result.code ?? "CONTENT_UNAVAILABLE" };
    const page = result.page;
    for (const item of page.items) {
      if (passed) { if (!seen.has(item.id)) added.push(item); }
      else if (item.id === last) passed = true;
    }
    const end = !page.hasMore || page.nextCursor === null;
    if (passed && (added.length > 0 || end)) return { kind: "resumed", added, page };
    if (end) return { kind: "lost" };
    cursor = page.nextCursor;
  }
  return { kind: "lost" };
}

/** How many reads finding the place may take: enough to pass what is on screen and one page more, never more than ten. */
export function resumeBudget(shown: number, pageSize: number): number {
  return Math.min(10, Math.ceil(shown / Math.max(1, pageSize)) + 2);
}
