import { directPageDenied, primeDirectDenials } from "./direct-policy.ts";
import { createHash } from "node:crypto";
import type { SearchContext, SearchSnapshot } from "../../../contracts/website.ts";
import { makeSearchContext } from "../../lib/content/search-context.ts";
import type { WebsiteRecord } from "../../../contracts/website-sync.ts";
import type { PageObjectResponse } from "@notionhq/client";
import type { AnyContent, ContentByKind, ContentDetail, ContentDocument, ContentKind, ContentLink, Course, CourseTree, DateRange, ImageAsset, ListQuery, Page, StatusEntry, StudyNode, StudyNote, StudyNoteType, TextRun } from "../../../contracts/content.ts";
import { ContentServiceError, type ContentRepository } from "../../../contracts/repository.ts";
import { validateListQuery, validateLibraryYearsQuery } from "../../lib/content/query.ts";
import { statusPreview, statusTimeZone, statusYears, type StatusReadOptions } from "../../lib/content/status.ts";
import { libraryYears, supportsYear } from "../../lib/content/years.ts";
import { buildNotionDocument, type RegisterBlockImageInput } from "./blocks.ts";
import { normalizeId } from "./config.ts";
import { assertWebsiteSourceSchema as assertSourceSchema } from "./website-config.ts";
import type { WebsiteNotionSource as NotionSource, WebsiteNotionConfig as NotionSourcesConfig } from "./website-config.ts";
import { compareContent, contentDate, matchesContent } from "../../lib/content/website.ts";
import { GAME_DATE_POLICY, projectGameDates } from "../../lib/content/game-date.ts";
import { isMoviePublicRating, normalizeMovieRatingSource } from "../../lib/content/movie-rating.ts";
import { configDigest } from "../database/validation.ts";
import { getDate, getLastPlayedDate, getFirstPlayedDate, getProperty, getRating, getSelect, getTags, getTitle, normalizeDateTime, getNumber, getValues, getPublicUrl } from "./properties.ts";
import { mapBounded } from "./bounded-work.ts";
import type { NotionReadClient } from "./types.ts";
import { AutomaticStudySession, studyOverride, type StudyDiscoveryProgress } from "./automatic-study.ts";
import { studyPreorder, studyTree, type StudyOrderEntry } from "./study-order.ts";
import { validateStudyCheckpoint, type StudyChangeSource, type StudyEntry, type StudyObservation, type StudyReadOptions } from "./study-incremental.ts";

export interface PublicNotionPage {
  page: PageObjectResponse;
  source: NotionSource;
  course: PublicNotionPage | null;
  /** Root note first; every ancestor independently passed publication checks. */
  ancestors: PageObjectResponse[];
}
export interface NotionRepository extends ContentRepository {
  /** Fresh owner/ancestor checks and this page's body, without enumerating whole sources. */
  collectRecord(id: string, input: { kind: ContentKind; ordinal: number; denied?: ReadonlySet<string> }): Promise<WebsiteRecord | null>;
  resolvePublicPage(id: string): Promise<PublicNotionPage | null>;
  /** Fresh single-owner checks without enumerating explicitly public sources. */
  resolveMediaOwner?(id: string): Promise<PublicNotionPage | null>;
  getCourseMetadata(courseSlug: string): Promise<Course | null>;
  collectRecords(documents?: boolean, denied?: ReadonlySet<string>): Promise<{ detail: ContentDetail<AnyContent>; evidence: { sourceKey: string; dataSourceId: string | null; databaseParentId: string | null; courseId: string | null; parentId: string | null; ordinal: number } }[]>;
}
/** Diagnostics only: completion is not a publication or resume checkpoint. */
export interface CollectionProgress {
  phase: "source-start" | "collecting" | "source-complete" | "complete";
  sourceIndex: number;
  sourceCount: number;
  sourcePages: number;
  sourceCompleted: number;
  recordsCompleted: number;
}
export interface NotionRepositoryOptions extends StatusReadOptions {
  client: NotionReadClient;
  config: NotionSourcesConfig;
  registerImage?: (input: RegisterBlockImageInput) => Promise<ImageAsset | null>;
  deniedPageIds?: ReadonlySet<string>;
  onStudyDiscoveryProgress?: (progress: StudyDiscoveryProgress) => void;
  collectionConcurrency?: number;
  /** Explicit background collection budget; interactive defaults stay at 16 MiB. */
  maxCollectionBytes?: number;
  onCollectionProgress?: (progress: CollectionProgress) => void;
  /** Worker-only page lifetime; no cache survives into interactive reads. */
  withCollectionPage?: <T>(owner: PublicNotionPage, work: () => Promise<T>) => Promise<T>;
  onCollectionPlan?: (ids: string[]) => Promise<void>;
  collectPage?: (owner: PublicNotionPage, ordinal: number) => Promise<WebsiteRecord>;
  onCollectedRecord?: (record: WebsiteRecord) => Promise<void>;
}

