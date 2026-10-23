import type {
  AnyContent, ContentKind, ContentByKind, ListQuery, Page, ContentDetail, StudyNode,
} from "../contracts/content.ts";
import { ContentServiceError, type ContentRepository } from "../contracts/repository.ts";
import { fixtureItems, fixtureDocuments, fixtureTrees } from "../fixtures/content.ts";
import { createHash } from "node:crypto";
import { validateListQuery, validateLibraryYearsQuery } from "../src/lib/content/query.ts";
import { statusPreview, statusTimeZone, statusYears, type StatusReadOptions } from "../src/lib/content/status.ts";
import { contentYear, libraryYears, supportsYear } from "../src/lib/content/years.ts";
import { GAME_DATE_POLICY, gameBrowsingDate, projectGameDates } from "../src/lib/content/game-date.ts";
import { contextFromItems } from "../src/lib/content/search-context.ts";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const invalid = (message: string): never => {
  throw new ContentServiceError("INVALID_QUERY", message);
};
function dateOf(item: AnyContent): string | null {
  switch (item.kind) {
    case "post": return item.publishedAt?.start ?? null;
    case "status": return item.recordedAt?.start ?? null;
    case "album": return item.date?.start ?? null;
    case "book": return item.readingDate?.start ?? null;
    case "movie": return item.watchedDate?.start ?? null;
    case "game": return gameBrowsingDate(item)?.start ?? null;
    case "study-note": return item.date?.start ?? null;
    case "course": return null;
    case "project": return item.period?.start ?? null;
    case "page": return null;
  }
}
function matches(item: AnyContent, query: ListQuery): boolean {
  if (query.tag && !item.tags.includes(query.tag)) return false;
  if (query.status) {
    if (!("status" in item)) return false;
    if (query.status === "completed" && item.kind === "game") {
      if (!["clear", "platinumed"].includes(item.status)) return false;
    } else if (item.status !== query.status) return false;
  }
  if (query.type && (item.kind !== "movie" || item.mediaType !== query.type)) return false;
  if (query.platform && (item.kind !== "game" || !item.platforms.includes(query.platform))) return false;
  if (query.semester && (item.kind !== "course" || item.semester !== query.semester)) return false;
  return true;
}
function findNode(nodes: StudyNode[], id: string): StudyNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = findNode(node.children ?? [], id);
    if (found) return found;
  }
  return null;
}
/** Development provider. Mock cursor syntax is not a Notion cursor contract. */
export function createMockRepository(options: StatusReadOptions = {}): ContentRepository {
  const publicItem = <T extends AnyContent>(item: T): T => (item.kind === "game" ? projectGameDates(item, statusTimeZone(options)) : item) as T;
  return {
    async readSearchSnapshot(kinds) {
      const records = kinds.flatMap(kind => fixtureItems[kind].map(item => ({ item: publicItem(item), document: fixtureDocuments[item.id] ?? null })));
      const items = new Map<string, AnyContent>([...fixtureItems.course, ...fixtureItems["study-note"]].map(item => [item.id, item]));
      const searchContexts = Object.fromEntries(records.flatMap(({ item }) => item.kind === "study-note" ? [[item.id, contextFromItems(item, items)]] : []));
      return clone({ version: createHash("sha256").update(JSON.stringify([records, searchContexts])).digest("base64url"), records, searchContexts });
    },
    async getContentMetadata<K extends ContentKind>(kind: K, slug: string) {
      const item = fixtureItems[kind].find(item => item.slug === slug);
      return item ? clone(publicItem(item)) as ContentByKind[K] : null;
    },
    async getPage(key) {
      if (key !== "about") return null;
      const item = fixtureItems.page.find(p => p.pageKey === key);
      return item ? clone({ slug: "about", title: item.title, updatedAt: item.updatedAt, document: fixtureDocuments[item.id] ?? null }) : null;
    },
    async readSnapshot(kinds, documents = false) {
      const records = kinds.flatMap(kind => fixtureItems[kind].map(item => ({ item: publicItem(item), document: documents || kind === "status" ? fixtureDocuments[item.id] ?? null : null })));
      return clone({ version: createHash("sha256").update(JSON.stringify(records)).digest("base64url"), records });
    },
    async list<K extends ContentKind>(kind: K, query: ListQuery = {}): Promise<Page<ContentByKind[K]>> {
      validateListQuery(kind, query);
      const limit = query.limit ?? 12;
      const timeZone = supportsYear(kind) ? statusTimeZone(options) : "UTC";
      const { cursor: _cursor, ...filters } = query;
      const order = query.order ?? (kind === "course" ? "title-asc" : "date-desc");
      const fingerprint = createHash("sha256").update(JSON.stringify([kind, timeZone, ...(kind === "game" ? [GAME_DATE_POLICY] : []), Object.fromEntries(Object.entries({...filters, limit, order}).sort(([a], [b]) => a.localeCompare(b)))])).digest("base64url");
      let offset = 0;
      if (query.cursor) {
        const parts = /^m1\.([A-Za-z0-9_-]{43})\.(\d+)$/.exec(query.cursor);
        if (!parts) return invalid("Invalid mock cursor. Restart pagination.");
        if (parts[1] !== fingerprint) invalid("Invalid mock cursor. Restart pagination.");
        offset = Number(parts[2]);
        if (!Number.isSafeInteger(offset)) invalid("Invalid mock cursor");
      }
      const all = fixtureItems[kind].map(publicItem).filter(item => matches(item, query) && (query.year === undefined ||
        (supportsYear(item.kind) && contentYear(item, timeZone) === (query.year === "undated" ? null : query.year))));
      all.sort((a, b) => {
        if (order !== "title-asc") {
          const da = dateOf(a), db = dateOf(b);
          if (da === null && db !== null) return 1;
          if (da !== null && db === null) return -1;
          if (da !== db && da !== null && db !== null)
            return order === "date-desc" ? db.localeCompare(da) : da.localeCompare(db);
        }
        return a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
      });
      const selected = all.slice(offset, offset + limit).map(item => item.kind === "status" ? statusPreview(item, fixtureDocuments[item.id] ?? null) : item) as ContentByKind[K][];
      const hasMore = offset + selected.length < all.length;
      return clone({ items: selected, hasMore, total: all.length,
        nextCursor: hasMore ? `m1.${fingerprint}.${offset + selected.length}` : null });
    },
    async get<K extends ContentKind>(kind: K, slug: string): Promise<ContentDetail<ContentByKind[K]> | null> {
      const item = fixtureItems[kind].find(x => x.slug === slug);
      if (!item) return null;
      return clone({ item: publicItem(item), document: fixtureDocuments[item.id] ?? null }) as ContentDetail<ContentByKind[K]>;
    },
    async getHome() {
      return clone({
        featuredPosts: fixtureItems.post.slice(0, 1),
        recentStatuses: fixtureItems.status.slice(0, 12).map(item => statusPreview(item, fixtureDocuments[item.id] ?? null)),
        latestAlbums: fixtureItems.album.slice(0, 1),
        readingBooks: fixtureItems.book.filter(x => x.status === "reading").slice(0, 3),
        playingGames: fixtureItems.game.filter(x => x.status === "playing").slice(0, 3).map(publicItem),
        featuredCourses: fixtureItems.course.slice(0, 1),
      });
    },
    async getCourseMetadata(courseSlug) {
      const course = fixtureItems.course.find(item => item.slug === courseSlug);
      return course ? clone(course) : null;
    },
    async getStatusYears() { return statusYears(fixtureItems.status, statusTimeZone(options)); },
    async getLibraryYears(kind, query = {}) {
      validateLibraryYearsQuery(kind, query);
      return libraryYears(fixtureItems[kind].map(publicItem).filter(item => matches(item, query)), statusTimeZone(options));
    },
    async getCourseTree(courseSlug: string, parentId?: string) {
      const course = fixtureItems.course.find(x => x.slug === courseSlug);
      if (!course) return null;
      const tree = fixtureTrees[course.id];
      if (!tree) return clone({courseId: course.id, nodes: []});
      const enrich = (nodes: StudyNode[]): StudyNode[] => nodes.map(node => {
        const note = fixtureItems["study-note"].find(note => note.id === node.id && note.courseId === course.id);
        return { ...node, ...(note ? { noteType: note.noteType, date: note.date } : {}), children: enrich(node.children ?? []) };
      });
      if (!parentId) return clone({ ...tree, nodes: enrich(tree.nodes) });
      const parent = findNode(tree.nodes, parentId);
      return parent ? clone({courseId: course.id, nodes: enrich(parent.children ?? [])}) : null;
    },
  };
}
