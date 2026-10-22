import { parseArgs, parseEnv } from "node:util";
import { dirname, isAbsolute, resolve } from "node:path";
import { writeSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ContentServiceError } from "../../contracts/repository.ts";
import { createDatabasePool, sqlExecutor } from "../../src/server/database/connection.ts";
import { createSupabaseStorage } from "../../src/server/database/storage.ts";
import { createLocalMediaStorage } from "../../src/server/database/local-storage.ts";
import { createNotionClient } from "../../src/server/notion/client.ts";
import { sharedNotionScheduler } from "../../src/server/notion/request-scheduler.ts";
import { parseNotionSourcesConfig } from "../../src/server/notion/config.ts";
import { parseWebsiteNotionConfig } from "../../src/server/notion/website-config.ts";
import { createNotionRepository } from "../../src/server/notion/repository.ts";
import { createWebsiteNotionRepository } from "../../src/server/notion/website-repository.ts";
import { resolveNotionMediaSource } from "../../src/server/notion/media-source.ts";
import { createImageDownloader } from "../notion-sync/download.ts";
import { loadSourceConfig } from "../notion-sync/inputs.ts";
import { acquireLock, readPrivateFile } from "../notion-sync/state.ts";
import { generateAndRegisterThumbnails } from "./batch.ts";
import { migrateThumbnails, verifyThumbnailProtocol } from "./migrate.ts";
import { migrateCourseCoverThumbnails, verifyCourseCoverThumbnailProtocol } from "./course-cover-migrate.ts";
import { migrateBodyImageThumbnails, verifyBodyImageThumbnailProtocol } from "./body-image-migrate.ts";
import { parseThumbnailPlan } from "./plan.ts";
import { assertMatchingDatabaseTargets } from "./targets.ts";
import { loadVerifiedThumbnailCache } from "./cache.ts";
import { thumbnailEncodingRecipe } from "./encode.ts";
import { createThumbnailOriginalMirror } from "./original-mirror.ts";
import { parseThumbnailWidthSelection } from "./widths.ts";
import { initializeThumbnailBudgetLedger, openThumbnailBudgetAttempt, type ThumbnailBudgetGuard } from "./budget.ts";

const usage = `Usage: npm run media:thumbnails -- COMMAND [options]
  verify
  verify-course-covers
  verify-body-images
  migrate-body-images --env ABSOLUTE_PRIVATE_ADMIN_ENV
  migrate-course-covers --env ABSOLUTE_PRIVATE_ADMIN_ENV
  migrate --env ABSOLUTE_PRIVATE_ADMIN_ENV
  budget-init --budget ABSOLUTE_PRIVATE_EXECUTION_BUDGET
  run --env ABSOLUTE_PRIVATE_WRITER_ENV --reader-env ABSOLUTE_PRIVATE_READER_ENV
      --plan ABSOLUTE_PRIVATE_JSON --state-dir ABSOLUTE_PRIVATE_DIRECTORY
      --budget ABSOLUTE_PRIVATE_EXECUTION_BUDGET
      [--widths ABSOLUTE_PRIVATE_WIDTH_SELECTION]
      [--originals-dir ABSOLUTE_PRIVATE_SHA_DIRECTORY]
Private input files must be owner-only. No passwords or tokens belong in arguments.
The budget directory must be separate from the thumbnail state directory.
budget-init creates an offline ledger once; run requires it and never resets spent allowances.
Omitted widths process both caps; an explicit v2 width selection may request an eligible 1600 cap.
An original mirror reads SHA-named 600 files under a canonical 700 directory, with no download fallback.
The run command appends previews for exactly one current generation; it never publishes or renews content.`;

const failure = {outcome:"failed", message:"Thumbnail command failed. Check private inputs, current publication and restricted permissions. Upstream details are withheld."};

async function environment(path: string | undefined): Promise<Record<string, string>> {
  if (!path) throw new ContentServiceError("MISCONFIGURED", "A private environment file is required.");
  return Object.fromEntries(Object.entries(parseEnv(await readPrivateFile(path))).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

async function separateDirectories(budgetFile: string, stateDir: string): Promise<void> {
  if (!isAbsolute(budgetFile) || !isAbsolute(stateDir) || resolve(budgetFile) !== budgetFile || resolve(stateDir) !== stateDir ||
      dirname(budgetFile) === stateDir) throw new Error("Budget and thumbnail state directories must be separate absolute paths.");
  // The state leaf may be new. Check its existing ancestry without creating it
  // or allowing a symlink alias to the budget directory before reading env.
  let existing = stateDir;
  for (let depth = 0; depth < 128; depth++) {
    try {
      const info = await lstat(existing);
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(existing) !== existing) throw new Error("The thumbnail state directory is unavailable.");
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(existing);
      if (parent === existing) break;
      existing = parent;
    }
  }
  throw new Error("The thumbnail state directory is unavailable.");
}

/** Local CLI transport: preserve SDK/Storage cancellation and stop the whole attempt. */
export function createThumbnailBudgetFetch(
  budget: Pick<ThumbnailBudgetGuard, "signal" | "check">,
  timeoutMs?: number,
  fetcher: typeof fetch = fetch,
): typeof fetch {
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 20_000)) throw new Error("Invalid request timeout.");
  return async (input, init) => {
    budget.check();
    const signal = AbortSignal.any([budget.signal, ...(init?.signal ? [init.signal] : []),
      ...(timeoutMs ? [AbortSignal.timeout(timeoutMs)] : [])]);
    const response = await fetcher(input, {...init, signal});
    budget.check();
    return response;
  };
}

