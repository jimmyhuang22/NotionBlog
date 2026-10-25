/**
 * An in-memory backend with made-up content, so the console can be tried before the real one exists.
 * Operations advance with the clock; nothing leaves this process. The data is fictional and the
 * console labels it as demo data throughout.
 */
import {
  BackendError,
  type BackendErrorBody,
  type ConsoleBackend,
  type ContentItem,
  type ContentPage,
  type FreezePreview,
  type Operation,
  type OperationCounts,
  type OperationKind,
  type OperationTarget,
  type Section,
  type SectionSummary,
  type SyncStatus,
  type TakedownPlan,
  type UnfreezeMode,
  type UnfreezePreview,
} from "./types.ts";

export { demoScenarios, type DemoScenario } from "./demo-scenarios.ts";
import type { DemoScenario } from "./demo-scenarios.ts";

interface DemoNode {
  id: string;
  section: Section;
  title: string;
  subtitle: string | null;
  slug: string;
  parentId: string | null;
  frozenAt: string | null;
  withdrawn: boolean;
  sourceEditedAt: string | null;
  publishedAt: string | null;
  consoleEdited: number;
  images: number;
  /** Pictures still served from Notion. */
  notionImages: number;
}

interface Step {
  label: string;
  ms: number;
}

interface DemoOperation {
  op: Operation;
  steps: Step[];
  /** Index of the step that fails, if any. */
  failAt: number | null;
  endsUnknown: boolean;
  effect: () => OperationCounts | null;
  applied: boolean;
  /** Keeps the shared write lock while running (everything but reads). */
  exclusive: boolean;
  /** The error a failing step reports. */
  failError: BackendErrorBody | null;
  /** For a takedown: the plan it can be resumed from. */
  planId: string | null;
}

