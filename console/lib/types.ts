/**
 * What the console asks of the backend, and what it gets back.
 *
 * The console never talks to Notion, the database or the sync runner directly. Everything goes
 * through a ConsoleBackend: the demo one in this directory, or the bridge (bridge-backend.ts) that
 * runs a backend-owned command speaking the JSON protocol in docs/CONSOLE_BRIDGE.md.
 */

export type Section = "study" | "status" | "movie" | "book" | "game" | "album" | "page";

export const sectionLabels: Record<Section, string> = {
  study: "学习",
  status: "动态",
  movie: "影视",
  book: "书籍",
  game: "游戏",
  album: "相册",
  page: "关于",
};

/** `frozen` is set on the page that was frozen; its descendants report `inheritedFrozen`. */
export type ContentState = "syncing" | "frozen" | "withdrawn";

export interface ContentItem {
  /** Opaque to the console; never a Notion URL. */
  id: string;
  section: Section;
  title: string;
  /** A short second line, such as a course code. */
  subtitle: string | null;
  /** Site path when the page is public; null otherwise. */
  href: string | null;
  parentId: string | null;
  /** Published direct children. */
  childCount: number;
  state: ContentState;
  inheritedFrozen: boolean;
  frozenAt: string | null;
  /** Last edit seen in the source, when known. */
  sourceEditedAt: string | null;
  publishedAt: string | null;
  /** The database copy was changed in the console after freezing. */
  consoleEdited: boolean;
}

export interface SectionSummary {
  section: Section;
  count: number;
  frozen: number;
}

export interface ContentPage {
  items: ContentItem[];
  total: number;
}

export type OperationKind = "sync" | "freeze" | "unfreeze-permanent" | "unfreeze-once" | "takedown";
export type OperationState = "queued" | "running" | "succeeded" | "failed" | "unknown" | "cancelled";
export type StepState = "pending" | "running" | "done" | "failed" | "skipped";

export interface OperationTarget {
  id: string;
  title: string;
  href: string | null;
}

export interface OperationCounts {
  pagesChanged?: number;
  pagesWithdrawn?: number;
  mediaNew?: number;
  pages?: number;
  images?: number;
}

export interface Operation {
  id: string;
  kind: OperationKind;
  /** Null for a whole-site sync. */
  target: OperationTarget | null;
  trigger: "console" | "schedule";
  state: OperationState;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  steps: { label: string; state: StepState }[];
  counts: OperationCounts | null;
  error: BackendErrorBody | null;
  /** A takedown that stopped part way can be resumed from its plan. */
  resumePlanId: string | null;
}

export interface Capabilities {
  /** Start a whole-site sync from the console. */
  sync: boolean;
  /** Freeze and unfreeze (needs the persistent mode). */
  freeze: boolean;
  /** Sync one page instead of everything. */
  targetedSync: boolean;
  takedown: boolean;
  contentList: boolean;
}

export interface SyncStatus {
  mode: "qualified" | "published" | "unknown";
  capabilities: Capabilities;
  running: Operation | null;
  lastSuccessAt: string | null;
  lastRun: Operation | null;
  nextScheduledAt: string | null;
  /** Plain words, such as "每 2 小时". */
  schedule: string | null;
  queue: { pending: number; needsReview: number } | null;
  /** Why scheduled syncs are not running right now, in plain words; null when they run normally. */
  hold: string | null;
  publishedVersionAt: string | null;
  observedAt: string;
}

export interface FreezePreview {
  target: ContentItem;
  pages: number;
  images: number;
  /** Pages whose pictures still come from Notion; freezing is refused while any remain. */
  mediaNotReady: { title: string; images: number }[];
  /** Ties the confirmation to what was shown; a changed state makes the backend refuse it. */
  digest: string;
}

export type UnfreezeMode = "once" | "permanent";

export interface UnfreezePreview {
  target: ContentItem;
  mode: UnfreezeMode;
  pages: number;
  /** Console edits that Notion's version will replace. */
  consoleEdits: number;
  /** Pages no longer found or public in Notion; they will be taken down. */
  missingInSource: { title: string }[];
  digest: string;
}

export interface TakedownPlan {
  planId: string;
  target: OperationTarget;
  descendants: number;
  images: number;
  /** The database still holds a sync lease; taking down invalidates it, so coordinate first. */
  syncBusy?: boolean;
  createdAt: string;
  expiresAt: string;
}

export type BackendErrorCode =
  | "BUSY"
  | "NOT_FOUND"
  | "NOT_PUBLISHED"
  | "ALREADY_FROZEN"
  | "NOT_FROZEN"
  | "PREVIEW_STALE"
  | "MEDIA_NOT_READY"
  | "PLAN_EXPIRED"
  | "UNSUPPORTED"
  | "INVALID_INPUT"
  | "OUTCOME_UNKNOWN"
  | "RUN_FAILED"
  | "UNAVAILABLE";

export interface BackendErrorBody {
  code: BackendErrorCode;
  /** Diagnostic detail for the operator; never credentials, source IDs or private paths. */
  message: string;
  /** For BUSY: the operation already running. */
  runningOperationId?: string;
}

export class BackendError extends Error {
  readonly code: BackendErrorCode;
  readonly runningOperationId?: string;
  constructor(body: BackendErrorBody) {
    super(body.message);
    this.name = "BackendError";
    this.code = body.code;
    this.runningOperationId = body.runningOperationId;
  }
}

export interface ConsoleBackend {
  readonly kind: "demo" | "bridge";
  status(): Promise<SyncStatus>;
  startSync(target: string | null): Promise<{ operationId: string }>;
  sections(): Promise<SectionSummary[]>;
  listContent(query: { section: Section; parentId: string | null; search: string | null }): Promise<ContentPage>;
  resolveTarget(input: string): Promise<ContentItem>;
  previewFreeze(target: string): Promise<FreezePreview>;
  startFreeze(target: string, digest: string): Promise<{ operationId: string }>;
  previewUnfreeze(target: string, mode: UnfreezeMode): Promise<UnfreezePreview>;
  startUnfreeze(target: string, mode: UnfreezeMode, digest: string): Promise<{ operationId: string }>;
  planTakedown(input: string): Promise<TakedownPlan>;
  executeTakedown(planId: string): Promise<{ operationId: string }>;
  resumeTakedown(planId: string): Promise<{ operationId: string }>;
  operation(id: string): Promise<Operation>;
  operations(limit: number): Promise<Operation[]>;
}

/** Plain-language text for each error code; the backend's message is shown underneath as detail. */
export const errorText: Record<BackendErrorCode, string> = {
  BUSY: "已经有一轮同步在运行，等它结束后再试。",
  NOT_FOUND: "没有找到这个页面。请输入网站上的页面地址或 Notion 页面链接。",
  NOT_PUBLISHED: "这个页面目前没有在网站上公开。",
  ALREADY_FROZEN: "这个页面已经冻结了。",
  NOT_FROZEN: "这个页面没有冻结。",
  PREVIEW_STALE: "内容在你确认前发生了变化，请重新查看影响范围。",
  MEDIA_NOT_READY: "还有图片依赖 Notion，补齐之前不能冻结。",
  PLAN_EXPIRED: "这份下架计划已过期，请重新生成。",
  UNSUPPORTED: "后端暂时还不支持这项操作。",
  INVALID_INPUT: "输入的内容无法识别。",
  OUTCOME_UNKNOWN: "结果未知：操作可能已经生效。请先核对，不要直接重试。",
  RUN_FAILED: "这一轮没有完成。",
  UNAVAILABLE: "暂时连不上后端，请稍后再试。",
};
