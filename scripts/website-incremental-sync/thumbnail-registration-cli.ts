import { pathToFileURL } from "node:url";
import { isAbsolute, dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, unlink, lstat } from "node:fs/promises";
import { Client } from "pg";
import { readPrivateFile, privateDirectory, acquireLock } from "../notion-sync/state.ts";
import { parseWebsiteNotionConfig } from "../../src/server/notion/website-config.ts";
import { databasePoolConfig } from "../../src/server/database/connection.ts";
import type { AcceptedFullBaseline } from "./full-baseline-artifact.ts";
import type { AcceptanceThumbnail } from "./media-acceptance.ts";
import { parseThumbnailScope, type ThumbnailScope } from "./thumbnail-scope.ts";
import { installRequestBudget } from "./request-budget.ts";
import { planThumbnailRegistration, runThumbnailRegistration, createThumbnailRegistrationBudget, registrationFail as fail, ThumbnailRegistrationError,
  type VerifiedThumbnailCoverage, type RegistrationProgress } from "./thumbnail-registration.ts";

export function parseThumbnailRegistrationArguments(args: readonly string[]) {
  const [command, ...rest] = args;
  if (!["plan", "register", "verify"].includes(command) || rest.length % 2) fail("THUMBNAIL_REGISTRATION_INPUT_INVALID");
  const allowed = ["config", "artifact", "thumbnails", "coverage", "coverage-receipt", "duration-ms", "sql-request-bytes", "sql-response-bytes", "plan-sha256", "state-dir", "runtime", "receipt", "deadline-ms", "thumbnail-scope"];
  const values = new Map<string, string>();
  for (let n = 0; n < rest.length; n += 2) {
    const key = rest[n].startsWith("--") ? rest[n].slice(2) : "", value = rest[n + 1];
    if (!allowed.includes(key) || !value || value.startsWith("--") || values.has(key)) fail("THUMBNAIL_REGISTRATION_INPUT_INVALID"); values.set(key, value);
  }
  const path = (key: string) => { const v = values.get(key); if (!v || !isAbsolute(v)) fail("THUMBNAIL_REGISTRATION_INPUT_INVALID"); return v; };
  const number = (key: string) => { const v = values.get(key); if (!v || !/^(0|[1-9][0-9]*)$/.test(v) || !Number.isSafeInteger(Number(v))) fail("THUMBNAIL_REGISTRATION_INPUT_INVALID"); return Number(v); };
  const digest = values.get("plan-sha256");
  if (command === "plan" ? ["plan-sha256", "state-dir", "runtime", "receipt", "deadline-ms"].some(k => values.has(k)) : !digest || !/^[a-f0-9]{64}$/.test(digest)) fail("THUMBNAIL_REGISTRATION_INPUT_INVALID");
  return { command, config: path("config"), artifact: path("artifact"), thumbnails: path("thumbnails"), coverage: path("coverage"), coverageReceipt: path("coverage-receipt"), digest,
    thumbnailScope: values.has("thumbnail-scope") ? path("thumbnail-scope") : undefined,
    stateDir: command === "plan" ? undefined : path("state-dir"), runtime: command === "plan" ? undefined : path("runtime"), receipt: command === "plan" ? undefined : path("receipt"), deadline: command === "plan" ? undefined : number("deadline-ms"),
    limits: { durationMs: number("duration-ms"), sqlRequestBytes: number("sql-request-bytes"), sqlResponseBytes: number("sql-response-bytes") } };
}

/** Each execution reserves a NEW private receipt. A started/in-flight receipt
 * is preserved, never silently reused to retry an ambiguous registration. */
async function reserveReceipt(path: string, initial: unknown) {
  await privateDirectory(dirname(path));
  const f = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await f.writeFile(JSON.stringify(initial) + "\n"); await f.sync(); } finally { await f.close(); }
  const identity = await lstat(path);
  return async (value: unknown) => {
    const before = await lstat(path);
    if (before.isSymbolicLink() || before.ino !== identity.ino || before.dev !== identity.dev) fail("THUMBNAIL_REGISTRATION_RECEIPT_CHANGED");
    const temp = join(dirname(path), `.registration-${randomUUID()}`), h = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      try { await h.writeFile(JSON.stringify(value) + "\n"); await h.sync(); } finally { await h.close(); }
      await rename(temp, path); Object.assign(identity, await lstat(path));
      const parent = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY); try { await parent.sync(); } finally { await parent.close(); }
    } finally { await unlink(temp).catch(() => {}); }
  };
}

