import type { ContentFeatures } from "../../config/features.ts";
import type { ContentRepository } from "../../contracts/repository.ts";
import { readStatusFocus } from "./status-focus.ts";

const libraryKinds = { games: "game", movies: "movie", books: "book" } as const;
const sectionKinds = { blog: "post", photos: "album", projects: "project" } as const;
export interface RouteLookups { studyProject?: (slug: string) => Promise<boolean> }

/** Metadata-only eligibility checks; upstream failures propagate instead of becoming 404s. */
export async function qualifyRoute(pathname: string, features: ContentFeatures, repository: ContentRepository, query?: URLSearchParams, lookups: RouteLookups = {}): Promise<boolean> {
  let parts: string[];
  try { parts = pathname.split("/").filter(Boolean).map(part => decodeURIComponent(part)); }
  catch { return false; }
  if (parts.some(part => part.includes("/") || part.includes("\\"))) return false;
  const [section, slug, child, noteSlug] = parts;
  const metadata = <K extends keyof ContentFeatures>(kind: K, key: string) => repository.getContentMetadata
    ? repository.getContentMetadata(kind, key)
    : repository.get(kind, key).then(detail => detail?.item ?? null);
  if (section === "about") return parts.length === 1 && features.page && !!await metadata("page", "about");
  if (Object.hasOwn(sectionKinds, section)) {
    const kind = sectionKinds[section as keyof typeof sectionKinds];
    return parts.length <= 2 && features[kind] && (parts.length === 1 || !!await metadata(kind, slug));
  }
  if (section === "library") {
    if (!Object.hasOwn(libraryKinds, slug) || parts.length > 3) return false;
    const kind = libraryKinds[slug as keyof typeof libraryKinds];
    return features[kind] && (parts.length === 2 || !!await metadata(kind, child));
  }
  if (section === "study") {
    if (!features.course) return false;
    if (parts.length === 1) return true;
    if (slug === "projects" && parts.length === 3) return /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(child) && !!await lookups.studyProject?.(child);
    if (parts.length !== 2 && (parts.length !== 4 || child !== "notes")) return false;
    if (parts.length === 4 && !features["study-note"]) return false;
    if (parts.length === 4 && repository.isStudyNoteAvailable) return repository.isStudyNoteAvailable(slug, noteSlug);
    const course = await metadata("course", slug);
    if (!course) return false;
    if (parts.length === 2) return true;
    const note = await metadata("study-note", noteSlug);
    return !!note && note.courseId === course.id;
  }
  if (section === "status") {
    if (parts.length !== 1 || !features.status) return false;
    if (!query?.has("focus")) return true;
    const values = query.getAll("focus"), key = values.length === 1 ? readStatusFocus(values[0]) : null;
    return !!key && !!await metadata("status", key);
  }
  return true;
}
