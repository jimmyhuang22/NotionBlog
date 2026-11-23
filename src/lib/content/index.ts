import type { ContentKind, LibraryKind, ListQuery } from "../../../contracts/content.ts";
import { readLibraryFirstPageFrom } from "./library-page.ts";
import { getContentProvider } from "./provider.ts";
export { getContentProvider } from "./provider.ts";
import { publicRepository } from "../../server/public-cache/runtime.ts";
import { publicProjectionGeneration } from "../../server/public-cache/read.ts";
import "server-only";
import { cache } from "react";

import { ContentServiceError, type ContentRepository } from "../../../contracts/repository.ts";
import { getNotionRuntime } from "../../server/notion/runtime.ts";
import { getDatabaseRuntime } from "../../server/database/runtime.ts";
import { createLibraryUrlProjection } from "../../server/database/library-urls.ts";
import { createStudyUrlProjection } from "../../server/database/study-urls.ts";
import { createCombinedGameTrophyReader } from "../../server/database/game-trophies.ts";
import { publicationMode } from "../../server/database/publication.ts";
import { getSiteConfig } from "../site/index.ts";
import { createContentService } from "./factory.ts";
import { readTimelineIndexSnapshot, hydrateTimelinePage } from "./website.ts";
import type { TimelineEvent } from "../../../contracts/website.ts";
import { contentFeatures } from "../../../config/features.ts";
import { measureContentRead, traceContentRead } from "../../server/content-read-timing.ts";
import { requestCourseMetadata } from "./request-course.ts";
import { requestStudyRepository } from "./request-study.ts";
import { readRecentGamesFrom } from "./recent-games.ts";

function databaseLibraryUrls(runtime: ReturnType<typeof getDatabaseRuntime>) {
  const mode = process.env.DATABASE_LIBRARY_URLS ?? "legacy";
  if (mode === "legacy") return undefined;
  if (mode !== "title" || process.env.DATABASE_CONTENT_VERSION !== "2") {
    throw new ContentServiceError("MISCONFIGURED", "Title-based library URLs require database v2.");
  }
  return createLibraryUrlProjection(runtime.cacheStateDb, publicationMode(process.env.DATABASE_PUBLICATION_MODE), process.env.SITE_URL);
}

function databaseStudyUrls(runtime: ReturnType<typeof getDatabaseRuntime>) {
  const mode = process.env.DATABASE_STUDY_URLS ?? "legacy";
  if (mode === "legacy") return undefined;
  if (mode !== "title" || process.env.DATABASE_CONTENT_VERSION !== "2") {
    throw new ContentServiceError("MISCONFIGURED", "Title-based study URLs require database v2.");
  }
  return createStudyUrlProjection(runtime.cacheStateDb, publicationMode(process.env.DATABASE_PUBLICATION_MODE), process.env.SITE_URL);
}

const requestContentService = cache((_generation: string | undefined) => {
  const provider = getContentProvider();
  const database = provider === "database" ? getDatabaseRuntime() : undefined;
  const repository = database ? databaseLibraryUrls(database)?.repository(database.repository) ?? database.repository
    : provider === "notion" ? getNotionRuntime().repository : undefined;
  const studyUrls = database && databaseStudyUrls(database);
  const studyRepository = repository && (studyUrls ? studyUrls.repository(repository) : requestStudyRepository(repository));
  const requestRepository = studyRepository ? { ...studyRepository, getCourseMetadata: (slug: string) => requestCourseMetadata(studyRepository,slug) } : undefined;
  return createContentService({ provider, timeZone: getSiteConfig().timeZone,
    notionRepository: provider === "notion" ? requestRepository : undefined,
    databaseRepository: provider === "database" ? requestRepository : undefined });
});
// A generation retry must also replace settled course/study memos from the same render.
const getContentService = () => requestContentService(publicProjectionGeneration());

