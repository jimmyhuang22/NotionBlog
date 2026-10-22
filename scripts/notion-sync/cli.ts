import { randomUUID } from "node:crypto";
import { parseArgs, parseEnv } from "node:util";
import { isAbsolute } from "node:path";
import { createNotionClient } from "../../src/server/notion/client.ts";
import { NotionRequestScheduler } from "../../src/server/notion/request-scheduler.ts";
import { createDatabasePool, sqlExecutor } from "../../src/server/database/connection.ts";
import { createDatabaseWriter } from "../../src/server/database/writer.ts";
import { createMediaSourceWriter } from "../../src/server/database/media-sources.ts";
import { createSupabaseStorage } from "../../src/server/database/storage.ts";
import { createDemo } from "./demo.ts";
import { FakeStorage, FakeWriter } from "./fakes.ts";
import { runSync, type SyncMode } from "./worker.ts";
import { acquireLock, privateDirectory, readPrivateFile, readStatus, saveCheckpoint, saveReport, unlockStale } from "./state.ts";
import { errorCode, WorkerError } from "./errors.ts";
import { loadSourceConfig } from "./inputs.ts";
import { createImageDownloader } from "./download.ts";
import { createHeicConverter } from "./heic.ts";

const usage = `Usage: node scripts/notion-sync/cli.ts --state-dir ABSOLUTE_PATH [--demo | --env ABSOLUTE_PATH]
  --mode dry-run|stage|publish   Default: dry-run. Demo writes only in memory.
  --reconcile                  Every run already performs a full reconcile.
  --timeout-seconds N           Total work budget, default 1800, maximum 3600.
  --status                     Read local anonymous reports; no network.
  --unlock-stale               Remove a lock only after its PID is confirmed absent.
Private --env files are mode 600; no credential values belong in arguments.`;

async function main() {
  const { values } = parseArgs({ options: {
    demo: { type: "boolean" }, env: { type: "string" }, "state-dir": { type: "string" }, mode: { type: "string" },
    reconcile: { type: "boolean" }, "timeout-seconds": { type: "string" }, status: { type: "boolean" },
    "unlock-stale": { type: "boolean" }, help: { type: "boolean" },
  }, strict: true, allowPositionals: false });
  if (values.help) { console.log(usage); return; }
  let env: Record<string, string> = {};
  if (values.env) env = Object.fromEntries(Object.entries(parseEnv(await readPrivateFile(values.env))).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  if (values.demo && values.env) throw new WorkerError("MISCONFIGURED");
  const state = values["state-dir"] ?? env.SYNC_STATE_DIR;
  if (!state || !isAbsolute(state)) throw new WorkerError("MISCONFIGURED");
  await privateDirectory(state);
  if (values.status) { console.log(JSON.stringify(await readStatus(state))); return; }
  if (values["unlock-stale"]) { await unlockStale(state); console.log(JSON.stringify({ unlocked: true })); return; }
  const mode = values.mode ?? env.SYNC_MODE ?? "dry-run";
  if (!["dry-run", "stage", "publish"].includes(mode)) throw new WorkerError("MISCONFIGURED");
  const mediaProvider = env.SYNC_MEDIA_PROVIDER ?? "storage";
  if (!["storage", "notion"].includes(mediaProvider)) throw new WorkerError("MISCONFIGURED");
  const timeoutSeconds = Number(values["timeout-seconds"] ?? "1800");
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) throw new WorkerError("MISCONFIGURED");
  const runId = randomUUID(), release = await acquireLock(state, runId);
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  const cancel = () => controller.abort();
  process.on("SIGINT", cancel); process.on("SIGTERM", cancel);
  let pool: ReturnType<typeof createDatabasePool> | undefined;
  let demo: ReturnType<typeof createDemo> | undefined, notionRequests = 0;
  const started = Date.now();
  try {
    demo = values.demo ? createDemo() : undefined;
    if (!demo && (!values.env || !env.NOTION_TOKEN)) throw new WorkerError("MISCONFIGURED");
    const config = demo?.config ?? await loadSourceConfig(env);
    const scheduler = new NotionRequestScheduler();
    const transport: typeof fetch = async (url, init) => scheduler.run(async signal => {
      notionRequests++;
      const response = await fetch(url, { ...init, signal: AbortSignal.any([signal, controller.signal, ...(init?.signal ? [init.signal] : [])]) });
      if (response.status === 429 || response.status === 529) scheduler.defer(response.headers.get("retry-after") ?? "1");
      return response;
    }, { signal: controller.signal, timeoutMs: 9000 });
    const client = demo?.client ?? createNotionClient({ token: env.NOTION_TOKEN, notionVersion: env.NOTION_API_VERSION, fetch: transport });
    let writer, storage, mediaSources;
    if (mode !== "dry-run") {
      if (demo) { writer = new FakeWriter(); storage = new FakeStorage(); }
      else {
        storage = createSupabaseStorage({ url: env.STORAGE_URL ?? "", bucket: env.STORAGE_BUCKET ?? "",
          apiKey: env.STORAGE_API_KEY ?? "", token: env.STORAGE_WRITE_TOKEN ?? "", role: "writer" });
        pool = createDatabasePool(env.SYNC_DATABASE_URL, env.DATABASE_TLS, env.DATABASE_CA_CERT);
        writer = createDatabaseWriter(sqlExecutor(pool));
        if (mediaProvider === "notion") mediaSources = createMediaSourceWriter(sqlExecutor(pool));
      }
    }
    const report = await runSync({ runId, client, config, mode: mode as SyncMode, writer, storage, mediaSources,
      download: demo?.download ?? createImageDownloader({
        userAgent: env.SYNC_IMAGE_USER_AGENT,
        timeoutMs: env.SYNC_IMAGE_TIMEOUT_MS ? Number(env.SYNC_IMAGE_TIMEOUT_MS) : undefined,
        headerTimeoutMs: env.SYNC_IMAGE_HEADER_TIMEOUT_MS ? Number(env.SYNC_IMAGE_HEADER_TIMEOUT_MS) : undefined,
        convertHeic: env.SYNC_HEIC_CONVERTER_PATH ? createHeicConverter({ executable: env.SYNC_HEIC_CONVERTER_PATH, temporaryRoot: state }) : undefined,
      }), signal: controller.signal,
      // Demo success is deliberately never a cloud success checkpoint.
      checkpoint: demo ? undefined : (lease, result) => saveCheckpoint(state, lease, result) });
    const operational = { ...report, notionRequests: demo ? demo.requests.length : notionRequests,
      backend: demo ? "offline-memory" : mode === "dry-run" ? "notion-read-only" : "database" };
    await saveReport(state, operational);
    console.log(JSON.stringify(operational));
  } catch (error) {
    const failure = { runId, mode, elapsedMs: Date.now() - started, notionRequests: demo ? demo.requests.length : notionRequests,
      code: errorCode(error), outcome: errorCode(error) === "CHECKPOINT_FAILED" ? "published-checkpoint-failed" : "failed" };
    await saveReport(state, failure).catch(() => {});
    console.error(JSON.stringify(failure)); process.exitCode = 1;
  } finally {
    clearTimeout(deadline); process.off("SIGINT", cancel); process.off("SIGTERM", cancel);
    await pool?.end().catch(() => {}); await release();
  }
}
main().catch(error => { console.error(JSON.stringify({ code: errorCode(error), outcome: "failed-before-run" })); process.exitCode = 1; });
