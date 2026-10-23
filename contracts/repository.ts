import type {
  ContentKind, ContentByKind, ContentDetail, ListQuery,
  Page, HomeSummary, CourseTree, Course, StatusYears, SitePage, LibraryKind, LibraryYears, LibraryYearsQuery,
} from "./content.ts";
import type { CursorQuery, PublicContentSnapshot, SearchHit, SearchQuery, SearchSnapshot, TimelinePage } from "./website.ts";

export interface ContentRepository {
  /** Public eligibility and item fields only, without loading a document. */
  getContentMetadata?<K extends ContentKind>(kind: K, slug: string): Promise<ContentByKind[K] | null>;
  getPage?(key: "about"): Promise<SitePage | null>;
  getTimeline?(query?: CursorQuery): Promise<TimelinePage>;
  search?(query: SearchQuery): Promise<Page<SearchHit>>;
  /** Search bodies and optional context from one qualification scope; never a browser endpoint. */
  readSearchSnapshot?(kinds: ContentKind[]): Promise<SearchSnapshot>;
  /** One bounded, internally consistent read; never exposed as an HTTP endpoint. */
  readSnapshot?(kinds: ContentKind[], documents?: boolean): Promise<PublicContentSnapshot>;
  /** Server-side timeline/list index; every document is null, including Status. */
  readIndex?(kinds: ContentKind[]): Promise<PublicContentSnapshot>;
  /** Bounded server-only batch, pinned to the index's run:revision. */
  getSelected?<K extends ContentKind>(kind: K, slugs: string[], version: string): Promise<ContentDetail<ContentByKind[K]>[]>;
  /** Only publicly eligible records, with validated query fields. */
  list<K extends ContentKind>(kind: K, query?: ListQuery): Promise<Page<ContentByKind[K]>>;
  /** Unknown, unpublished, archived, or out-of-scope content returns null. */
  get<K extends ContentKind>(kind: K, slug: string): Promise<ContentDetail<ContentByKind[K]> | null>;
  getHome(): Promise<HomeSummary>;
  /** Optional adapter capability; counts current public Status without loading bodies. */
  getStatusYears?(): Promise<StatusYears>;
  /** Public library experience years, optionally restricted to a status; no bodies. */
  getLibraryYears?(kind: LibraryKind, query?: LibraryYearsQuery): Promise<LibraryYears>;
  /** Optional adapter capability: validated course metadata without reading its body. */
  getCourseMetadata?(courseSlug: string): Promise<Course | null>;
  /** Optional metadata-only check of current course/note eligibility and ownership in one read. */
  isStudyNoteAvailable?(courseSlug: string, noteSlug: string): Promise<boolean>;
  /** Server-only paired read; note is null for missing, withdrawn or foreign-course content. */
  readStudyNote?(courseSlug: string, noteSlug: string): Promise<{ course: Course; note: ContentDetail<ContentByKind["study-note"]> | null } | null>;
  /** parentId, when supplied, must belong to this public course tree. */
  getCourseTree(courseSlug: string, parentId?: string): Promise<CourseTree | null>;
}
export type ContentErrorCode =
  | "INVALID_QUERY" | "CONTENT_UNAVAILABLE" | "RATE_LIMITED" | "MISCONFIGURED";
export class ContentServiceError extends Error {
  readonly code: ContentErrorCode;
  constructor(code: ContentErrorCode, message: string) {
    super(message);
    this.name = "ContentServiceError";
    this.code = code;
  }
}