/** Server components and route handlers use this entry point instead of individual adapters. */
const uncachedRepository: ContentRepository & Required<Pick<ContentRepository, "getContentMetadata" | "getCourseMetadata" | "getStatusYears" | "getLibraryYears" | "getPage" | "getTimeline" | "search" | "readStudyNote">> = {
  getContentMetadata: (kind, slug) => traceContentRead("metadata", kind, () => measureContentRead("service", getContentService).repository.getContentMetadata!(kind, slug)),
  list: (kind, query) => getContentService().repository.list(kind, query),
  get: (kind, slug) => traceContentRead("detail", kind, () => measureContentRead("service", getContentService).repository.get(kind, slug)),
  getPage: key => getContentService().repository.getPage!(key),
  getTimeline: query => getContentService().repository.getTimeline!(query),
  search: query => traceContentRead("search", "unknown", () => measureContentRead("service", getContentService).repository.search!(query)),
  getHome: () => getContentService().repository.getHome(),
  getStatusYears: () => getContentService().repository.getStatusYears!(),
  getLibraryYears: (kind, query) => getContentService().repository.getLibraryYears!(kind, query),
  getCourseMetadata: courseSlug => getContentService().repository.getCourseMetadata!(courseSlug),
  isStudyNoteAvailable: (courseSlug,noteSlug) => traceContentRead("metadata","study-note",async () => {
    const repository = measureContentRead("service",getContentService).repository;
    if (repository.isStudyNoteAvailable) return repository.isStudyNoteAvailable(courseSlug,noteSlug);
    const course = await repository.getCourseMetadata!(courseSlug);
    const note = course ? await repository.getContentMetadata!("study-note",noteSlug) : null;
    return !!course && !!note && note.courseId === course.id;
  }),
  readStudyNote: (courseSlug, noteSlug) => traceContentRead("detail", "study-note", async () => {
    const repository = measureContentRead("service", getContentService).repository;
    return repository.readStudyNote?.(courseSlug, noteSlug) ?? null;
  }),
  getCourseTree: (courseSlug, parentId) => getContentService().repository.getCourseTree(courseSlug, parentId),
};

/** Full eligible timeline snapshot for the server-side mixed feed; never exposed directly over HTTP. */
export function readContentTimelineSnapshot() {
  return readTimelineIndexSnapshot(getContentService().repository, contentFeatures, getSiteConfig().timeZone);
}
export function readHomeTimelineSnapshot() {
  const service = getContentService();
  const database = service.provider === "database" ? getDatabaseRuntime() : undefined;
  const display = database?.homeTimeline;
  const libraryUrls = database && display ? databaseLibraryUrls(database) : undefined;
  const studyUrls = database && display ? databaseStudyUrls(database) : undefined;
  const index = display && (libraryUrls || studyUrls) ? { ...display, readIndex: (kinds: ContentKind[]) => {
    const snapshot = display.readIndex(kinds);
    const works = libraryUrls ? libraryUrls.project(snapshot) : snapshot;
    return studyUrls ? studyUrls.project(works) : works;
  } } : display;
  return readTimelineIndexSnapshot(service.repository, contentFeatures, getSiteConfig().timeZone, index);
}
export function hydrateContentTimelinePage(events: TimelineEvent[], version: string) {
  return hydrateTimelinePage(getContentService().repository, contentFeatures, events, version, getSiteConfig().timeZone);
}

const cachedContentRepository = publicRepository("content", "contentRepository", uncachedRepository);
let gameTrophyReader: ReturnType<typeof createCombinedGameTrophyReader> | undefined;
export const contentRepository: typeof cachedContentRepository = {
  ...cachedContentRepository,
  async get(kind, slug) {
    const detail = await cachedContentRepository.get(kind, slug);
    if (kind !== "game" || !detail || getContentProvider() !== "database" || process.env.DATABASE_CONTENT_VERSION !== "2") return detail;
    const runtime = getDatabaseRuntime();
    const readSets = gameTrophyReader ??= createCombinedGameTrophyReader(
      runtime.cacheStateDb, publicationMode(process.env.DATABASE_PUBLICATION_MODE));
    // Game-account privacy can change independently of a website content publication.
    const storageSlug = process.env.DATABASE_LIBRARY_URLS === "title" ? detail.item.id : slug;
    const trophySets = await readSets(detail.item.id, storageSlug);
    return trophySets.length ? { ...detail, trophySets } : detail;
  },
};

/** Live joint SSR entry: deliberately outside publicRepository's completed DTO cache. */
export function readLibraryFirstPage<K extends LibraryKind>(kind: K, query: ListQuery = {}) {
  return traceContentRead("works", kind, () => readLibraryFirstPageFrom(getContentService().repository, contentRepository, kind, query));
}

// Recheck the current publication for each render. React only shares this read within the render.
export const readRecentGames = cache(() =>
  readRecentGamesFrom(getContentService().repository, getSiteConfig().timeZone));
