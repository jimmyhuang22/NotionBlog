/**
 * The console's bridge command: `node scripts/console-bridge/cli.ts --config <private config.json>`.
 * Reads one JSON request on stdin and writes one JSON reply on stdout (docs/CONSOLE_BRIDGE.md).
 * Phase one: status, operation history and takedown. Everything else answers UNSUPPORTED.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Operation, SyncStatus } from "../../console/lib/types.ts";
import { loadConfig, type BridgeConfig } from "./config.ts";
import { BridgeError } from "./errors.ts";
import { describeSync, type SyncView } from "./sync-status.ts";
import { Takedown } from "./takedown.ts";

const VERSION = 1;
const cliPath = fileURLToPath(import.meta.url);

function readSync(config: BridgeConfig): SyncView {
  let state: unknown;
  try {
    state = JSON.parse(readFileSync(config.sync.stateFile, "utf8"));
  } catch {
    throw new BridgeError("UNAVAILABLE", "读不到同步程序的状态文件。");
  }
  const suspended = config.sync.suspendFlag !== null && existsSync(config.sync.suspendFlag);
  return describeSync(state, { suspended, schedule: config.sync.schedule, now: Date.now() });
}

function text(value: unknown, max = 2000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new BridgeError("INVALID_INPUT", "输入为空或太长。");
  return value.trim();
}

export async function handle(request: unknown, config: BridgeConfig, configPath: string): Promise<unknown> {
  if (typeof request !== "object" || request === null) throw new BridgeError("INVALID_INPUT", "请求格式不对。");
  const { version, op, input } = request as { version?: unknown; op?: unknown; input?: Record<string, unknown> };
  if (version !== VERSION) throw new BridgeError("INVALID_INPUT", "协议版本不对。");
  const takedown = new Takedown(config, configPath, cliPath);
  const args = input ?? {};

  switch (op) {
    case "status": {
      const view = readSync(config);
      const status: SyncStatus = {
        ...view.status,
        capabilities: { sync: false, targetedSync: false, freeze: false, takedown: takedown.enabled, contentList: false },
        observedAt: new Date().toISOString(),
      };
      return status;
    }
    case "operation.list": {
      const limit = typeof args.limit === "number" && args.limit > 0 ? Math.min(args.limit, 200) : 50;
      const ops: Operation[] = [...readSync(config).history, ...(takedown.enabled ? takedown.operations() : [])];
      ops.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      return ops.slice(0, limit);
    }
    case "operation.get": {
      const id = text(args.id, 200);
      const found = id.startsWith("takedown-") ? takedown.operation(id) : readSync(config).history.find((op) => op.id === id) ?? null;
      if (!found) throw new BridgeError("NOT_FOUND", "没有这条操作记录。");
      return found;
    }
    case "takedown.plan":
      return takedown.plan(text(args.input));
    case "takedown.execute":
      return takedown.start(text(args.planId, 100), "execute");
    case "takedown.resume":
      return takedown.start(text(args.planId, 100), "resume");
    default:
      throw new BridgeError("UNSUPPORTED", "这一项还没有接上。");
  }
}

async function main(argv: string[]) {
  const configIndex = argv.indexOf("--config");
  const configPath = configIndex >= 0 ? argv[configIndex + 1] : undefined;
  if (!configPath) {
    process.stderr.write("usage: cli.ts --config <absolute private config.json> [--worker <id>]\n");
    process.exitCode = 2;
    return;
  }
  const config = loadConfig(configPath);

  const workerIndex = argv.indexOf("--worker");
  if (workerIndex >= 0) {
    await new Takedown(config, configPath, cliPath).work(argv[workerIndex + 1] ?? "");
    return;
  }

  let body = "";
  for await (const chunk of process.stdin) {
    body += chunk;
    if (body.length > 1_000_000) break;
  }
  let reply: unknown;
  try {
    reply = { version: VERSION, ok: true, data: await handle(JSON.parse(body), config, configPath) };
  } catch (error) {
    if (error instanceof BridgeError) {
      reply = { version: VERSION, ok: false, error: { code: error.code, message: error.message, ...(error.runningOperationId ? { runningOperationId: error.runningOperationId } : {}) } };
    } else {
      // Details go to stderr, which the console never shows.
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      reply = { version: VERSION, ok: false, error: { code: "UNAVAILABLE", message: "桥接命令内部错误。" } };
    }
  }
  process.stdout.write(JSON.stringify(reply));
}

if (process.argv[1] === cliPath) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.stdout.write(JSON.stringify({ version: VERSION, ok: false, error: { code: "UNAVAILABLE", message: "桥接命令无法启动，请检查配置。" } }));
    process.exitCode = 1;
  });
}