/** Private companion to one complete worker collection, never a browser DTO. */
export interface WebsiteStudyCollection {
  records: WebsiteRecord[];
  baseline: {
    format: "study-baseline-v1";
    sourceDigest: string;
    recordsDigest: string;
    entriesDigest: string;
    deniedDigest: string;
    sourceKeys: string[];
    entries: StudyEntry[];
  };
}

/** Capture ordering during the same complete collection used by the full
 * publisher. No second source scan, body download or image registration. */
export async function collectWebsiteStudyBaseline(options: NotionRepositoryOptions, denied: ReadonlySet<string> = new Set()): Promise<WebsiteStudyCollection> {
  const config = structuredClone(options.config);
  const sources = config.sources.filter(s => s.kind === "course" || s.kind === "study-note");
  const courses = sources.filter(s => s.kind === "course");
  if (!courses.length || sources.some(s => s.kind === "course" ? s.publication.mode !== "all" : s.publication.mode !== "course-descendants") ||
      courses.some(c => !sources.some(s => s.kind === "study-note" && s.dataSourceId === c.dataSourceId)) ||
      sources.some(s => s.kind === "study-note" && !courses.some(c => c.dataSourceId === s.dataSourceId))) {
    throw new ContentServiceError("MISCONFIGURED", "A complete automatic study configuration is required for the baseline.");
  }
  const deniedPageIds = new Set([...options.deniedPageIds ?? [], ...denied].map(normalizeId));
  let entries: StudyEntry[] | undefined;
  const records = await createWebsiteRepository({ ...options, config, deniedPageIds }, captured => { entries = captured; }).collectRecords(true, deniedPageIds);
  // Match the full publisher's removal of the navigation-only breadcrumb.
  for (const record of records) if (record.detail.item.kind === "study-note") record.detail.item.breadcrumbs = record.detail.item.breadcrumbs.filter(link => link.href !== "/study");
  const byId = new Map(records.map(record => [record.detail.item.id, record]));
  entries = entries!.map(entry => ({ ...entry, record: structuredClone(byId.get(entry.record.detail.item.id)!) }));
  validateStudyCheckpoint({ version: "collected", sourceDigest: configDigest(config), entries });
  return { records, baseline: {
    format: "study-baseline-v1", sourceDigest: configDigest(config), recordsDigest: configDigest(records),
    entriesDigest: configDigest(entries),
    deniedDigest: configDigest([...deniedPageIds].sort()), sourceKeys: sources.map(s => s.key).sort(), entries,
  } };
}

