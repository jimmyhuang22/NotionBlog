/**
 * Takedown for the console, wrapping the existing tool (scripts/public-cache/withdraw-cli.ts) without
 * changing it. Planning runs the tool and waits; executing starts a detached worker and returns at
 * once, and progress is read back from the tool's own journal.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, openSync, closeSync, readFileSync, readdirSync, writeFileSync, renameSync, constants, existsSync } from "node:fs";
import { join } from "node:path";
import type { Operation, OperationState, StepState, TakedownPlan } from "../../console/lib/types.ts";
import type { BridgeConfig } from "./config.ts";
import { BridgeError } from "./errors.ts";

const steps = ["写入下架名单", "清除页面缓存", "清除图片缓存", "核验"];
/** How many steps each journal phase has finished. */
const phaseDone: Record<string, number> = { PLANNED: 0, DENIED_PURGE_PENDING: 1, PURGED_VERIFY_PENDING: 3, COMPLETE: 4 };
const planMinutes = 15;
const planTimeoutMs = 55_000;
const runTimeoutMs = 30 * 60_000;

interface PlanRecord {
  planId: string;
  journal: string;
  target: { id: string; title: string; href: string | null };
  descendants: number;
  images: number;
  createdAt: string;
  expiresAt: string;
}

interface OperationRecord {
  id: string;
  planId: string;
  mode: "execute" | "resume";
  createdAt: string;
  startedAt: string | null;
  pid: number | null;
  finishedAt: string | null;
  exitCode: number | null;
}

interface Journal {
  phase?: unknown;
  plan?: { pages?: { href?: unknown }[]; assets?: unknown[]; leaseActive?: unknown };
}

export class Takedown {
  private readonly config: BridgeConfig;
  private readonly configPath: string;
  private readonly cliPath: string;

  constructor(config: BridgeConfig, configPath: string, cliPath: string) {
    this.config = config;
    this.configPath = configPath;
    this.cliPath = cliPath;
  }

  get enabled(): boolean {
    return this.config.takedown !== null;
  }

