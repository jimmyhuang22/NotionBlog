import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { openFullBaselineDatabase, IncrementalDatabaseError, type IncrementalDatabaseOptions } from "../../src/server/database/incremental-connection.ts";
import { configDigest } from "../../src/server/database/website-validation.ts";
import { parseWebsiteNotionConfig, websiteCollectionTimeZone, type WebsiteNotionConfig } from "../../src/server/notion/website-config.ts";
import { ContentServiceError } from "../../contracts/repository.ts";
import { acquireLock, privateDirectory } from "../notion-sync/state.ts";
import { WorkerError } from "../notion-sync/errors.ts";
import { runWebsiteSync } from "../website-sync/worker.ts";
import { assertFullBaselineConfig, savePreparedFullBaseline, sealFullBaselineArtifact, FullBaselineArtifactError } from "./full-baseline-artifact.ts";
import { createDatabaseContentBaselineReader } from "./content-baseline.ts";
import { createFullBaselineBudget, hostAwait, hostFail, IncrementalHostError, type HostBudget, type HostBudgetOptions } from "./host-budget.ts";
import { writeHostJson } from "./host-state.ts";
import type { FullBaselineSources } from "./full-baseline-sources.ts";
import { createHostResources, type RegisterHostCleanup } from "./host-resources.ts";

type Database = Awaited<ReturnType<typeof openFullBaselineDatabase>>;
export interface FullBaselineHostOptions extends HostBudgetOptions {
  command: "publish" | "seal"; config: unknown; lockDirectory: string; artifactDirectory: string;
  database: Omit<IncrementalDatabaseOptions, "configDigest">; maxMediaBytes?: number;
}
export interface FullBaselineHostDependencies {
  /** Transport seam only; production always performs the actual LOGIN checks. */
  database?(input: IncrementalDatabaseOptions, signal: AbortSignal): Promise<Database>;
  /** Allocation is lazy and forbidden during seal and guarded startup. */
  sources(input: { config: WebsiteNotionConfig; budget: HostBudget; registerCleanup: RegisterHostCleanup }): Promise<FullBaselineSources>;
}
function safeCode(e: unknown) {
  if (e instanceof WorkerError) return e.code === "BUSY" ? "HOST_BUSY" : "FULL_BASELINE_PRIVATE_STATE_INVALID";
  if (e instanceof IncrementalHostError || e instanceof IncrementalDatabaseError || e instanceof FullBaselineArtifactError) return e.code;
  if (e instanceof ContentServiceError) return "FULL_BASELINE_TRANSPORT_UNAVAILABLE";
  return "FULL_BASELINE_UNAVAILABLE";
}
async function exists(path: string) {
  try { await lstat(path); return true; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; }
}

/** One explicit first full publication or source-free sealing of its persisted
 * candidate. This does not configure cloud capabilities, scopes or schedules. */
