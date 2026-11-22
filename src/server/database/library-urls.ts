import type { ContentByKind, ContentKind, LibraryKind } from "../../../contracts/content.ts";
import { ContentServiceError, type ContentRepository } from "../../../contracts/repository.ts";
import { isLibraryTitleSlug, libraryDetailHref, readLibraryTitleSlug } from "../../lib/content/library-url.ts";
import { isLibraryKind } from "../../lib/content/years.ts";
import type { PublicationMode } from "./publication.ts";
import { callSql, type SqlExecutor } from "./sql.ts";

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

function siteHosts(origin: string | undefined) {
  if (!origin) return new Set<string>();
  const { hostname } = new URL(origin);
  return new Set([hostname, hostname.startsWith("www.") ? hostname.slice(4) : `www.${hostname}`]);
}

/** Translate only website addresses taken from qualified projections. The source DTOs
 * and their stored links retain their original identity for sync and withdrawal. */
export function createLibraryUrlProjection(db: SqlExecutor, mode: PublicationMode, siteUrl?: string) {
  const hosts = siteHosts(siteUrl);
  function parse(value: unknown) {
    if (typeof value !== "string" || !value.includes("/library/") || /[\u0000-\u0020\u007f\\]/u.test(value)) return null;
    try {
      const relative = value.startsWith("/") && !value.startsWith("//");
      const url = new URL(value, "https://relative.invalid");
      if (!relative && (!["http:", "https:"].includes(url.protocol) || url.username || url.password
        || url.port || !hosts.has(url.hostname))) return null;
      const path = decodeURIComponent(url.pathname);
      const match = legacyPath.exec(path);
      return match ? { path, kind: pathKind[match[1] as keyof typeof pathKind], suffix: url.search + url.hash } : null;
    } catch { return null; }
  }

  async function read(keys: string[], kind?: LibraryKind) {
    if (!keys.length) return [];
    const names = await callSql<Name[]>(db, "SELECT nb_library_urls_api.read_names($1, $2, $3) AS result", [mode, keys, kind ?? null]);
    if (!Array.isArray(names) || names.some(name => !name || !legacyPath.test(name.oldHref)
      || !isLibraryTitleSlug(name.slug) || !/^[a-f0-9]{32}$/u.test(name.storageSlug))) unavailable();
    return names;
  }

  async function project<T>(pending: T | Promise<T>): Promise<T> {
    const value = await pending;
    const paths = new Set<string>();
    const keys = ["href", "url", "externalUrl"] as const;
    function collect(node: unknown) {
      if (!node || typeof node !== "object") return;
      const object = node as Record<string, unknown>;
      for (const key of keys) {
        const match = parse(object[key]);
        if (match) paths.add(match.path);
      }
      Object.values(object).forEach(collect);
    }
    collect(value);
    if (!paths.size) return value;

    const names = new Map((await read([...paths])).map(name => [name.oldHref, name.slug]));
    function visit(node: unknown): unknown {
      if (Array.isArray(node)) return node.map(visit).filter(item => item !== null);
      if (!node || typeof node !== "object") return node;
      const object = node as Record<string, unknown>;
      const result = Object.fromEntries(Object.entries(object).map(([key, child]) => [key, visit(child)]));
      for (const key of keys) {
        const match = parse(object[key]);
        if (!match) continue;
        const name = names.get(match.path);
        if (name) {
          const href = libraryDetailHref(match.kind, name) + match.suffix;
          if (key === "url" && object.kind === "external") return { kind: "internal", href };
          result[key] = href;
          if (key === "href" && typeof object.slug === "string") result.slug = name;
        } else {
          if (object.kind === "internal" || object.kind === "external") return { kind: "unavailable" };
          if (key === "href" && typeof object.kind === "string" && isLibraryKind(object.kind)) unavailable();
          if (key !== "externalUrl") return null;
          result[key] = null;
        }
      }
      if (object.type === "child-page" && result.target === null) result.title = "Unavailable page";
      if (object.pageMention && (result.link as { kind?: string } | undefined)?.kind === "unavailable") {
        result.text = "Unavailable page";
      }
      return result;
    }
    return visit(value) as T;
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
