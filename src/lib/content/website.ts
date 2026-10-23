import { createHash } from "node:crypto";
import type { AnyContent, ContentDetail, ContentDocument, ContentKind, ContentLink, DateRange, ListQuery, Page } from "../../../contracts/content.ts";
import type { ContentRepository } from "../../../contracts/repository.ts";
import { ContentServiceError } from "../../../contracts/repository.ts";
import type { CursorQuery, PublicContentSnapshot, SearchHit, SearchQuery, SearchSnapshot, TimelineEvent } from "../../../contracts/website.ts";
import { CONTENT_KINDS, type ContentFeatures } from "../../../config/features.ts";
import { statusTimeZone, statusPreview } from "./status.ts";
import { contentYear, supportsYear } from "./years.ts";
import { gameActivityDate, gameBrowsingDate } from "./game-date.ts";
import { validateLibraryYearsQuery } from "./query.ts";
import type { FeedSnapshot } from "../../../contracts/home-feed.ts";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("base64url");
// A projection change must invalidate cursors even when the stored snapshot is unchanged.
const timelineVersion = (version: string, selected: ContentKind[], zone: string) => hash(["completion-dates-v2", version, selected, zone]);
const invalid = (): never => { throw new ContentServiceError("INVALID_QUERY", "Invalid query or changed content. Restart pagination."); };
const unavailable = (): never => { throw new ContentServiceError("CONTENT_UNAVAILABLE", "The public content snapshot exceeds the supported size."); };
export function validateCursorQuery(query: CursorQuery, extras: string[] = []): void {
  if (!query || typeof query !== "object" || Array.isArray(query) || Object.keys(query).some(k => !["limit", "cursor", ...extras].includes(k))) invalid();
  if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 50)) invalid();
  if (query.cursor !== undefined && (typeof query.cursor !== "string" || !query.cursor || query.cursor.length > 1024 || /[\u0000-\u0020\u007f]/.test(query.cursor))) invalid();
}
function parsePageCursor(cursor: string): { fingerprint: string; offset: number } {
  const match = /^w1\.([A-Za-z0-9_-]{43})\.(0|[1-9]\d*)$/.exec(cursor);
  if (!match) return invalid();
  const offset = Number(match[2]);
  if (!Number.isSafeInteger(offset)) return invalid();
  return { fingerprint: match[1], offset };
}
export function pageOf<T>(items: T[], query: CursorQuery, identity: unknown): Page<T> {
  validateCursorQuery(query);
  const fingerprint = hash(identity), limit = query.limit ?? 12;
  let offset = 0;
  if (query.cursor) {
    const cursor = parsePageCursor(query.cursor);
    if (cursor.fingerprint !== fingerprint || cursor.offset > items.length) invalid();
    offset = cursor.offset;
  }
  const selected = items.slice(offset, offset + limit), hasMore = offset + selected.length < items.length;
  return { items: selected, total: items.length, hasMore, nextCursor: hasMore ? `w1.${fingerprint}.${offset + selected.length}` : null };
}
export function contentDate(item: AnyContent, timeZone = "UTC"): DateRange | null {
  switch (item.kind) {
    case "status": return item.recordedAt;
    case "post": return item.publishedAt;
    case "album": return item.date;
    case "book": return item.readingDate;
    case "movie": return item.watchedDate;
    case "game": return gameBrowsingDate(item, timeZone);
    case "project": return item.period;
    case "study-note": return item.date;
    default: return null;
  }
}
/** Event dates describe the activity; archive/list dates retain their existing meaning. */
function timelineDate(item: AnyContent, zone: string): DateRange | null {
  if (item.kind === "book") {
    const date = item.readingDate;
    return date ? { start: item.status === "reading" ? date.start : date.end ?? date.start, end: null, precision: date.precision } : null;
  }
  if (item.kind === "game" && ["clear", "platinumed"].includes(item.status)) {
    const date = item.playedDate;
    return date ? { start: date.end ?? date.start, end: null, precision: date.precision } : null;
  }
  if (item.kind === "game") return gameActivityDate(item, zone);
  return contentDate(item, zone);
}
export function compareContent(a: AnyContent, b: AnyContent, order: ListQuery["order"] = "date-desc", timeZone = "UTC"): number {
  if (order !== "title-asc") {
    const da = contentDate(a, timeZone)?.start ?? null, db = contentDate(b, timeZone)?.start ?? null;
    if (da === null && db !== null) return 1;
    if (db === null && da !== null) return -1;
    if (da !== null && db !== null && da !== db) return order === "date-asc" ? da.localeCompare(db) : db.localeCompare(da);
  }
  return a.title.localeCompare(b.title, "en") || a.id.localeCompare(b.id);
}
export function matchesContent(item: AnyContent, query: ListQuery, zone: string): boolean {
  if (query.tag && !item.tags.includes(query.tag)) return false;
  if (query.status) {
    if (!("status" in item)) return false;
    if (query.status === "completed" && item.kind === "game") { if (!["clear", "platinumed"].includes(item.status)) return false; }
    else if (item.status !== query.status) return false;
  }
  if (query.type && (item.kind !== "movie" || item.mediaType !== query.type)) return false;
  if (query.platform && (item.kind !== "game" || !item.platforms.includes(query.platform))) return false;
  if (query.semester && (item.kind !== "course" || item.semester !== query.semester)) return false;
  return query.year === undefined || (supportsYear(item.kind) && contentYear(item, zone) === (query.year === "undated" ? null : query.year));
}
/** Search readable AST text only; href/src and unavailable link labels are excluded. */
export function documentPlainText(document: ContentDocument | null): string {
  const parts: string[] = [];
  function runs(values: { text: string; link?: { kind: string } }[]) {
    for (const run of values) if (run.link?.kind !== "unavailable") parts.push(run.text);
  }
  function visit(blocks: ContentDocument["blocks"]) {
    for (const block of blocks) {
      if ("text" in block) runs(block.text);
      if (block.type === "code") parts.push(block.code);
      if (block.type === "equation") parts.push(block.expression);
      if (block.type === "toggle") { runs(block.title); visit(block.children); }
      if (block.type === "callout") visit(block.children);
      if (block.type === "list") for (const item of block.items) { runs(item.text); visit(item.children); }
      if (block.type === "columns") for (const column of block.columns) visit(column.blocks);
      if (block.type === "table") for (const row of block.rows) for (const cell of row) runs(cell);
      if ("caption" in block) runs(block.caption);
      if (block.type === "bookmark") parts.push(block.title, block.description ?? "");
    }
  }
  if (document) visit(document.blocks);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

export function validateSearchQuery(query: SearchQuery): void {
  validateCursorQuery(query, ["q", "kinds"]);
  if (typeof query.q !== "string" || query.q !== query.q.trim() || !query.q || query.q.length > 128 || /[\u0000-\u001f\u007f]/.test(query.q)) invalid();
  if (query.kinds !== undefined && (!Array.isArray(query.kinds) || !query.kinds.length || query.kinds.length > CONTENT_KINDS.length || query.kinds.some(k => !CONTENT_KINDS.includes(k)))) invalid();
  // Reject malformed continuations before a provider loads the search snapshot.
  if (query.cursor !== undefined) parsePageCursor(query.cursor);
}

/** Shared matching/ranking/cursors for full snapshots and compact SQL text. */
export function searchContentSnapshot(all: SearchSnapshot, query: SearchQuery, selected: ContentKind[]): Page<SearchHit> {
  const needle = query.q.normalize("NFKC").toLocaleLowerCase();
  const hits: (SearchHit & { score: number })[] = [];
  for (const { item, document } of all.records) {
    const title = item.title.normalize("NFKC").toLocaleLowerCase();
    const text = `${item.summary ?? ""} ${documentPlainText(document)}`.replace(/\s+/g, " ").trim();
    const normalized = text.normalize("NFKC").toLocaleLowerCase(), offset = normalized.indexOf(needle);
    if (!title.includes(needle) && offset < 0) continue;
    const start = Math.max(0, offset - 45);
    hits.push({ id: item.id, kind: item.kind, title: item.title, href: item.href, updatedAt: item.updatedAt, excerpt: text.slice(start, start + 180), score: title.includes(needle) ? 2 : 1,
      ...(item.kind === "study-note" && all.searchContexts ? { context: all.searchContexts[item.id] ?? null } : {}) });
  }
  hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, "en") || a.id.localeCompare(b.id));
  const { cursor, limit } = query;
  // Live media/link scrubbing can change hits without changing the stored version.
  // Bind the cursor to the ordered visible result, including changed excerpts.
  const page = pageOf(hits, { cursor, limit }, ["search", all.version, selected, needle, limit ?? 12, hash(hits)]);
  return { ...page, items: page.items.map(({ score: _score, ...hit }) => hit) };
}

