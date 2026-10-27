/** The bridge's private configuration file (never committed). See docs/CONSOLE_BRIDGE.md. */
import { readFileSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import type { JobsConfig } from "./jobs.ts";

export interface BridgeConfig {
  /** Private directory for plans, journals and operation records; must sit under a `.local` folder. */
  stateDir: string;
  /** The live site's origin, used to turn a site path into the full address the takedown tool expects. */
  siteOrigin: string;
  sync: {
    /** The sync controller's state file, read only. */
    stateFile: string;
    /** When this file exists, scheduled syncs are suspended. */
    suspendFlag: string | null;
    /** Plain words for the console, such as "每 5 分钟检查一次". */
    schedule: string;
  };
  /** Other scheduled jobs to show; null hides the list. */
  jobs: JobsConfig | null;
  /** Explicit phase-two installation; absent/null preserves the read-only first phase. */
  management?: { node: string; project: string; envFile: string; configFile: string } | null;
  /** Null keeps takedown switched off. */
  takedown: {
    /** Node binary that runs the takedown tool. */
    node: string;
    /** The pinned project copy that holds scripts/public-cache/withdraw-cli.ts. */
    project: string;
    /** Private env file with the restricted operator account, cache settings and lock lists. */
    envFile: string;
  } | null;
}

function absolute(value: unknown, name: string): string {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value) throw new Error(`CONFIG_${name}`);
  return value;
}

export function loadConfig(path: string): BridgeConfig {
  const raw: unknown = JSON.parse(readFileSync(absolute(path, "PATH"), "utf8"));
  if (typeof raw !== "object" || raw === null) throw new Error("CONFIG_SHAPE");
  const value = raw as Record<string, unknown>;
  if (value.version !== 1) throw new Error("CONFIG_VERSION");

  const stateDir = absolute(value.stateDir, "STATE_DIR");
  if (!stateDir.split(sep).includes(".local")) throw new Error("CONFIG_STATE_DIR_NOT_PRIVATE");

  const origin = new URL(String(value.siteOrigin ?? ""));
  if (origin.protocol !== "https:") throw new Error("CONFIG_SITE_ORIGIN");

  const sync = value.sync as Record<string, unknown> | undefined;
  if (!sync) throw new Error("CONFIG_SYNC");
  const schedule = typeof sync.schedule === "string" && sync.schedule.length <= 60 ? sync.schedule : null;
  if (!schedule) throw new Error("CONFIG_SCHEDULE");

  let takedown: BridgeConfig["takedown"] = null;
  if (value.takedown !== null && value.takedown !== undefined) {
    const entry = value.takedown as Record<string, unknown>;
    takedown = { node: absolute(entry.node, "TAKEDOWN_NODE"), project: absolute(entry.project, "TAKEDOWN_PROJECT"), envFile: absolute(entry.envFile, "TAKEDOWN_ENV") };
  }

  let jobs: BridgeConfig["jobs"] = null;
  if (value.jobs !== null && value.jobs !== undefined) {
    const entry = value.jobs as Record<string, unknown>;
    if (!Array.isArray(entry.list) || entry.list.length > 50) throw new Error("CONFIG_JOBS");
    jobs = {
      dataDir: absolute(entry.dataDir, "JOBS_DATA"),
      suspendDir: absolute(entry.suspendDir, "JOBS_SUSPEND"),
      list: entry.list.map((item: unknown) => {
        const job = item as Record<string, unknown>;
        if (typeof job.dag !== "string" || typeof job.name !== "string" || job.name.length > 40) throw new Error("CONFIG_JOB");
        return { dag: job.dag, name: job.name, schedule: typeof job.schedule === "string" && job.schedule.length <= 60 ? job.schedule : null };
      }),
    };
  }

  let management: BridgeConfig["management"] = null;
  if (value.management !== null && value.management !== undefined) {
    const entry = value.management as Record<string, unknown>;
    management = { node: absolute(entry.node, "MANAGEMENT_NODE"), project: absolute(entry.project, "MANAGEMENT_PROJECT"),
      envFile: absolute(entry.envFile, "MANAGEMENT_ENV"), configFile: absolute(entry.configFile, "MANAGEMENT_CONFIG") };
  }

  return {
    stateDir,
    jobs,
    management,
    siteOrigin: origin.origin,
    sync: {
      stateFile: absolute(sync.stateFile, "SYNC_STATE"),
      suspendFlag: sync.suspendFlag === null || sync.suspendFlag === undefined ? null : absolute(sync.suspendFlag, "SYNC_SUSPEND"),
      schedule,
    },
    takedown,
  };
}
