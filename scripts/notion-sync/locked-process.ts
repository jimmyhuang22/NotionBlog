import { spawn, type ChildProcess } from "node:child_process";
import { acquireLock } from "./state.ts";

/** A hard deadline is safe only when the worker has stopped before lock release. */
export async function runLockedProcess(options: { root: string; runId: string; args: string[]; timeoutMs: number; graceMs?: number }) {
  let child: ChildProcess | undefined, killTimer: ReturnType<typeof setTimeout> | undefined;
  let reason: "TIME_LIMIT" | "CANCELLED" | undefined;
  const stop = (code: "TIME_LIMIT" | "CANCELLED") => {
    reason ??= code;
    if (!child || killTimer) return;
    child.kill("SIGTERM");
    killTimer = setTimeout(() => child?.kill("SIGKILL"), options.graceMs ?? 5000);
    killTimer.unref();
  };
  const cancel = () => stop("CANCELLED");
  process.on("SIGINT", cancel); process.on("SIGTERM", cancel);
  let release: (() => Promise<void>) | undefined;
  const timer = setTimeout(() => stop("TIME_LIMIT"), options.timeoutMs);
  try {
    release = await acquireLock(options.root, options.runId);
    if (reason) return { code: 1, reason };
    const code = await new Promise<number | null>((resolve, reject) => {
      child = spawn(process.execPath, options.args, { stdio: ["ignore", "inherit", "inherit", "ipc"] });
      let failure: Error | undefined;
      child.once("error", error => { failure = error; });
      // An error (including a failed kill) alone is not proof that work stopped.
      child.once("close", code => { if (failure) reject(failure); else resolve(code); });
    });
    return { code, reason };
  } finally {
    clearTimeout(timer); clearTimeout(killTimer);
    try { await release?.(); }
    finally { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); }
  }
}
