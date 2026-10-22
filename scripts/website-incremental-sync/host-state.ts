import { constants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { privateDirectory, readPrivateFile } from "../notion-sync/state.ts";
import { hostFail } from "./host-budget.ts";

export function validateHostReport(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) hostFail("HOST_STATE_INVALID");
  const value = input as Record<string, unknown>, counts = ["recovered", "published", "unchanged", "retired", "discoveredPages", "discoveredHints", "baselineRecords", "baselineMedia"];
  const keys = ["format", "outcome", "phase", "errorCode", "startedAt", "finishedAt", "budget", "queue", ...counts];
  const count = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  const code = (c: unknown) => c === null || typeof c === "string" && /^[A-Z_]{1,80}$/.test(c);
  if (Object.keys(value).length !== keys.length || Object.keys(value).some(k => !keys.includes(k)) || value.format !== "incremental-host-report-v1" ||
    !["failed", "cancelled", "initialized", "recovered", "updated", "unchanged", "partial", "retry", "blocked", "needs_review"].includes(String(value.outcome)) ||
    !["lock", "database", "initialize", "recovery", "discovery", "publication"].includes(String(value.phase)) || !code(value.errorCode) ||
    counts.some(k => !count(value[k])) || ["startedAt", "finishedAt"].some(k => typeof value[k] !== "string" || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value[k]) || !Number.isFinite(Date.parse(value[k])))) hostFail("HOST_STATE_INVALID");
  const budget = value.budget as Record<string, unknown>;
  if (!budget || Object.keys(budget).length !== 4 || !code(budget.errorCode) || ["sourceRequests", "sourceBytes", "mediaBytes"].some(k => !count(budget[k]))) hostFail("HOST_STATE_INVALID");
  if (value.queue !== null) {
    const queue = value.queue as Record<string, unknown>, names = ["pending", "leased", "retry", "awaiting_verification", "needs_review", "done", "events", "checkpoints", "retirement_pending"];
    if (!queue || Object.keys(queue).length !== names.length || names.some(k => !count(queue[k]))) hostFail("HOST_STATE_INVALID");
  }
  return value;
}

type PrivateReportFile = "incremental-ready.json" | "incremental-latest.json" | "baseline-latest.json";
export async function readHostJson(directory: string, name: PrivateReportFile) {
  await privateDirectory(directory);
  try { return JSON.parse(await readPrivateFile(join(directory, name))); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; hostFail("HOST_STATE_INVALID"); }
}
export async function writeHostJson(directory: string, name: PrivateReportFile, value: unknown, signal?: AbortSignal) {
  await privateDirectory(directory); signal?.throwIfAborted();
  const temp = join(directory, `.host-${randomUUID()}`), bytes = JSON.stringify(value) + "\n";
  if (Buffer.byteLength(bytes) > 2 * 1024 * 1024) hostFail("HOST_STATE_INVALID");
  const file = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    signal?.throwIfAborted(); await rename(temp, join(directory, name));
    const dir = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
    try { await dir.sync(); } finally { await dir.close(); }
  } finally { await unlink(temp).catch(() => {}); }
}