const day = 86_400_000;
const minute = 60_000;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function seedNodes(now: number): DemoNode[] {
  const nodes: DemoNode[] = [];
  const add = (node: Partial<DemoNode> & Pick<DemoNode, "id" | "section" | "title" | "slug">) => {
    nodes.push({
      subtitle: null,
      parentId: null,
      frozenAt: null,
      withdrawn: false,
      sourceEditedAt: iso(now - 30 * day),
      publishedAt: iso(now - 40 * minute),
      consoleEdited: 0,
      images: 0,
      notionImages: 0,
      ...node,
    });
  };

  // Study: four sample courses; the first is already frozen, the third still has pictures on Notion.
  const frozenAt = iso(now - 25 * day);
  add({ id: "c-alg", section: "study", title: "算法与数据结构", subtitle: "DEMO2001", slug: "/study/demo-algorithms", frozenAt, sourceEditedAt: iso(now - 210 * day), images: 2 });
  add({ id: "n-alg-1", section: "study", title: "第 1 周：排序", slug: "/study/demo-algorithms/week-1", parentId: "c-alg", sourceEditedAt: iso(now - 230 * day), images: 4 });
  add({ id: "n-alg-1a", section: "study", title: "快速排序", slug: "/study/demo-algorithms/week-1/quicksort", parentId: "n-alg-1", sourceEditedAt: iso(now - 231 * day), images: 3, consoleEdited: 1 });
  add({ id: "n-alg-1b", section: "study", title: "归并排序", slug: "/study/demo-algorithms/week-1/mergesort", parentId: "n-alg-1", sourceEditedAt: iso(now - 231 * day), images: 2 });
  add({ id: "n-alg-2", section: "study", title: "第 2 周：图", slug: "/study/demo-algorithms/week-2", parentId: "c-alg", sourceEditedAt: iso(now - 224 * day), images: 6 });
  add({ id: "n-alg-3", section: "study", title: "期末复习", slug: "/study/demo-algorithms/review", parentId: "c-alg", sourceEditedAt: iso(now - 205 * day), images: 1 });

  add({ id: "c-web", section: "study", title: "网页开发基础", subtitle: "DEMO1102", slug: "/study/demo-web", sourceEditedAt: iso(now - 2 * day), images: 1 });
  add({ id: "n-web-1", section: "study", title: "第 1 周：HTML 与语义", slug: "/study/demo-web/week-1", parentId: "c-web", sourceEditedAt: iso(now - 20 * day), images: 3 });
  add({ id: "n-web-2", section: "study", title: "第 2 周：CSS 布局", slug: "/study/demo-web/week-2", parentId: "c-web", sourceEditedAt: iso(now - 9 * day), images: 5 });
  add({ id: "n-web-3", section: "study", title: "第 3 周：浏览器里的 JavaScript", slug: "/study/demo-web/week-3", parentId: "c-web", sourceEditedAt: iso(now - 2 * day), images: 2 });

  add({ id: "c-db", section: "study", title: "数据库系统", subtitle: "DEMO3005", slug: "/study/demo-databases", sourceEditedAt: iso(now - 70 * day), images: 1 });
  add({ id: "n-db-1", section: "study", title: "关系模型", slug: "/study/demo-databases/relational", parentId: "c-db", sourceEditedAt: iso(now - 90 * day), images: 2 });
  add({ id: "n-db-2", section: "study", title: "索引与查询计划", slug: "/study/demo-databases/indexes", parentId: "c-db", sourceEditedAt: iso(now - 75 * day), images: 4, notionImages: 3 });
  add({ id: "n-db-3", section: "study", title: "事务", slug: "/study/demo-databases/transactions", parentId: "c-db", sourceEditedAt: iso(now - 70 * day), images: 1 });

  add({ id: "c-ml", section: "study", title: "机器学习导论", subtitle: "DEMO4010", slug: "/study/demo-ml", sourceEditedAt: iso(now - 5 * day), images: 0 });
  add({ id: "n-ml-1", section: "study", title: "线性回归", slug: "/study/demo-ml/linear-regression", parentId: "c-ml", sourceEditedAt: iso(now - 5 * day), images: 3 });

  const posts = [
    ["周末去海边走了走", 1, 4],
    ["把书架重新整理了一遍", 3, 2],
    ["第一次自己做了拉面", 6, 3],
    ["换了新的机械键盘", 11, 1],
    ["今天的晚霞很好看", 15, 1],
    ["读完了一本很长的小说", 22, 0],
  ] as const;
  posts.forEach(([title, ago, images], index) =>
    add({ id: `s-${index}`, section: "status", title, slug: `/status#demo-${index}`, sourceEditedAt: iso(now - ago * day), images }),
  );

  const library: [Section, string, string][] = [
    ["movie", "示例电影：夏天的尾巴", "/movies/demo-summer"],
    ["movie", "示例剧集：城市夜话", "/movies/demo-city"],
    ["book", "示例书籍：慢慢走", "/books/demo-slow"],
    ["book", "示例书籍：山与海", "/books/demo-mountain"],
    ["game", "示例游戏：星际旅人", "/games/demo-traveller"],
    ["game", "示例游戏：小镇日常", "/games/demo-town"],
    ["album", "示例相册：春天", "/photos/demo-spring"],
    ["page", "关于", "/about"],
  ];
  library.forEach(([section, title, slug], index) =>
    add({ id: `l-${index}`, section, title, slug, sourceEditedAt: iso(now - (8 + index * 9) * day), images: 1 }),
  );
  return nodes;
}

const stepPlans: Record<OperationKind | "sync-target", string[]> = {
  sync: ["等待锁", "发现变化", "读取变化的页面", "处理图片", "发布", "刷新缓存"],
  "sync-target": ["等待锁", "读取这个页面", "处理图片", "发布", "刷新缓存"],
  freeze: ["核对图片", "写入冻结名单", "刷新缓存"],
  "unfreeze-once": ["解冻", "从 Notion 读取", "发布", "重新冻结", "刷新缓存"],
  "unfreeze-permanent": ["解冻", "从 Notion 读取", "发布", "刷新缓存"],
  takedown: ["写入下架名单", "清除页面缓存", "清除图片缓存", "核验"],
};

