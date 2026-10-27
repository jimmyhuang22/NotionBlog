/**
 * Reads the website sync controller's state file (read-only) and describes it the way the console
 * expects. Nothing here starts, pauses or changes a sync.
 */
import type { Operation, SyncStatus } from "../../console/lib/types.ts";

interface HistoryEntry {
  status?: unknown;
  operation?: unknown;
  startedAtUTC?: unknown;
  finishedAtUTC?: unknown;
  reason?: unknown;
  failureCategory?: unknown;
}

export interface SyncView {
  status: Omit<SyncStatus, "capabilities" | "observedAt">;
  history: Operation[];
}

const publishedPostIncomplete = "PUBLISHED_POST_INCOMPLETE";
const failedStates = new Set(["FAILED", "FAIL", publishedPostIncomplete]);

function iso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

/** Reason codes are upper-case words; anything else (a path, free text) is not shown. */
function reasonCode(value: unknown): string | null {
  return typeof value === "string" && /^[A-Z0-9_-]{1,100}$/.test(value) ? value : null;
}

/** Plain words for the reason codes the controller has used; the code stays beside them. */
const reasonWords: Record<string, string> = {
  SOURCE_NATIVE_POOL_CONNECTION_LIMIT_DURING_DISCOVERY: "扫描 Notion 内容时，数据库连接数到了上限",
  SOURCE_OWNER_RECEIPT_FIELD_MISMATCH_BEFORE_PUBLICATION: "发布前核对回执，字段对不上，所以没有发布",
  SOURCE_ADMISSION_FAILED_BEFORE_PUBLICATION: "发布前的准入检查没通过，所以没有发布",
  SOURCE_COLLECTION_FAILED_REVIEWED_NO_PUBLISH: "采集失败，核对后确认没有发布",
  READER_EAUTHQUERY: "读取账号连数据库时认证失败",
  CONTENT_FAILED: "采集或发布内容时失败",
  "PRODUCTION-VISITOR_FAILED": "发布后的访客验收没通过",
};

export function reasonMessage(code: string | null): string {
  if (!code) return "没有记录原因。";
  const words = reasonWords[code];
  return words ? `${words}（${code}）` : `原因代码：${code}`;
}

function syncOperation(entry: { state: Operation["state"]; startedAt: string | null; finishedAt: string | null; reason: string | null; id: string; postIncomplete?: boolean }): Operation {
  const done = entry.state === "succeeded";
  const running = entry.state === "running";
  return {
    id: entry.id,
    kind: "sync",
    target: null,
    trigger: "schedule",
    state: entry.state,
    createdAt: entry.startedAt ?? entry.finishedAt ?? new Date(0).toISOString(),
    startedAt: entry.startedAt,
    finishedAt: entry.finishedAt,
    // The controller does not report steps; one honest step stands for the whole round.
    steps: [{ label: entry.postIncomplete ? "内容已发布，后续阶段未完成" : running ? "整轮同步（后端不报告分步进度）" : "整轮同步", state: running ? "running" : done ? "done" : "failed" }],
    counts: null,
    error:
      entry.state === "failed"
        ? { code: "RUN_FAILED", message: `${entry.postIncomplete ? "内容已发布，后续检查或补全未完成。" : ""}${reasonMessage(entry.reason)}` }
        : null,
    resumePlanId: null,
  };
}

export function describeSync(
  state: unknown,
  options: { suspended: boolean; schedule: string; now: number; validUntilFor?: (operation: string) => string | null },
): SyncView {
  if (typeof state !== "object" || state === null) throw new Error("SYNC_STATE_SHAPE");
  const record = state as Record<string, unknown>;
  const rawHistory = Array.isArray(record.history) ? (record.history as HistoryEntry[]) : [];

  const history: Operation[] = [];
  rawHistory.forEach((entry, index) => {
    const finishedAt = iso(entry.finishedAtUTC);
    if (!finishedAt) return;
    const status = typeof entry.status === "string" ? entry.status : "";
    const state: Operation["state"] = status === "PASS" ? "succeeded" : failedStates.has(status) ? "failed" : "unknown";
    // The newest entry's reason may only be on the top-level state.
    const isCurrent = index === rawHistory.length - 1 && iso(record.finishedAtUTC) === finishedAt;
    const reason = reasonCode(entry.reason) ?? reasonCode(entry.failureCategory) ?? (isCurrent ? reasonCode(record.reason) : null);
    const startedAt = iso(entry.startedAtUTC) ?? (isCurrent ? iso(record.startedAtUTC) : null);
    history.push(syncOperation({ id: `sync-${Date.parse(finishedAt)}`, state, startedAt, finishedAt, reason, postIncomplete: status === publishedPostIncomplete }));
  });
  history.sort((a, b) => Date.parse(b.finishedAt ?? b.createdAt) - Date.parse(a.finishedAt ?? a.createdAt));

  const runningNow = record.status === "RUNNING";
  const startedAt = iso(record.startedAtUTC);
  const running = runningNow
    ? syncOperation({ id: `sync-running-${startedAt ? Date.parse(startedAt) : 0}`, state: "running", startedAt, finishedAt: null, reason: null })
    : null;

  const lastSuccess = history.find((op) => op.state === "succeeded")?.finishedAt ?? null;
  // A partial round may have replaced the publication without supplying its publication time.
  // Keep the last complete round's success time, but do not label its version as current.
  const publicationTimeUnknown = record.status === publishedPostIncomplete ||
    rawHistory.some((entry) => entry.status === publishedPostIncomplete &&
      iso(entry.finishedAtUTC) !== null && Date.parse(entry.finishedAtUTC as string) > (lastSuccess ? Date.parse(lastSuccess) : -Infinity));
  // The last successful round's receipt says until when its content counts as current.
  const lastPass = [...rawHistory].reverse().find((entry) => entry.status === "PASS");
  const validUntil = !publicationTimeUnknown && lastPass && typeof lastPass.operation === "string" && options.validUntilFor ? iso(options.validUntilFor(lastPass.operation)) : null;
  const failedNow = typeof record.status === "string" && failedStates.has(record.status);
  // The controller admits no new round while the last one failed or the schedule flag is set.
  const hold =
    record.status === publishedPostIncomplete
      ? `${options.suspended ? "调度开关处于暂停状态。" : ""}内容已发布，后续阶段未完成，要等人工核对后才会继续。`
      : options.suspended && failedNow
      ? "调度开关处于暂停状态，上一轮也失败了，要等人工核对后才会继续。"
      : options.suspended
        ? "调度开关处于暂停状态。"
        : failedNow
          ? "上一轮失败，要等人工核对后才会继续。"
          : null;
  const due = typeof record.nextDueAt === "number" ? record.nextDueAt * 1000 : null;
  const nextScheduledAt = !hold && !runningNow && due !== null && due > options.now ? new Date(due).toISOString() : null;

  return {
    status: {
      mode: "qualified",
      running,
      lastSuccessAt: lastSuccess,
      lastRun: history[0] ?? null,
      nextScheduledAt,
      schedule: options.suspended ? "已暂停" : options.schedule,
      queue: null,
      hold,
      publishedVersionAt: publicationTimeUnknown ? null : lastSuccess,
      contentValidUntil: validUntil,
    },
    history: running ? [running, ...history] : history,
  };
}
