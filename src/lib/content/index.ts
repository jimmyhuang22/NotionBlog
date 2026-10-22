import { publicRepository } from "../../server/public-cache/runtime.ts";
import "server-only";
import { cache } from "react";

import { ContentServiceError, type ContentRepository } from "../../../contracts/repository.ts";
import { getNotionRuntime } from "../../server/notion/runtime.ts";
import { getDatabaseRuntime } from "../../server/database/runtime.ts";
import { getSiteConfig } from "../site/index.ts";
import { createContentService, type ContentProvider } from "./factory.ts";
import { readTimelineIndexSnapshot, hydrateTimelinePage } from "./website.ts";
import type { TimelineEvent } from "../../../contracts/website.ts";
import { contentFeatures } from "../../../config/features.ts";
import { measureContentRead, traceContentRead } from "../../server/content-read-timing.ts";
import { requestCourseMetadata } from "./request-course.ts";
import { requestStudyRepository } from "./request-study.ts";

const getContentService = cache(() => {
  const provider = getContentProvider();
  const repository = provider === "database" ? getDatabaseRuntime().repository : provider === "notion" ? getNotionRuntime().repository : undefined;
  const studyRepository=repository?requestStudyRepository(repository):undefined;
  const requestRepository = studyRepository ? { ...studyRepository, getCourseMetadata: (slug: string) => requestCourseMetadata(studyRepository,slug) } : undefined;
  return createContentService({ provider, timeZone: getSiteConfig().timeZone,
    notionRepository: provider === "notion" ? requestRepository : undefined,
    databaseRepository: provider === "database" ? requestRepository : undefined });
});

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

/** The current provider is explicit; a real-provider failure never falls back to demo data. */
export function getContentProvider(): ContentProvider {
  const provider = process.env.CONTENT_PROVIDER ?? "mock";
  if (provider !== "mock" && provider !== "notion" && provider !== "database") throw new ContentServiceError("MISCONFIGURED", "Unsupported content provider configuration.");
  return provider;
}

/** Full eligible timeline snapshot for the server-side mixed feed; never exposed directly over HTTP. */
export function readContentTimelineSnapshot() {
  return readTimelineIndexSnapshot(getContentService().repository, contentFeatures, getSiteConfig().timeZone);
}
export function hydrateContentTimelinePage(events: TimelineEvent[], version: string) {
  return hydrateTimelinePage(getContentService().repository, contentFeatures, events, version, getSiteConfig().timeZone);
}

export const contentRepository = publicRepository("content", "contentRepository", uncachedRepository);