export async function searchRepository(repository: ContentRepository, features: ContentFeatures, query: SearchQuery): Promise<Page<SearchHit>> {
  validateSearchQuery(query);
  const selected = [...new Set(query.kinds ?? CONTENT_KINDS)].filter(kind => features[kind]).sort();
  const page = repository.search && selected.length ? await repository.search({ ...query, kinds: selected })
    : searchContentSnapshot(repository.readSearchSnapshot && selected.includes("study-note")
      ? await publicSnapshot({ ...repository, readSnapshot: repository.readSearchSnapshot }, selected, true) : await publicSnapshot(repository, selected, true), query, selected);
  // A disabled course must not gain a display label through a still-enabled note search.
  return features.course ? page : { ...page, items: page.items.map(hit => hit.context ? { ...hit, context: null } : hit) };
}
/** Adapter fallback is bounded and checks every continuation; failures never become empty results. */
export async function publicSnapshot(repository: ContentRepository, kinds: ContentKind[], documents = false): Promise<PublicContentSnapshot> {
  if (!kinds.length) return { version: hash([]), records: [] };
  if (repository.readSnapshot) {
    const result = await repository.readSnapshot(kinds, documents);
    if (typeof result.version !== "string" || !result.version || !Array.isArray(result.records) || result.records.length > 20000 ||
      result.records.some(d => !d?.item || !kinds.includes(d.item.kind)) ||
      new Set(result.records.map(d => d.item.id)).size !== result.records.length ||
      Buffer.byteLength(JSON.stringify(result.records)) + ((result as SearchSnapshot).searchContexts ? Buffer.byteLength(JSON.stringify((result as SearchSnapshot).searchContexts)) : 0) > 16 * 1024 * 1024) unavailable();
    return result;
  }
  const records: ContentDetail<AnyContent>[] = [];
  for (const kind of kinds) {
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await repository.list(kind, { limit: 50, ...(cursor ? { cursor } : {}) });
      for (const item of page.items) {
        if (records.length >= 20000) unavailable();
        const detail = documents ? await repository.get(kind, item.slug) : { item, document: null };
        if (!detail) throw new ContentServiceError("CONTENT_UNAVAILABLE", "Content changed during snapshot reading.");
        records.push(detail);
      }
      if (page.hasMore && (!page.nextCursor || seen.has(page.nextCursor))) unavailable();
      cursor = page.hasMore ? page.nextCursor! : undefined;
      if (cursor) seen.add(cursor);
    } while (cursor);
  }
  return { version: hash(records), records };
}
function timelineDayReader(zone: string): (date: DateRange | null) => string {
  // Formatting configuration is shared only within this calculation; no content
  // or publication eligibility survives for another request.
  let formatter: Intl.DateTimeFormat | undefined;
  const days = new WeakMap<DateRange, string>();
  return date => {
    if (!date) return "undated";
    if (date.precision === "date") return date.start;
    const cached = days.get(date);
    if (cached !== undefined) return cached;
    const parts = (formatter ??= new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" })).formatToParts(new Date(date.start));
    const get = (type: string) => parts.find(p => p.type === type)!.value;
    const day = `${get("year")}-${get("month")}-${get("day")}`;
    days.set(date, day);
    return day;
  };
}
export async function readTimelineSnapshot(repository: ContentRepository, features: ContentFeatures, timeZone?: string): Promise<FeedSnapshot<TimelineEvent>> {
  const selected = CONTENT_KINDS.filter(kind => features[kind] && !["course", "study-note", "page"].includes(kind));
  const snapshot = await publicSnapshot(repository, selected, true), zone = statusTimeZone({ timeZone });
  return { version: timelineVersion(snapshot.version, selected, zone), items: timelineEvents(snapshot, zone) };
}
/** Sort the full metadata index, then hydrate only the Status entries selected
 * for the outgoing page. Older adapters keep their existing snapshot path. */
export async function readTimelineIndexSnapshot(repository: ContentRepository, features: ContentFeatures, timeZone?: string): Promise<FeedSnapshot<TimelineEvent>> {
  if (!repository.readIndex) return readTimelineSnapshot(repository, features, timeZone);
  const selected = CONTENT_KINDS.filter(kind => features[kind] && !["course", "study-note", "page"].includes(kind));
  const snapshot = await publicSnapshot({ ...repository, readSnapshot: repository.readIndex }, selected), zone = statusTimeZone({ timeZone });
  if (snapshot.records.some(record => record.document !== null)) unavailable();
  return { version: timelineVersion(snapshot.version, selected, zone), items: timelineEvents(snapshot, zone) };
}
export async function hydrateTimelinePage(repository: ContentRepository, features: ContentFeatures, events: TimelineEvent[], expectedVersion: string, timeZone?: string): Promise<TimelineEvent[]> {
  if (!repository.readIndex || !events.some(event => event.type === "status")) return events;
  const selected = CONTENT_KINDS.filter(kind => features[kind] && !["course", "study-note", "page"].includes(kind)), zone = statusTimeZone({ timeZone });
  const verify = async () => {
    const current = await repository.readIndex!([]);
    if (timelineVersion(current.version, selected, zone) !== expectedVersion) invalid();
    return current.version;
  };
  const pin = await verify();
  if (repository.getSelected) {
    const statuses = events.filter((event): event is Extract<TimelineEvent, { type: "status" }> => event.type === "status");
    const details = await repository.getSelected("status", statuses.map(event => event.entry.slug), pin);
    const byId = new Map(details.map(detail => [detail.item.id, detail]));
    const result = events.map(event => {
      if (event.type !== "status") return event;
      const detail = byId.get(event.entry.id);
      if (!detail || detail.item.slug !== event.entry.slug || JSON.stringify(detail.item.recordedAt) !== JSON.stringify(event.occurredAt)) return invalid();
      return { ...event, entry: statusPreview(detail.item, detail.document) };
    });
    await verify(); return result;
  }
  const result = [...events]; let next = 0, failed = false, failure: unknown;
  await Promise.all(Array.from({ length: Math.min(2, events.length) }, async () => {
    while (!failed && next < events.length) {
      const index = next++, event = events[index];
      if (event.type !== "status") continue;
      try {
        const detail = await repository.get("status", event.entry.slug);
        if (!detail) throw new ContentServiceError("INVALID_QUERY", "Content changed during timeline reading.");
        if (detail.item.id !== event.entry.id || JSON.stringify(detail.item.recordedAt) !== JSON.stringify(event.occurredAt)) invalid();
        result[index] = { ...event, entry: statusPreview(detail.item, detail.document) };
      } catch (error) { if (!failed) { failed = true; failure = error; } }
    }
  }));
  if (failed) throw failure;
  await verify(); return result;
}
export function timelineEvents(snapshot: PublicContentSnapshot, zone: string): TimelineEvent[] {
  const events = new Map<string, TimelineEvent>();
  const dayOf = timelineDayReader(zone);
  for (const detail of snapshot.records) {
    const item = detail.item, occurredAt = timelineDate(item, zone);
    if (item.kind === "status") { events.set(`status:${item.id}`, { id: `status:${item.id}`, type: "status", occurredAt, entry: statusPreview(item, detail.document) }); continue; }
    let type: Exclude<TimelineEvent, { type: "status" }>["type"] | undefined;
    let rating: Exclude<TimelineEvent, { type: "status" }>["rating"] = null, progressPercent: number | null = null, extra: string | null = null;
    switch (item.kind) {
      case "movie": if (item.status === "watched") { type = "movie-watched"; rating = item.rating; extra = item.mediaType; } break;
      case "book": if (["reading", "read", "given-up"].includes(item.status)) { type = `book-${item.status}` as typeof type; rating = item.personalRating; progressPercent = item.progressPercent; } break;
      case "game": if (item.status !== "playing" && !occurredAt) break;
        if (["playing", "clear", "platinumed"].includes(item.status)) { type = item.status === "clear" ? "game-cleared" : `game-${item.status}` as typeof type; rating = item.rating; progressPercent = item.progressPercent; extra = item.platforms.join(" · ") || null; } break;
      case "album": type = "album-new"; extra = item.photoCount === null ? null : String(item.photoCount); break;
      case "post": type = "post-new"; break;
      case "project": type = "project-new"; extra = item.role; break;
    }
    if (!type) continue;
    const id = `${item.kind}:${item.id}:${dayOf(occurredAt)}`;
    // A snapshot contains the current state of each work; duplicate observations on a day collapse.
    const previous = events.get(id);
    if (previous && (previous.occurredAt?.start ?? "") > (occurredAt?.start ?? "")) continue;
    events.set(id, { id, type, occurredAt, title: item.title, summary: item.summary, cover: item.cover, href: item.href, externalUrl: null, rating, progressPercent, detail: extra,
      ...(item.kind === "game" ? { playedTime: item.playedTime ? { ...item.playedTime } : null } : {}) });
  }
  return [...events.values()].sort((a, b) => {
    if (!a.occurredAt && b.occurredAt) return 1;
    if (a.occurredAt && !b.occurredAt) return -1;
    const day = dayOf(b.occurredAt).localeCompare(dayOf(a.occurredAt));
    if (day) return day;
    if (a.occurredAt?.precision !== b.occurredAt?.precision) return a.occurredAt?.precision === "datetime" ? -1 : 1;
    return (b.occurredAt?.start ?? "").localeCompare(a.occurredAt?.start ?? "") || a.id.localeCompare(b.id);
  });
}
export function createWebsiteQueries(repository: ContentRepository, features: ContentFeatures, timeZone = "UTC"): ContentRepository {
  const kinds = () => CONTENT_KINDS.filter(kind => features[kind]);
  const snapshot = (selected: ContentKind[], documents = false) => publicSnapshot(repository, selected.filter(kind => features[kind]), documents);
  return {
    ...repository,
    async getLibraryYears(kind, query = {}) {
      validateLibraryYearsQuery(kind, query);
      const zone = statusTimeZone({ timeZone });
      if (!features[kind]) return { years: [], undatedCount: 0, timeZone: zone };
      if (!repository.getLibraryYears) throw new ContentServiceError("CONTENT_UNAVAILABLE", "Library years require a compatible reader.");
      return repository.getLibraryYears(kind, query);
    },
    async getPage(key) {
      if (key !== "about" || !features.page) return null;
      if (repository.getPage) return repository.getPage(key);
      const detail = await repository.get("page", key);
      return detail ? { slug: "about", title: detail.item.title, updatedAt: detail.item.updatedAt, document: detail.document } : null;
    },
    async get(kind, slug) {
      const detail = await repository.get(kind, slug);
      if (!detail || kind !== "post") return detail;
      const all = await snapshot(["post"]);
      const posts = all.records.map(x => x.item).sort((a, b) => compareContent(a, b));
      const index = posts.findIndex(x => x.id === detail.item.id);
      if (index < 0) throw new ContentServiceError("CONTENT_UNAVAILABLE", "Content changed while reading adjacent posts.");
      const link = (item: AnyContent | undefined): ContentLink | null => item ? { title: item.title, href: item.href } : null;
      return { ...detail, adjacent: { newer: link(posts[index - 1]), older: link(posts[index + 1]) } };
    },
    async getTimeline(query = {}) {
      validateCursorQuery(query);
      const selected = kinds().filter(kind => !["course", "study-note", "page"].includes(kind));
      if (repository.readIndex) {
        const index = await readTimelineIndexSnapshot(repository, features, timeZone);
        const page = pageOf(index.items, query, ["timeline-index", index.version, selected, timeZone, query.limit ?? 12]);
        return { ...page, items: await hydrateTimelinePage(repository, features, page.items, index.version, timeZone) };
      }
      const all = await snapshot(selected), zone = statusTimeZone({ timeZone });
      return pageOf(timelineEvents(all, zone), query, ["timeline", timelineVersion(all.version, selected, zone), selected, zone, query.limit ?? 12]);
    },
    async search(query) {
      return searchRepository(repository, features, query);
    },
    readSnapshot: snapshot,
  };
}
