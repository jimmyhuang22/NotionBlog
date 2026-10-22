import { createHash } from "node:crypto";
import type { PageObjectResponse } from "@notionhq/client";
import type { AnyContent, ContentByKind, ContentDetail, ContentDocument, ContentKind, ContentLink, Course, CourseTree, DateRange, ImageAsset, ListQuery, Page, StatusEntry, StudyNode, StudyNote, StudyNoteType, TextRun } from "../../../contracts/content.ts";
import { ContentServiceError, type ContentRepository } from "../../../contracts/repository.ts";
import { validateListQuery } from "../../lib/content/query.ts";
import { statusPreview, statusTimeZone, statusYear, statusYears, type StatusReadOptions } from "../../lib/content/status.ts";
import { buildNotionDocument, type RegisterBlockImageInput } from "./blocks.ts";
import { assertSourceSchema, normalizeId } from "./config.ts";
import { getDate, getProperty, getRating, getSelect, getTags, getTitle, normalizeDateTime } from "./properties.ts";
import { mapBounded } from "./bounded-work.ts";
import type { NotionReadClient, NotionSource, NotionSourcesConfig, ReleaseContentKind } from "./types.ts";

export interface PublicNotionPage {
  page: PageObjectResponse;
  source: NotionSource;
  course: PublicNotionPage | null;
  /** Root note first; every ancestor independently passed publication checks. */
  ancestors: PageObjectResponse[];
}
export interface NotionRepository extends ContentRepository {
  resolvePublicPage(id: string): Promise<PublicNotionPage | null>;
  /** Fresh single-owner qualification; optional for existing injected adapters. */
  resolveMediaOwner?(id: string): Promise<PublicNotionPage | null>;
  getCourseMetadata(courseSlug: string): Promise<Course | null>;
}
export interface NotionRepositoryOptions extends StatusReadOptions {
  client: NotionReadClient;
  config: NotionSourcesConfig;
  registerImage?: (input: RegisterBlockImageInput) => Promise<ImageAsset | null>;
}

function idOrNull(value: string): string | null {
  try { return normalizeId(value); } catch { return null; }
}
function active(page: PageObjectResponse): boolean {
  const archive = page as PageObjectResponse & { is_archived?: boolean };
  return !page.in_trash && !page.archived && !archive.is_archived;
}
function dateOf(item: AnyContent): string | null {
  if (item.kind === "status") return item.recordedAt?.start ?? null;
  if (item.kind === "study-note") return item.date?.start ?? null;
  return null;
}
function noteType(value: string | null): StudyNoteType {
  const type = value?.toLowerCase().trim();
  return ["course", "assignment", "summary", "note", "quiz", "test", "textbook", "tool"].includes(type ?? "") ? type as StudyNoteType : "unknown";
}
function titleOf(page: PageObjectResponse, source: NotionSource): string {
  return getTitle(page, source.fields.title) || (source.kind === "study-note" ? getTitle(page, "title") : "");
}
function documentText(document: ContentDocument): TextRun[] {
  const result: TextRun[] = [];
  function visit(blocks: ContentDocument["blocks"]) {
    for (const block of blocks) {
      if ("text" in block) result.push(...block.text, { text: "\n" });
      if ("children" in block) visit(block.children);
      if (block.type === "list") for (const item of block.items) { result.push(...item.text, { text: "\n" }); visit(item.children); }
      if (block.type === "columns") for (const column of block.columns) visit(column.blocks);
    }
  }
  visit(document.blocks);
  return result;
}

/** A session lives for one operation only; no public qualification survives to the next request. */
class ReadSession {
  private pages = new Map<string, Promise<PageObjectResponse | null>>();
  private blocks = new Map<string, ReturnType<NotionReadClient["getBlock"]>>();
  private schemas = new Map<string, Promise<void>>();
  private sourcePages = new Map<string, Promise<Map<string, PageObjectResponse>>>();
  private options: NotionRepositoryOptions;
  private mediaQualification: boolean;
  constructor(options: NotionRepositoryOptions, mediaQualification = false) {
    this.options = options;
    this.mediaQualification = mediaQualification;
  }