export class DemoBackend implements ConsoleBackend {
  readonly kind = "demo" as const;
  scenario: DemoScenario = "normal";
  private nodes: DemoNode[];
  private ops: DemoOperation[] = [];
  private plans = new Map<string, { plan: TakedownPlan; nodeId: string }>();
  private sequence = 0;
  private lastSuccessAt: number;
  /** Step length; tests shorten it. */
  private readonly stepMs: number;
  private readonly clock: () => number;

  constructor(options: { stepMs?: number; clock?: () => number } = {}) {
    this.clock = options.clock ?? Date.now;
    this.stepMs = options.stepMs ?? 1400;
    const now = this.clock();
    this.nodes = seedNodes(now);
    this.lastSuccessAt = now - 40 * minute;
    // History: two scheduled rounds and a freeze from earlier.
    this.ops.push(this.finished("sync", null, "schedule", now - 162 * minute, 11 * minute, { pagesChanged: 0, pagesWithdrawn: 0, mediaNew: 0 }));
    this.ops.push(this.finished("freeze", this.target(this.node("c-alg")), "console", now - 25 * day, 0.5 * minute, { pages: 6, images: 18 }));
    this.ops.push(this.finished("sync", null, "schedule", now - 42 * minute, 2 * minute, { pagesChanged: 2, pagesWithdrawn: 0, mediaNew: 1 }));
  }

  setScenario(scenario: DemoScenario) {
    this.scenario = scenario;
  }

  async status(): Promise<SyncStatus> {
    const now = this.clock();
    this.tick(now);
    const oldMode = this.scenario === "old-mode" || this.scenario === "phase-one";
    const phaseOne = this.scenario === "phase-one";
    const running = this.ops.find((entry) => entry.exclusive && isActive(entry.op))?.op ?? null;
    const lastRun = [...this.ops].reverse().find((entry) => entry.op.kind === "sync" && !isActive(entry.op))?.op ?? null;
    const pending = this.nodes.filter((node) => !node.withdrawn && !this.isFrozen(node) && node.sourceEditedAt && node.publishedAt && node.sourceEditedAt > node.publishedAt).length;
    return {
      mode: oldMode ? "qualified" : "published",
      capabilities: { sync: !phaseOne, freeze: !oldMode, targetedSync: !oldMode, takedown: true, contentList: !phaseOne },
      running: running ? clone(running) : null,
      lastSuccessAt: iso(this.lastSuccessAt),
      lastRun: lastRun ? clone(lastRun) : null,
      nextScheduledAt: iso(nextEvenHour(now)),
      schedule: "每 2 小时",
      queue: oldMode ? null : { pending, needsReview: 0 },
      hold: null,
      publishedVersionAt: iso(this.lastSuccessAt),
      observedAt: iso(now),
    };
  }

  async startSync(target: string | null): Promise<{ operationId: string }> {
    this.tick(this.clock());
    if (this.scenario === "phase-one") throw new BackendError({ code: "UNSUPPORTED", message: "第一阶段还没接上立即同步。" });
    if (target !== null && this.scenario === "old-mode") throw new BackendError({ code: "UNSUPPORTED", message: "旧模式只能整轮同步。" });
    const node = target === null ? null : this.requirePublished(target);
    this.assertIdle();
    const fails = this.scenario === "sync-fails";
    const op = this.start("sync", node ? this.target(node) : null, node ? stepPlans["sync-target"] : stepPlans.sync, {
      failAt: fails ? (node ? 1 : 2) : null,
      error: fails ? { code: "UNAVAILABLE", message: "Notion 返回 503（演示）。上一个已发布版本保持不变。" } : undefined,
      effect: () => {
        const now = this.clock();
        this.lastSuccessAt = now;
        const touched = node ? [node] : this.nodes.filter((entry) => !entry.withdrawn && !this.isFrozen(entry) && entry.sourceEditedAt && entry.publishedAt && entry.sourceEditedAt > entry.publishedAt);
        for (const entry of node ? [node] : this.nodes.filter((item) => !item.withdrawn && !this.isFrozen(item))) entry.publishedAt = iso(now);
        return { pagesChanged: touched.length, pagesWithdrawn: 0, mediaNew: touched.reduce((sum, entry) => sum + Math.min(entry.images, 1), 0) };
      },
    });
    return { operationId: op.id };
  }

