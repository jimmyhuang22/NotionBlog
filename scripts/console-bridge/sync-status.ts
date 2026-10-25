/**
 * Reads the website sync controller's state file (read-only) and describes it the way the console
 * expects. Nothing here starts, pauses or changes a sync.
 */
import type { Operation, SyncStatus } from "../../console/lib/types.ts";

interface HistoryEntry {
  status?: unknown;
  startedAtUTC?: unknown;
  finishedAtUTC?: unknown;
  reason?: unknown;
  failureCategory?: unknown;
}

export interface SyncView {
  status: Omit<SyncStatus, "capabilities" | "observedAt">;
  history: Operation[];
}

const failedStates = new Set(["FAILED", "FAIL"]);

function iso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

/** Reason codes are upper-case words; anything else (a path, free text) is not shown. */
function reasonCode(value: unknown): string | null {
  return typeof value === "string" && /^[A-Z0-9_]{1,100}$/.test(value) ? value : null;
}

function syncOperation(entry: { state: Operation["state"]; startedAt: string | null; finishedAt: string | null; reason: string | null; id: string }): Operation {
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
    steps: [{ label: running ? "整轮同步（后端不报告分步进度）" : "整轮同步", state: running ? "running" : done ? "done" : "failed" }],
    counts: null,
    error:
      entry.state === "failed"
        ? { code: "RUN_FAILED", message: entry.reason ? `原因代码：${entry.reason}` : "没有记录原因。" }
        : null,
    resumePlanId: null,
  };
}

export function describeSync(state: unknown, options: { suspended: boolean; schedule: string; now: number }): SyncView {
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
    history.push(syncOperation({ id: `sync-${Date.parse(finishedAt)}`, state, startedAt, finishedAt, reason }));
  });
  history.sort((a, b) => Date.parse(b.finishedAt ?? b.createdAt) - Date.parse(a.finishedAt ?? a.createdAt));

  const runningNow = record.status === "RUNNING";
  const startedAt = iso(record.startedAtUTC);
  const running = runningNow
    ? syncOperation({ id: `sync-running-${startedAt ? Date.parse(startedAt) : 0}`, state: "running", startedAt, finishedAt: null, reason: null })
    : null;

  const lastSuccess = history.find((op) => op.state === "succeeded")?.finishedAt ?? null;
  const failedNow = typeof record.status === "string" && failedStates.has(record.status);
  // The controller admits no new round while the last one failed or the schedule flag is set.
  const hold =
    options.suspended && failedNow
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
      publishedVersionAt: null,
    },
    history: running ? [running, ...history] : history,
  };
}
