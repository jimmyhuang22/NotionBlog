/** Public DTOs. No Notion SDK, property objects, signed URLs, or credentials. */
export type ContentKind =
  | "post" | "status" | "album" | "book" | "movie"
  | "game" | "course" | "study-note" | "project" | "page";

export interface DateRange {
  /** ISO date or ISO datetime. Do not replace unknown dates with created_time. */
  start: string;
  end: string | null;
  precision: "date" | "datetime";
}
export interface ImageAsset {
  id: string;
  /** Stable app media URL or intentionally public external URL. */
  src: string;
  alt: string;
  width: number | null;
  height: number | null;
}
export interface ContentLink { title: string; href: string }
export type TextLink =
  | { kind: "external"; url: string }
  | { kind: "internal"; href: string }
  | { kind: "unavailable" };
export interface TextRun {
  text: string;
  /** Notion inline equation; text contains the expression, never rendered HTML. */
  equation?: true;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  underline?: boolean;
  strike?: boolean;
  color?: "default" | "muted" | "accent" | "warning";
  link?: TextLink;
}
export interface Rating {
  value: number | null;
  scale: number | null;
  /** Preserve a non-numeric source label when it cannot be reliably normalized. */
  label: string;
}
export interface TimeAmount { value: number; unit: "hour" | "minute" }
export interface ContentBase {
  id: string;
  kind: ContentKind;
  slug: string;
  href: string;
  title: string;
  summary: string | null;
  tags: string[];
  cover: ImageAsset | null;
  updatedAt: string | null;
}
export interface Post extends ContentBase {
  kind: "post";
  publishedAt: DateRange | null;
}
export interface Project extends ContentBase {
  kind: "project";
  period: DateRange | null;
  role: string | null;
  stack: string[];
  links: { label: string; url: string }[];
}
/** Ordinary Notion page selected by an exact fixed key; descendants are independent. */
export interface SiteContentPage extends ContentBase { kind: "page"; pageKey: "about" }
export interface SitePage {
  slug: "about";
  title: string;
  updatedAt: string | null;
  document: ContentDocument | null;
}
export interface StatusEntry extends ContentBase {
  kind: "status";
  recordedAt: DateRange | null;
  text: TextRun[];
  /** List-only projection: first nine body images in document order. */
  images?: ImageAsset[];
  /** False only when list text and images represent the complete body. */
  hasMoreBody?: boolean;
  /** List-only authorized text blocks, bounded to 400 Unicode code points / 12 nodes. */
  previewBody?: ContentBlock[];
  /** Preview budgets omitted eligible text; independent of the full text/images hasMoreBody flag. */
  previewBodyTruncated?: boolean;
}
export interface StatusYears {
  years: { year: number; count: number }[];
  undatedCount: number;
  /** Datetimes use this IANA zone; date-only values keep their written date. */
  timeZone: string;
}
export type LibraryKind = "movie" | "book" | "game";
/** Counts use the library browsing date, after the optional status filter. */
export type LibraryYears = StatusYears;
export interface LibraryYearsQuery { status?: string }
export interface Album extends ContentBase {
  kind: "album";
  date: DateRange | null;
  /** null until computed; do not imply 0 from a missing body query. */
  photoCount: number | null;
}
export type BookStatus = "reading" | "read" | "wishlist" | "given-up" | "unknown";
export interface Book extends ContentBase {
  kind: "book";
  authors: string[];
  status: BookStatus;
  readingDate: DateRange | null;
  pagesRead: number | null;
  totalPages: number | null;
  progressPercent: number | null;
  personalRating: Rating | null;
  doubanRating: number | null;
  externalUrl: string | null;
}
export type MovieStatus = "watched" | "wishlist" | "unknown";
export type MovieRatingSource = "douban" | "bangumi" | "1905";
export interface Movie extends ContentBase {
  kind: "movie";
  originalTitle: string | null;
  mediaType: string | null;
  status: MovieStatus;
  watchedDate: DateRange | null;
  releaseDate: DateRange | null;
  director: string | null;
  actors: string[];
  rating: Rating | null;
  /** Public score on a 0–10 scale. Legacy snapshots may omit it; null is explicitly unknown. */
  publicRating?: number | null;
  /** Verified source of the public score; absence never implies Douban. */
  ratingSource?: MovieRatingSource | null;
  /** Legacy public-score field, retained for older clients; its name does not prove the source. */
  doubanRating: number | null;
}
export type GameStatus = "platinumed" | "clear" | "playing" | "wishlist" | "unknown";
export interface Game extends ContentBase {
  kind: "game";
  status: GameStatus;
  platforms: string[];
  /** Owner-maintained experience range; never overwritten by account activity. */
  playedDate: DateRange | null;
  /** Latest observed linked-platform play, day only in the site zone. Legacy snapshots may omit it. */
  lastPlayedDate?: DateRange | null;
  /** Earliest observed linked-platform play, day only. Unknown (including Steam) stays null. */
  firstPlayedDate?: DateRange | null;
  /** Stable archive day: the personal experience range's end, otherwise its start; unknown stays null. */
  archiveDate?: DateRange | null;
  releaseDate: DateRange | null;
  playedTime: TimeAmount | null;
  estimatedTime: TimeAmount | null;
  progressPercent: number | null;
  rating: Rating | null;
}
export interface Course extends ContentBase {
  kind: "course";
  code: string;
  semester: string | null;
  ratings: {
    experience: Rating | null;
    usefulness: Rating | null;
    recommendation: Rating | null;
    difficulty: Rating | null;
  };
}
export type StudyNoteType =
  | "course" | "assignment" | "summary" | "note" | "quiz"
  | "test" | "textbook" | "tool" | "unknown";