  async sections(): Promise<SectionSummary[]> {
    this.tick(this.clock());
    this.requireContentList();
    const order: Section[] = ["study", "status", "movie", "book", "game", "album", "page"];
    return order.map((section) => {
      const top = this.nodes.filter((node) => node.section === section && node.parentId === null && !node.withdrawn);
      return { section, count: top.length, frozen: top.filter((node) => node.frozenAt).length };
    });
  }

  async listContent(query: { section: Section; parentId: string | null; search: string | null }): Promise<ContentPage> {
    this.tick(this.clock());
    this.requireContentList();
    const search = query.search?.trim().toLowerCase() || null;
    let nodes = this.nodes.filter((node) => node.section === query.section);
    if (search) {
      nodes = nodes.filter((node) => `${node.title} ${node.subtitle ?? ""}`.toLowerCase().includes(search));
    } else {
      nodes = nodes.filter((node) => node.parentId === query.parentId);
    }
    const items = nodes.map((node) => this.item(node));
    return { items, total: items.length };
  }

  async resolveTarget(input: string): Promise<ContentItem> {
    return this.item(this.resolve(input));
  }

  async previewFreeze(target: string): Promise<FreezePreview> {
    this.requireFreezeSupport();
    const node = this.requirePublished(target);
    if (this.isFrozen(node)) throw new BackendError({ code: "ALREADY_FROZEN", message: node.frozenAt ? "这个页面已冻结。" : "它随上级页面一起冻结了。" });
    const subtree = this.subtree(node).filter((entry) => !entry.withdrawn);
    return {
      target: this.item(node),
      pages: subtree.length,
      images: subtree.reduce((sum, entry) => sum + entry.images, 0),
      mediaNotReady: subtree.filter((entry) => entry.notionImages > 0).map((entry) => ({ title: entry.title, images: entry.notionImages })),
      digest: this.digest(subtree),
    };
  }

  async startFreeze(target: string, digest: string): Promise<{ operationId: string }> {
    const preview = await this.previewFreeze(target);
    if (preview.digest !== digest) throw new BackendError({ code: "PREVIEW_STALE", message: "冻结范围已变化。" });
    if (preview.mediaNotReady.length) throw new BackendError({ code: "MEDIA_NOT_READY", message: `${preview.mediaNotReady.length} 个页面的图片还在 Notion。` });
    this.assertIdle();
    const node = this.resolve(target);
    const op = this.start("freeze", this.target(node), stepPlans.freeze, {
      endsUnknown: this.scenario === "unknown",
      effect: () => {
        node.frozenAt = iso(this.clock());
        for (const entry of this.subtree(node)) if (entry !== node) entry.frozenAt = null;
        return { pages: preview.pages, images: preview.images };
      },
    });
    return { operationId: op.id };
  }

  async previewUnfreeze(target: string, mode: UnfreezeMode): Promise<UnfreezePreview> {
    this.requireFreezeSupport();
    const node = this.requirePublished(target);
    if (!node.frozenAt) throw new BackendError({ code: "NOT_FROZEN", message: this.isFrozen(node) ? "它随上级页面冻结，请在上级页面解冻。" : "这个页面没有冻结。" });
    const subtree = this.subtree(node).filter((entry) => !entry.withdrawn);
    return {
      target: this.item(node),
      mode,
      pages: subtree.length,
      consoleEdits: subtree.reduce((sum, entry) => sum + entry.consoleEdited, 0),
      // One sample page "deleted in Notion" so the warning can be seen.
      missingInSource: subtree.filter((entry) => entry.id === "n-alg-3").map((entry) => ({ title: entry.title })),
      digest: this.digest(subtree) + mode,
    };
  }

