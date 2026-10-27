import { randomUUID, createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, unlink, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ContentItem, Operation, SyncStatus, FreezePreview, UnfreezePreview, UnfreezeMode } from "../../console/lib/types.ts";
import type { StoredMedia } from "../../contracts/sync.ts";
import { createFreezeStore, freezeQuery, FreezeError, type FreezePlan } from "../../src/server/database/freeze.ts";
import type { SqlExecutor } from "../../src/server/database/sql.ts";
import { acquireLock, privateDirectory, readPrivateFile } from "../notion-sync/state.ts";
import { WorkerError } from "../notion-sync/errors.ts";
import { validateHostReport } from "../website-incremental-sync/host-state.ts";

export interface ManagementConfig {
  version: 1; enabled: boolean; stateDir: string; lockDirectory: string; runtimeDirectory: string;
  sourceConfigPath: string; siteOrigin: string; durationMs: number; mediaBytes: number;
}
export interface ManagementPorts {
  database(): Promise<SqlExecutor>;
  verifyMedia(media: StoredMedia, signal: AbortSignal, thumbnail: boolean): Promise<void>;
  inspectSource(plan: FreezePlan, signal: AbortSignal): Promise<{ fingerprint: string; missing: { title: string }[] }>;
  runSync(input: { target: {sourceKey: string; pageKey: string} | null; refresh?: {groupId: string; generation: string}; expectedRevision?: string }, signal: AbortSignal): Promise<Record<string, unknown>>;
  enqueue(members: {id: string; sourceKey: string}[], operationId: string): Promise<void>;
  assertIdle(): Promise<void>;
  dispatch(id: string): Promise<void>;
  latestReport(): Promise<Record<string, unknown> | null>;
  closeDatabase?(): Promise<void>;
}
interface SavedPreview { digest: string; plan: FreezePlan; sourceFingerprint: string | null; expiresAt: number }
interface SavedOperation { operation: Operation; request: {op: string; target: string | null; digest?: string}; submitted: boolean; pid?: number }
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const operationId = (value: string) => /^manage-[a-f0-9-]{36}$/.test(value);
const previewId = (value: string) => /^[a-f0-9]{64}$/.test(value);

export function managementError(error: unknown): { code: string; message: string } {
  if (error instanceof WorkerError && error.code === "BUSY") return { code: "BUSY", message: "另一项操作正在进行。" };
  if (error instanceof FreezeError) {
    const codes: Record<string, string> = { FREEZE_NOT_FOUND: "NOT_FOUND", FREEZE_ALREADY_FROZEN: "ALREADY_FROZEN", FREEZE_NOT_FROZEN: "NOT_FROZEN",
      FREEZE_PREVIEW_STALE: "PREVIEW_STALE", FREEZE_MEDIA_NOT_READY: "MEDIA_NOT_READY", FREEZE_INPUT_INVALID: "INVALID_INPUT", BUSY: "BUSY" };
    return { code: codes[error.code] ?? "UNAVAILABLE", message: "操作尚未确认完成，请核对当前状态。" };
  }
  return { code: "UNAVAILABLE", message: "后端暂时不可用，请查看操作记录。" };
}