function idOrNull(value: string): string | null {
  try { return normalizeId(value); } catch { return null; }
}
function active(page: { in_trash?: boolean; archived?: boolean; is_archived?: boolean }): boolean {
  return !page.in_trash && !page.archived && !page.is_archived;
}
function dateOf(item: AnyContent): string | null {
  if (item.kind === "status") return item.recordedAt?.start ?? null;
  if (item.kind === "study-note") return item.date?.start ?? null;
  return contentDate(item)?.start ?? null;
}
function noteType(value: string | null): StudyNoteType {
  const type = value?.toLowerCase().trim();
  return ["course", "assignment", "summary", "note", "quiz", "test", "textbook", "tool"].includes(type ?? "") ? type as StudyNoteType : "unknown";
}
function titleOf(page: PageObjectResponse, source: NotionSource): string {
  return getTitle(page, source.fields.title) || (source.kind === "study-note" ? getTitle(page, Object.keys(page.properties).find(k => page.properties[k].type === "title") ?? "title") : "");
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

function hydrateBody(item:AnyContent,document:ContentDocument|null):void {
  if(!document)return;
  if(item.kind==="status")item.text=documentText(document);
  if(item.kind==="album"&&item.photoCount===null&&document.completeness==="complete") {
    let images=0;const visit=(blocks:ContentDocument["blocks"])=>{for(const b of blocks){if(b.type==="image")images++;if(b.type==="list")for(const i of b.items)visit(i.children);if(b.type==="callout"||b.type==="toggle")visit(b.children);if(b.type==="columns")for(const c of b.columns)visit(c.blocks);}};
    visit(document.blocks);item.photoCount=images;
  }
}

/** A session lives for one operation only; no public qualification survives to the next request. */
class ReadSession {
  private pages = new Map<string, Promise<PageObjectResponse | null>>();
  private blocks = new Map<string, ReturnType<NotionReadClient["getBlock"]>>();
  private schemas = new Map<string, Promise<void>>();
  private sourcePages = new Map<string, Promise<Map<string, PageObjectResponse>>>();
  private options: NotionRepositoryOptions;
  private automatic: AutomaticStudySession;
  constructor(options: NotionRepositoryOptions) {
    const deniedPageIds=new Set([...(options.deniedPageIds??[])].map(normalizeId));
    this.automatic = new AutomaticStudySession(options.client, options.config, deniedPageIds, options.onStudyDiscoveryProgress);
    this.options = { ...options, deniedPageIds, client: this.automatic.client };
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
      for (const page of await this.options.client.listPages!(source.dataSourceId!)) {
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
    if (source.publication.mode !== "all") throw new ContentServiceError("MISCONFIGURED", "Entire-source publication requires explicit configuration.");
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
    await primeDirectDenials(ids);
    await mapBounded([...new Set(ids)], 4, async id => await directPageDenied(id) ? null : this.page(id));
  }
  async sourceIds(source: NotionSource): Promise<string[]> {
    if (source.publication.mode === "course-descendants") return this.automatic.ids(source);
    return source.publication.mode === "all" ? [...(await this.queryPages(source)).keys()] : source.publication.allowlistPageIds;
  }
  async publishedIds(kind: ContentKind): Promise<string[]> {
    const ids = new Set<string>();
    for (const source of this.options.config.sources.filter(source => source.enabled && source.kind === kind)) {
      const sourceIds = await this.sourceIds(source);
      sourceIds.forEach(id => ids.add(id));
    }
    return [...ids];
  }
  private async schema(source: NotionSource) {
    if (source.kind === "page") return;
    if (!this.schemas.has(source.key)) this.schemas.set(source.key, (async () => {
      const schema = await this.options.client.getDataSource(source.dataSourceId!);
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

  async resolve(id: string, expectedKind?: ContentKind, trail: string[] = []): Promise<PublicNotionPage | null> {
    const canonical = idOrNull(id);
    if (!canonical || this.options.deniedPageIds?.has(canonical) || trail.includes(canonical) || trail.length >= 24 || await directPageDenied(canonical)) return null;
    // Resolve explicit note/course identities before unrelated automatic Status sources.
    const sources = this.options.config.sources.filter(source => source.enabled && (!expectedKind || source.kind === expectedKind))
      .sort((a, b) => Number(a.publication.mode === "all") - Number(b.publication.mode === "all"));
    for (const source of sources) {
      if (source.publication.mode === "course-descendants") {
        const resolved = await this.automatic.resolve(canonical, source);
        if (resolved) return resolved;
        continue;
      }
      // Exact reads use the active page and its direct source parent. Enumeration belongs to lists.
      const wholeSource = source.publication.mode === "all";
      const selected = wholeSource || source.publication.allowlistPageIds.includes(canonical);
      if (!selected) continue;
      const page = await this.page(canonical);
      if (!page || !active(page) || normalizeId(page.id) !== canonical) return null;
      if (source.kind === "page") return source.pageId === canonical ? { page, source, course: null, ancestors: [] } : null;
      const direct = page.parent.type === "data_source_id" && idOrNull(page.parent.data_source_id) === source.dataSourceId;
      if (wholeSource && !direct) continue;
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

  async item(resolved: PublicNotionPage, cover = true): Promise<AnyContent> {
    const { page, source } = resolved;
    const id = normalizeId(page.id);
    const courseId = resolved.course ? normalizeId(resolved.course.page.id) : null;
    const title = titleOf(page, source) || "未命名内容";
    const path = { post: "/blog", album: "/photos", book: "/library/books", movie: "/library/movies", game: "/library/games", project: "/projects" };
    const href = source.kind === "status" ? `/status#${id}` : source.kind === "course" ? `/study/${id}` : source.kind === "study-note" ? `/study/${courseId}/notes/${id}` : source.kind === "page" ? "/about" : `${path[source.kind]}/${id}`;
    const base = { id, kind: source.kind, slug: source.kind === "page" ? "about" : id, href, title, summary: getSelect(page, source.fields.summary), tags: getTags(page, source.fields.tags), cover: cover ? await this.cover(resolved) : null, updatedAt: normalizeDateTime(page.last_edited_time) };
    if (source.kind === "status") return { ...base, kind: "status", recordedAt: getDate(page, source.fields.recordedAt), text: [] };
    if (source.kind === "course") return {
      ...base, kind: "course", code: getSelect(page, source.fields.code)?.trim() || null,
      semester: getSelect(page, source.fields.semester),
      ratings: {
        experience: getRating(page, source.fields.experience ?? source.fields.experienceRating),
        usefulness: getRating(page, source.fields.usefulness ?? source.fields.usefulnessRating),
        recommendation: getRating(page, source.fields.recommendation ?? source.fields.recommendationRating),
        difficulty: getRating(page, source.fields.difficulty ?? source.fields.difficultyRating),
      },
    };
    const f = source.fields;
    const state = (allowed: readonly string[]) => { const label = getSelect(page, f.status); return label ? source.statusMap[label] ?? (allowed.includes(label) ? label : "unknown") : "unknown"; };
    if (source.kind === "page") return { ...base, kind: "page", pageKey: "about" };
    if (source.kind === "post") return { ...base, kind: "post", publishedAt: getDate(page, f.publishedAt) };
    if (source.kind === "album") return { ...base, kind: "album", date: getDate(page, f.date), photoCount: getNumber(page, f.photoCount) };
    if (source.kind === "book") {
      const pagesRead = getNumber(page, f.pagesRead), totalPages = getNumber(page, f.totalPages);
      return { ...base, kind: "book", authors: getValues(page, f.authors), status: state(["reading", "read", "wishlist", "given-up"]) as ContentByKind["book"]["status"], readingDate: getDate(page, f.readingDate), pagesRead, totalPages,
        progressPercent: pagesRead !== null && totalPages !== null && totalPages > 0 && pagesRead <= totalPages ? Math.round(pagesRead / totalPages * 1000) / 10 : null,
        personalRating: getRating(page, f.personalRating), doubanRating: getNumber(page, f.doubanRating), externalUrl: getPublicUrl(page, f.externalUrl) };
    }
    if (source.kind === "movie") {
      const mappedRating = getNumber(page, f.publicRating ?? f.doubanRating);
      const publicRating = isMoviePublicRating(mappedRating) ? mappedRating : null;
      // One invalid source field must not reject the whole collection. Never log page data.
      if (!isMoviePublicRating(mappedRating)) console.warn("NOTION_MOVIE_PUBLIC_RATING_INVALID");
      return { ...base, kind: "movie", originalTitle: getSelect(page, f.originalTitle), mediaType: getSelect(page, f.mediaType), status: state(["watched", "wishlist"]) as ContentByKind["movie"]["status"], watchedDate: getDate(page, f.watchedDate), releaseDate: getDate(page, f.releaseDate), director: getSelect(page, f.director), actors: getValues(page, f.actors), rating: getRating(page, f.rating), doubanRating: getNumber(page, f.doubanRating), publicRating,
        ratingSource: publicRating === null ? null : normalizeMovieRatingSource(getSelect(page, f.ratingSource)) };
    }
    if (source.kind === "game") {
      const minutes = getNumber(page, f.platformMinutes) ?? getNumber(page, f.steamMinutes), historical = getNumber(page, f.playedTime), estimated = getNumber(page, f.estimatedTime);
      return projectGameDates({ ...base, kind: "game", status: state(["clear", "platinumed", "playing", "wishlist"]) as ContentByKind["game"]["status"], platforms: getValues(page, f.platforms), playedDate: getDate(page, f.playedDate), lastPlayedDate: getLastPlayedDate(page, f.lastPlayedDate), firstPlayedDate: getFirstPlayedDate(page, f.firstPlayedDate), releaseDate: getDate(page, f.releaseDate),
        playedTime: minutes !== null ? { value: minutes, unit: "minute" } : historical !== null && source.playedTimeUnit ? { value: historical, unit: source.playedTimeUnit } : null,
        estimatedTime: estimated !== null && source.playedTimeUnit ? { value: estimated, unit: source.playedTimeUnit } : null, progressPercent: null, rating: getRating(page, f.rating) }, statusTimeZone(this.options));
    }
    if (source.kind === "project") return { ...base, kind: "project", period: getDate(page, f.period), role: getSelect(page, f.role), stack: getValues(page, f.stack), links: [["代码", getPublicUrl(page, f.repositoryUrl)], ["演示", getPublicUrl(page, f.demoUrl)]].filter((link): link is [string, string] => link[1] !== null).map(([label, url]) => ({ label, url })) };
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

  private async courseDatabaseRepresented(resolved: PublicNotionPage, databaseId: string): Promise<boolean> {
    const source = resolved.source, courseId = normalizeId(resolved.page.id);
    if (source.kind !== "course" || source.publication.mode !== "all" ||
        resolved.page.parent.type !== "data_source_id" || normalizeId(resolved.page.parent.data_source_id) !== source.dataSourceId ||
        this.options.deniedPageIds?.has(databaseId) || !this.options.client.getDatabase ||
        !this.options.config.sources.some(s => s.enabled && s.kind === "study-note" &&
          s.publication.mode === "course-descendants" && s.dataSourceId === source.dataSourceId)) return false;
    const database = await this.options.client.getDatabase(databaseId);
    if (!active(database) || normalizeId(database.id) !== databaseId ||
        database.parent.type !== "page_id" || normalizeId(database.parent.page_id) !== courseId) return false;
    for (const item of database.data_sources) {
      const schema = await this.options.client.getDataSource(item.id);
      if (!active(schema) || normalizeId(schema.id) !== normalizeId(item.id) ||
          schema.parent.type !== "database_id" || normalizeId(schema.parent.database_id) !== databaseId ||
          schema.database_parent.type !== "page_id" || normalizeId(schema.database_parent.page_id) !== courseId) continue;
      if (Object.values(schema.properties).some(p => p.type === "title")) {
        return true;
      }
    }
    return false;
  }

  async document(resolved: PublicNotionPage): Promise<ContentDocument> {
    return buildNotionDocument(normalizeId(resolved.page.id), this.options.client, {
      resolvePageLink: id => this.link(id),
      ...(resolved.source.kind === "course" ? { isCourseDatabaseRepresented: (id: string) => this.courseDatabaseRepresented(resolved, id) } : {}),
      registerImage: input => this.options.registerImage?.(input) ?? Promise.resolve(null),
      canonicalImageUrls: true,
      inlineEquations: true,
      pageMentions: true,
      externalVideos: true,
    });
  }
  async studyChange(id:string,flags:StudyReadOptions):Promise<StudyObservation> {
    id=normalizeId(id);
    if(this.options.deniedPageIds?.has(id))return {state:"withdrawn",reason:"denied"};
    const page=await this.page(id);
    // Notion object_not_found can also mean lost access. It cannot authorize a
    // deletion; unknown availability aborts this delta and leaves state alone.
    if(!page)throw new ContentServiceError("CONTENT_UNAVAILABLE","A changed study page is unavailable.");
    if(!active(page))return {state:"withdrawn",reason:"archived"};
    const resolved=await this.resolve(id,"study-note")??await this.resolve(id,"course");
    if(!resolved)return {state:"withdrawn",reason:"out-of-scope"};
    if(flags.document&&!this.options.registerImage)throw new ContentServiceError("MISCONFIGURED","Study body updates require an explicit media preparation port.");
    const item=await this.item(resolved,flags.document),courseId=resolved.course?normalizeId(resolved.course.page.id):null;
    const ancestors=resolved.course?[normalizeId(resolved.course.page.id),...resolved.ancestors.map(p=>normalizeId(p.id))]:[];
    if(item.kind==="study-note")item.breadcrumbs=item.breadcrumbs.filter(link=>link.href!=="/study");
    const noteSource=this.options.config.sources.find(s=>s.kind==="study-note"&&s.publication.mode==="course-descendants"&&s.dataSourceId===resolved.source.dataSourceId);
    if(!noteSource)throw new ContentServiceError("MISCONFIGURED","Study changes require the configured automatic source.");
    const children=flags.children?await this.automatic.children(noteSource,id,courseId??id):undefined;
    const document=flags.document?await this.document(resolved):null;
    return {state:"active",entry:{record:{detail:{item,document},evidence:{sourceKey:resolved.source.key,dataSourceId:resolved.source.dataSourceId,
      databaseParentId:null,courseId,parentId:ancestors.at(-1)??null,ordinal:0}},override:studyOverride(page,resolved.source),position:null},ancestors,
      ...(children?{children:children.map(c=>({...c,updatedAt:normalizeDateTime(c.updatedAt)}))}:{})};
  }
  async orderedNotes(sources: NotionSource[], courseId?: string): Promise<StudyNote[]> {
    const entries: StudyOrderEntry[] = [], automaticOrder = new Map<string, number>();
    for (const source of sources) {
      const ids = source.publication.mode === "course-descendants" ? await this.automatic.ids(source, courseId) : await this.sourceIds(source);
      for (const [position, id] of ids.entries()) {
        const resolved = await this.resolve(id, "study-note");
        if (!resolved || (courseId && normalizeId(resolved.course!.page.id) !== courseId)) continue;
        const item = await this.item(resolved, false) as StudyNote;
        entries.push({ item, override: studyOverride(resolved.page, resolved.source) });
        if (source.publication.mode === "course-descendants") automaticOrder.set(id, position);
      }
    }
    const positions = new Map<string, Map<string, number>>();
    for (const entry of entries) if (entry.item.parentId !== null) {
      if (automaticOrder.has(entry.item.id)) entry.bodyPosition = automaticOrder.get(entry.item.id);
      else {
        const parent = entry.item.parentId;
        if (!positions.has(parent)) positions.set(parent, await this.automatic.childPositions(parent));
        entry.bodyPosition = positions.get(parent)!.get(entry.item.id);
      }
    }
    const courses = [...new Set(entries.map(e => e.item.courseId))].sort();
    return courses.flatMap(id => studyPreorder(entries.filter(e => e.item.courseId === id)));
  }
}

/** Worker-only adapter. A delta opens a fresh session, reuses reads inside it,
 * and never retains qualification or source metadata for the next operation. */
export function createWebsiteStudyChangeSource(options:NotionRepositoryOptions):StudyChangeSource {
  if(!options.config.sources.some(s=>s.kind==="study-note"&&s.publication.mode==="course-descendants"))
    throw new ContentServiceError("MISCONFIGURED","Automatic study source configuration is required.");
  const supplied=options.registerImage;
  const config=structuredClone(options.config),sourceDigest=configDigest(config);
  const openOperation=():StudyChangeSource=>{
    const session=new ReadSession({...options,config,
    ...(supplied?{registerImage:async input=>{
      const image=await supplied(input);if(!image)throw new ContentServiceError("CONTENT_UNAVAILABLE","Study media preparation was incomplete.");return image;
    }}:{})});
    return {sourceDigest,read:(id,flags)=>session.studyChange(id,flags)};
  };
  return {sourceDigest,openOperation,read:(id,flags)=>openOperation().read(id,flags)};
}

export function createWebsiteNotionRepository(options: NotionRepositoryOptions): NotionRepository {
  return createWebsiteRepository(options);
}
function createWebsiteRepository(options: NotionRepositoryOptions, captureStudy?: (entries: StudyEntry[]) => void): NotionRepository {
  options = { ...options, timeZone: options.timeZone ?? options.config.timeZone };
  const session = (denied = options.deniedPageIds) => new ReadSession({ ...options, deniedPageIds: denied });
  const readSnapshot = async (kinds: ContentKind[], documents = false, withContext = false): Promise<SearchSnapshot> => {
      const reader = session(), records: ContentDetail<AnyContent>[] = [];
      const searchContexts: Record<string, SearchContext | null> = {};
      for (const kind of [...new Set(kinds)]) {
        const ids = await reader.publishedIds(kind);
        if (records.length + ids.length > 20000) throw new ContentServiceError("CONTENT_UNAVAILABLE", "Public snapshot exceeds the supported size.");
        await reader.prefetchPages(ids);
        const selected = await mapBounded(ids, 4, async id => {
          const resolved = await reader.resolve(id, kind);
          if (!resolved) return null;
          const item = await reader.item(resolved), document = documents || kind === "status" ? await reader.document(resolved) : null;
          if (withContext && item.kind === "study-note") searchContexts[item.id] = resolved.course
            ? makeSearchContext(getSelect(resolved.course.page, resolved.course.source.fields.code), titleOf(resolved.course.page, resolved.course.source), resolved.ancestors.map(page => titleOf(page, resolved.source)), normalizeId(resolved.course.page.id)) : null;
          hydrateBody(item, document);
          return { item, document };
        });
        records.push(...selected.filter((x): x is ContentDetail<AnyContent> => x !== null));
      }
      records.sort((a, b) => a.item.id.localeCompare(b.item.id));
      return { version: configDigest([options.config, records, ...(withContext ? [searchContexts] : [])]), records, ...(withContext ? { searchContexts } : {}) };
  };
  return {
    async getContentMetadata<K extends ContentKind>(kind: K, slug: string): Promise<ContentByKind[K] | null> {
      const reader = session();
      if (kind === "page" && slug !== "about") return null;
      const identity = kind === "page" ? options.config.sources.find(source => source.kind === "page" && source.pageKey === "about")?.pageId : slug;
      if (!identity) return null;
      const resolved = await reader.resolve(identity, kind);
      return resolved ? await reader.item(resolved, false) as ContentByKind[K] : null;
    },
    async getPage(key) {
      if (key !== "about") return null;
      const source = options.config.sources.find(s => s.kind === "page" && s.pageKey === key);
      if (!source?.pageId) return null;
      const reader = session(), resolved = await reader.resolve(source.pageId, "page");
      if (!resolved) return null;
      const item = await reader.item(resolved, false);
      return { slug: "about", title: item.title, updatedAt: item.updatedAt, document: await reader.document(resolved) };
    },
    readSnapshot,
    readSearchSnapshot: kinds => readSnapshot(kinds, true, true),
    async collectRecords(documents = true, denied: ReadonlySet<string> = new Set()) {
      const maxCollectionBytes = options.maxCollectionBytes ?? 16 * 1024 * 1024;
      if (!Number.isSafeInteger(maxCollectionBytes) || maxCollectionBytes < 1 || maxCollectionBytes > 64 * 1024 * 1024) throw new ContentServiceError("MISCONFIGURED", "Invalid collection byte budget.");
      const concurrency = options.collectionConcurrency ?? 1;
      if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new ContentServiceError("MISCONFIGURED", "Invalid collection concurrency.");
      const excluded=new Set([...(options.deniedPageIds??[]),...denied].map(normalizeId));
      const reader = session(excluded), records = [];
      const studyEntries: StudyEntry[] = [];
      let snapshotBytes=2;
      // Discover all automatic study ownership once before downloading media.
      // The session reuses these body reads when mapping the actual AST.
      for(const source of options.config.sources)if(source.publication.mode==="course-descendants")await reader.sourceIds(source);
      const studyOrdinals=documents?new Map((await reader.orderedNotes(options.config.sources.filter(s=>s.kind==="study-note"))).map((note,index)=>[note.id,index])):new Map<string,number>();
      const selectedIds = new Map<string, string[]>();
      if (options.onCollectionPlan) {
        for (const source of options.config.sources) selectedIds.set(source.key, await reader.sourceIds(source));
        await options.onCollectionPlan([...new Set([...selectedIds.values()].flat())]);
      }
      for (const [sourceIndex, source] of options.config.sources.entries()) {
        const ids = selectedIds.get(source.key) ?? await reader.sourceIds(source);
        if(records.length+ids.length>20000)throw new ContentServiceError("CONTENT_UNAVAILABLE","Website snapshot exceeds supported size.");
        await reader.prefetchPages(ids);
        let sourceCompleted = 0, recordsCompleted = records.length;
        const emit = (phase: CollectionProgress["phase"]) => options.onCollectionProgress?.({ phase,
          sourceIndex: sourceIndex + 1, sourceCount: options.config.sources.length, sourcePages: ids.length, sourceCompleted, recordsCompleted });
        emit("source-start");
        const selected = await mapBounded([...ids.entries()], concurrency, async ([sourceOrdinal, id]) => {
          if (excluded.has(id) || (source.coursePageId && excluded.has(source.coursePageId))) return null;
          const resolved = await reader.resolve(id, source.kind);
          if (!resolved || resolved.source.key !== source.key) throw new ContentServiceError("CONTENT_UNAVAILABLE", "A selected page could not be completely verified.");
          if (resolved.ancestors.some(p => excluded.has(normalizeId(p.id)))) return null;
          const collect = async () => {
          const ordinal=studyOrdinals.get(id)??sourceOrdinal;
          const supplied = documents && options.collectPage ? await options.collectPage(resolved, ordinal) : null;
          const item = supplied?.detail.item ?? await reader.item(resolved), document = supplied ? supplied.detail.document : documents ? await reader.document(resolved) : null;
          hydrateBody(item, document);
          const courseId = resolved.course ? normalizeId(resolved.course.page.id) : null;
          const parentId = source.kind === "study-note" ? resolved.ancestors.length ? normalizeId(resolved.ancestors.at(-1)!.id) : courseId : null;
          const record={ detail: { item, document }, evidence: { sourceKey: source.key, dataSourceId: source.dataSourceId, databaseParentId: source.kind === "study-note" ? source.coursePageId : null, courseId, parentId, ordinal } };
          snapshotBytes+=Buffer.byteLength(JSON.stringify(record))+1;
          if(snapshotBytes>maxCollectionBytes)throw new ContentServiceError("CONTENT_UNAVAILABLE","Website snapshot exceeds supported size.");
          const entry = captureStudy && (item.kind === "course" || item.kind === "study-note") ? {
            record, override: studyOverride(resolved.page, resolved.source), position: item.kind === "study-note" ? ordinal : null,
          } : null;
          return { record, entry };
          };
          const result = options.withCollectionPage ? await options.withCollectionPage(resolved, collect) : await collect();
          await options.onCollectedRecord?.(structuredClone(result.record));
          sourceCompleted++; recordsCompleted++; emit("collecting");
          return result;
        });
        // Results retain source order even when a later page finishes first.
        for (const result of selected) if (result) {
          records.push(result.record);
          if (result.entry) studyEntries.push(result.entry);
        }
        emit("source-complete");
      }
      if (records.length > 20000 || Buffer.byteLength(JSON.stringify(records)) > maxCollectionBytes) throw new ContentServiceError("CONTENT_UNAVAILABLE", "Website snapshot exceeds supported size.");
      // Automatic note admission requires its course and parent to be staged
      // first. Preserve each source's precomputed directory ordinal.
      const staged = new Set<string>(), ordered: typeof records = [];
      let pending = records;
      while (pending.length) {
        const next: typeof records = [];
        for (const record of pending) {
          if (record.evidence.parentId !== null && !staged.has(record.evidence.parentId)) { next.push(record); continue; }
          staged.add(record.detail.item.id); ordered.push(record);
        }
        if (next.length === pending.length) throw new ContentServiceError("CONTENT_UNAVAILABLE", "Invalid study parent order.");
        pending = next;
      }
      // A failed/partial traversal never exposes a baseline companion.
      if (captureStudy) {
        validateStudyCheckpoint({ version: "collected", sourceDigest: configDigest(options.config), entries: studyEntries.map(entry => {
          const record = structuredClone(entry.record);
          if (record.detail.item.kind === "study-note") record.detail.item.breadcrumbs = record.detail.item.breadcrumbs.filter(link => link.href !== "/study");
          return { ...entry, record };
        }) });
        captureStudy(studyEntries);
      }
      options.onCollectionProgress?.({ phase: "complete", sourceIndex: options.config.sources.length,
        sourceCount: options.config.sources.length, sourcePages: 0, sourceCompleted: 0, recordsCompleted: ordered.length });
      return ordered;
    },
    async collectRecord(id, input) {
      if (!Number.isSafeInteger(input.ordinal) || input.ordinal < 0 || input.ordinal > 2147483647) {
        throw new ContentServiceError("MISCONFIGURED", "A valid source or directory ordinal is required.");
      }
      const deniedPageIds = new Set([...options.deniedPageIds ?? [], ...input.denied ?? []].map(normalizeId));
      const reader = new ReadSession({ ...options, deniedPageIds });
      const resolved = await reader.resolve(id, input.kind);
      if (!resolved) return null;
      const item = await reader.item(resolved), document = await reader.document(resolved);
      hydrateBody(item, document);
      const courseId = resolved.course ? normalizeId(resolved.course.page.id) : null;
      const parentId = resolved.source.kind === "study-note"
        ? resolved.ancestors.length ? normalizeId(resolved.ancestors.at(-1)!.id) : courseId : null;
      return { detail: { item, document }, evidence: { sourceKey: resolved.source.key,
        dataSourceId: resolved.source.dataSourceId, databaseParentId: resolved.source.kind === "study-note" ? resolved.source.coursePageId : null,
        courseId, parentId, ordinal: input.ordinal } };
    },
    resolvePublicPage: id => session().resolve(id),
    resolveMediaOwner: id => new ReadSession(options).resolve(id),
    async getCourseMetadata(courseSlug) {
      const reader = session();
      const course = await reader.resolve(courseSlug, "course");
      return course ? await reader.item(course) as Course : null;
    },
    async list<K extends ContentKind>(kind: K, query: ListQuery = {}): Promise<Page<ContentByKind[K]>> {
      validateListQuery(kind, query);
      const reader = session();
      const ids = await reader.publishedIds(kind as ContentKind);
      const timeZone = supportsYear(kind) ? statusTimeZone(options) : "UTC";
      await reader.prefetchPages(ids);
      const records: { resolved: PublicNotionPage; item: AnyContent }[] = [];
      // Status may opt into its complete source; other kinds remain individually selected.
      await mapBounded(ids, 4, async id => {
        const resolved = await reader.resolve(id, kind as ContentKind);
        if (!resolved) return;
        const item = await reader.item(resolved);
        if (!matchesContent(item, query, timeZone)) return;
        records.push({ resolved, item });
      });
      const order = query.order ?? (kind === "course" ? "title-asc" : "date-desc");
      records.sort((a, b) => compareContent(a.item, b.item, order, timeZone));
      const { cursor: _cursor, ...filters } = query;
      const fingerprint = createHash("sha256").update(JSON.stringify({ kind, timeZone, ...(kind === "game" ? { gameDatePolicy: GAME_DATE_POLICY } : {}), filters: Object.fromEntries(Object.entries(filters).sort(([a], [b]) => a.localeCompare(b))), sources: options.config.sources, records: records.map(({ item }) => [item.id, item.title, dateOf(item), item.updatedAt]) })).digest("base64url");
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
      return { items: selected.map(record => record.item) as ContentByKind[K][], total: records.length, hasMore, nextCursor: hasMore ? `n1.${fingerprint}.${offset + selected.length}` : null };
    },
    async get<K extends ContentKind>(kind: K, slug: string): Promise<ContentDetail<ContentByKind[K]> | null> {
      const reader = session();
      if (kind === "page" && slug !== "about") return null;
      const identity = kind === "page" && slug === "about" ? options.config.sources.find(s => s.kind === "page" && s.pageKey === "about")?.pageId : slug;
      if (!identity) return null;
      const resolved = await reader.resolve(identity, kind as ContentKind);
      if (!resolved) return null;
      const item = await reader.item(resolved);
      const document = await reader.document(resolved);
      hydrateBody(item, document);
      return { item, document } as ContentDetail<ContentByKind[K]>;
    },
    async getLibraryYears(kind, query = {}) {
      validateLibraryYearsQuery(kind, query);
      const reader = session(), timeZone = statusTimeZone(options);
      const ids = await reader.publishedIds(kind);
      if (ids.length > 20000) throw new ContentServiceError("CONTENT_UNAVAILABLE", "Public snapshot exceeds the supported size.");
      await reader.prefetchPages(ids);
      const items = await mapBounded(ids, 4, async id => {
        const resolved = await reader.resolve(id, kind);
        return resolved ? await reader.item(resolved, false) : null;
      });
      return libraryYears(items.filter((item): item is AnyContent => item !== null && matchesContent(item, query, timeZone)), timeZone);
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
      const [posts,statuses,albums,books,games,courses]=await Promise.all([this.list("post",{limit:3}),this.list("status",{limit:12}),this.list("album",{limit:3}),this.list("book",{status:"reading",limit:3}),this.list("game",{status:"playing",limit:3}),this.list("course",{limit:6})]);
      return {featuredPosts:posts.items,recentStatuses:statuses.items,latestAlbums:albums.items,readingBooks:books.items,playingGames:games.items,featuredCourses:courses.items};
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
      const sources = options.config.sources.filter(source => source.enabled && source.kind === "study-note" &&
        (source.coursePageId === courseId || (source.publication.mode === "course-descendants" && source.dataSourceId === course.source.dataSourceId)));
      await reader.prepareStudyPages(sources);
      const notes = await reader.orderedNotes(sources, courseId);
      return studyTree(notes, courseId, parentId ? idOrNull(parentId) ?? undefined : undefined);
    },
  };
}