  private page(id: string) {
    if (!this.pages.has(id)) this.pages.set(id, this.options.client.getPage(id));
    return this.pages.get(id)!;
  }
  private async queryPages(source: NotionSource): Promise<Map<string, PageObjectResponse>> {
    if (!this.options.client.listPages) throw new ContentServiceError("MISCONFIGURED", "Source publication requires the query adapter.");
    if (!this.sourcePages.has(source.key)) this.sourcePages.set(source.key, (async () => {
      await this.schema(source);
      const selected = new Set(source.publication.allowlistPageIds);
      const pages = new Map<string, PageObjectResponse>();
      for (const page of await this.options.client.listPages!(source.dataSourceId)) {
        if (!active(page) || page.parent.type !== "data_source_id" || idOrNull(page.parent.data_source_id) !== source.dataSourceId) continue;
        const id = normalizeId(page.id);
        // Querying a learning source never grants publication to an unselected row.
        if (source.publication.mode !== "all" && !selected.has(id)) continue;
        pages.set(id, page);
        this.pages.set(id, Promise.resolve(page));
      }
      return pages;
    })());
    return this.sourcePages.get(source.key)!;
  }
  private async allStatusPages(source: NotionSource): Promise<Map<string, PageObjectResponse>> {
    if (source.kind !== "status") throw new ContentServiceError("MISCONFIGURED", "Only Status supports source publication.");
    return this.queryPages(source);
  }
  async prepareStudyPages(sources: NotionSource[]): Promise<void> {
    if (!this.options.client.listPages) return;
    for (const source of sources) {
      if (source.kind === "study-note" && source.publication.mode === "allowlist" && source.publication.allowlistPageIds.length > 1) {
        await this.queryPages(source);
      }
    }
  }
  async prefetchPages(ids: string[]): Promise<void> {
    // The transport still spaces HTTP starts; four outstanding reads overlap latency.
    await mapBounded([...new Set(ids)], 4, id => this.page(id));
  }
  async publishedIds(kind: ReleaseContentKind): Promise<string[]> {
    const ids = new Set<string>();
    for (const source of this.options.config.sources.filter(source => source.enabled && source.kind === kind)) {
      const sourceIds = source.publication.mode === "all" ? [...(await this.allStatusPages(source)).keys()] : source.publication.allowlistPageIds;
      sourceIds.forEach(id => ids.add(id));
    }
    return [...ids];
  }
  private async schema(source: NotionSource) {
    if (!this.schemas.has(source.key)) this.schemas.set(source.key, (async () => {
      const schema = await this.options.client.getDataSource(source.dataSourceId);
      if (normalizeId(schema.id) !== source.dataSourceId || schema.in_trash || schema.archived) {
        throw new ContentServiceError("MISCONFIGURED", "Configured content source is unavailable.");
      }
      assertSourceSchema(source, schema);
      if (source.kind === "study-note") {
        const parent = schema.database_parent;
        const courseId = parent.type === "page_id" ? idOrNull(parent.page_id) : parent.type === "block_id" ? await this.containingPage(parent.block_id) : null;
        if (courseId !== source.coursePageId) throw new ContentServiceError("MISCONFIGURED", "The study source does not belong to its configured course.");
      }
    })());
    await this.schemas.get(source.key);
  }
  private async containingPage(blockId: string): Promise<string | null> {
    const seen = new Set<string>();
    const canonical = idOrNull(blockId);
    if (!canonical) return null;
    let current = canonical;
    for (let depth = 0; depth < 24; depth++) {
      if (seen.has(current)) return null;
      seen.add(current);
      if (!this.blocks.has(current)) this.blocks.set(current, this.options.client.getBlock(current));
      const block = await this.blocks.get(current)!;
      if (!block || block.in_trash || block.archived || idOrNull(block.id) !== current) return null;
      if (block.parent.type === "page_id") return idOrNull(block.parent.page_id);
      if (block.parent.type !== "block_id") return null;
      const parent = idOrNull(block.parent.block_id);
      if (!parent) return null;
      current = parent;
    }
    return null;
  }