  async startUnfreeze(target: string, mode: UnfreezeMode, digest: string): Promise<{ operationId: string }> {
    const preview = await this.previewUnfreeze(target, mode);
    if (preview.digest !== digest) throw new BackendError({ code: "PREVIEW_STALE", message: "解冻范围已变化。" });
    this.assertIdle();
    const node = this.resolve(target);
    const kind: OperationKind = mode === "once" ? "unfreeze-once" : "unfreeze-permanent";
    const fails = this.scenario === "sync-fails";
    const op = this.start(kind, this.target(node), stepPlans[kind], {
      failAt: fails ? 1 : null,
      error: fails ? { code: "UNAVAILABLE", message: "Notion 返回 503（演示）。页面保持冻结，网站内容不变。" } : undefined,
      effect: () => {
        const now = this.clock();
        const subtree = this.subtree(node);
        for (const entry of subtree) {
          entry.consoleEdited = 0;
          entry.publishedAt = iso(now);
        }
        const missing = new Set(preview.missingInSource.map((entry) => entry.title));
        let withdrawn = 0;
        for (const entry of subtree) {
          if (missing.has(entry.title)) {
            entry.withdrawn = true;
            withdrawn += 1;
          }
        }
        if (mode === "permanent") node.frozenAt = null;
        else node.frozenAt = iso(now);
        return { pagesChanged: Math.max(1, preview.consoleEdits), pagesWithdrawn: withdrawn, mediaNew: 0 };
      },
    });
    return { operationId: op.id };
  }

  async planTakedown(input: string): Promise<TakedownPlan> {
    const node = this.requirePublished(input);
    const subtree = this.subtree(node).filter((entry) => !entry.withdrawn);
    const now = this.clock();
    const plan: TakedownPlan = {
      planId: `plan-${++this.sequence}`,
      target: this.target(node),
      descendants: subtree.length - 1,
      images: subtree.reduce((sum, entry) => sum + entry.images, 0),
      syncBusy: false,
      createdAt: iso(now),
      expiresAt: iso(now + 15 * minute),
    };
    this.plans.set(plan.planId, { plan, nodeId: node.id });
    return { ...plan };
  }

  async executeTakedown(planId: string): Promise<{ operationId: string }> {
    return this.takedown(planId, false);
  }

  async resumeTakedown(planId: string): Promise<{ operationId: string }> {
    return this.takedown(planId, true);
  }

  async operation(id: string): Promise<Operation> {
    this.tick(this.clock());
    const entry = this.ops.find((candidate) => candidate.op.id === id);
    if (!entry) throw new BackendError({ code: "NOT_FOUND", message: "没有这条操作记录。" });
    return clone(entry.op);
  }

  async operations(limit: number): Promise<Operation[]> {
    this.tick(this.clock());
    return this.ops.slice(-limit).reverse().map((entry) => clone(entry.op));
  }

  private takedown(planId: string, resume: boolean): { operationId: string } {
    this.tick(this.clock());
    const stored = this.plans.get(planId);
    if (!stored) throw new BackendError({ code: "NOT_FOUND", message: "没有这份下架计划。" });
    if (!resume && Date.parse(stored.plan.expiresAt) < this.clock()) throw new BackendError({ code: "PLAN_EXPIRED", message: "计划超过 15 分钟。" });
    this.assertIdle();
    const node = this.node(stored.nodeId);
    const unknown = this.scenario === "unknown" && !resume;
    const op = this.start("takedown", this.target(node), stepPlans.takedown, {
      endsUnknown: unknown,
      resumePlanId: planId,
      effect: () => {
        const subtree = this.subtree(node);
        for (const entry of subtree) entry.withdrawn = true;
        return { pages: subtree.length, images: subtree.reduce((sum, entry) => sum + entry.images, 0) };
      },
    });
    return { operationId: op.id };
  }

