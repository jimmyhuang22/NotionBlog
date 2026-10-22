import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { SqlExecutor } from "../../src/server/database/sql.ts";
import { uuid } from "../../src/server/public-cache/events.ts";
import { acquireLock } from "../notion-sync/state.ts";
import { type CacheClientConfig } from "./control.ts";
import { initialConsumerReport, consumeCacheRefresh, type CacheConsumerReport } from "./consume.ts";
import { privateCachePath, readCacheJournal, saveCacheJournal } from "./local.ts";

interface Success { runId: string; finishedAt: string }
interface State { version: 1; kind: "cache-consumer"; identity: string; runId: string; report: CacheConsumerReport; lastSuccess: Success | null }
/** The operator supplies one state directory per site. It never holds source-publication locks. */
export async function runCacheConsumer(statePath: string, config: CacheClientConfig, databaseUrl: string, ports: {
  connect(): Promise<{ db: SqlExecutor; close(): Promise<void> }>;
  request?: typeof fetch; signal?: AbortSignal;
}) {
  privateCachePath(statePath);
  if (!databaseUrl) throw Error("CACHE_DATABASE_CONFIG");
  const identity = createHash("sha256").update(JSON.stringify(["cache-consumer-v1", config.siteKey, config.origin, databaseUrl])).digest("hex");
  const runId = randomUUID(), directory = dirname(statePath);
  const release = await acquireLock(join(directory, "consumer-lock"), runId);
  let connection: Awaited<ReturnType<typeof ports.connect>> | undefined;
  try {
    let lastSuccess: Success | null = null;
    try {
      const previous = await readCacheJournal(statePath) as State;
      if (previous.version !== 1 || previous.kind !== "cache-consumer" || previous.identity !== identity) throw Error("CACHE_CONSUMER_IDENTITY");
      if (previous.lastSuccess !== null) {
        if (!previous.lastSuccess || !uuid(previous.lastSuccess.runId) || typeof previous.lastSuccess.finishedAt !== "string" ||
          previous.lastSuccess.finishedAt.length > 32 || !Number.isFinite(Date.parse(previous.lastSuccess.finishedAt))) throw Error("CACHE_CONSUMER_STATE");
        lastSuccess = { runId: previous.lastSuccess.runId, finishedAt: previous.lastSuccess.finishedAt };
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const attemptPath = join(directory, `attempt-${runId}.json`);
    const state: State = { version: 1, kind: "cache-consumer", identity, runId, report: initialConsumerReport(), lastSuccess };
    const save = async (createOnly = false) => {
      await saveCacheJournal(attemptPath, state, createOnly);
      await saveCacheJournal(statePath, state);
    };
    // Persist the attempt before opening a connection or sending a purge.
    await save(true);
    const signal = ports.signal ?? AbortSignal.timeout(30_000);
    try {
      signal.throwIfAborted();
      connection = await ports.connect();
      state.report = await consumeCacheRefresh(connection.db, config, { request: ports.request, signal, report: state.report,
        progress: async report => { state.report = report; await save(); } });
      // Do not report a closed, successful attempt until the connection actually drains.
      const closing = connection; connection = undefined;
      const stage = state.report.stage; state.report.stage = "close";
      await closing.close(); state.report.stage = stage;
    } catch {
      state.report = { ...state.report, status: "failed", finishedAt: new Date().toISOString(), errorCode:
        signal.aborted ? "CACHE_CONSUMER_DEADLINE" : state.report.stage === "close" ? "CACHE_CONNECTION_CLOSE_FAILED" : "CACHE_CONNECTION_FAILED" };
    }
    if (state.report.status === "complete" || state.report.status === "idle") state.lastSuccess = { runId, finishedAt: state.report.finishedAt! };
    await save();
    return { runId, ...state.report };
  } finally { try { await connection?.close(); } finally { await release(); } }
}
