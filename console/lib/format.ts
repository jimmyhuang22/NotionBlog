import type { ContentState, Operation, OperationCounts, OperationKind, OperationState } from "./types.ts";

export const kindLabels: Record<OperationKind, string> = {
  sync: "同步",
  freeze: "冻结",
  "unfreeze-permanent": "永久解冻",
  "unfreeze-once": "同步一次",
  takedown: "下架",
};

export const operationStateLabels: Record<OperationState, string> = {
  queued: "排队中",
  running: "进行中",
  succeeded: "完成",
  failed: "失败",
  unknown: "结果未知",
  cancelled: "已取消",
};

export const contentStateLabels: Record<ContentState, string> = {
  syncing: "同步中",
  frozen: "已冻结",
  withdrawn: "已下架",
};

export function isActive(op: Pick<Operation, "state">): boolean {
  return op.state === "queued" || op.state === "running";
}

export function operationTitle(op: Operation): string {
  if (op.kind === "sync") return op.target ? `同步「${op.target.title}」` : op.trigger === "schedule" ? "定时同步" : "同步全部";
  return `${kindLabels[op.kind]}「${op.target?.title ?? "未知页面"}」`;
}

/** One line such as "改了 2 页 · 新图 1 张"; null when there is nothing to say. */
export function countsLine(op: Operation): string | null {
  const counts: OperationCounts | null = op.counts;
  if (!counts) return null;
  const parts: string[] = [];
  if (op.kind === "freeze" || op.kind === "takedown") {
    if (counts.pages !== undefined) parts.push(`${counts.pages} 个页面`);
    if (counts.images !== undefined) parts.push(`${counts.images} 张图片`);
  } else {
    if (counts.pagesChanged !== undefined) parts.push(counts.pagesChanged === 0 ? "没有变化" : `更新 ${counts.pagesChanged} 页`);
    if (counts.pagesWithdrawn) parts.push(`下架 ${counts.pagesWithdrawn} 页`);
    if (counts.mediaNew) parts.push(`新图 ${counts.mediaNew} 张`);
  }
  return parts.length ? parts.join(" · ") : null;
}

export function formatDateTime(value: string, timeZone: string): string {
  const date = new Date(value);
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const thisYear = new Intl.DateTimeFormat("en", { timeZone, year: "numeric" }).format(new Date());
  const year = get("year") === thisYear ? "" : `${get("year")} 年 `;
  return `${year}${get("month")} 月 ${get("day")} 日 ${get("hour")}:${get("minute")}`;
}

export function formatDate(value: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("zh-CN", { timeZone, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(new Date(value));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")} 年 ${get("month")} 月 ${get("day")} 日`;
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 ? `${minutes} 分 ${seconds % 60} 秒` : `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours} 小时 ${minutes % 60} 分` : `${hours} 小时`;
}

/** "3 分钟前", "2 小时后"; under a minute is "刚刚" or "马上". */
export function formatRelative(value: string, now: number): string {
  const diff = Date.parse(value) - now;
  const future = diff > 0;
  const minutes = Math.round(Math.abs(diff) / 60_000);
  if (minutes < 1) return future ? "马上" : "刚刚";
  let text: string;
  if (minutes < 60) text = `${minutes} 分钟`;
  else if (minutes < 60 * 24) text = `${Math.round(minutes / 60)} 小时`;
  else if (minutes < 60 * 24 * 60) text = `${Math.round(minutes / 60 / 24)} 天`;
  else text = `${Math.round(minutes / 60 / 24 / 30)} 个月`;
  return future ? `${text}后` : `${text}前`;
}

export function operationDuration(op: Operation, now: number): number | null {
  if (!op.startedAt) return null;
  const end = op.finishedAt ? Date.parse(op.finishedAt) : now;
  return end - Date.parse(op.startedAt);
}
