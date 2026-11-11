import type { LibraryKind, ListQuery } from "../../../contracts/content.ts";
import { ContentServiceError, type ContentRepository, type LibraryPageResult } from "../../../contracts/repository.ts";
import { hasYear } from "../year-filter.ts";
import { isLibraryKind } from "./years.ts";
import { validateListQuery } from "./query.ts";

/** Choose the capability before loading. A live reader failure is never retried
 * through a cached or less strict adapter. Legacy providers retain their path. */
export async function readLibraryFirstPageFrom<K extends LibraryKind>(
  live: ContentRepository, legacy: ContentRepository, kind: K, query: ListQuery = {},
): Promise<LibraryPageResult<K>> {
  if (!isLibraryKind(kind)) throw new ContentServiceError("INVALID_QUERY", "Unsupported library kind.");
  validateListQuery(kind, query);
  if (live.readLibraryPage) return live.readLibraryPage(kind, query);
  const [first, years] = await Promise.all([
    legacy.list(kind, query),
    legacy.getLibraryYears?.(kind, query.status ? { status: query.status } : {}).catch(() => null) ?? null,
  ]);
  const asked = query.year ?? null, year = years && !hasYear(years, asked) ? null : asked;
  const fallback = { ...query }; delete fallback.year;
  return { page: year === asked ? first : await legacy.list(kind, fallback), years, year };
}