/** Narrow backend operations only. Browser input never chooses a command, SQL, credential, or path. */
export class ManagementBackend {
  constructor(privateConfig: ManagementConfig, privatePorts: ManagementPorts) { this.config = privateConfig; this.ports = privatePorts; }
  private readonly config: ManagementConfig;
  private readonly ports: ManagementPorts;
  private async location(kind: "plans" | "operations", id: string) {
    if (kind === "plans" ? !previewId(id) : !operationId(id)) throw new FreezeError("FREEZE_INPUT_INVALID");
    const directory = join(this.config.stateDir, kind); await privateDirectory(this.config.stateDir); await privateDirectory(directory);
    return join(directory, `${id}.json`);
  }
  private async save(kind: "plans" | "operations", id: string, value: unknown) {
    const path = await this.location(kind, id), temp = `${path}.${randomUUID()}`;
    const bytes = JSON.stringify(value) + "\n";
    if (Buffer.byteLength(bytes) > 16 * 1024 * 1024) throw new FreezeError("FREEZE_LIMIT");
    const file = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try {
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      await rename(temp, path);
      const directory = await open(join(path, ".."), constants.O_RDONLY | constants.O_DIRECTORY);
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await unlink(temp).catch(() => {}); }
  }
  private async load<T>(kind: "plans" | "operations", id: string): Promise<T> {
    return JSON.parse(await readPrivateFile(await this.location(kind, id), 16 * 1024 * 1024));
  }
  private target(value: unknown): string {
    if (typeof value !== "string" || !value.trim() || value.length > 2000) throw new FreezeError("FREEZE_INPUT_INVALID");
    const input = value.trim();
    if (input.startsWith("/")) return this.target(new URL(input, this.config.siteOrigin).toString());
    if (!/^https?:/.test(input)) return input;
    let url: URL; try { url = new URL(input); } catch { throw new FreezeError("FREEZE_INPUT_INVALID"); }
    if (url.username || url.password) throw new FreezeError("FREEZE_INPUT_INVALID");
    if (url.origin === this.config.siteOrigin) {
      const focus = url.searchParams.get("focus") ?? (url.pathname === "/status" ? url.hash.slice(1) : null);
      return focus && /^[A-Za-z0-9_-]{1,128}$/.test(focus) ?
        (/^[a-f0-9-]{32,36}$/i.test(focus) && focus.replace(/-/g, "").length === 32 ? focus.replace(/-/g, "").toLowerCase() : focus) : url.pathname;
    }
    if (!["notion.so", "www.notion.so", "app.notion.so", "app.notion.com"].includes(url.hostname) && !url.hostname.endsWith(".notion.site")) throw new FreezeError("FREEZE_INPUT_INVALID");
    const raw = (url.searchParams.get("p") ?? url.pathname.split("/").pop() ?? "").replace(/-/g, "").match(/[a-f0-9]{32}$/i)?.[0];
    if (!raw) throw new FreezeError("FREEZE_INPUT_INVALID");
    return raw.toLowerCase();
  }
  private async database() {
    if (!this.config.enabled) throw new FreezeError("FREEZE_DISABLED");
    const db = await this.ports.database();
    if (!(await createFreezeStore(db).state()).enabled) throw new FreezeError("FREEZE_DISABLED");
    return db;
  }
  async resolve(input: unknown): Promise<ContentItem> {
    return freezeQuery(await this.database(), "SELECT nb_freeze_api.resolve_item($1) AS result", [this.target(input)]);
  }
  async preview(input: unknown, mode: "freeze" | UnfreezeMode): Promise<FreezePreview | UnfreezePreview> {
    const db = await this.database(), plan = await createFreezeStore(db).preview(this.target(input), mode);
    const target = await this.resolve(plan.rootId);
    let source: Awaited<ReturnType<ManagementPorts["inspectSource"]>> | null = null;
    if (mode !== "freeze") source = await this.ports.inspectSource(plan, AbortSignal.timeout(50000));
    const saved: SavedPreview = { digest: digest([plan.digest, source?.fingerprint ?? null]), plan, sourceFingerprint: source?.fingerprint ?? null, expiresAt: Date.now() + 15 * 60000 };
    await this.save("plans", saved.digest, saved);
    return mode === "freeze" ? { target, pages: plan.pages, images: plan.images, digest: saved.digest,
      mediaNotReady: plan.missingImages ? [{ title: plan.title, images: plan.missingImages }] : [] } :
      { target, mode, pages: plan.pages, consoleEdits: 0, missingInSource: source!.missing, digest: saved.digest };
  }
  async start(op: "freeze.start" | "unfreeze.start" | "sync.start", input: {target?: unknown; digest?: unknown; mode?: unknown}) {
    const db = await this.database();
    let target: ContentItem | null = null, kind: Operation["kind"] = "sync";
    if (op !== "sync.start") {
      if (typeof input.digest !== "string" || !previewId(input.digest)) throw new FreezeError("FREEZE_INPUT_INVALID");
      const saved = await this.load<SavedPreview>("plans", input.digest);
      const action = op === "freeze.start" ? "freeze" : input.mode;
      target = await this.resolve(input.target);
      if (saved.expiresAt < Date.now() || saved.plan.action !== action || target.id !== saved.plan.rootId) throw new FreezeError("FREEZE_PREVIEW_STALE");
      kind = action === "freeze" ? "freeze" : action === "once" ? "unfreeze-once" : "unfreeze-permanent";
    } else if (input.target !== null && input.target !== undefined) target = await this.resolve(input.target);
    if (op === "sync.start" && target?.state === "frozen") throw new FreezeError("FREEZE_ALREADY_FROZEN");
    if (target?.state === "withdrawn" && kind !== "unfreeze-permanent") throw new FreezeError("FREEZE_NOT_FOUND");
    // Never queue a second writer; the worker and scheduled task still use the canonical lock as the authority.
    await this.ports.assertIdle();
    const id = `manage-${randomUUID()}`;
    const record: SavedOperation = { submitted: false, request: {op, target: target?.id ?? null, digest: typeof input.digest === "string" ? input.digest : undefined},
      operation: {id, kind, target, trigger: "console", state: "queued", createdAt: new Date().toISOString(), startedAt: null, finishedAt: null,
        steps: [{label: "核对并执行", state: "pending"}], counts: null, error: null, resumePlanId: null} };
    await this.save("operations", id, record);
    try { await this.ports.dispatch(id); }
    catch { record.operation.state = "failed"; record.operation.error = {code: "UNAVAILABLE", message: "操作未启动。"}; await this.save("operations", id, record); throw new FreezeError("FREEZE_UNAVAILABLE"); }
    return { operationId: id };
  }
  async work(id: string) {
    const record = await this.load<SavedOperation>("operations", id);
    if (record.operation.state !== "queued") throw new FreezeError("FREEZE_OPERATION_CONFLICT");
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), this.config.durationMs);
    const abort = () => controller.abort(); process.on("SIGTERM", abort); process.on("SIGINT", abort);
    const signal = controller.signal;
    let release: (() => Promise<void>) | undefined, confirmedWrite = false;
    record.pid = process.pid;
    record.operation.state = "running"; record.operation.startedAt = new Date().toISOString(); record.operation.steps[0].state = "running";
    await this.save("operations", id, record);
    try {
      const db = await this.database(), store = createFreezeStore(db), request = record.request;
      const preview = request.digest ? await this.load<SavedPreview>("plans", request.digest) : null;
      if (preview && preview.expiresAt < Date.now()) throw new FreezeError("FREEZE_PREVIEW_STALE");
      if (record.operation.kind === "sync" || record.operation.kind === "unfreeze-once") {
        if (preview) {
          const current = await store.preview(preview.plan.rootId, "once");
          if (current.digest !== preview.plan.digest || (await this.ports.inspectSource(preview.plan, signal)).fingerprint !== preview.sourceFingerprint) throw new FreezeError("FREEZE_PREVIEW_STALE");
        }
        const task = request.target === null ? null : await freezeQuery<{sourceKey: string; pageKey: string}>(db, "SELECT nb_freeze_api.resolve_task($1) AS result", [request.target]);
        record.submitted = true; await this.save("operations", id, record);
        const report = validateHostReport(await this.ports.runSync({ target: task,
          refresh: preview ? {groupId: preview.plan.groupId!, generation: preview.plan.generation} : undefined,
          expectedRevision: preview?.plan.publicationRevision }, signal));
        const queue = report.queue as {pending: number; retry: number; awaiting_verification: number; needs_review: number} | null;
        if (!["updated", "unchanged", "partial"].includes(String(report.outcome))) {
          if (queue?.awaiting_verification) throw new FreezeError("FREEZE_UNAVAILABLE");
          record.submitted = false; throw new FreezeError("FREEZE_SYNC_INCOMPLETE");
        }
        record.operation.steps[0].label = report.outcome === "partial" ? "本轮已处理，仍有待办；请查看同步队列" : "本轮处理完成";
        // The host reports submitted batches, not the number of pages in those batches.
        record.operation.counts = null;
      } else {
        release = await acquireLock(this.config.lockDirectory, id);
        await this.ports.assertIdle(); signal.throwIfAborted();
        if (!preview) throw new FreezeError("FREEZE_INPUT_INVALID");
        const plan = preview.plan;
        if (record.operation.kind === "freeze") {
          const current = await store.preview(plan.rootId, "freeze");
          if (current.digest !== plan.digest) throw new FreezeError("FREEZE_PREVIEW_STALE");
          if (plan.missingImages || plan.media.reduce((n, m) => n + m.byteSize, 0) > this.config.mediaBytes) throw new FreezeError("FREEZE_MEDIA_NOT_READY");
          for (const media of plan.media) { signal.throwIfAborted(); await this.ports.verifyMedia(media, signal, plan.thumbnailIds.includes(media.assetId)); }
          signal.throwIfAborted(); record.submitted = true; await this.save("operations", id, record);
          const result = await store.freeze(id.slice(7), plan, plan.media);
          confirmedWrite = true;
          const state = await store.state();
          if (state.members.filter(m => m.groupId === result.groupId).length !== plan.pages) throw new FreezeError("FREEZE_UNAVAILABLE");
          record.operation.counts = {pages: plan.pages, images: plan.images};
        } else {
          if ((await this.ports.inspectSource(plan, signal)).fingerprint !== preview.sourceFingerprint) throw new FreezeError("FREEZE_PREVIEW_STALE");
          signal.throwIfAborted(); record.submitted = true; await this.save("operations", id, record);
          const result = await store.unfreeze(id.slice(7), plan);
          confirmedWrite = true;
          await this.ports.enqueue(result.members, id);
          record.operation.counts = {pages: result.members.length};
        }
      }
      record.operation.state = "succeeded"; record.operation.steps[0].state = "done";
    } catch (e) {
      const error = managementError(e);
      const rejected = e instanceof FreezeError && !["FREEZE_UNAVAILABLE"].includes(e.code);
      record.operation.state = confirmedWrite || record.submitted && !rejected ? "unknown" : "failed";
      record.operation.steps[0].state = "failed";
      record.operation.error = record.operation.state === "unknown" ? {code: "OUTCOME_UNKNOWN", message: "操作可能已提交，请核对记录；不要重新执行。"} :
        {code: error.code as "UNAVAILABLE", message: error.message};
    } finally {
      clearTimeout(timer);
      process.removeListener("SIGTERM", abort); process.removeListener("SIGINT", abort);
      try { await this.ports.closeDatabase?.(); }
      catch { record.operation.state = record.submitted ? "unknown" : "failed"; record.operation.error = {code: "OUTCOME_UNKNOWN", message: "数据库连接收尾未确认，请先核对记录。"}; }
      record.operation.finishedAt = new Date().toISOString();
      try { await this.save("operations", id, record); } finally { await release?.(); }
    }
  }
  async operation(id: string): Promise<Operation> {
    const record = await this.load<SavedOperation>("operations", id);
    if (["running", "queued"].includes(record.operation.state) && record.pid) {
      try { process.kill(record.pid, 0); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === "ESRCH") {
        record.operation.state = record.submitted ? "unknown" : "failed";
        record.operation.error = {code: record.submitted ? "OUTCOME_UNKNOWN" : "RUN_FAILED", message: "运行进程已结束，请核对操作记录。"};
      } }
    }
    return record.operation;
  }
  async operations(limit = 50): Promise<Operation[]> {
    await privateDirectory(this.config.stateDir);
    const directory = join(this.config.stateDir, "operations"); await privateDirectory(directory);
    const names = (await readdir(directory)).filter(name => /^manage-[a-f0-9-]{36}\.json$/.test(name));
    if (names.length > 10000) throw new FreezeError("FREEZE_LIMIT");
    const records = await Promise.all(names.map(name => this.operation(name.slice(0, -5))));
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, Math.min(200, Math.max(1, limit)));
  }
  async request(op: string, input: Record<string, unknown>) {
    switch (op) {
      case "target.resolve": return this.resolve(input.input);
      case "freeze.preview": return this.preview(input.target, "freeze");
      case "unfreeze.preview":
        if (input.mode !== "once" && input.mode !== "permanent") throw new FreezeError("FREEZE_INPUT_INVALID");
        return this.preview(input.target, input.mode);
      case "freeze.start": case "unfreeze.start": case "sync.start": return this.start(op, input);
      case "operation.get": return this.operation(String(input.id));
      case "operation.list": return this.operations(typeof input.limit === "number" ? input.limit : 50);
      case "content.sections": return freezeQuery(await this.database(), "SELECT nb_freeze_api.sections() AS result");
      case "content.list": return freezeQuery(await this.database(), "SELECT nb_freeze_api.list_content($1,$2,$3) AS result", [input.section, input.parentId ?? null, input.search ?? null]);
      case "status": {
        const state = await createFreezeStore(await this.database()).state(), operations = await this.operations();
        const latest = await this.ports.latestReport(), queue = latest?.queue as {pending: number; needs_review: number} | null;
        const complete = latest && ["updated", "unchanged"].includes(String(latest.outcome));
        return {mode: "published", running: operations.find(op => op.state === "running" || op.state === "queued") ?? null,
          lastRun: operations[0] ?? null, lastSuccessAt: complete && typeof latest.finishedAt === "string" ? latest.finishedAt : null, publishedVersionAt: state.publishedAt,
          queue: queue ? {pending: queue.pending, needsReview: queue.needs_review} : null, contentValidUntil: null,
          capabilities: {sync: true, targetedSync: true, freeze: true, contentList: true, jobs: false, takedown: false}, observedAt: new Date().toISOString()} satisfies Partial<SyncStatus>;
      }
      default: throw new FreezeError("FREEZE_INPUT_INVALID");
    }
  }
}
