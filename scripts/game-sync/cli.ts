import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { unlockStale } from "../notion-sync/state.ts";
import { GameSyncError } from "./model.ts";
import { safeCode } from "./daily.ts";
import { runLockedProcess } from "../notion-sync/locked-process.ts";

async function notifyFailure() {
  if (process.platform !== "darwin" || process.argv[2] !== "daily" || process.argv[4] !== "notify") return;
  await new Promise<void>(done => {
    const child = spawn("/usr/bin/osascript", ["-e", 'display notification "每日游戏同步未完成，请查看错误码与私有回执；BUSY 时检查锁所有者。" with title "Notion 游戏同步"'],
      { shell: false, stdio: "ignore" });
    const timer = setTimeout(() => { child.kill("SIGKILL"); done(); }, 5000);
    const finish = () => { clearTimeout(timer); done(); };
    child.once("error", finish); child.once("close", finish);
  });
}

async function main() {
  const [command, rootArg, flag] = process.argv.slice(2);
  if (!rootArg || !["nintendo-login", "nintendo-finish", "collect-psn", "collect-nintendo", "collect-steam", "dry-run", "apply", "daily", "unlock-stale"].includes(command)) {
    throw new GameSyncError("USAGE: node scripts/game-sync/cli.ts <command> <private-directory>");
  }
  if (![24, 25, 26].includes(Number(process.versions.node.split(".")[0]))) throw new GameSyncError("NODE_VERSION_UNSUPPORTED");
  if (command === "daily" && flag !== undefined && flag !== "notify") throw new GameSyncError("SELECT_PROVIDER");
  const root = resolve(rootArg), runId = randomUUID();
  if (command === "unlock-stale") { await unlockStale(root); console.log(JSON.stringify({ unlocked: true })); return; }
  const result = await runLockedProcess({ root, runId, timeoutMs: 15 * 60000,
    args: [fileURLToPath(new URL("./command-worker.ts", import.meta.url)), command, root, flag ?? "", runId] });
  if (result.reason) throw new GameSyncError(result.reason);
  if (result.code !== 0) { await notifyFailure(); process.exitCode = result.code ?? 1; }
}
main().catch(async e => { console.error(JSON.stringify({ code: safeCode(e) })); await notifyFailure(); process.exitCode = 1; });