  private start(
    kind: OperationKind,
    target: OperationTarget | null,
    labels: string[],
    options: {
      failAt?: number | null;
      endsUnknown?: boolean;
      error?: BackendErrorBody;
      effect: () => OperationCounts | null;
      resumePlanId?: string;
    },
  ): Operation {
    const now = this.clock();
    const op: Operation = {
      id: `op-${++this.sequence}`,
      kind,
      target,
      trigger: "console",
      state: "running",
      createdAt: iso(now),
      startedAt: iso(now),
      finishedAt: null,
      steps: labels.map((label) => ({ label, state: "pending" })),
      counts: null,
      error: null,
      resumePlanId: null,
    };
    const entry: DemoOperation = {
      op,
      steps: labels.map((label) => ({ label, ms: this.stepMs })),
      failAt: options.failAt ?? null,
      endsUnknown: options.endsUnknown ?? false,
      effect: options.effect,
      applied: false,
      exclusive: true,
      failError: options.error ?? null,
      planId: options.resumePlanId ?? null,
    };
    this.ops.push(entry);
    this.tick(now);
    return op;
  }

  /** Moves every running operation forward to `now`. */
  private tick(now: number) {
    for (const entry of this.ops) {
      if (!isActive(entry.op) || !entry.op.startedAt) continue;
      let elapsed = now - Date.parse(entry.op.startedAt);
      let finished = true;
      for (let index = 0; index < entry.steps.length; index += 1) {
        const step = entry.op.steps[index];
        if (elapsed >= entry.steps[index].ms) {
          if (entry.failAt === index) {
            step.state = "failed";
            for (const later of entry.op.steps.slice(index + 1)) later.state = "skipped";
            entry.op.state = "failed";
            entry.op.error = entry.failError ?? { code: "UNAVAILABLE", message: "演示失败。" };
            entry.op.finishedAt = iso(Date.parse(entry.op.startedAt) + this.elapsedTo(entry, index + 1));
            if (entry.op.kind === "takedown") entry.op.resumePlanId = entry.planId;
            finished = false;
            break;
          }
          step.state = "done";
          elapsed -= entry.steps[index].ms;
        } else {
          step.state = "running";
          finished = false;
          break;
        }
      }
      if (!finished) continue;
      entry.op.finishedAt = iso(Date.parse(entry.op.startedAt) + this.elapsedTo(entry, entry.steps.length));
      if (entry.endsUnknown) {
        entry.op.state = "unknown";
        entry.op.steps[entry.steps.length - 1].state = "failed";
        entry.op.error = { code: "OUTCOME_UNKNOWN", message: "数据库已收到写入请求，但没有收到确认（演示）。" };
        if (entry.op.kind === "takedown") entry.op.resumePlanId = entry.planId;
        continue;
      }
      entry.op.state = "succeeded";
      if (!entry.applied) {
        entry.applied = true;
        entry.op.counts = entry.effect();
      }
    }
  }

  private elapsedTo(entry: DemoOperation, steps: number): number {
    return entry.steps.slice(0, steps).reduce((sum, step) => sum + step.ms, 0);
  }

  private finished(kind: OperationKind, target: OperationTarget | null, trigger: "console" | "schedule", startedAt: number, duration: number, counts: OperationCounts): DemoOperation {
    const labels = target === null && kind === "sync" ? stepPlans.sync : stepPlans[kind];
    return {
      op: {
        id: `op-${++this.sequence}`,
        kind,
        target,
        trigger,
        state: "succeeded",
        createdAt: iso(startedAt),
        startedAt: iso(startedAt),
        finishedAt: iso(startedAt + duration),
        steps: labels.map((label) => ({ label, state: "done" })),
        counts,
        error: null,
        resumePlanId: null,
      },
      steps: [],
      failAt: null,
      endsUnknown: false,
      effect: () => counts,
      applied: true,
      exclusive: true,
      failError: null,
      planId: null,
    };
  }

  private assertIdle() {
    const running = this.ops.find((entry) => entry.exclusive && isActive(entry.op));
    if (running) throw new BackendError({ code: "BUSY", message: "另一项操作正在进行。", runningOperationId: running.op.id });
  }

