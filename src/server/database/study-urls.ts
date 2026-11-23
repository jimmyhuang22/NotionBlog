import type { ContentByKind, ContentKind } from "../../../contracts/content.ts";
import { ContentServiceError, type ContentRepository } from "../../../contracts/repository.ts";
import { isLibraryTitleSlug, readLibraryTitleSlug } from "../../lib/content/library-url.ts";
import { publicPathProjector, sitePathReader } from "./public-paths.ts";
import type { PublicationMode } from "./publication.ts";
import { callSql, type SqlExecutor } from "./sql.ts";

const storageId = /^[a-f0-9]{32}$/u;
const legacyPath = /^\/study\/[a-f0-9]{32}(?:\/notes\/[a-f0-9]{32})?$/u;

interface Name {
  courseId: string;
  courseName: string;
  noteId: string | null;
  noteName: string | null;
}

function studyPath(course: string, note?: string | null) {
  return `/study/${course}${note ? `/notes/${note}` : ""}`;
}

function unavailable(): never {
  throw new ContentServiceError("CONTENT_UNAVAILABLE", "A public study address is unavailable.");
}

export function createStudyUrlProjection(db: SqlExecutor, mode: PublicationMode, siteUrl?: string) {
  const readSitePath = sitePathReader(siteUrl, "/study/");
  const project = publicPathProjector(value => {
    const url = readSitePath(value);
    return url && legacyPath.test(url.path) ? url : null;
  }, async paths => (await read(paths, true)).map(name => ({
    oldHref: studyPath(name.courseId, name.noteId),
    href: studyPath(encodeURIComponent(name.courseName), name.noteName && encodeURIComponent(name.noteName)),
    // The generic detail API still uses storage keys for notes, whose short
    // names only identify a page when paired with the course address.
    ...(name.noteId === null && { slug: name.courseName }),
  })), kind => kind === "course" || kind === "study-note", unavailable);

  async function read(paths: string[], legacy = false) {
    if (!paths.length) return [];
    const names = await callSql<Name[]>(db, "SELECT nb_study_urls_api.read_names($1, $2, $3) AS result", [mode, paths, legacy]);
    if (!Array.isArray(names) || names.some(name => !name || !storageId.test(name.courseId)
      || typeof name.courseName !== "string" || !isLibraryTitleSlug(name.courseName) || name.courseName === "projects"
      || (name.noteId === null ? name.noteName !== null :
        !storageId.test(name.noteId) || typeof name.noteName !== "string" || !isLibraryTitleSlug(name.noteName)))) unavailable();
    return names;
  }

  async function lookup(course: string, note?: string) {
    const courseName = readLibraryTitleSlug(course);
    const noteName = note === undefined ? undefined : readLibraryTitleSlug(note);
    if (!courseName || courseName === "projects" || noteName === null) return null;
    const names = await read([studyPath(courseName, noteName)]);
    return names[0] ?? null;
  }

  function repository(base: ContentRepository): ContentRepository {
    async function key(kind: ContentKind, slug: string) {
      return kind === "course" ? (await lookup(slug))?.courseId ?? null : slug;
    }
    return {
      ...base,
      async get(kind, slug) {
        const stored = await key(kind, slug);
        return stored ? project(base.get(kind, stored)) : null;
      },
      async getContentMetadata<K extends ContentKind>(kind: K, slug: string): Promise<ContentByKind[K] | null> {
        const stored = await key(kind, slug);
        if (!stored) return null;
        return project(base.getContentMetadata ? base.getContentMetadata(kind, stored) : base.get(kind, stored).then(detail => detail?.item ?? null));
      },
      async getCourseMetadata(slug) {
        const name = await lookup(slug);
        if (!name) return null;
        return project(base.getCourseMetadata ? base.getCourseMetadata(name.courseId) : base.get("course", name.courseId).then(detail => detail?.item ?? null));
      },
      async isStudyNoteAvailable(course, note) {
        const name = await lookup(course, note);
        return name?.noteId ? true : false;
      },
      async readStudyNote(course, note) {
        const name = await lookup(course, note);
        if (!name?.noteId) return null;
        if (!base.readStudyNote) unavailable();
        return project(base.readStudyNote(name.courseId, name.noteId));
      },
      async getCourseTree(course, parentId) {
        const name = await lookup(course);
        return name ? project(base.getCourseTree(name.courseId, parentId)) : null;
      },
      list: (kind, query) => project(base.list(kind, query)),
      getHome: () => project(base.getHome()),
      ...(base.getPage && { getPage: key => project(base.getPage!(key)) }),
      ...(base.readLibraryPage && { readLibraryPage: (kind, query) => project(base.readLibraryPage!(kind, query)) }),
      ...(base.readSnapshot && { readSnapshot: (kinds, documents) => project(base.readSnapshot!(kinds, documents)) }),
      ...(base.readIndex && { readIndex: kinds => project(base.readIndex!(kinds)) }),
      ...(base.readSearchSnapshot && { readSearchSnapshot: kinds => project(base.readSearchSnapshot!(kinds)) }),
      ...(base.search && { search: query => project(base.search!(query)) }),
      ...(base.getSelected && {
        async getSelected<K extends ContentKind>(kind: K, slugs: string[], version: string) {
          if (kind !== "course") return project(base.getSelected!(kind, slugs, version));
          const paths = slugs.flatMap(slug => {
            const name = readLibraryTitleSlug(slug);
            return name && name !== "projects" ? [studyPath(name)] : [];
          });
          const ids = new Map((await read(paths)).map(name => [name.courseName, name.courseId]));
          const ordered = slugs.flatMap(slug => {
            const id = ids.get(readLibraryTitleSlug(slug) ?? "");
            return id ? [id] : [];
          });
          return project(base.getSelected!(kind, ordered, version));
        },
      }),
    };
  }

  return { repository, project };
}