/** The entry point supplies a hard deadline exit; library callers never exit their host process. */
export async function thumbnailCommand(args: string[], onDeadline?: () => void): Promise<void> {
  if (onDeadline !== undefined && typeof onDeadline !== "function") throw new Error("Invalid deadline callback.");
  const {values, positionals} = parseArgs({args, strict:true, allowPositionals:true, options:{
    env:{type:"string"}, "reader-env":{type:"string"}, plan:{type:"string"}, "state-dir":{type:"string"}, budget:{type:"string"}, help:{type:"boolean"},
    widths:{type:"string"}, "originals-dir":{type:"string"},
  }});
  if (values.help) { console.log(usage); return; }
  const [command] = positionals;
  if (positionals.length !== 1 || !["verify", "verify-course-covers", "verify-body-images", "migrate", "migrate-course-covers", "migrate-body-images", "budget-init", "run"].includes(command)) throw new Error("Invalid command.");
  if (command === "verify-body-images") {
    if (Object.keys(values).length) throw new Error("Invalid options.");
    const { sql: _sql, ...verified } = await verifyBodyImageThumbnailProtocol();
    console.log(JSON.stringify(verified)); return;
  }
  if (command === "verify-course-covers") {
    if (Object.keys(values).length) throw new Error("Invalid options.");
    const { sql: _sql, ...verified } = await verifyCourseCoverThumbnailProtocol();
    console.log(JSON.stringify(verified)); return;
  }
  if (command === "verify") {
    if (Object.keys(values).length) throw new Error("Invalid options.");
    await verifyCourseCoverThumbnailProtocol();
    await verifyBodyImageThumbnailProtocol();
    console.log(JSON.stringify(await verifyThumbnailProtocol())); return;
  }
  if (command === "budget-init") {
    if (!values.budget || Object.keys(values).some(key => key !== "budget")) throw new Error("A private execution budget is required.");
    await initializeThumbnailBudgetLedger(values.budget);
    console.log(JSON.stringify({outcome:"budget-initialized"}));
    return;
  }
  if (command === "migrate" || command === "migrate-course-covers" || command === "migrate-body-images") {
    if (Object.keys(values).some(key => key !== "env")) throw new Error("Invalid options.");
    const env = await environment(values.env);
    const pool = createDatabasePool(env.DATABASE_MIGRATION_URL, env.DATABASE_TLS, env.DATABASE_CA_CERT);
    try {
      const client = await pool.connect();
      try { console.log(JSON.stringify(await (command === "migrate" ? migrateThumbnails : command === "migrate-course-covers" ? migrateCourseCoverThumbnails : migrateBodyImageThumbnails)({query: async <T>(text:string, parameters?:unknown[]) => ({rows:(await client.query(text, parameters)).rows as T[]})}))); }
      finally { client.release(); }
    } finally { await pool.end(); }
    return;
  }
  // Reject absent/mismatched execution allowances before reading credentials or
  // constructing a Notion client, database pool or Storage adapter.
  if (!values.budget) throw new Error("A private execution budget is required.");
  if (!values.plan || !values["state-dir"]) throw new Error("A private plan and state directory are required.");
  await separateDirectories(values.budget, values["state-dir"]);
  const plan = parseThumbnailPlan(JSON.parse(await readPrivateFile(values.plan)));
  if (values.widths !== undefined) {
    const path = values.widths, parent = dirname(path), info = await lstat(parent);
    if (!isAbsolute(path) || resolve(path) !== path || !info.isDirectory() || info.isSymbolicLink() ||
        (info.mode & 0o777) !== 0o700 || (process.getuid && info.uid !== process.getuid()) ||
        await realpath(path) !== path) throw new Error("The private width selection is unavailable.");
    const file = await lstat(path);
    if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o777) !== 0o600 ||
        (process.getuid && file.uid !== process.getuid())) throw new Error("The private width selection is unavailable.");
  }
  const widths = values.widths === undefined ? undefined : parseThumbnailWidthSelection(JSON.parse(await readPrivateFile(values.widths)), plan);
  const readOriginal = values["originals-dir"] === undefined ? undefined : await createThumbnailOriginalMirror(values["originals-dir"]);
  const budget = await openThumbnailBudgetAttempt(values.budget, plan);
  const deadline = () => {
    if (budget.deadlineSignal.reason?.name === "TimeoutError") onDeadline?.();
  };
  budget.deadlineSignal.addEventListener("abort", deadline, {once:true});
  if (budget.deadlineSignal.aborted) deadline();
  let release: (() => Promise<void>) | undefined;
  let readerPool: ReturnType<typeof createDatabasePool> | undefined;
  let writerPool: ReturnType<typeof createDatabasePool> | undefined;
  let completed: Record<string, unknown> | undefined;
  try {
    budget.check();
    const env = await environment(values.env); budget.check();
    const reader = await environment(values["reader-env"]); budget.check();
    assertMatchingDatabaseTargets(reader.DATABASE_READER_URL, env.SYNC_DATABASE_URL);
    for (const key of ["DATABASE_TLS", "DATABASE_CA_CERT", "STORAGE_URL", "STORAGE_BUCKET", "STORAGE_API_KEY", "DATABASE_MEDIA_DIRECTORY"]) {
      if (env[key] && reader[key] && env[key] !== reader[key]) throw new Error("Reader and writer configuration differs.");
    }
    release = await acquireLock(values["state-dir"], plan.runId); budget.check();
    // The state lock also serializes this private candidate manifest. It never
    // authorizes a parent or reads an earlier published run's private tables.
    const cache = await loadVerifiedThumbnailCache(values["state-dir"], thumbnailEncodingRecipe()); budget.check();
    const config = await loadSourceConfig(env); budget.check();
    const token = env.NOTION_TOKEN ?? "";
    // Fetch injection otherwise bypasses the production scheduler. Keep its
    // existing rate/cooldown behavior while adding the shared batch abort.
    const client = createNotionClient({token, notionVersion:env.NOTION_API_VERSION, fetch:createThumbnailBudgetFetch(budget,9000), scheduler:sharedNotionScheduler(token)});
    const repository = plan.version === "v1"
      ? createNotionRepository({client, config:parseNotionSourcesConfig(config)})
      : createWebsiteNotionRepository({client, config:parseWebsiteNotionConfig(config)});
    readerPool = createDatabasePool(reader.DATABASE_READER_URL, reader.DATABASE_TLS, reader.DATABASE_CA_CERT);
    writerPool = createDatabasePool(env.SYNC_DATABASE_URL, env.DATABASE_TLS, env.DATABASE_CA_CERT);
    const storage = env.DATABASE_MEDIA_DIRECTORY
      ? createLocalMediaStorage(env.DATABASE_MEDIA_DIRECTORY, env.SYNC_DATABASE_URL ?? "", "writer")
      : createSupabaseStorage({url:env.STORAGE_URL ?? "", bucket:env.STORAGE_BUCKET ?? "", apiKey:env.STORAGE_API_KEY ?? "", token:env.STORAGE_WRITE_TOKEN ?? "", role:"writer",fetch:createThumbnailBudgetFetch(budget)});
    budget.check();
    let report;
    try {
      report = await generateAndRegisterThumbnails({...plan, widths, readOriginal, db:sqlExecutor(readerPool), registrationDb:sqlExecutor(writerPool), storage, cache, budget,
        resolve:binding => resolveNotionMediaSource(binding, repository, client),
        download:(url, signal, expected) => createImageDownloader({userAgent:env.SYNC_IMAGE_USER_AGENT,maxBytes:expected})(url,signal),
      });
    } catch (error) {
      // Keep completed, qualified entries after a partial batch. Persistence
      // cannot turn a failed batch into a successful command.
      try { await cache.save(); }
      catch (cacheError) { throw new AggregateError([error, cacheError], "Thumbnail processing and private cache persistence failed."); }
      throw error;
    }
    await cache.save();
    budget.check();
    completed = {outcome:"completed", ...report, cumulativeBudget:budget.snapshot()};
  } finally {
    try {
      await readerPool?.end().catch(() => {}); await writerPool?.end().catch(() => {}); await release?.();
      if (completed) budget.check();
    } finally {
      try { await budget.close(); }
      finally { budget.deadlineSignal.removeEventListener("abort", deadline); }
    }
  }
  // A completion receipt follows persistence and lock/pool cleanup.
  if (budget.deadlineSignal.aborted) throw new ContentServiceError("CONTENT_UNAVAILABLE", "Thumbnail execution deadline exceeded.");
  console.log(JSON.stringify(completed));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  thumbnailCommand(process.argv.slice(2), () => {
    // Native work can also block process.exit shutdown. Kill only this CLI;
    // persistent reservations and stale locks remain for explicit recovery.
    try { writeSync(2, JSON.stringify(failure) + "\n"); }
    finally {
      try { process.kill(process.pid, "SIGKILL"); }
      finally { process.exit(1); }
    }
  }).catch(() => {
    console.error(JSON.stringify(failure));
    process.exitCode = 1;
  });
}
