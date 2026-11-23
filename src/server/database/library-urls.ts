import type { ContentByKind, ContentKind, LibraryKind } from "../../../contracts/content.ts";
import { ContentServiceError, type ContentRepository } from "../../../contracts/repository.ts";
import { isLibraryTitleSlug, libraryDetailHref, readLibraryTitleSlug } from "../../lib/content/library-url.ts";
import { isLibraryKind } from "../../lib/content/years.ts";
import type { PublicationMode } from "./publication.ts";
import { callSql, type SqlExecutor } from "./sql.ts";
import { publicPathProjector, sitePathReader } from "./public-paths.ts";

interface Name {
  oldHref: string;
  storageSlug: string;
  slug: string;
}

const legacyPath = /^\/library\/(games|books|movies)\/[a-f0-9]{32}$/u;
const pathKind = { games: "game", books: "book", movies: "movie" } as const;

function unavailable(): never {
  throw new ContentServiceError("CONTENT_UNAVAILABLE", "A public work address is unavailable.");
}

/** Translate only website addresses taken from qualified projections. */
export function createLibraryUrlProjection(db: SqlExecutor, mode: PublicationMode, siteUrl?: string) {
  const readSitePath = sitePathReader(siteUrl, "/library/");
  const project = publicPathProjector(value => {
    const url = readSitePath(value);
    return url && legacyPath.test(url.path) ? url : null;
  }, async paths => (await read(paths)).map(({ oldHref, slug }) => ({
    oldHref, slug, href: libraryDetailHref(pathKind[oldHref.split("/")[2] as keyof typeof pathKind], slug),
  })), isLibraryKind, unavailable);

  async function read(keys: string[], kind?: LibraryKind) {
    if (!keys.length) return [];
    const names = await callSql<Name[]>(db, "SELECT nb_library_urls_api.read_names($1, $2, $3) AS result", [mode, keys, kind ?? null]);
    if (!Array.isArray(names) || names.some(name => !name || !legacyPath.test(name.oldHref)
      || !isLibraryTitleSlug(name.slug) || !/^[a-f0-9]{32}$/u.test(name.storageSlug))) unavailable();
    return names;
  }

  function repository(base: ContentRepository): ContentRepository {
    async function lookup(kind: ContentKind, slug: string) {
      if (!isLibraryKind(kind)) return slug;
      const name = readLibraryTitleSlug(slug);
      return name ? (await read([name], kind))[0]?.storageSlug ?? null : null;
    }
    return {
      ...base,
      async get(kind, slug) {
        const key = await lookup(kind, slug);
        return key ? project(base.get(kind, key)) : null;
      },
      async getContentMetadata<K extends ContentKind>(kind: K, slug: string): Promise<ContentByKind[K] | null> {
        const key = await lookup(kind, slug);
        if (!key) return null;
        return project(base.getContentMetadata ? base.getContentMetadata(kind, key)
          : base.get(kind, key).then(detail => detail?.item ?? null));
      },
      list: (kind, query) => project(base.list(kind, query)),
      getHome: () => project(base.getHome()),
      ...(base.getPage && { getPage: key => project(base.getPage!(key)) }),
      ...(base.readStudyNote && { readStudyNote: (course, note) => project(base.readStudyNote!(course, note)) }),
      ...(base.readLibraryPage && { readLibraryPage: (kind, query) => project(base.readLibraryPage!(kind, query)) }),
      ...(base.readSnapshot && { readSnapshot: (kinds, documents) => project(base.readSnapshot!(kinds, documents)) }),
      ...(base.readIndex && { readIndex: kinds => project(base.readIndex!(kinds)) }),
      ...(base.readSearchSnapshot && { readSearchSnapshot: kinds => project(base.readSearchSnapshot!(kinds)) }),
      ...(base.search && { search: query => project(base.search!(query)) }),
      ...(base.getSelected && {
        async getSelected<K extends ContentKind>(kind: K, slugs: string[], version: string) {
          if (!isLibraryKind(kind)) return project(base.getSelected!(kind, slugs, version));
          const names = new Map((await read(slugs.filter(isLibraryTitleSlug), kind)).map(name => [name.slug, name.storageSlug]));
          const stored = slugs.flatMap(slug => names.get(slug) ?? []);
          return stored.length ? project(base.getSelected!(kind, stored, version)) : [];
        },
      }),
    };
  }
  return { repository, project };
}