  async resolve(id: string, expectedKind?: ReleaseContentKind, trail: string[] = []): Promise<PublicNotionPage | null> {
    const canonical = idOrNull(id);
    if (!canonical || trail.includes(canonical) || trail.length >= 24) return null;
    // Resolve explicit note/course identities before unrelated automatic Status sources.
    const sources = this.options.config.sources.filter(source => source.enabled && (!expectedKind || source.kind === expectedKind))
      .sort((a, b) => Number(a.publication.mode === "all") - Number(b.publication.mode === "all"));
    for (const source of sources) {
      // A media request already names one exact owner. For whole-source Status
      // publication its fresh active page, direct source parent and current
      // schema establish eligibility without enumerating every Status row.
      // Listings, details and link qualification still use their existing query.
      const directStatusMedia = this.mediaQualification && source.kind === "status" && source.publication.mode === "all";
      const selected = directStatusMedia || (source.publication.mode === "all"
        ? (await this.allStatusPages(source)).has(canonical)
        : source.publication.allowlistPageIds.includes(canonical));
      if (!selected) continue;
      const page = await this.page(canonical);
      if (!page || !active(page) || normalizeId(page.id) !== canonical) return null;
      const direct = page.parent.type === "data_source_id" && idOrNull(page.parent.data_source_id) === source.dataSourceId;
      if (directStatusMedia && !direct) continue;
      await this.schema(source);
      if (source.kind !== "study-note") {
        if (direct) return { page, source, course: null, ancestors: [] };
        continue;
      }
      const course = source.coursePageId ? await this.resolve(source.coursePageId, "course", [...trail, canonical]) : null;
      if (!course) continue;
      if (direct) return { page, source, course, ancestors: [] };
      const parentId = page.parent.type === "page_id" ? idOrNull(page.parent.page_id) : page.parent.type === "block_id" ? await this.containingPage(page.parent.block_id) : null;
      if (!parentId) continue;
      if (parentId === source.coursePageId) return { page, source, course, ancestors: [] };
      const parent = await this.resolve(parentId, "study-note", [...trail, canonical]);
      if (parent?.source.key === source.key && parent.course && normalizeId(parent.course.page.id) === normalizeId(course.page.id)) {
        return { page, source, course, ancestors: [...parent.ancestors, parent.page] };
      }
    }
    return null;
  }

  async link(id: string): Promise<ContentLink | null> {
    const resolved = await this.resolve(id);
    if (!resolved) return null;
    const item = await this.item(resolved, false);
    return { title: item.title, href: item.href };
  }

  async item(resolved: PublicNotionPage, cover = true): Promise<StatusEntry | Course | StudyNote> {
    const { page, source } = resolved;
    const id = normalizeId(page.id);
    const courseId = resolved.course ? normalizeId(resolved.course.page.id) : null;
    const title = titleOf(page, source) || (source.kind === "status" ? "未命名动态" : source.kind === "course" ? "未命名课程" : "未命名笔记");
    const base = { id, kind: source.kind, slug: id, href: source.kind === "status" ? `/status#${id}` : source.kind === "course" ? `/study/${id}` : `/study/${courseId}/notes/${id}`, title, summary: getSelect(page, source.fields.summary), tags: getTags(page, source.fields.tags), cover: cover ? await this.cover(resolved) : null, updatedAt: normalizeDateTime(page.last_edited_time) };
    if (source.kind === "status") return { ...base, kind: "status", recordedAt: getDate(page, source.fields.recordedAt), text: [] };
    if (source.kind === "course") return {
      ...base, kind: "course", code: getSelect(page, source.fields.code) ?? title.match(/^([A-Z]{2,}\d{2,})\b/)?.[1] ?? id,
      semester: getSelect(page, source.fields.semester),
      ratings: {
        experience: getRating(page, source.fields.experience ?? source.fields.experienceRating),
        usefulness: getRating(page, source.fields.usefulness ?? source.fields.usefulnessRating),
        recommendation: getRating(page, source.fields.recommendation ?? source.fields.recommendationRating),
        difficulty: getRating(page, source.fields.difficulty ?? source.fields.difficultyRating),
      },
    };
    const breadcrumbs: ContentLink[] = [{ title: "学习", href: "/study" }];
    if (resolved.course) breadcrumbs.push({ title: titleOf(resolved.course.page, resolved.course.source) || "课程", href: `/study/${courseId}` });
    for (const ancestor of resolved.ancestors) breadcrumbs.push({ title: titleOf(ancestor, source) || "笔记", href: `/study/${courseId}/notes/${normalizeId(ancestor.id)}` });
    return { ...base, kind: "study-note", courseId: courseId!, parentId: resolved.ancestors.length ? normalizeId(resolved.ancestors.at(-1)!.id) : null, noteType: noteType(getSelect(page, source.fields.type)), date: getDate(page, source.fields.date), breadcrumbs };
  }

