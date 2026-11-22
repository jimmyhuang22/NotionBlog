import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { readPrivateFile } from "../notion-sync/state.ts";
import { GameSyncError, object, required, observations } from "./model.ts";
import { readEnv, readJson, writeJson, writeText } from "./private.ts";
import { collectNintendo, finishLogin, loginRequest } from "./nintendo.ts";
import { collectPsn, collectPsnTrophyDetails, collectPsnWebsiteTrophies } from "./psn.ts";
import { collectSteam, fixedSteamPolicy, steamPolicy } from "./steam.ts";
import { syncNotion } from "./notion.ts";
import type { SyncConfig } from "./notion.ts";
import { PLAN_VERSION } from "./plan.ts";
import type { SyncPlan, SyncProgress } from "./plan.ts";
import { runDaily, safeCode } from "./daily.ts";
import { planPsnWebsiteTrophies, writePsnWebsiteTrophies } from "./website-trophies.ts";
import { maxTrophySnapshotBytes, planPsnTrophyDetails, writePsnTrophyDetails } from "./psn-trophy-details.ts";
import { collectSteamAchievements, maxSteamAchievementSnapshotBytes, planSteamAchievements, writeSteamAchievements } from "./steam-achievements.ts";


export async function runGameCommand(args: string[], runId: string) {
  if (!process.send || !process.connected) throw new GameSyncError("SUPERVISOR_REQUIRED");
  const [command, rootArg, flag] = args;
  const root = resolve(rootArg);
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
    if (command === "collect-steam-achievements" || command === "apply-steam-achievements") {
      const config = await readJson(join(root, "config.json"));
      const policy = await fixedSteamPolicy(root);
      if (!policy) throw new GameSyncError("STEAM_ALLOWLIST_REQUIRED");
      const steamId = env.STEAM_ID ?? "", path = join(root, "steam-achievements-snapshot.json");
      if (command === "collect-steam-achievements") {
        const snapshot = await collectSteamAchievements(env.STEAM_WEB_API_KEY ?? "", steamId, policy, config, flag);
        const text = JSON.stringify(snapshot) + "\n";
        if (Buffer.byteLength(text) > maxSteamAchievementSnapshotBytes) throw new GameSyncError("STEAM_ACHIEVEMENT_ICON_BUDGET");
        await writeText(path, text);
        console.log(JSON.stringify({ total: snapshot.set.trophies.length }));
        return;
      }
      const plan = planSteamAchievements(await readJson(path, maxSteamAchievementSnapshotBytes), steamId, policy, config);
      const { createDatabasePool, sqlExecutor } = await import("../../src/server/database/connection.ts");
      const pool = createDatabasePool(env.SYNC_DATABASE_URL, env.DATABASE_TLS ?? "verify", env.DATABASE_CA_CERT);
      try {
        const applied = await writeSteamAchievements(sqlExecutor(pool), plan);
        console.log(JSON.stringify({ applied, sets: 1 }));
      } finally {
        await pool.end();
      }
      return;
    }
    if (command === "collect-psn-trophies") {
      const snapshot = await collectPsnWebsiteTrophies(env.PSN_NPSSO ?? "", env.PSN_ONLINE_ID ?? "",
        join(root, "psn-auth.json"), "psn-main");
      await writeJson(join(root, "psn-trophies-snapshot.json"), snapshot);
      console.log(JSON.stringify({ products: snapshot.products.length }));
      return;
    }
    if (command === "collect-psn-trophy-details") {
      const snapshot = await collectPsnTrophyDetails(env.PSN_NPSSO ?? "", env.PSN_ONLINE_ID ?? "",
        join(root, "psn-auth.json"), await readJson(join(root, "config.json")), flag);
      const serialised = JSON.stringify(snapshot) + "\n";
      if (Buffer.byteLength(serialised) > maxTrophySnapshotBytes) throw new GameSyncError("PSN_TROPHY_ICON_BUDGET");
      await writeText(join(root, "psn-trophy-details-snapshot.json"), serialised);
      console.log(JSON.stringify({ sets: Object.keys(snapshot.details).length }));
      return;
    }
    if (command === "apply-psn-trophies" || command === "apply-psn-trophy-details") {
      const details = command === "apply-psn-trophy-details";
      const snapshot = await readJson(join(root, details ? "psn-trophy-details-snapshot.json" : "psn-trophies-snapshot.json"),
        details ? maxTrophySnapshotBytes : 8 * 1024 * 1024);
      const config = await readJson(join(root, "config.json")), onlineId = env.PSN_ONLINE_ID ?? "";
      const plan = details ? planPsnTrophyDetails(snapshot, onlineId, config) : planPsnWebsiteTrophies(snapshot, onlineId, config);
      const { createDatabasePool, sqlExecutor } = await import("../../src/server/database/connection.ts");
      const pool = createDatabasePool(env.SYNC_DATABASE_URL, env.DATABASE_TLS ?? "verify", env.DATABASE_CA_CERT);
      try {
        const applied = details ? await writePsnTrophyDetails(sqlExecutor(pool), plan) : await writePsnWebsiteTrophies(sqlExecutor(pool), plan);
        console.log(JSON.stringify({ applied, sets: plan.sets.length }));
      } finally {
        await pool.end();
      }
      return;
    }
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

}

const orphaned = () => process.exit(1);
process.on("disconnect", orphaned);
runGameCommand(process.argv.slice(2, 5), process.argv[5]).catch(e => { console.error(JSON.stringify({ code: safeCode(e) })); process.exitCode = 1; }).finally(() => { process.removeListener("disconnect", orphaned); if (process.connected) process.disconnect?.(); });
