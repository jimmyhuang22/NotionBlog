import { resolve, join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readPrivateFile, acquireLock } from "../notion-sync/state.ts";
import { GameSyncError, object, required, observations } from "./model.ts";
import { readEnv, readJson, writeJson, writeText } from "./private.ts";
import { collectNintendo, finishLogin, loginRequest } from "./nintendo.ts";
import { collectPsn } from "./psn.ts";
import { collectSteam, fixedSteamPolicy, steamPolicy } from "./steam.ts";
import { syncNotion } from "./notion.ts";
import type { SyncConfig } from "./notion.ts";
import { PLAN_VERSION } from "./plan.ts";
import type { SyncPlan, SyncProgress } from "./plan.ts";
import { runDaily, safeCode } from "./daily.ts";

async function notifyFailure() {
  if (process.platform !== "darwin" || process.argv[2] !== "daily" || process.argv[4] !== "notify") return;
  await new Promise<void>(done => {
    const child = spawn("/usr/bin/osascript", ["-e", 'display notification "每日游戏同步未完成，请查看私有回执；可能需要重新登录。" with title "Notion 游戏同步"'],
      { shell: false, stdio: "ignore" });
    const timer = setTimeout(() => { child.kill("SIGKILL"); done(); }, 5000);
    const finish = () => { clearTimeout(timer); done(); };
    child.once("error", finish); child.once("close", finish);
  });
}

