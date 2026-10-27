import { spawn } from "node:child_process";
import { join } from "node:path";
import type { BridgeConfig } from "./config.ts";
import { BridgeError } from "./errors.ts";
import type { BackendErrorCode } from "../../console/lib/types.ts";

const codes = new Set(["BUSY", "NOT_FOUND", "NOT_PUBLISHED", "ALREADY_FROZEN", "NOT_FROZEN", "PREVIEW_STALE", "MEDIA_NOT_READY", "PLAN_EXPIRED", "UNSUPPORTED", "INVALID_INPUT", "OUTCOME_UNKNOWN", "RUN_FAILED", "UNAVAILABLE"]);
export async function managementRequest(config: BridgeConfig, op: string, input: Record<string, unknown>): Promise<unknown> {
  if (!config.management) throw new BridgeError("UNSUPPORTED", "第二阶段还没有接上。");
  const tool = config.management, starting = op.endsWith(".start");
  const timeout = op.endsWith(".preview") ? 55000 : starting ? 25000 : 12000;
  const env: NodeJS.ProcessEnv = {NODE_ENV: process.env.NODE_ENV ?? "production"};
  for (const key of ["PATH", "HOME"]) if (process.env[key]) env[key] = process.env[key];
  const child = spawn(tool.node, [`--env-file=${tool.envFile}`, join(tool.project, "scripts/console-management/cli.ts"), "--config", tool.configFile],
    {cwd: tool.project, env, stdio: ["pipe", "pipe", "ignore"]});
  let body = "", stopped = false;
  const timer = setTimeout(() => { stopped = true; child.kill("SIGTERM"); }, timeout);
  child.stdout.on("data", value => { body += value; if (Buffer.byteLength(body) > 4 * 1024 * 1024) { stopped = true; child.kill("SIGTERM"); } });
  child.stdin.on("error", () => {});
  child.stdin.end(JSON.stringify({version: 1, op, input}));
  try {
    const code = await new Promise<number | null>((done, fail) => {child.once("exit", done); child.once("error", fail);});
    if (stopped || code !== 0) throw new Error("BACKEND_UNAVAILABLE");
    const response = JSON.parse(body);
    if (response?.version !== 1 || typeof response.ok !== "boolean") throw new Error("BAD_REPLY");
    if (!response.ok) {
      const error = response.error;
      // Native diagnostics are fixed messages; arbitrary error text is never forwarded.
      throw new BridgeError(codes.has(error?.code) ? error.code as BackendErrorCode : "UNAVAILABLE", "操作未确认完成，请查看后端操作记录。");
    }
    if (!Object.hasOwn(response, "data")) throw new Error("BAD_REPLY");
    return response.data;
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError(starting ? "OUTCOME_UNKNOWN" : "UNAVAILABLE", starting ? "启动结果未确认，请先查看操作记录。" : "第二阶段后端暂时没有响应。");
  } finally { clearTimeout(timer); }
}
