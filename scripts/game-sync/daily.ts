import { join } from "node:path";
import { GameSyncError } from "./model.ts";
import { WorkerError } from "../notion-sync/errors.ts";
import { writeJson } from "./private.ts";

export type DailyProvider = "psn" | "nintendo" | "steam";
type Counts = Record<string, number | boolean>;
export interface DailyPort {
  collect: (provider: DailyProvider) => Promise<Counts>;
  sync: (provider: DailyProvider, apply: boolean) => Promise<Counts>;
}
export function safeCode(error: unknown): string {
  if ((error instanceof GameSyncError || error instanceof WorkerError) && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code)) return error.code;
  return "SYNC_FAILED";
}

/** Caller holds the account directory's lock. Steam requires a separate durable allowlist opt-in. */
export async function runDaily(root: string, runId: string, port: DailyPort, includeSteam = false) {
  const result: { runId: string; startedAt: string; finishedAt?: string; status: string; code?: string;
    stages: { provider: DailyProvider; step: "collect" | "dry-run" | "apply"; status: string; report?: Counts }[] } =
    { runId, startedAt: new Date().toISOString(), status: "running", stages: [] };
  async function save() {
    await writeJson(join(root, "daily-receipts", `${runId}.json`), result);
    await writeJson(join(root, "daily-receipt.json"), result);
  }
  try {
    await save();
    const providers: DailyProvider[] = includeSteam ? ["psn", "nintendo", "steam"] : ["psn", "nintendo"];
    for (const provider of providers) {
      for (const step of ["collect", "dry-run", "apply"] as const) {
        const stage = { provider, step, status: "running" } as (typeof result.stages)[number];
        result.stages.push(stage); await save();
        stage.report = step === "collect" ? await port.collect(provider) : await port.sync(provider, step === "apply");
        if (step === "apply" && (stage.report.applied !== true || stage.report.verified !==
            Number(stage.report.create) + Number(stage.report.update) + Number(stage.report.archive))) throw new GameSyncError("READBACK_FAILED");
        stage.status = "completed"; await save();
      }
    }
    result.status = "verified"; result.finishedAt = new Date().toISOString(); await save();
    return result;
  } catch (e) {
    result.status = "failed"; result.code = safeCode(e); result.finishedAt = new Date().toISOString();
    if (result.stages.at(-1)?.status === "running") result.stages.at(-1)!.status = "failed";
    await save(); throw e;
  }
}