export interface StudyNote extends ContentBase {
  kind: "study-note";
  courseId: string;
  parentId: string | null;
  noteType: StudyNoteType;
  date: DateRange | null;
  breadcrumbs: ContentLink[];
}
/** Every descendant exposed here has independently passed publication checks. */
export interface StudyNode {
  id: string;
  title: string;
  href: string;
  hasChildren: boolean;
  children?: StudyNode[];
  /** Optional for older directory consumers; projected from already eligible metadata. */
  noteType?: StudyNoteType;
  date?: DateRange | null;
}
export interface CourseTree { courseId: string; nodes: StudyNode[] }
export interface TableOfContentsEntry { id: string; title: string; level: 1 | 2 | 3 }
export type ContentBlock =
  | { id: string; type: "paragraph"; text: TextRun[] }
  | { id: string; type: "heading"; level: 1 | 2 | 3; text: TextRun[] }
  | { id: string; type: "list"; ordered: boolean; items: { id: string; text: TextRun[]; checked: boolean | null; children: ContentBlock[] }[] }
  | { id: string; type: "quote"; text: TextRun[] }
  | { id: string; type: "callout"; tone: "default" | "info" | "warning"; icon: string | null; text: TextRun[]; children: ContentBlock[] }
  | { id: string; type: "toggle"; title: TextRun[]; children: ContentBlock[] }
  | { id: string; type: "code"; language: string; code: string; caption: TextRun[] }
  | { id: string; type: "image"; image: ImageAsset; caption: TextRun[] }
  | { id: string; type: "divider" }
  | { id: string; type: "table"; hasColumnHeader: boolean; hasRowHeader: boolean; rows: TextRun[][][] }
  | { id: string; type: "columns"; columns: { ratio: number | null; blocks: ContentBlock[] }[] }
  | { id: string; type: "bookmark"; title: string; url: string; description: string | null }
  | { id: string; type: "embed"; url: string; title: string; display: "link" | "iframe" }
  | { id: string; type: "child-page"; title: string; target: ContentLink | null }
  | { id: string; type: "table-of-contents" }
  | { id: string; type: "equation"; expression: string }
  | { id: string; type: "unsupported"; label: string };
export interface ContentDocument {
  blocks: ContentBlock[];
  toc: TableOfContentsEntry[];
  /** Empty blocks means known empty; null document means body not loaded. */
  completeness: "complete" | "partial";
}
export interface ContentDetail<T extends ContentBase = ContentBase> {
  item: T;
  document: ContentDocument | null;
  adjacent?: { newer: ContentLink | null; older: ContentLink | null };
}
export interface ContentByKind {
  post: Post; status: StatusEntry; album: Album; book: Book;
  movie: Movie; game: Game; course: Course; "study-note": StudyNote; project: Project; page: SiteContentPage;
}
export type AnyContent = ContentByKind[ContentKind];
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
  /** Total after publication and all query filters, before pagination. */
  total?: number;
}
export interface ListQuery {
  /** Opaque. Clients never parse it; reset when filters or ordering change. */
  cursor?: string;
  limit?: number;
  status?: string;
  tag?: string;
  type?: string;
  platform?: string;
  semester?: string;
  /** Status and library experience dates, in the site zone; "undated" selects unknown dates. */
  year?: number | "undated";
  order?: "date-desc" | "date-asc" | "title-asc";
}
export interface HomeSummary {
  featuredPosts: Post[];
  recentStatuses: StatusEntry[];
  latestAlbums: Album[];
  readingBooks: Book[];
  playingGames: Game[];
  featuredCourses: Course[];
}
