import "server-only";
import { cache } from "react";
import { contentRepository, getContentProvider } from "@/lib/content";
import { isEnabledContentKind } from "../../config/features.ts";

/**
 * Per-request memoisation only (React cache lives for one render). Metadata, the page and
 * its Suspense sections share one upstream read; nothing is kept between requests.
 */
export const getCourse = cache((slug: string) => contentRepository.get("course", slug));
export const getCourseMetadata = cache((slug: string) => contentRepository.getCourseMetadata(slug));
export const getStudyNote = cache(async (course: string, slug: string) => {
  if (process.env.DATABASE_STUDY_URLS === "title" && getContentProvider() === "database") {
    return (await contentRepository.readStudyNote(course, slug)) ?? { course: null, note: null };
  }
  const [owner, note] = await Promise.all([getCourseMetadata(course), contentRepository.get("study-note", slug)]);
  return { course: owner, note };
});
export const getCourseTree = cache((slug: string) => contentRepository.getCourseTree(slug));

/**
 * Whether the about page can be read right now: switched on and actually published. A slow or
 * failed check counts as no, so nothing offers a way into a page that may not be there.
 */
export const isAboutAvailable = cache(async (): Promise<boolean> => {
  if (!isEnabledContentKind("page")) return false;
  try { return !!await contentRepository.getContentMetadata("page", "about"); }
  catch { return false; }
});
