import type { ContentKind, ListQuery, LibraryKind, LibraryYearsQuery } from "../../../contracts/content.ts";
import { ContentServiceError } from "../../../contracts/repository.ts";
import { isLibraryKind, supportsYear } from "./years.ts";

const orders = new Set(["date-desc", "date-asc", "title-asc"]);
const statuses: Partial<Record<ContentKind, readonly string[]>> = {
  book: ["reading", "read", "wishlist", "given-up", "unknown"],
  movie: ["watched", "wishlist", "unknown"],
  game: ["platinumed", "clear", "playing", "wishlist", "unknown", "completed"],
};

function invalid(message: string): never {
  throw new ContentServiceError("INVALID_QUERY", message);
}

function allowedKeys(kind: ContentKind): Set<string> {
  const keys = new Set(["cursor", "limit", "tag", "order"]);
  if (statuses[kind]) keys.add("status");
  if (kind === "movie") keys.add("type");
  if (kind === "game") keys.add("platform");
  if (kind === "course") keys.add("semester");
  if (supportsYear(kind)) keys.add("year");
  return keys;
}

/** Validate repository callers as well as HTTP callers; no unsupported filters are ignored. */
export function validateListQuery(kind: ContentKind, query: ListQuery): void {
  if (!query || typeof query !== "object" || Array.isArray(query)) {
    invalid("Expected a query object.");
  }
  const allowed = allowedKeys(kind);
  for (const [key, value] of Object.entries(query)) {
    if (!allowed.has(key)) invalid("Filter not supported for this content kind.");
    if (value === undefined) continue;
    if (key === "limit") {
      if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 50) {
        invalid("limit must be an integer from 1 to 50.");
      }
    } else if (key === "year") {
      if (value !== "undated" && (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 9999)) {
        invalid("year must be an integer from 1 to 9999, or undated.");
      }
    } else if (
      typeof value !== "string" || value.trim() !== value || value.length === 0 ||
      value.length > (key === "cursor" ? 1024 : 256) || /[\u0000-\u001f\u007f]/.test(value)
    ) {
      invalid("Expected a non-empty query string within the supported length.");
    }
  }
  if (query.order !== undefined && !orders.has(query.order)) invalid("Invalid ordering.");
  if (query.status !== undefined && !statuses[kind]?.includes(query.status)) {
    invalid("Invalid status filter.");
  }
}

export function parseListQuery(kind: ContentKind, params: URLSearchParams): ListQuery {
  const result: Record<string, string | number> = {};
  const allowed = allowedKeys(kind);
  for (const [key, value] of params) {
    if (!allowed.has(key)) invalid("Filter not supported for this content kind.");
    if (Object.hasOwn(result, key)) invalid("Query parameters must not be repeated.");
    if (key === "limit") {
      if (!/^[1-9][0-9]*$/.test(value)) invalid("limit must be an integer from 1 to 50.");
      result.limit = Number(value);
    } else if (key === "year" && value !== "undated") {
      if (!/^[1-9][0-9]{0,3}$/.test(value)) invalid("Invalid year filter.");
      result.year = Number(value);
    } else {
      result[key] = value;
    }
  }
  const query = result as ListQuery;
  validateListQuery(kind, query);
  return query;
}

export function validateLibraryYearsQuery(kind: LibraryKind, query: LibraryYearsQuery): void {
  if (!isLibraryKind(kind)) invalid("Library years are not supported for this content kind.");
  validateListQuery(kind, query);
  if (Object.keys(query).some(key => key !== "status")) invalid("Library year summaries only support status.");
}
export function parseLibraryYearsQuery(kind: LibraryKind, params: URLSearchParams): LibraryYearsQuery {
  const query = parseListQuery(kind, params);
  validateLibraryYearsQuery(kind, query);
  return query;
}
