/**
 * Status of the other scheduled jobs, read from Dagu's own run records on disk (read only).
 * Dagu's HTTP API needs a login; its data directory does not, and holds the same records.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { JobState, JobStatus } from "../../console/lib/types.ts";

export interface JobsConfig {
  /** Dagu's data directory (`paths.data_dir`). */
  dataDir: string;
  /** Dagu's suspend flag directory (`paths.suspend_flags_dir`). */
  suspendDir: string;
  list: { dag: string; name: string; schedule: string | null }[];
}

interface RunRecord {
  status?: unknown;
  startedAt?: unknown;
  finishedAt?: unknown;
  nodes?: { step?: { name?: unknown }; status?: unknown }[];
}

// Dagu's status numbers.
const states: Record<number, JobState> = { 0: "never", 1: "running", 2: "failed", 3: "cancelled", 4: "succeeded", 5: "queued", 6: "partial", 7: "queued", 8: "failed" };
/** How many past runs to look through for the last success. */
const scanLimit = 300;

function iso(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function lastLine(path: string): RunRecord | null {
  try {
    const lines = readFileSync(path, "utf8").split("\n").filter((line) => line.trim());
    return lines.length ? (JSON.parse(lines[lines.length - 1]) as RunRecord) : null;
  } catch {
    return null;
  }
}

function sortedDesc(path: string, pattern: RegExp): string[] {
  try {
    return readdirSync(path).filter((name) => pattern.test(name)).sort().reverse();
  } catch {
    return [];
  }
}

/** Status files of past runs, newest first (each run's newest attempt). */
function* runFiles(root: string): Generator<string> {
  for (const year of sortedDesc(root, /^\d{4}$/)) {
    for (const month of sortedDesc(join(root, year), /^\d{2}$/)) {
      for (const day of sortedDesc(join(root, year, month), /^\d{2}$/)) {
        for (const run of sortedDesc(join(root, year, month, day), /^dag-run_/)) {
          const attempt = sortedDesc(join(root, year, month, day, run), /^a_/)[0];
          if (attempt) yield join(root, year, month, day, run, attempt, "status.jsonl");
        }
      }
    }
  }
}

/** Dag names are plain words; anything else is refused before it touches a path. */
function safeDag(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,80}$/.test(name);
}

export function readJobs(config: JobsConfig): JobStatus[] {
  return config.list.map(({ dag, name, schedule }) => {
    const base: JobStatus = { id: dag, name, schedule, suspended: false, state: "unknown", lastStartedAt: null, lastFinishedAt: null, lastSuccessAt: null, failedStep: null };
    if (!safeDag(dag)) return base;
    base.suspended = existsSync(join(config.suspendDir, `${dag}.suspend`));
    const root = join(config.dataDir, "dag-runs", dag, "dag-runs");
    let latest: RunRecord | null = null;
    let scanned = 0;
    for (const file of runFiles(root)) {
      const record = lastLine(file);
      if (!record) continue;
      if (!latest) latest = record;
      if (record.status === 4) {
        base.lastSuccessAt = iso(record.finishedAt) ?? iso(record.startedAt);
        break;
      }
      if (++scanned >= scanLimit) break;
    }
    if (!latest) return { ...base, state: existsSync(root) ? "unknown" : "never" };
    const state = typeof latest.status === "number" ? states[latest.status] ?? "unknown" : "unknown";
    const failed = (latest.nodes ?? []).find((node) => node.status === 2);
    const stepName = typeof failed?.step?.name === "string" && /^[A-Za-z0-9_-]{1,60}$/.test(failed.step.name) ? failed.step.name : null;
    return {
      ...base,
      state,
      lastStartedAt: iso(latest.startedAt),
      lastFinishedAt: state === "running" ? null : iso(latest.finishedAt),
      failedStep: state === "failed" || state === "partial" ? stepName : null,
    };
  });
}