  private requireContentList() {
    if (this.scenario === "phase-one") throw new BackendError({ code: "UNSUPPORTED", message: "第一阶段还没接上内容列表。" });
  }

  private requireFreezeSupport() {
    if (this.scenario === "old-mode" || this.scenario === "phase-one") throw new BackendError({ code: "UNSUPPORTED", message: "冻结需要新模式（持久发布）上线。" });
  }

  private resolve(input: string): DemoNode {
    const value = input.trim();
    if (!value) throw new BackendError({ code: "INVALID_INPUT", message: "输入为空。" });
    const byId = this.nodes.find((node) => node.id === value);
    if (byId) return byId;
    let path = value;
    try {
      const url = new URL(value);
      path = url.pathname + url.hash;
    } catch {
      // Not a URL: a site path or a title.
    }
    const byPath = this.nodes.find((node) => node.slug === path || node.slug === path.replace(/\/$/, ""));
    if (byPath) return byPath;
    const byTitle = this.nodes.find((node) => node.title === value || node.subtitle === value);
    if (byTitle) return byTitle;
    throw new BackendError({ code: "NOT_FOUND", message: "演示数据里没有这个页面。可以试试 /study/demo-web。" });
  }

  private requirePublished(input: string): DemoNode {
    const node = this.resolve(input);
    if (node.withdrawn) throw new BackendError({ code: "NOT_PUBLISHED", message: "这个页面已经下架。" });
    return node;
  }

  private node(id: string): DemoNode {
    const node = this.nodes.find((entry) => entry.id === id);
    if (!node) throw new BackendError({ code: "NOT_FOUND", message: "没有这个页面。" });
    return node;
  }

  private subtree(root: DemoNode): DemoNode[] {
    const result = [root];
    for (let index = 0; index < result.length; index += 1) {
      for (const node of this.nodes) if (node.parentId === result[index].id) result.push(node);
    }
    return result;
  }

  private frozenAncestor(node: DemoNode): DemoNode | null {
    let current = node.parentId ? this.nodes.find((entry) => entry.id === node.parentId) ?? null : null;
    while (current) {
      if (current.frozenAt) return current;
      current = current.parentId ? this.nodes.find((entry) => entry.id === current!.parentId) ?? null : null;
    }
    return null;
  }

  private isFrozen(node: DemoNode): boolean {
    return Boolean(node.frozenAt) || this.frozenAncestor(node) !== null;
  }

  private item(node: DemoNode): ContentItem {
    const inherited = !node.frozenAt && this.frozenAncestor(node) !== null;
    return {
      id: node.id,
      section: node.section,
      title: node.title,
      subtitle: node.subtitle,
      href: node.withdrawn ? null : node.slug,
      parentId: node.parentId,
      childCount: this.nodes.filter((entry) => entry.parentId === node.id && !entry.withdrawn).length,
      state: node.withdrawn ? "withdrawn" : node.frozenAt || inherited ? "frozen" : "syncing",
      inheritedFrozen: inherited,
      frozenAt: node.frozenAt,
      sourceEditedAt: node.sourceEditedAt,
      publishedAt: node.publishedAt,
      consoleEdited: node.consoleEdited > 0,
    };
  }

  private target(node: DemoNode): OperationTarget {
    return { id: node.id, title: node.title, href: node.withdrawn ? null : node.slug };
  }

  private digest(nodes: DemoNode[]): string {
    return nodes.map((node) => `${node.id}:${node.frozenAt ?? ""}:${node.withdrawn ? 1 : 0}:${node.notionImages}`).join("|");
  }
}

function isActive(op: Operation): boolean {
  return op.state === "queued" || op.state === "running";
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** The demo schedule: every two hours at ten past. */
function nextEvenHour(now: number): number {
  const date = new Date(now);
  date.setUTCMinutes(10, 0, 0);
  while (date.getTime() <= now || date.getUTCHours() % 2 !== 0) date.setTime(date.getTime() + 60 * minute);
  return date.getTime();
}
