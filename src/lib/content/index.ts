import type { LibraryKind, ListQuery } from "../../../contracts/content.ts";
import { readLibraryFirstPageFrom } from "./library-page.ts";
import { getContentProvider } from "./provider.ts";
export { getContentProvider } from "./provider.ts";
import { publicRepository } from "../../server/public-cache/runtime.ts";
import { publicProjectionGeneration } from "../../server/public-cache/read.ts";
import "server-only";
import { cache } from "react";

import { type ContentRepository } from "../../../contracts/repository.ts";
import { getNotionRuntime } from "../../server/notion/runtime.ts";
import { getDatabaseRuntime } from "../../server/database/runtime.ts";
import { createGameTrophyReader } from "../../server/database/game-trophies.ts";
import { publicationMode } from "../../server/database/publication.ts";
import { getSiteConfig } from "../site/index.ts";
import { createContentService } from "./factory.ts";
import { readTimelineIndexSnapshot, hydrateTimelinePage } from "./website.ts";
import type { TimelineEvent } from "../../../contracts/website.ts";
import { contentFeatures } from "../../../config/features.ts";
import { measureContentRead, traceContentRead } from "../../server/content-read-timing.ts";
import { requestCourseMetadata } from "./request-course.ts";
import { requestStudyRepository } from "./request-study.ts";

const requestContentService = cache((_generation: string | undefined) => {
  const provider = getContentProvider();
  const repository = provider === "database" ? getDatabaseRuntime().repository : provider === "notion" ? getNotionRuntime().repository : undefined;
  const studyRepository=repository?requestStudyRepository(repository):undefined;
  const requestRepository = studyRepository ? { ...studyRepository, getCourseMetadata: (slug: string) => requestCourseMetadata(studyRepository,slug) } : undefined;
  return createContentService({ provider, timeZone: getSiteConfig().timeZone,
    notionRepository: provider === "notion" ? requestRepository : undefined,
    databaseRepository: provider === "database" ? requestRepository : undefined });
});
// A generation retry must also replace settled course/study memos from the same render.
const getContentService = () => requestContentService(publicProjectionGeneration());

/** Server components and route handlers use this entry point instead of individual adapters. */
const uncachedRepository: ContentRepository & Required<Pick<ContentRepository, "getContentMetadata" | "getCourseMetadata" | "getStatusYears" | "getLibraryYears" | "getPage" | "getTimeline" | "search">> = {
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
  getCourseTree: (courseSlug, parentId) => getContentService().repository.getCourseTree(courseSlug, parentId),
};

/** Full eligible timeline snapshot for the server-side mixed feed; never exposed directly over HTTP. */
export function readContentTimelineSnapshot() {
  return readTimelineIndexSnapshot(getContentService().repository, contentFeatures, getSiteConfig().timeZone);
}
export function readHomeTimelineSnapshot() {
  const service = getContentService();
  const display = service.provider === "database" ? getDatabaseRuntime().homeTimeline : undefined;
  return readTimelineIndexSnapshot(service.repository, contentFeatures, getSiteConfig().timeZone, display);
}
export function hydrateContentTimelinePage(events: TimelineEvent[], version: string) {
  return hydrateTimelinePage(getContentService().repository, contentFeatures, events, version, getSiteConfig().timeZone);
}

const cachedContentRepository = publicRepository("content", "contentRepository", uncachedRepository);
let gameTrophyReader: ReturnType<typeof createGameTrophyReader> | undefined;
export const contentRepository: typeof cachedContentRepository = {
  ...cachedContentRepository,
  async get(kind, slug) {
    const detail = await cachedContentRepository.get(kind, slug);
    if (kind !== "game" || !detail || getContentProvider() !== "database" || process.env.DATABASE_CONTENT_VERSION !== "2") return detail;
    const readSets = gameTrophyReader ??= createGameTrophyReader(
      getDatabaseRuntime().cacheStateDb, publicationMode(process.env.DATABASE_PUBLICATION_MODE));
    // Game-account privacy can change independently of a website content publication.
    const trophySets = await readSets(detail.item.id, slug);
    return trophySets.length ? { ...detail, trophySets } : detail;
  },
};

/** Live joint SSR entry: deliberately outside publicRepository's completed DTO cache. */
export function readLibraryFirstPage<K extends LibraryKind>(kind: K, query: ListQuery = {}) {
  return traceContentRead("works", kind, () => readLibraryFirstPageFrom(getContentService().repository, contentRepository, kind, query));
}