  private async cover(resolved: PublicNotionPage): Promise<ImageAsset | null> {
    const { page, source } = resolved;
    if (!this.options.registerImage || source.cover.strategy === "none") return null;
    let file = page.cover;
    let property: string | undefined;
    if (source.cover.strategy === "files-property") {
      property = source.cover.property;
      const value = getProperty(page, property);
      file = value?.type === "files" ? value.files[0] ?? null : null;
    }
    if (!file || (file.type !== "file" && file.type !== "external")) return null;
    return this.options.registerImage({ ownerPageId: normalizeId(page.id), ...(property ? { property } : {}), alt: getTitle(page, source.fields.title), url: file.type === "file" ? file.file.url : file.external.url, ...(file.type === "file" ? { expiryTime: file.file.expiry_time } : {}) });
  }

  async document(resolved: PublicNotionPage): Promise<ContentDocument> {
    return buildNotionDocument(normalizeId(resolved.page.id), this.options.client, {
      resolvePageLink: id => this.link(id),
      registerImage: input => this.options.registerImage?.(input) ?? Promise.resolve(null),
    });
  }
}

export function createNotionRepository(options: NotionRepositoryOptions): NotionRepository {
  const session = () => new ReadSession(options);
  return {
    resolvePublicPage: id => session().resolve(id),
    resolveMediaOwner: id => new ReadSession(options, true).resolve(id),
    async getCourseMetadata(courseSlug) {
      const reader = session();
      const course = await reader.resolve(courseSlug, "course");
      return course ? await reader.item(course) as Course : null;
    },
    async list<K extends ContentKind>(kind: K, query: ListQuery = {}): Promise<Page<ContentByKind[K]>> {
      validateListQuery(kind, query);
      if (!["status", "course", "study-note"].includes(kind)) return { items: [], nextCursor: null, hasMore: false };
      const reader = session();
      const ids = await reader.publishedIds(kind as ReleaseContentKind);
      const timeZone = kind === "status" ? statusTimeZone(options) : "UTC";
      await reader.prefetchPages(ids);
      const records: { resolved: PublicNotionPage; item: StatusEntry | Course | StudyNote }[] = [];
      // Status may opt into its complete source; other kinds remain individually selected.
      await mapBounded(ids, 4, async id => {
        const resolved = await reader.resolve(id, kind as ReleaseContentKind);
        if (!resolved) return;
        const item = await reader.item(resolved);
        if (query.tag && !item.tags.includes(query.tag)) return;
        if (query.year !== undefined && (item.kind !== "status" || statusYear(item, timeZone) !== (query.year === "undated" ? null : query.year))) return;
        if (query.semester && (item.kind !== "course" || item.semester !== query.semester)) return;
        records.push({ resolved, item });
      });
      const order = query.order ?? (kind === "course" ? "title-asc" : "date-desc");
      records.sort((a, b) => {
        if (order === "title-asc") return a.item.title.localeCompare(b.item.title) || a.item.id.localeCompare(b.item.id);
        const da = dateOf(a.item), db = dateOf(b.item);
        if (da === null && db !== null) return 1;
        if (db === null && da !== null) return -1;
        if (da !== db && da !== null && db !== null) return order === "date-desc" ? db.localeCompare(da) : da.localeCompare(db);
        return a.item.id.localeCompare(b.item.id);
      });
      const { cursor: _cursor, ...filters } = query;
      const fingerprint = createHash("sha256").update(JSON.stringify({ kind, timeZone, filters: Object.fromEntries(Object.entries(filters).sort(([a], [b]) => a.localeCompare(b))), sources: options.config.sources, records: records.map(({ item }) => [item.id, item.title, dateOf(item), item.updatedAt]) })).digest("base64url");
      let offset = 0;
      if (query.cursor) {
        const match = /^n1\.([A-Za-z0-9_-]{43})\.(\d+)$/.exec(query.cursor);
        if (!match || match[1] !== fingerprint || !Number.isSafeInteger(Number(match[2])) || Number(match[2]) > records.length) throw new ContentServiceError("INVALID_QUERY", "Content or filters changed. Restart pagination.");
        offset = Number(match[2]);
      }
      const limit = query.limit ?? 12;
      const selected = records.slice(offset, offset + limit);
      await mapBounded(selected, 4, async record => {
        if (record.item.kind === "status") {
          const document = await reader.document(record.resolved);
          record.item.text = documentText(document);
          record.item = statusPreview(record.item, document);
        }
      });
      const hasMore = offset + selected.length < records.length;
      return { items: selected.map(record => record.item) as ContentByKind[K][], hasMore, nextCursor: hasMore ? `n1.${fingerprint}.${offset + selected.length}` : null };
    },
    async get<K extends ContentKind>(kind: K, slug: string): Promise<ContentDetail<ContentByKind[K]> | null> {
      if (!["status", "course", "study-note"].includes(kind)) return null;
      const reader = session();
      const resolved = await reader.resolve(slug, kind as ReleaseContentKind);
      if (!resolved) return null;
      const item = await reader.item(resolved);
      const document = await reader.document(resolved);
      if (item.kind === "status") {
        item.text = documentText(document);
      }
      return { item, document } as ContentDetail<ContentByKind[K]>;
    },
    async getStatusYears() {
      const reader = session();
      const ids = await reader.publishedIds("status");
      await reader.prefetchPages(ids);
      const items = await mapBounded(ids, 4, async id => {
        const resolved = await reader.resolve(id, "status");
        return resolved ? await reader.item(resolved, false) as StatusEntry : null;
      });
      return statusYears(items.filter((item): item is StatusEntry => item !== null), statusTimeZone(options));
    },
    async getHome() {
      const [statuses, courses] = await Promise.all([this.list("status", { limit: 4 }), this.list("course", { limit: 4 })]);
      return { featuredPosts: [], recentStatuses: statuses.items, latestAlbums: [], readingBooks: [], playingGames: [], featuredCourses: courses.items };
    },
    async getCourseTree(courseSlug: string, parentId?: string): Promise<CourseTree | null> {
      const reader = session();
      const course = await reader.resolve(courseSlug, "course");
      if (!course) return null;
      const courseId = normalizeId(course.page.id);
      if (parentId) {
        const parent = await reader.resolve(parentId, "study-note");
        if (!parent?.course || normalizeId(parent.course.page.id) !== courseId) return null;
      }
      const sources = options.config.sources.filter(source => source.enabled && source.kind === "study-note" && source.coursePageId === courseId);
      await reader.prepareStudyPages(sources);
      const ids = [...new Set(sources.flatMap(source => source.publication.allowlistPageIds))];
      await reader.prefetchPages(ids);
      const notes: StudyNote[] = [];
      await mapBounded(ids, 4, async id => {
        const resolved = await reader.resolve(id, "study-note");
        if (!resolved?.course || normalizeId(resolved.course.page.id) !== courseId) return;
        notes.push(await reader.item(resolved, false) as StudyNote);
      });
      notes.sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
      const childrenByParent = new Map<string | null, StudyNote[]>();
      for (const note of notes) {
        if (!childrenByParent.has(note.parentId)) childrenByParent.set(note.parentId, []);
        childrenByParent.get(note.parentId)!.push(note);
      }
      const build = (parent: string | null): StudyNode[] => (childrenByParent.get(parent) ?? []).map(note => {
        const children = build(note.id);
        return { id: note.id, title: note.title, href: note.href, hasChildren: children.length > 0, children, noteType: note.noteType, date: note.date };
      });
      return { courseId, nodes: build(parentId ? idOrNull(parentId) : null) };
    },
  };
}