export async function runFullBaselineHost(options: FullBaselineHostOptions, dependencies: FullBaselineHostDependencies) {
  const config = parseWebsiteNotionConfig(structuredClone(options.config)); assertFullBaselineConfig(config);
  websiteCollectionTimeZone(config);
  const maximum = options.maxMediaBytes ?? 1024 ** 3;
  if (!["publish", "seal"].includes(options.command) || ![options.lockDirectory, options.artifactDirectory].every(isAbsolute) ||
      resolve(options.lockDirectory) === resolve(options.artifactDirectory) || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 2 * 1024 ** 3) hostFail("HOST_INPUT_INVALID");
  const budget = createFullBaselineBudget({ ...options, durationMs: options.durationMs ?? (options.command === "seal" ? 120000 : 3600000) });
  const report = { format: "full-baseline-host-report-v1", command: options.command, outcome: "failed", phase: "lock",
    errorCode: null as string | null, startedAt: new Date().toISOString(), finishedAt: "", records: 0, media: 0,
    prepared: false, sealed: false, promoteRequested: false, budget: budget.statistics() };
  let release: (() => Promise<void>) | undefined, db: Database | undefined;
  const resources = createHostResources();
  try {
    budget.guard(); release = await acquireLock(options.lockDirectory, randomUUID()); budget.guard();
    await privateDirectory(options.artifactDirectory); budget.guard();
    if (options.command === "publish" && (await exists(join(options.artifactDirectory, "incremental-prepared.json")) ||
        await exists(join(options.artifactDirectory, "incremental-baseline.json")))) hostFail("FULL_BASELINE_ALREADY_PREPARED");
    report.phase = "database";
    db = await (dependencies.database ?? ((input, signal) => openFullBaselineDatabase(input, {}, signal)))({ ...options.database, configDigest: configDigest(config) }, budget.signal);
    budget.guard();
    if (options.command === "publish") {
      report.phase = "collection";
      const source = await hostAwait(budget, () => resources.open(() => dependencies.sources({ config, budget, registerCleanup: resources.register }))); budget.guard();
      const writer = { ...db.fullPublisher,
        async renew(...args: Parameters<Database["fullPublisher"]["renew"]>) {
          budget.guard();
          try { await db!.fullPublisher.renew(...args); budget.guard(); }
          catch (e) { budget.cancel("FULL_BASELINE_LEASE_UNCONFIRMED"); throw e; }
        },
        async promote(...args: Parameters<Database["fullPublisher"]["promote"]>) {
          budget.guard(); report.promoteRequested = true; report.phase = "publication";
          await db!.fullPublisher.promote(...args); budget.guard();
        },
      };
      await runWebsiteSync({ client: source.client, config, mode: "publish", writer, storage: source.storage,
        download: source.download, signal: budget.signal, maxMediaBytes: maximum,
        async onIncrementalBaseline(capture) {
          budget.guard();
          const saved = await savePreparedFullBaseline({ directory: options.artifactDirectory, config, capture }, budget.signal);
          budget.guard(); report.prepared = true; report.records = saved.records; report.media = saved.media;
        },
      }); budget.guard();
    }
    report.phase = "seal";
    const sealed = await hostAwait(budget, () => sealFullBaselineArtifact({ directory: options.artifactDirectory, config,
      reader: createDatabaseContentBaselineReader(db!.reader) }, budget.signal)); budget.guard();
    report.records = sealed.records; report.media = sealed.media; report.prepared = true; report.sealed = true; report.outcome = "accepted";
  } catch (e) {
    report.errorCode = budget.statistics().errorCode ?? safeCode(e);
    report.outcome = budget.signal.aborted && report.errorCode !== "FULL_BASELINE_LEASE_UNCONFIRMED" ? "cancelled" : report.promoteRequested ? "unconfirmed" : "failed";
  } finally {
    budget.close();
    try { await resources.close(); } catch { report.outcome = "failed"; report.errorCode ??= "HOST_RESOURCE_CLOSE_FAILED"; }
    try { await db?.close(); } catch { report.outcome = "failed"; report.errorCode ??= "HOST_CLOSE_FAILED"; }
    report.finishedAt = new Date().toISOString(); report.budget = budget.statistics();
    try { if (release) await writeHostJson(options.artifactDirectory, "baseline-latest.json", report); }
    catch { report.outcome = "failed"; report.errorCode = "HOST_REPORT_UNSAVED"; }
    try { await release?.(); } catch { report.outcome = "failed"; report.errorCode = "HOST_LOCK_RELEASE_FAILED"; }
  }
  return report;
}

/** Status output accepts only the fixed aggregate shape, never private data. */
export function validateFullBaselineReport(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) hostFail("HOST_STATE_INVALID");
  const r = input as Record<string, unknown>, keys = ["format", "command", "outcome", "phase", "errorCode", "startedAt", "finishedAt", "records", "media", "prepared", "sealed", "promoteRequested", "budget"];
  const count = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  const code = (v: unknown) => v === null || typeof v === "string" && /^[A-Z_]{1,80}$/.test(v);
  if (Object.keys(r).length !== keys.length || Object.keys(r).some(k => !keys.includes(k)) || r.format !== "full-baseline-host-report-v1" ||
      !["publish", "seal"].includes(String(r.command)) || !["accepted", "unconfirmed", "failed", "cancelled"].includes(String(r.outcome)) ||
      !["lock", "database", "collection", "publication", "seal"].includes(String(r.phase)) || !code(r.errorCode) ||
      !["startedAt", "finishedAt"].every(k => typeof r[k] === "string" && Number.isFinite(Date.parse(r[k]))) ||
      !["records", "media"].every(k => count(r[k])) || !["prepared", "sealed", "promoteRequested"].every(k => typeof r[k] === "boolean")) hostFail("HOST_STATE_INVALID");
  const b = r.budget as Record<string, unknown>;
  if (!b || Object.keys(b).length !== 4 || !code(b.errorCode) || !["sourceRequests", "sourceBytes", "mediaBytes"].every(k => count(b[k]))) hostFail("HOST_STATE_INVALID");
  return r;
}
