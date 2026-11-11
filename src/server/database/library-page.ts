import { isDeepStrictEqual } from "node:util";
import type { AnyContent, ContentByKind, LibraryKind, LibraryYears, ListQuery } from "../../../contracts/content.ts";
import { ContentServiceError, type LibraryPageResult } from "../../../contracts/repository.ts";
import { WEBSITE_SCHEMA_DIGEST } from "../../../contracts/website-sync.ts";
import protocol from "../../../database/library-page-protocol.json" with { type: "json" };
import { hasYear } from "../../lib/year-filter.ts";
import { GAME_DATE_POLICY } from "../../lib/content/game-date.ts";
import { validateListQuery } from "../../lib/content/query.ts";
import { statusTimeZone, type StatusReadOptions } from "../../lib/content/status.ts";
import { isLibraryKind, libraryYears } from "../../lib/content/years.ts";
import { compareContent, matchesContent, pageOf } from "../../lib/content/website.ts";
import { checkContentReadBudget } from "../content-read-budget.ts";
import { applyDeliveryHints, validateDeliveryHints, type DeliveryHints, type PrepareLibraryDelivery } from "./library-display.ts";
import { projectWebsiteContent as project, type Projection } from "./website-repository.ts";
import { callSql, type SqlExecutor } from "./sql.ts";
import type { PublicationMode } from "./publication.ts";

export const LIBRARY_SELECTORS_SQL = "SELECT nb_library_api.read_selectors($1,$2,$3) AS result";
export const LIBRARY_SELECTED_SQL = "SELECT nb_library_api.read_selected($1,$2,$3::text[],$4::uuid,$5::bigint,$6,$7) AS result";
interface LibraryProjection extends Projection { viewFingerprint: string; hasMore: false }
export interface LibraryReadOptions extends StatusReadOptions {
  mode: PublicationMode;
  prepareDelivery?: PrepareLibraryDelivery;
  /** Pure optional computation; its failure must never swallow a reader failure. */
  computeYears?: typeof libraryYears;
}
export function readLibraryPageMode(value: string | undefined): boolean {
  if (value === undefined || value === "" || value === "legacy") return false;
  if (value === "compact") return true;
  throw new ContentServiceError("MISCONFIGURED", "Invalid library page mode.");
}
const unavailable = (): never => { throw new ContentServiceError("CONTENT_UNAVAILABLE", "Invalid library content projection."); };
const changed = (): never => { throw new ContentServiceError("INVALID_QUERY", "Content changed during library reading. Restart pagination."); };
function validateProjection(p: LibraryProjection, kind: LibraryKind, max: number): LibraryProjection {
  if (!p || p.schemaDigest !== WEBSITE_SCHEMA_DIGEST || typeof p.runId !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(p.runId) ||
    typeof p.revision !== "string" || !/^\d{1,20}$/.test(p.revision) || typeof p.viewFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(p.viewFingerprint) ||
    !Array.isArray(p.records) || p.records.length > max || !Array.isArray(p.links) || !Array.isArray(p.mediaIds) || p.hasMore !== false ||
    p.links.some(x => typeof x !== "string") || p.mediaIds.some(x => typeof x !== "string") ||
    p.records.some(d => !d?.item || d.item.kind !== kind || typeof d.item.id !== "string" || typeof d.item.slug !== "string" || d.document !== null) ||
    new Set(p.records.map(d => d.item.id)).size !== p.records.length || new Set(p.records.map(d => d.item.slug)).size !== p.records.length ||
    Buffer.byteLength(JSON.stringify(p)) > 16 * 1024 * 1024) unavailable();
  return p;
}
const fields = {
  movie: ["status", "mediaType", "watchedDate"], book: ["status", "readingDate"],
  game: ["status", "platforms", "playedDate", "lastPlayedDate", "firstPlayedDate", "archiveDate"],
};
function selectorOf(item: AnyContent) {
  const o = item as unknown as Record<string, unknown>;
  return Object.fromEntries(["id", "kind", "slug", "href", "title", "tags", ...fields[item.kind as LibraryKind]]
    .filter(key => Object.hasOwn(o, key)).map(key => [key, o[key]]));
}