async function main() {
  const [command, rootArg, flag] = process.argv.slice(2);
  if (!rootArg || !["nintendo-login", "nintendo-finish", "collect-psn", "collect-nintendo", "collect-steam", "dry-run", "apply", "daily"].includes(command)) {
    throw new GameSyncError("USAGE: node scripts/game-sync/cli.ts <command> <private-directory>");
  }
  if (![24, 25, 26].includes(Number(process.versions.node.split(".")[0]))) throw new GameSyncError("NODE_VERSION_UNSUPPORTED");
  if (command === "daily" && flag !== undefined && flag !== "notify") throw new GameSyncError("SELECT_PROVIDER");
  const root = resolve(rootArg), runId = randomUUID();
  const release = await acquireLock(root, runId);
  const deadline = setTimeout(async () => { console.error(JSON.stringify({ code: "TIME_LIMIT", runId })); await notifyFailure(); process.exit(1); }, 15 * 60000);
  try {
    if (command === "nintendo-login") {
      const pending = loginRequest(); await writeJson(join(root, "nintendo-pending.json"), pending);
      await writeJson(join(root, "nintendo-login.json"), { url: pending.url });
      console.log(JSON.stringify({ loginUrl: pending.url })); return;
    }
    if (command === "nintendo-finish") {
      await finishLogin(join(root, "nintendo-pending.json"), await readPrivateFile(join(root, "nintendo-callback.txt")), join(root, "nintendo-auth.json"));
      await writeText(join(root, "nintendo-callback.txt"), "");
      console.log(JSON.stringify({ connected: true })); return;
    }
    const env = await readEnv(join(root, "credentials.env"));
    async function currentSteamPolicy() {
      const policy = await fixedSteamPolicy(root) ?? steamPolicy(await readJson(join(root, "steam-policy.json")));
      if (policy.mode === "fixed-allowlist" && policy.steamId !== env.STEAM_ID) throw new GameSyncError("STEAM_ACCOUNT_MISMATCH");
      return policy;
    }
    async function collect(provider: string) {
      const policy = provider === "steam" ? await currentSteamPolicy() : null;
      const rows = provider === "steam"
        ? await collectSteam(env.STEAM_WEB_API_KEY ?? "", env.STEAM_ID ?? "", policy, "steam-main")
        : provider === "psn"
        ? await collectPsn(env.PSN_NPSSO ?? "", env.PSN_ONLINE_ID ?? "", join(root, "psn-auth.json"), "psn-main")
        : await collectNintendo(join(root, "nintendo-auth.json"), join(root, "nintendo-identity.json"), "nintendo-main", "global");
      await writeJson(join(root, `${provider}-snapshot.json`), rows);
      if (policy) await writeJson(join(root, "steam-policy-proof.json"), { digest: createHash("sha256").update(JSON.stringify(policy)).digest("hex") });
      return { collected: rows.length, allowed: rows.filter(r => r.visibility === "allowed").length,
        excluded: rows.filter(r => r.visibility === "excluded").length, unknown: rows.filter(r => r.visibility === "unknown").length };
    }
    if (command.startsWith("collect-")) { console.log(JSON.stringify(await collect(command.slice(8)))); return; }
    async function sync(flag: string, applying: boolean) {
      if (!["psn", "nintendo", "steam"].includes(flag)) throw new GameSyncError("SELECT_PROVIDER");
      const config = object(await readJson(join(root, "config.json")));
      required(config.recordsSourceId); required(config.gamesSourceId);
      if (Object.values(object(config.bindings)).some(v => typeof v !== "string" || !/^[0-9a-f-]{32,36}$/i.test(v))) throw new GameSyncError("PRIVATE_CONFIG_INVALID");
      if (!Array.isArray(config.excluded) || config.excluded.some(v => typeof v !== "string")) throw new GameSyncError("PRIVATE_CONFIG_INVALID");
      const raw = observations(await readJson(join(root, `${flag}-snapshot.json`)), flag === "psn" ? "PSN" : flag === "steam" ? "Steam" : "Nintendo");
      if (flag === "steam") {
        const policy = await currentSteamPolicy();
        const proof = object(await readJson(join(root, "steam-policy-proof.json")));
        if (proof.digest !== createHash("sha256").update(JSON.stringify(policy)).digest("hex")) throw new GameSyncError("COLLECT_FIRST");
      }
      // Snapshots must be fresh, and a separate dry-run is required before applying that exact snapshot.
      if (raw.some(r => Date.now() - Date.parse(r.syncedAt) > 60 * 60000 || Date.parse(r.syncedAt) > Date.now() + 60000)) {
        throw new GameSyncError("SNAPSHOT_EXPIRED");
      }
      const digest = createHash("sha256").update(JSON.stringify([config, raw])).digest("hex");
      const planPath = join(root, `${flag}-plan.json`);
      const receiptPath = join(root, `${flag}-receipt.json`);
      const journalPath = join(root, `${flag}-receipts`, `${runId}.json`);
      const saved = applying ? await readJson(planPath, 16 * 1024 * 1024) as { digest?: unknown; plan?: SyncPlan } | null : null;
      if (applying && (!saved || saved.digest !== digest || saved.plan?.version !== PLAN_VERSION)) throw new GameSyncError("DRY_RUN_REQUIRED");
      let plan: SyncPlan | undefined, progress: SyncProgress | undefined;
      const startedAt = new Date().toISOString();
      async function receipt(value: unknown) {
        await writeJson(journalPath, value); await writeJson(receiptPath, value);
      }
      try {
        const report = await syncNotion(required(env.NOTION_GAME_SYNC_TOKEN), config as unknown as SyncConfig, raw, applying, undefined, {
          ...(applying ? { expectedPlan: saved!.plan } : {}),
          onPlan: async value => {
            if (Buffer.byteLength(JSON.stringify(value)) > 15 * 1024 * 1024) throw new GameSyncError("LIMIT_EXCEEDED");
            plan = value;
          },
          onProgress: async value => {
            progress = value;
            await receipt({ runId, digest, startedAt, status: "running", plan, progress });
          },
        });
        const result = { runId, digest, startedAt, finishedAt: new Date().toISOString(),
          status: applying ? "verified" : "planned", plan, ...(applying ? { progress } : {}), report };
        if (applying) await receipt(result); else await writeJson(planPath, result);
        return report;
      } catch (e) {
        if (applying) await receipt({ runId, digest, startedAt, finishedAt: new Date().toISOString(), status: "failed",
          code: safeCode(e), plan: plan ?? saved!.plan, progress: progress ?? null });
        throw e;
      }
    }
    const includeSteam = command === "daily" && await fixedSteamPolicy(root) !== null;
    if (includeSteam) await currentSteamPolicy();
    console.log(JSON.stringify(command === "daily" ? await runDaily(root, runId, { collect, sync }, includeSteam) : await sync(flag, command === "apply")));
  } finally { clearTimeout(deadline); await release(); }
}
main().catch(async e => { console.error(JSON.stringify({ code: safeCode(e) })); await notifyFailure(); process.exitCode = 1; });
