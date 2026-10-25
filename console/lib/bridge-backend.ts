/**
 * The real backend, reached through a backend-owned command (protocol: docs/CONSOLE_BRIDGE.md).
 *
 * Each call runs the command once without a shell, writes one JSON request to its stdin and reads
 * one JSON reply from its stdout. Long work (a sync, a freeze, a takedown) is started by one call
 * and followed with `operation.get`; no call waits for it.
 */
import { spawn } from "node:child_process";
import {
  BackendError,
  type BackendErrorBody,
  type BackendErrorCode,
  type ConsoleBackend,
  type ContentItem,
  type ContentPage,
  type FreezePreview,
  type JobStatus,
  type Operation,
  type Section,
  type SectionSummary,
  type SyncStatus,
  type TakedownPlan,
  type UnfreezeMode,
  type UnfreezePreview,
} from "./types.ts";

export const BRIDGE_PROTOCOL_VERSION = 1;

/** Read calls answer quickly; previews may walk a subtree. Starting work only queues it. */
const timeouts = {
  read: 15_000,
  preview: 60_000,
  start: 30_000,
} as const;

const maxReplyBytes = 4 * 1024 * 1024;

const knownCodes = new Set<BackendErrorCode>([
  "BUSY", "NOT_FOUND", "NOT_PUBLISHED", "ALREADY_FROZEN", "NOT_FROZEN", "PREVIEW_STALE",
  "MEDIA_NOT_READY", "PLAN_EXPIRED", "UNSUPPORTED", "INVALID_INPUT", "OUTCOME_UNKNOWN", "RUN_FAILED", "UNAVAILABLE",
]);

export interface BridgeOptions {
  /** Absolute path of the executable. */
  command: string;
  args: string[];
  /** Extra environment for the command; the console's own secrets are not passed on. */
  env?: Record<string, string>;
}

type Timeout = keyof typeof timeouts;

export class BridgeBackend implements ConsoleBackend {
  readonly kind = "bridge" as const;

  private readonly options: BridgeOptions;

  constructor(options: BridgeOptions) {
    this.options = options;
    if (!options.command.startsWith("/")) throw new Error("CONSOLE_BRIDGE_COMMAND must be an absolute path.");
  }

  status() {
    return this.call<SyncStatus>("status", {}, "read", isObject);
  }
  startSync(target: string | null) {
    return this.call<{ operationId: string }>("sync.start", { target }, "start", hasOperationId);
  }
  sections() {
    return this.call<SectionSummary[]>("content.sections", {}, "read", Array.isArray);
  }
  listContent(query: { section: Section; parentId: string | null; search: string | null }) {
    return this.call<ContentPage>("content.list", query, "read", (value) => isObject(value) && Array.isArray(value.items));
  }
  resolveTarget(input: string) {
    return this.call<ContentItem>("target.resolve", { input }, "read", (value) => isObject(value) && typeof value.id === "string");
  }
  previewFreeze(target: string) {
    return this.call<FreezePreview>("freeze.preview", { target }, "preview", hasDigest);
  }
  startFreeze(target: string, digest: string) {
    return this.call<{ operationId: string }>("freeze.start", { target, digest }, "start", hasOperationId);
  }
  previewUnfreeze(target: string, mode: UnfreezeMode) {
    return this.call<UnfreezePreview>("unfreeze.preview", { target, mode }, "preview", hasDigest);
  }
  startUnfreeze(target: string, mode: UnfreezeMode, digest: string) {
    return this.call<{ operationId: string }>("unfreeze.start", { target, mode, digest }, "start", hasOperationId);
  }
  planTakedown(input: string) {
    return this.call<TakedownPlan>("takedown.plan", { input }, "preview", (value) => isObject(value) && typeof value.planId === "string");
  }
  executeTakedown(planId: string) {
    return this.call<{ operationId: string }>("takedown.execute", { planId }, "start", hasOperationId);
  }
  resumeTakedown(planId: string) {
    return this.call<{ operationId: string }>("takedown.resume", { planId }, "start", hasOperationId);
  }
  operation(id: string) {
    return this.call<Operation>("operation.get", { id }, "read", (value) => isObject(value) && typeof value.id === "string");
  }
  operations(limit: number) {
    return this.call<Operation[]>("operation.list", { limit }, "read", Array.isArray);
  }
  jobs() {
    return this.call<JobStatus[]>("jobs.list", {}, "read", Array.isArray);
  }