export async function thumbnailRegistrationMain(args: readonly string[], env: NodeJS.ProcessEnv = process.env) {
  if (args.length === 1 && args[0] === "--help") {
    console.log("node scripts/website-incremental-sync/thumbnail-registration-cli.ts plan|register|verify --config PRIVATE_JSON --artifact SAME_ACCEPTED_JSON --thumbnails PRIVATE_CANDIDATES --coverage VERIFIED_COVERAGE --coverage-receipt ORIGINAL_PRIVATE_RECEIPT --duration-ms N --sql-request-bytes N --sql-response-bytes N [--thumbnail-scope REVIEWED_PRIVATE_JSON]\nregister|verify additionally require --plan-sha256 REVIEWED_DIGEST --runtime ORIGINAL_CANONICAL_RUNTIME --state-dir CANONICAL_STATE --receipt FRESH_PRIVATE_FILE --deadline-ms ABSOLUTE_UNIX_MS. No Source/object requests, generation, uploads or publication."); return 0;
  }
  const parsed = parseThumbnailRegistrationArguments(args), config = parseWebsiteNotionConfig(JSON.parse(await readPrivateFile(parsed.config)));
  const artifact = JSON.parse(await readPrivateFile(parsed.artifact, 48 * 1024 ** 2)) as AcceptedFullBaseline;
  let thumbnailScope: ThumbnailScope | undefined;
  if (parsed.thumbnailScope) {
    try { thumbnailScope = parseThumbnailScope(JSON.parse(await readPrivateFile(parsed.thumbnailScope, 1024))); }
    catch { fail("THUMBNAIL_REGISTRATION_INPUT_INVALID"); }
  }
  const candidates = JSON.parse(await readPrivateFile(parsed.thumbnails, (thumbnailScope ? 4 : 1) * 1024 ** 2)) as { format: string; entries: AcceptanceThumbnail[] };
  if (!candidates || Object.keys(candidates).length !== 2 || candidates.format !== "media-acceptance-thumbnails-v1") fail("THUMBNAIL_REGISTRATION_INPUT_INVALID");
  const coverage = JSON.parse(await readPrivateFile(parsed.coverage)) as VerifiedThumbnailCoverage;
  const receiptHash = createHash("sha256").update(await readPrivateFile(parsed.coverageReceipt)).digest("hex");
  const plan = planThumbnailRegistration(config, artifact, candidates.entries, coverage, receiptHash,
    { ...parsed.limits, ...(thumbnailScope ? { thumbnailScope } : {}) });
  if (parsed.command === "plan") { console.log(JSON.stringify({ outcome: "planned", planDigest: plan.digest, ...plan.summary,
    ...(plan.thumbnailScope ? { thumbnailScope: plan.thumbnailScope } : {}) })); return 0; }
  if (parsed.digest !== plan.digest) fail("THUMBNAIL_REGISTRATION_PLAN_CHANGED");
  if (!parsed.deadline || parsed.deadline <= Date.now() || !env.SYNC_DATABASE_URL || !env.SYNC_READER_DATABASE_URL || env.DATABASE_TLS !== undefined && env.DATABASE_TLS !== "verify" ||
    ["NOTION_TOKEN", "COS_SECRET_ID", "COS_SECRET_KEY", "STORAGE_WRITE_TOKEN", "STORAGE_REFRESH_TOKEN"].some(k => !!env[k])) fail("THUMBNAIL_REGISTRATION_INPUT_INVALID");
  const runtimeBytes = await readPrivateFile(parsed.runtime!), runtime = JSON.parse(runtimeBytes);
  if (runtime.format !== "website-v2-runtime-1" || runtime.stateDir !== parsed.stateDir || typeof runtime.privateRoot !== "string" ||
    runtime.stateDir !== join(runtime.privateRoot, "state")) fail("THUMBNAIL_REGISTRATION_CANONICAL_STATE_INVALID");
  await privateDirectory(runtime.privateRoot);
  const readerSettings = databasePoolConfig(env.SYNC_READER_DATABASE_URL, env.DATABASE_TLS, env.DATABASE_CA_CERT);
  const writerSettings = databasePoolConfig(env.SYNC_DATABASE_URL, env.DATABASE_TLS, env.DATABASE_CA_CERT);
  const readerEndpoint = new URL(env.SYNC_READER_DATABASE_URL), writerEndpoint = new URL(env.SYNC_DATABASE_URL);
  const targetKey = (u: URL) => JSON.stringify([u.hostname, u.port || "5432", u.pathname]);
  if (targetKey(readerEndpoint) !== targetKey(writerEndpoint) || readerEndpoint.username === writerEndpoint.username) fail("THUMBNAIL_REGISTRATION_TARGET_INVALID");
  const budget = createThumbnailRegistrationBudget({ ...plan, summary: { ...plan.summary, durationMs: Math.min(plan.summary.durationMs, parsed.deadline - Date.now()) } });
  const http = installRequestBudget({ limits: { notion: 0, storage: 0, imageOrigin: 0, total: 0 }, storageOrigin: plan.origin,
    deadline: Math.min(parsed.deadline, Date.now() + plan.summary.durationMs) });
  let progress: RegistrationProgress = { phase: "preflight", writeRequests: 0, acknowledgedWrites: 0, verifiedBindings: 0, inFlight: null };
  let save: ((value: unknown) => Promise<void>) | undefined, unlock: (() => Promise<void>) | undefined;
  let reader: Client | undefined, writer: Client | undefined, closing: Promise<PromiseSettledResult<void>[]> | undefined;
  const pending = new Set<Promise<unknown>>(); let result: Record<string, unknown> = { outcome: "running" }, exit = 1;
  const track = <T>(task: Promise<T>) => { pending.add(task); void task.then(() => pending.delete(task), () => pending.delete(task)); return task; };
  const close = () => closing ??= Promise.allSettled([Promise.resolve().then(() => reader?.end()), Promise.resolve().then(() => writer?.end())]);
  const abort = () => budget.cancel("THUMBNAIL_REGISTRATION_CANCELLED"), stop = () => { http.cancel(); void close(); }, stopHttp = () => budget.cancel("THUMBNAIL_REGISTRATION_HTTP_FORBIDDEN");
  budget.signal.addEventListener("abort", stop, { once: true }); http.signal.addEventListener("abort", stopHttp, { once: true });
  process.once("SIGINT", abort); process.once("SIGTERM", abort);
  const snapshot = () => ({ format: "published-thumbnail-registration-receipt-v1", planDigest: plan.digest, command: parsed.command, runtimeSha256: createHash("sha256").update(runtimeBytes).digest("hex"),
    ...(plan.thumbnailScope ? { thumbnailScope: plan.thumbnailScope } : {}),
    ...progress, ...result, counters: budget.statistics(), possiblePartialRegistration: progress.writeRequests > progress.acknowledgedWrites,
    independentObjectAcceptanceRequired: true });
  try {
    budget.guard(); unlock = await acquireLock(parsed.stateDir!, randomUUID()); budget.guard();
    save = await reserveReceipt(parsed.receipt!, { ...snapshot(), outcome: "started" });
    reader = new Client({ ...readerSettings, options: "-c default_transaction_read_only=on" }); writer = new Client(writerSettings);
    for (const c of [reader, writer]) c.on("error", () => {});
    await budget.wait(() => track(reader!.connect())); await budget.wait(() => track(writer!.connect()));
    const port = (client: Client) => ({ query: <T>(text: string, values?: unknown[]) => track(client.query(text, values).then(v => ({ rows: v.rows as T[] }))) });
    result = await runThumbnailRegistration(plan, { reader: port(reader), writer: port(writer), readerUrl: env.SYNC_READER_DATABASE_URL,
      writerUrl: env.SYNC_DATABASE_URL, budget, verifyOnly: parsed.command === "verify", progress: async value => { progress = value; await save!(snapshot()); } });
    budget.guard(); exit = 0;
  } catch (e) {
    const code = (e as { code?: string }).code;
    result = { outcome: "failed", errorCode: budget.statistics().failure ?? (e instanceof ThumbnailRegistrationError ? e.code : code === "BUSY" ? "THUMBNAIL_REGISTRATION_BUSY" : "THUMBNAIL_REGISTRATION_UNAVAILABLE") };
  } finally {
    process.removeListener("SIGINT", abort); process.removeListener("SIGTERM", abort);
    budget.signal.removeEventListener("abort", stop); http.signal.removeEventListener("abort", stopHttp); http.close();
    const closed = await close(); await Promise.allSettled([...pending]);
    if (closed.some(v => v.status === "rejected")) { exit = 1; result = { outcome: "failed", errorCode: "THUMBNAIL_REGISTRATION_CLOSE_FAILED" }; }
    try { budget.guard(); } catch { exit = 1; result = { outcome: "failed", errorCode: budget.statistics().failure }; }
    try { await save?.(snapshot()); } catch { exit = 1; result = { outcome: "failed", errorCode: "THUMBNAIL_REGISTRATION_RECEIPT_FAILED" }; }
    try { await unlock?.(); } catch { exit = 1; result = { outcome: "failed", errorCode: "THUMBNAIL_REGISTRATION_UNLOCK_FAILED" }; }
    const counters = budget.statistics(); budget.close(); http.restore();
    console.log(JSON.stringify({ format: "published-thumbnail-registration-v1", planDigest: plan.digest, ...result, selectedBindings: plan.thumbnails.length,
      writeRequests: progress.writeRequests, acknowledgedWrites: progress.acknowledgedWrites, verifiedBindings: progress.verifiedBindings,
      possiblePartialRegistration: progress.writeRequests > progress.acknowledgedWrites, counters, httpRequests: http.statistics().total }));
  }
  return exit;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) thumbnailRegistrationMain(process.argv.slice(2))
  .then(code => { process.exitCode = code; }).catch(error => {
    console.error(JSON.stringify({ outcome: "failed", errorCode: error instanceof ThumbnailRegistrationError ? error.code : "THUMBNAIL_REGISTRATION_UNAVAILABLE" })); process.exitCode = 1;
  });