/** Request-local selectors, followed by fresh full authorization and selected
 * metadata. No completed-result cache, retry, transaction, or error fallback. */
export function createLibraryPageReader(db: SqlExecutor, options: LibraryReadOptions) {
  if (!["qualified", "published"].includes(options.mode)) throw new ContentServiceError("MISCONFIGURED", "Invalid library publication mode.");
  return async function readLibraryPage<K extends LibraryKind>(kind: K, query: ListQuery = {}): Promise<LibraryPageResult<K>> {
    checkContentReadBudget();
    if (!isLibraryKind(kind)) throw new ContentServiceError("INVALID_QUERY", "Unsupported library kind.");
    validateListQuery(kind, query);
    const zone = statusTimeZone(options), mode = options.mode;
    const pin = validateProjection(await callSql<LibraryProjection>(db, LIBRARY_SELECTORS_SQL, [mode, kind, protocol.migration.sha256]), kind, 20000);
    const selectors = project(pin.records, pin, zone);
    const yearItems = selectors.map(d => d.item).filter(item => matchesContent(item, query.status ? { status: query.status } : {}, zone));
    let years: LibraryYears | null = null;
    try {
      years = (options.computeYears ?? libraryYears)(yearItems, zone);
      if (!years || years.timeZone !== zone || !Array.isArray(years.years) || !Number.isSafeInteger(years.undatedCount) || years.undatedCount < 0 ||
        years.years.some((x, i) => !Number.isSafeInteger(x.year) || x.year < 1 || x.year > 9999 || !Number.isSafeInteger(x.count) || x.count <= 0 || i > 0 && years!.years[i - 1].year <= x.year) ||
        years.undatedCount + years.years.reduce((n, x) => n + x.count, 0) !== yearItems.length) throw Error("Invalid optional years");
    } catch { checkContentReadBudget(); years = null; }
    const select = (q: ListQuery) => {
      const { cursor, limit, ...filters } = q;
      const ordered = selectors.filter(d => matchesContent(d.item, filters, zone)).sort((a, b) => compareContent(a.item, b.item, q.order ?? "date-desc", zone));
      return pageOf(ordered.map(d => d.item), { cursor, limit }, ["list", kind, `${pin.runId}:${pin.revision}`, filters, limit ?? 12, zone, ...(kind === "game" ? [GAME_DATE_POLICY] : [])]);
    };
    let page = select(query); // Validate the original cursor even when dropping a nonexistent year.
    const asked = query.year ?? null, year = years && !hasYear(years, asked) ? null : asked;
    if (year !== asked) { const fallback = { ...query }; delete fallback.year; page = select(fallback); }
    const values = [mode, kind, page.items.map(item => item.slug), pin.runId, pin.revision, pin.viewFingerprint, protocol.migration.sha256];
    const readSelected = async () => {
      checkContentReadBudget();
      const fresh = validateProjection(await callSql<LibraryProjection>(db, LIBRARY_SELECTED_SQL, values), kind, page.items.length);
      if (fresh.runId !== pin.runId || fresh.revision !== pin.revision || fresh.viewFingerprint !== pin.viewFingerprint || fresh.records.length !== page.items.length) changed();
      checkContentReadBudget();
      return fresh;
    };
    // Empty pages still check all candidates, publication and expiry.
    let fresh = await readSelected(), delivery: DeliveryHints | undefined;
    if (options.prepareDelivery && fresh.mediaIds.length) {
      delivery = validateDeliveryHints(await options.prepareDelivery(structuredClone({ ...fresh, records: project(fresh.records, fresh, zone) })));
      fresh = await readSelected();
    }
    // No awaited work after this point. Only fresh public DTOs and whitelisted hints.
    const projected = project(fresh.records, fresh, zone);
    const records = delivery ? applyDeliveryHints(projected, delivery) : projected;
    const byId = new Map(records.map(d => [d.item.id, d.item]));
    const items = page.items.map(selector => {
      const item = byId.get(selector.id);
      if (!item || !isDeepStrictEqual(selectorOf(item), selectorOf(selector))) return changed();
      return item as ContentByKind[K];
    });
    return { page: { ...page, items }, years, year };
  };
}