  async plan(input: string): Promise<TakedownPlan> {
    const tool = this.tool();
    const target = this.targetUrl(input);
    const planId = randomUUID();
    const journal = join(this.dir("journals"), `${planId}.json`);
    const result = await run(tool.node, [`--env-file=${tool.envFile}`, join(tool.project, "scripts/public-cache/withdraw-cli.ts"), target, "--plan", journal], tool.project, planTimeoutMs);
    if (result.code !== 0 || !existsSync(journal)) {
      throw new BridgeError("UNAVAILABLE", "没能生成计划：页面可能不存在或没有公开，也可能是后端暂时连不上。网站没有变化。");
    }
    const data = readJson<Journal>(journal);
    const pages = data.plan?.pages ?? [];
    const path = new URL(target).pathname;
    const own = pages.find((page) => page.href === path) ?? pages[0];
    const href = typeof own?.href === "string" ? own.href : null;
    const now = Date.now();
    const record: PlanRecord = {
      planId,
      journal,
      target: { id: planId, title: href ?? target, href },
      descendants: Math.max(0, pages.length - 1),
      images: Array.isArray(data.plan?.assets) ? data.plan.assets.length : 0,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + planMinutes * 60_000).toISOString(),
    };
    writePrivate(join(this.dir("plans"), `${planId}.json`), record);
    return { planId, target: record.target, descendants: record.descendants, images: record.images, createdAt: record.createdAt, expiresAt: record.expiresAt };
  }

  start(planId: string, mode: "execute" | "resume"): { operationId: string } {
    this.tool();
    const plan = this.readPlan(planId);
    const phase = readJson<Journal>(plan.journal).phase;
    if (mode === "execute") {
      if (Date.parse(plan.expiresAt) < Date.now()) throw new BridgeError("PLAN_EXPIRED", "计划超过 15 分钟，请重新生成。");
      if (phase !== "PLANNED") throw new BridgeError("INVALID_INPUT", "这份计划已经执行过，请用“继续下架”。");
    } else if (phase === "PLANNED" || phase === "COMPLETE") {
      throw new BridgeError("INVALID_INPUT", phase === "COMPLETE" ? "这份计划已经完成。" : "这份计划还没有开始执行。");
    }
    const running = this.records().find((record) => !record.finishedAt && processAlive(record.pid));
    if (running) throw new BridgeError("BUSY", "另一项下架正在进行。", `takedown-${running.id}`);

    const record: OperationRecord = { id: randomUUID(), planId, mode, createdAt: new Date().toISOString(), startedAt: null, pid: null, finishedAt: null, exitCode: null };
    writePrivate(this.recordPath(record.id), record);
    const child = spawn(process.execPath, [this.cliPath, "--config", this.configPath, "--worker", record.id], {
      detached: true,
      stdio: "ignore",
      env: minimalEnv(),
    });
    child.unref();
    return { operationId: `takedown-${record.id}` };
  }

  /** Runs in the detached worker process. */
  async work(id: string): Promise<void> {
    const tool = this.tool();
    const record = readJson<OperationRecord>(this.recordPath(id));
    const plan = this.readPlan(record.planId);
    record.startedAt = new Date().toISOString();
    record.pid = process.pid;
    writePrivate(this.recordPath(id), record);
    const result = await run(tool.node, [`--env-file=${tool.envFile}`, join(tool.project, "scripts/public-cache/withdraw-cli.ts"), `--${record.mode}`, plan.journal], tool.project, runTimeoutMs);
    record.finishedAt = new Date().toISOString();
    record.exitCode = result.code;
    writePrivate(this.recordPath(id), record);
  }

  operations(): Operation[] {
    return this.records().map((record) => this.describe(record));
  }

  operation(id: string): Operation | null {
    const raw = id.startsWith("takedown-") ? id.slice("takedown-".length) : null;
    if (!raw || !/^[0-9a-f-]{36}$/.test(raw) || !existsSync(this.recordPath(raw))) return null;
    return this.describe(readJson<OperationRecord>(this.recordPath(raw)));
  }

  private describe(record: OperationRecord): Operation {
    let plan: PlanRecord | null = null;
    let phase = "PLANNED";
    try {
      plan = this.readPlan(record.planId);
      const value = readJson<Journal>(plan.journal).phase;
      if (typeof value === "string") phase = value;
    } catch {
      // A missing plan or journal is reported below as an unknown outcome.
    }
    const finished = record.finishedAt !== null;
    const alive = !finished && processAlive(record.pid);
    // A worker that never recorded itself within a minute did not start.
    const starting = !finished && record.pid === null && Date.now() - Date.parse(record.createdAt) < 60_000;
    const unknownDeny = phase === "DENY_OUTCOME_UNKNOWN";
    const done = unknownDeny ? 0 : phaseDone[phase] ?? 0;

    let state: OperationState;
    let error: Operation["error"] = null;
    let resumePlanId: string | null = null;
    if (alive || starting) {
      state = record.startedAt ? "running" : "queued";
    } else if (finished && record.exitCode === 0 && phase === "COMPLETE") {
      state = "succeeded";
    } else if (unknownDeny || !plan) {
      state = "unknown";
      error = { code: "OUTCOME_UNKNOWN", message: unknownDeny ? "写入下架名单的结果没有得到确认。" : "找不到这次下架的计划记录。" };
      resumePlanId = plan ? record.planId : null;
    } else if (phase === "PLANNED") {
      state = "failed";
      error = { code: "UNAVAILABLE", message: "下架没有开始：可能有同步正在运行（锁被占用），也可能连接失败。网站没有变化，可以重新生成计划再试。" };
    } else {
      state = finished ? "failed" : "unknown";
      error = { code: finished ? "UNAVAILABLE" : "OUTCOME_UNKNOWN", message: "下架名单已写入，但缓存清理或核验没有完成。可以继续下架。" };
      resumePlanId = record.planId;
    }

    const stepStates: StepState[] = steps.map((_, index) => {
      if (index < done) return "done";
      if (index === done && state === "running") return "running";
      if (index === done && (state === "failed" || state === "unknown")) return "failed";
      return state === "failed" || state === "unknown" ? "skipped" : "pending";
    });

    return {
      id: `takedown-${record.id}`,
      kind: "takedown",
      target: plan?.target ?? null,
      trigger: "console",
      state,
      createdAt: record.createdAt,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      steps: steps.map((label, index) => ({ label, state: stepStates[index] })),
      counts: state === "succeeded" && plan ? { pages: plan.descendants + 1, images: plan.images } : null,
      error,
      resumePlanId,
    };
  }

  private tool(): NonNullable<BridgeConfig["takedown"]> {
    if (!this.config.takedown) throw new BridgeError("UNSUPPORTED", "下架还没有接上。");
    return this.config.takedown;
  }

  private targetUrl(input: string): string {
    const value = input.trim();
    if (value.startsWith("/") && !value.startsWith("//")) return new URL(value, this.config.siteOrigin).toString();
    try {
      const url = new URL(value);
      if (url.protocol === "https:") return url.toString();
    } catch {
      // Falls through.
    }
    throw new BridgeError("INVALID_INPUT", "请输入以 / 开头的站内路径、完整的网站地址或 Notion 页面链接。");
  }

  private readPlan(planId: string): PlanRecord {
    if (!/^[0-9a-f-]{36}$/.test(planId)) throw new BridgeError("NOT_FOUND", "没有这份下架计划。");
    const path = join(this.dir("plans"), `${planId}.json`);
    if (!existsSync(path)) throw new BridgeError("NOT_FOUND", "没有这份下架计划。");
    return readJson<PlanRecord>(path);
  }

  private records(): OperationRecord[] {
    return readdirSync(this.dir("operations"))
      .filter((name) => /^[0-9a-f-]{36}\.json$/.test(name))
      .map((name) => readJson<OperationRecord>(join(this.dir("operations"), name)));
  }

  private recordPath(id: string): string {
    return join(this.dir("operations"), `${id}.json`);
  }

  private dir(name: string): string {
    const path = join(this.config.stateDir, name);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    return path;
  }
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** Writes through a temporary file so a reader never sees half a record. */
function writePrivate(path: string, value: unknown) {
  const temp = `${path}.tmp-${randomUUID()}`;
  const handle = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    writeFileSync(handle, JSON.stringify(value, null, 2) + "\n");
  } finally {
    closeSync(handle);
  }
  renameSync(temp, path);
}

/** Only what a child needs to start; private settings come from its own env file. */
function minimalEnv(): NodeJS.ProcessEnv {
  return { NODE_ENV: process.env.NODE_ENV, PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "" };
}

function processAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function run(command: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number | null }> {
  return new Promise((resolvePromise) => {
    // The tool reads its own private env file; the bridge passes nothing else on.
    const child = spawn(command, args, { cwd, stdio: ["ignore", "ignore", "ignore"], env: minimalEnv() });
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("error", () => {
      clearTimeout(timer);
      resolvePromise({ code: null });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code });
    });
  });
}
