import { createMockRepository } from "../../../adapters/mock-repository.ts";
import {
  contentFeatures,
  isEnabledContentKind,
  type ContentFeatures,
} from "../../../config/features.ts";
import type {
  ContentByKind, ContentKind, CourseTree, ListQuery, Page, StudyNode, LibraryKind, LibraryYearsQuery,
} from "../../../contracts/content.ts";
import {
  ContentServiceError,
  type ContentRepository,
} from "../../../contracts/repository.ts";
import type { SearchQuery } from "../../../contracts/website.ts";
import { validateListQuery, validateLibraryYearsQuery } from "./query.ts";
import { createWebsiteQueries, searchRepository } from "./website.ts";

export type ContentProvider = "mock" | "notion" | "database";
export interface ContentService {
  provider: ContentProvider;
  repository: ContentRepository;
}
export interface ContentServiceOptions {
  /** Credentials stay in the server runtime; the factory accepts a ready adapter. */
  provider?: string;
  features?: ContentFeatures;
  timeZone?: string;
  notionRepository?: ContentRepository;
  databaseRepository?: ContentRepository;
}

function findNode(nodes: StudyNode[], id: string): StudyNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = findNode(node.children ?? [], id);
    if (found) return found;
  }
  return null;
}

/** Keep the full contract available without exposing sections disabled by configuration. */
export function createFeatureGatedRepository(
  repository: ContentRepository,
  features: ContentFeatures = contentFeatures,
): ContentRepository {
  const enabled = (kind: string) => isEnabledContentKind(kind, features);
  const courseMetadata = async (slug: string) => repository.getCourseMetadata
    ? repository.getCourseMetadata(slug)
    : (await repository.get("course", slug))?.item ?? null;
  return {
    ...(repository.readSearchSnapshot ? { readSearchSnapshot: (kinds: ContentKind[]) => repository.readSearchSnapshot!(kinds.filter(kind => enabled(kind))) } : {}),
    ...(repository.search ? { search: (query: SearchQuery) => searchRepository(repository, features, query) } : {}),
    async getContentMetadata(kind, slug) {
      if (!enabled(kind)) return null;
      if (repository.getContentMetadata) return repository.getContentMetadata(kind, slug);
      if (kind === "course" && repository.getCourseMetadata) return await repository.getCourseMetadata(slug) as ContentByKind[typeof kind] | null;
      return (await repository.get(kind, slug))?.item ?? null;
    },
    ...(repository.readSnapshot ? { readSnapshot: (kinds: ContentKind[], documents?: boolean) => repository.readSnapshot!(kinds.filter(kind => enabled(kind)), documents) } : {}),
    ...(repository.readIndex ? { readIndex: (kinds: ContentKind[]) => repository.readIndex!(kinds.filter(kind => enabled(kind))) } : {}),
    ...(repository.getSelected ? { getSelected: (<K extends ContentKind>(kind: K, slugs: string[], version: string) =>
      enabled(kind) ? repository.getSelected!(kind, slugs, version) : Promise.resolve([])) } : {}),
    ...(repository.getLibraryYears ? { getLibraryYears: async (kind: LibraryKind, query: LibraryYearsQuery = {}) => {
      validateLibraryYearsQuery(kind, query);
      return enabled(kind) ? repository.getLibraryYears!(kind, query) : { years: [], undatedCount: 0, timeZone: "UTC" };
    } } : {}),
    async getPage(key) { return enabled("page") && repository.getPage ? repository.getPage(key) : null; },
    async list<K extends ContentKind>(kind: K, query: ListQuery = {}): Promise<Page<ContentByKind[K]>> {
      if (!enabled(kind)) return { items: [], nextCursor: null, hasMore: false, total: 0 };
      validateListQuery(kind, query);
      return repository.list(kind, query);
    },
    async get(kind, slug) {
      if (!enabled(kind)) return null;
      return repository.get(kind, slug);
    },
    async getStatusYears() {
      if (!enabled("status")) return { years: [], undatedCount: 0, timeZone: "UTC" };
      if (!repository.getStatusYears) throw new ContentServiceError("CONTENT_UNAVAILABLE", "Status years are unavailable.");
      return repository.getStatusYears();
    },
    async getCourseMetadata(courseSlug) {
      return enabled("course") ? courseMetadata(courseSlug) : null;
    },
    ...(repository.isStudyNoteAvailable ? { isStudyNoteAvailable: (courseSlug: string, noteSlug: string) =>
      enabled("course") && enabled("study-note") ? repository.isStudyNoteAvailable!(courseSlug, noteSlug) : Promise.resolve(false) } : {}),
    async getHome() {
      const home = await repository.getHome();
      return {
        featuredPosts: enabled("post") ? home.featuredPosts : [],
        recentStatuses: enabled("status") ? home.recentStatuses : [],
        latestAlbums: enabled("album") ? home.latestAlbums : [],
        readingBooks: enabled("book") ? home.readingBooks : [],
        playingGames: enabled("game") ? home.playingGames : [],
        featuredCourses: enabled("course") ? home.featuredCourses : [],
      };
    },
    async getCourseTree(courseSlug, parentId): Promise<CourseTree | null> {
      if (!enabled("course")) return null;
      const course = await courseMetadata(courseSlug);
      if (!course) return null;
      if (!enabled("study-note")) {
        return parentId === undefined ? { courseId: course.id, nodes: [] } : null;
      }
      const tree = await repository.getCourseTree(courseSlug);
      if (!tree) return null;
      if (tree.courseId !== course.id) {
        throw new ContentServiceError("CONTENT_UNAVAILABLE", "Course tree is unavailable.");
      }
      if (parentId === undefined) return tree;
      const parent = findNode(tree.nodes, parentId);
      return parent ? { courseId: tree.courseId, nodes: parent.children ?? [] } : null;
    },
  };
}

/** Pure factory: Node tests do not load server-only, environment values, or private files. */
export function createContentService(options: ContentServiceOptions = {}): ContentService {
  const provider = options.provider ?? "mock";
  if (provider === "database") {
    if (!options.databaseRepository) throw new ContentServiceError("MISCONFIGURED", "The server-side database adapter is not configured.");
    return { provider, repository: createWebsiteQueries(createFeatureGatedRepository(options.databaseRepository, options.features), options.features ?? contentFeatures, options.timeZone) };
  }
  if (provider === "notion") {
    if (!options.notionRepository) throw new ContentServiceError("MISCONFIGURED", "The server-side Notion adapter is not configured.");
    return { provider, repository: createWebsiteQueries(createFeatureGatedRepository(options.notionRepository, options.features), options.features ?? contentFeatures, options.timeZone) };
  }
  if (provider !== "mock") {
    throw new ContentServiceError("MISCONFIGURED", "Unsupported content provider configuration.");
  }
  return {
    provider: "mock",
    repository: createWebsiteQueries(createFeatureGatedRepository(createMockRepository({ timeZone: options.timeZone }), options.features), options.features ?? contentFeatures, options.timeZone),
  };
}