  private async call<T>(op: string, input: unknown, timeout: Timeout, valid: (value: unknown) => boolean): Promise<T> {
    const reply = await this.run(JSON.stringify({ version: BRIDGE_PROTOCOL_VERSION, op, input }), timeout);
    let parsed: unknown;
    try {
      parsed = JSON.parse(reply);
    } catch {
      throw unavailable(`${op}: the reply is not JSON.`);
    }
    if (!isObject(parsed) || parsed.version !== BRIDGE_PROTOCOL_VERSION) throw unavailable(`${op}: unexpected protocol version.`);
    if (parsed.ok === true) {
      if (!valid(parsed.data)) throw unavailable(`${op}: the reply has an unexpected shape.`);
      return parsed.data as T;
    }
    if (parsed.ok === false && isObject(parsed.error)) throw new BackendError(errorBody(parsed.error));
    throw unavailable(`${op}: the reply has neither data nor error.`);
  }

  private run(request: string, kind: Timeout): Promise<string> {
    const timeoutMs = timeouts[kind];
    return new Promise((resolve, reject) => {
      const child = spawn(this.options.command, this.options.args, {
        stdio: ["pipe", "pipe", "pipe"],
        // Only what the bridge needs; the console's login secrets stay here.
        env: { NODE_ENV: process.env.NODE_ENV, PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "", ...this.options.env },
        shell: false,
      });
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      const finish = (error: BackendError | null, value?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value ?? "");
      };
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        // A start call that timed out may still have started the work; a read did nothing.
        const message = `The backend did not answer within ${Math.round(timeoutMs / 1000)} s.`;
        finish(new BackendError({ code: kind === "start" ? "OUTCOME_UNKNOWN" : "UNAVAILABLE", message }));
      }, timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxReplyBytes) {
          child.kill("SIGTERM");
          finish(unavailable("The reply is too large."));
          return;
        }
        chunks.push(chunk);
      });
      // stderr is the bridge's own log; it is drained, not shown, since it may hold private detail.
      child.stderr.resume();
      child.on("error", (error) => finish(unavailable(`Could not start the backend command (${(error as NodeJS.ErrnoException).code ?? "error"}).`)));
      child.on("close", (code) => {
        const output = Buffer.concat(chunks).toString("utf8").trim();
        if (output) finish(null, output);
        else finish(unavailable(`The backend command exited with ${code ?? "a signal"} and no reply.`));
      });
      child.stdin.on("error", () => {
        // The command may exit before reading; its reply (or lack of one) decides the outcome.
      });
      child.stdin.end(request);
    });
  }
}

function unavailable(message: string): BackendError {
  return new BackendError({ code: "UNAVAILABLE", message });
}

function errorBody(value: Record<string, unknown>): BackendErrorBody {
  const code = typeof value.code === "string" && knownCodes.has(value.code as BackendErrorCode) ? (value.code as BackendErrorCode) : "UNAVAILABLE";
  const message = typeof value.message === "string" ? value.message.slice(0, 500) : "";
  const body: BackendErrorBody = { code, message };
  if (typeof value.runningOperationId === "string") body.runningOperationId = value.runningOperationId;
  return body;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOperationId(value: unknown): boolean {
  return isObject(value) && typeof value.operationId === "string";
}

function hasDigest(value: unknown): boolean {
  return isObject(value) && typeof value.digest === "string" && isObject(value.target);
}
