import { constants } from "node:fs";
import { open, mkdir, rename, readdir, lstat, readFile, realpath } from "node:fs/promises";
import { join, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { parseEnv } from "node:util";
import { fork, type ChildProcess } from "node:child_process";
import { Client } from "pg";
import { readPrivateFile, privateDirectory } from "../notion-sync/state.ts";
import { initializeSharedBudget, openSharedBudget, type SharedLimits } from "../website-sync/shared-budget.ts";
import { parseWebsiteNotionConfig } from "../../src/server/notion/website-config.ts";
import { databasePoolConfig } from "../../src/server/database/connection.ts";
import { INCREMENTAL_LOGIN_SQL } from "../../src/server/database/incremental-connection.ts";
import { readPublicationState } from "../../src/server/database/incremental-publication.ts";
import { configDigest } from "../../src/server/database/website-validation.ts";
import type { AcceptedFullBaseline } from "../website-incremental-sync/full-baseline-artifact.ts";
import type { AcceptanceThumbnail } from "../website-incremental-sync/media-acceptance.ts";
import { planVisitorAcceptance, visitorFail as fail, VisitorError, type VisitorLimits } from "./plan.ts";
import { installVisitorTransports, unchanged } from "./transport.ts";
import { checkVisitorResponses } from "./check.ts";

const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
export function parseVisitorArguments(args: readonly string[]) {
  const [command, ...rest] = args;
  if (!["plan", "run"].includes(command) || rest.length % 2) fail("VISITOR_INPUT_INVALID");
  const allowed = ["config", "artifact", "thumbnails", "env", "media-policy", "duration-ms", "http-requests", "response-bytes", "sql-queries", "sql-row-bytes", "operation", "phase", "plan-sha256", "deadline-ms", "port"];
  const values = new Map<string, string>();
  for (let n = 0; n < rest.length; n += 2) {
    const key = rest[n].slice(2), value = rest[n + 1];
    if (!rest[n].startsWith("--") || !allowed.includes(key) || !value || value.startsWith("--") || values.has(key)) fail("VISITOR_INPUT_INVALID"); values.set(key, value);
  }
  const path = (key: string) => { const p = values.get(key); if (!p || !isAbsolute(p) || resolve(p) !== p) fail("VISITOR_INPUT_INVALID"); return p; };
  const number = (key: string) => { const v = values.get(key); if (!v || !/^[1-9][0-9]*$/.test(v) || !Number.isSafeInteger(Number(v))) fail("VISITOR_INPUT_INVALID"); return Number(v); };
  const runKeys = ["operation", "phase", "plan-sha256", "deadline-ms", "port"];
  if (command === "plan" && runKeys.some(k => values.has(k)) || command === "run" && (!/^[a-f0-9]{64}$/.test(values.get("plan-sha256") ?? "") || !["pre", "post"].includes(values.get("phase") ?? ""))) fail("VISITOR_INPUT_INVALID");
  const limits: VisitorLimits = { durationMs: number("duration-ms"), httpRequests: number("http-requests"), responseBytes: number("response-bytes"), sqlQueries: number("sql-queries"), sqlRowBytes: number("sql-row-bytes") };
  const mediaPolicy = values.get("media-policy") ?? "required400";
  if (!["required400", "original-only"].includes(mediaPolicy)) fail("VISITOR_INPUT_INVALID");
  return { command, config: path("config"), artifact: path("artifact"), thumbnails: path("thumbnails"), env: path("env"), limits, mediaPolicy: mediaPolicy as "required400" | "original-only",
    ...(command === "run" ? { operation: path("operation"), phase: values.get("phase") as "pre" | "post", digest: values.get("plan-sha256")!, deadline: number("deadline-ms"), port: number("port") } : {}) };
}
const ENV_KEYS = ["CONTENT_PROVIDER", "DATABASE_CONTENT_VERSION", "DATABASE_PUBLICATION_MODE", "MEDIA_PROVIDER", "MEDIA_THUMBNAILS", "STORAGE_PROVIDER", "DATABASE_READER_URL", "DATABASE_TLS", "DATABASE_CA_CERT",
  "COS_BUCKET", "COS_REGION", "COS_PREFIX", "COS_SECRET_ID", "COS_SECRET_KEY", "COS_SECURITY_TOKEN", "COS_CREDENTIALS_EXPIRES_AT", "CONTENT_FEATURES_JSON", "SITE_CONFIG_JSON", "SITE_CONFIG"];
export async function visitorProfile(bytes: string) {
  const env = parseEnv(bytes);
  if (Object.keys(env).some(k => !ENV_KEYS.includes(k)) || env.CONTENT_PROVIDER !== "database" || env.DATABASE_CONTENT_VERSION !== "2" || env.DATABASE_PUBLICATION_MODE !== "published" ||
    env.MEDIA_PROVIDER !== "storage" || env.MEDIA_THUMBNAILS !== "enabled" || env.STORAGE_PROVIDER !== "cos" || env.DATABASE_TLS !== "verify" ||
    !env.COS_SECRET_ID || !env.COS_SECRET_KEY || !env.COS_BUCKET || !env.COS_REGION || !env.COS_PREFIX) fail("VISITOR_PROFILE_INVALID");
  databasePoolConfig(env.DATABASE_READER_URL, env.DATABASE_TLS, env.DATABASE_CA_CERT);
  if (env.SITE_CONFIG && env.SITE_CONFIG_JSON) fail("VISITOR_PROFILE_INVALID");
  const siteBytes = env.SITE_CONFIG ? await readPrivateFile(env.SITE_CONFIG) : env.SITE_CONFIG_JSON ?? "{}";
  const site = JSON.parse(siteBytes), timeZone = site.timeZone ?? "UTC";
  if (typeof timeZone !== "string") fail("VISITOR_PROFILE_INVALID");
  // The child consumes the reviewed bytes, never a private file that another
  // operation can edit halfway through the sampled render.
  delete env.SITE_CONFIG; env.SITE_CONFIG_JSON = siteBytes;
  return { env, timeZone, siteSha256: sha(siteBytes), origin: `https://${env.COS_BUCKET}.cos.${env.COS_REGION}.myqcloud.com`, prefix: env.COS_PREFIX };
}
/** Bind the built app actually used by the isolated child, not just source HEAD.
 * No env defaults or local identity files may override the reviewed profile. */
export async function visitorBuildBinding(project = PROJECT) {
  for (const name of await readdir(project)) if (/^\.env(?:\.|$)/.test(name) && name !== ".env.example") fail("VISITOR_BUILD_PRIVATE_DEFAULTS");
  try { await lstat(join(project, "config/site.json")); fail("VISITOR_BUILD_PRIVATE_DEFAULTS"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  const files: { path: string; sha256: string }[] = []; let total = 0;
  async function walk(relative: string) {
    for (const entry of await readdir(join(project, relative), { withFileTypes: true })) {
      if (entry.name === "node_modules" || relative === ".next" && ["cache", "dev", "diagnostics", "types", "trace", "trace-build", "trace-server"].includes(entry.name)) continue;
      const path = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) fail("VISITOR_BUILD_INVALID");
      if (entry.isDirectory()) await walk(path);
      else {
        const s = await lstat(join(project, path));
        if (!s.isFile() || s.size > 32 * 1024 ** 2 || (s.mode & 0o022) || (total += s.size) > 512 * 1024 ** 2 || files.length >= 5000) fail("VISITOR_BUILD_INVALID");
        files.push({ path, sha256: sha(await readFile(join(project, path))) });
      }
    }
  }
  await walk(".next");
  if (!files.some(f => f.path === ".next/BUILD_ID") || !files.some(f => f.path.startsWith(".next/server/"))) fail("VISITOR_BUILD_INVALID");
  for (const relative of ["src", "scripts", "contracts", "config", "database"]) {
    try { await walk(relative); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  }
  for (const path of ["package.json", "next.config.ts", "package-lock.json"]) {
    try { files.push({ path, sha256: sha(await readFile(join(project, path))) }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  }
  if (!["scripts/visitor-acceptance/cli.ts", "scripts/game-sync/package-lock.json", "package-lock.json"].every(path => files.some(f => f.path === path))) fail("VISITOR_BUILD_INVALID");
  return configDigest({ node: process.versions.node, nodePath: await realpath(process.execPath), files: files.sort((a, b) => a.path.localeCompare(b.path)) });
}
async function writePrivate(path: string, value: unknown, exclusive = false) {
  const temporary = exclusive ? path : join(dirname(path), `.visitor-${randomUUID()}`);
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(JSON.stringify(value) + "\n"); await file.sync(); } finally { await file.close(); }
  if (!exclusive) await rename(temporary, path);
  const parent = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY); try { await parent.sync(); } finally { await parent.close(); }
}
export function visitorSharedLimits(limits: VisitorLimits): SharedLimits {
  return { notionRequests: 0, authRequests: 3, storageRequests: limits.httpRequests, imageRequests: limits.httpRequests, httpRequests: limits.httpRequests,
    notionResponseBytes: 0, authResponseBytes: 0, storageResponseBytes: limits.responseBytes, imageResponseBytes: 0, uploadBodyBytes: 0,
    sqlRequests: limits.sqlQueries, sqlRequestBytes: 64 * 1024 ** 2, sqlResponseBytes: limits.sqlRowBytes,
    cleanupSqlRequests: 0, cleanupSqlRequestBytes: 0, cleanupSqlResponseBytes: 0 };
}
export function visitorCounters(c: SharedLimits) {
  return { httpRequests: c.httpRequests, visitorHttpRequests: c.imageRequests, objectHttpRequests: c.storageRequests, responseBytes: c.storageResponseBytes,
    sqlQueries: c.sqlRequests, sqlRowBytes: c.sqlResponseBytes, sqlRequestBytes: c.sqlRequestBytes, sqlConnectionAttempts: c.authRequests };
}
export async function visitorMain(args: readonly string[], dependencies: { buildBinding?(): Promise<string>; spawn?: typeof fork } = {}) {
  if (args.length === 1 && args[0] === "--help") {
    console.log("node scripts/visitor-acceptance/cli.ts plan|run --config PRIVATE_JSON --artifact SAME_ACCEPTED_FULL --thumbnails SAME_REGISTERED_SELECTION --env RESTRICTED_READER_PROFILE --duration-ms N --http-requests N --response-bytes N --sql-queries N --sql-row-bytes N\nrun also requires --operation FRESH_PRIVATE_DIRECTORY --phase pre|post --plan-sha256 REVIEWED_DIGEST --deadline-ms ABSOLUTE_UNIX_MS --port LOCAL_PORT. plan has zero network/ledger/server. Local instrumented built app only; no cloud deployment or Source. pre/post each once, same operation. Remote SQL and browser hydration are not inferred."); return 0;
  }
  const options = parseVisitorArguments(args);
  const [configBytes, artifactBytes, thumbnailsBytes, envBytes, buildBinding] = await Promise.all([
    readPrivateFile(options.config), readPrivateFile(options.artifact, 48 * 1024 ** 2), readPrivateFile(options.thumbnails, 1024 ** 2), readPrivateFile(options.env), (dependencies.buildBinding ?? visitorBuildBinding)(),
  ]);
  const config = parseWebsiteNotionConfig(JSON.parse(configBytes)), artifact = JSON.parse(artifactBytes) as AcceptedFullBaseline;
  const thumbnails = JSON.parse(thumbnailsBytes) as { format: string; entries: AcceptanceThumbnail[] };
  if (thumbnails.format !== "media-acceptance-thumbnails-v1" || Object.keys(thumbnails).length !== 2) fail("VISITOR_INPUT_INVALID");
  const profile = await visitorProfile(envBytes), plan = planVisitorAcceptance(config, artifact, thumbnails.entries, profile.timeZone, profile.origin, profile.prefix, options.limits, options.mediaPolicy);
  const binding = { planDigest: plan.digest, buildBinding, configSha256: sha(configBytes), artifactSha256: sha(artifactBytes), thumbnailsSha256: sha(thumbnailsBytes), envSha256: sha(envBytes), siteSha256: profile.siteSha256 };
  const executionDigest = configDigest(binding);
  if (options.command === "plan") { console.log(JSON.stringify({ outcome: "planned", planDigest: executionDigest, requests: plan.requests.length, mediaSampleAvailable: plan.mediaSampleAvailable, thumbnail400SampleAvailable: plan.thumbnail400SampleAvailable, mediaPolicy: plan.mediaPolicy, limits: plan.limits })); return 0; }
  if (options.digest !== executionDigest || !options.deadline || options.deadline <= Date.now() || !options.port || options.port < 1024 || options.port > 65535) fail("VISITOR_PLAN_CHANGED");
  const operation = options.operation!, phase = options.phase!, receiptPath = join(operation, `${phase}.json`);
  let previous: ReturnType<typeof visitorCounters> | undefined, previousSha256: string | undefined;
  await privateDirectory(dirname(operation));
  if (phase === "pre") { await mkdir(operation, { mode: 0o700 }); await privateDirectory(operation); await writePrivate(join(operation, "operation.json"), binding, true); }
  else { await privateDirectory(operation); unchanged(JSON.parse(await readPrivateFile(join(operation, "operation.json"))), binding);
    const beforeBytes = await readPrivateFile(join(operation, "pre.json")), before = JSON.parse(beforeBytes);
    if (before.format !== "representative-visitor-receipt-v1" || before.planDigest !== executionDigest || before.phase !== "pre" || before.outcome !== "passed" || before.accountingComplete !== true) fail("VISITOR_PRE_NOT_ACCEPTED");
    const ledgerPlanBytes = await readPrivateFile(join(operation, "pre-ledger/plan.json")), ledgerPlan = JSON.parse(ledgerPlanBytes);
    const state = JSON.parse(await readPrivateFile(join(operation, "pre-ledger/state.json")));
    if (ledgerPlan.runtimeSha256 !== executionDigest || state.planDigest !== sha(ledgerPlanBytes) || state.failure !== null) fail("VISITOR_PRE_NOT_ACCEPTED");
    unchanged(ledgerPlan.limits, visitorSharedLimits(plan.limits)); unchanged(before.counters, visitorCounters(state.counters));
    if (Object.entries(state.counters).some(([k, v]) => !Number.isSafeInteger(v) || (v as number) < 0 || (v as number) > ledgerPlan.limits[k])) fail("VISITOR_PRE_NOT_ACCEPTED");
    previous = before.counters; previousSha256 = sha(beforeBytes);
  }
  // Fixed exclusive slot survives cancellation, SIGKILL and receipt loss. A
  // rerun cannot acquire a fresh allowance inside this reviewed operation.
  await mkdir(join(operation, `${phase}-slot`), { mode: 0o700 });
  const started = Date.now(), deadline = Math.min(options.deadline, started + plan.limits.durationMs);
  const bridge = initializeSharedBudget(join(operation, `${phase}-ledger`), { format: "qualified-shared-budget-v1", parentPid: process.pid, nonce: randomUUID(), deadline, cleanupMs: 0,
    runtimeSha256: executionDigest, storageOrigin: plan.origin, limits: visitorSharedLimits(plan.limits) });
  const budget = openSharedBudget(bridge), localOrigin = `http://127.0.0.1:${options.port}`;
  let child: ChildProcess | undefined, readyResolve!: () => void, childResolve!: () => void;
  const ready = new Promise<void>(ok => { readyResolve = ok; }), exited = new Promise<void>(ok => { childResolve = ok; });
  let childDrained = false, childAccounting = false, childCode: number | null = null, childGone = false, accountingComplete = false, report: unknown, failure: string | null = null, serverFailure: string | null = null;
  const transport = installVisitorTransports({ budget, plan, readerUrl: profile.env.DATABASE_READER_URL!, localOrigin, role: "supervisor", onStop: () => { child?.kill("SIGTERM"); } });
  const client = new Client(databasePoolConfig(profile.env.DATABASE_READER_URL, "verify", profile.env.DATABASE_CA_CERT)); client.on("error", () => {});
  let connect: Promise<unknown> | undefined;
  const cancel = () => transport.stop("VISITOR_CANCELLED"); process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  const wait = <T>(p: Promise<T>) => new Promise<T>((ok, reject) => {
    const abort = () => reject(new VisitorError(transport.failure() ?? "VISITOR_CANCELLED"));
    if (transport.signal.aborted) { reject(new VisitorError("VISITOR_CANCELLED")); return; }
    transport.signal.addEventListener("abort", abort, { once: true });
    p.then(v => { transport.signal.removeEventListener("abort", abort); try { transport.guard(); ok(v); } catch (e) { reject(e); } }, e => { transport.signal.removeEventListener("abort", abort); reject(e); });
  });
  const snapshot = () => ({ format: "representative-visitor-receipt-v1", planDigest: executionDigest, phase, started, deadline,
    outcome: failure ? "failed" : accountingComplete ? "passed" : "started", failure, serverFailure, accountingComplete, childDrained, durationMs: Date.now() - started,
    counters: visitorCounters(budget.read().counters), previousReceiptSha256: previousSha256 ?? null,
    combinedCounters: Object.fromEntries(Object.entries(visitorCounters(budget.read().counters)).map(([k, v]) => [k, v + (previous?.[k as keyof typeof previous] ?? 0)])),
    report, cloudRouteVerified: false, browserHydrationVerified: false, regionalNetworkVerified: false });
  await writePrivate(receiptPath, snapshot(), true);
  try {
    const connecting = client.connect(); connect = connecting; await wait(connecting);
    const role = (await wait(client.query(INCREMENTAL_LOGIN_SQL, ["nb_reader", ["nb_publication_api.read_snapshot(text[],boolean)", "nb_delta_api.read_state()"]]))).rows;
    const username = decodeURIComponent(new URL(profile.env.DATABASE_READER_URL!).username), p = role[0];
    if (role.length !== 1 || !p || Object.keys(p).length !== 8 || ["safe_login", "isolated_role", "create_denied", "private_data_denied", "required_functions", "group_functions_only"].some(k => p[k] !== true) ||
      typeof p.login !== "string" || !username.startsWith(p.login) || !/^(?:\.[a-z0-9_-]{1,128})?$/.test(username.slice(p.login.length)) || p.database !== decodeURIComponent(new URL(profile.env.DATABASE_READER_URL!).pathname.slice(1))) fail("VISITOR_READER_ROLE_INVALID");
    const db = { query: async <T>(sql: string, values?: unknown[]) => ({ rows: (await client.query(sql, values)).rows as T[] }) };
    unchanged(await wait(readPublicationState(db)), plan.state);
    const contextPath = join(operation, `${phase}-context.json`); await writePrivate(contextPath, { bridge, plan, port: options.port }, true);
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, LANG: process.env.LANG, TMPDIR: process.env.TMPDIR, ...profile.env,
      NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", SITE_INDEXING_ENABLED: "false", SITE_URL: localOrigin, VISITOR_CONTEXT: contextPath };
    child = (dependencies.spawn ?? fork)(join(PROJECT, "scripts/visitor-acceptance/server.ts"), [], { cwd: PROJECT, env, execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"] });
    child.on("message", (m: any) => {
      if (m?.type === "ready" && m.pid === child!.pid) readyResolve();
      else if (m?.type === "stopped" || m?.type === "guard-stop") {
        if (m.type === "stopped") { childDrained = m.drained === true; childAccounting = m.accountingComplete === true; }
        if (m.failure) { serverFailure = typeof m.failure === "string" && /^VISITOR_[A-Z_]+$/.test(m.failure) ? m.failure : "VISITOR_SERVER_FAILED"; transport.stop(serverFailure ?? "VISITOR_SERVER_FAILED"); }
      } else if (m?.type === "failed") transport.stop("VISITOR_SERVER_FAILED");
    });
    child.once("error", () => { childGone = true; childResolve(); transport.stop("VISITOR_SERVER_FAILED"); });
    child.once("exit", code => { childCode = code; childGone = true; childResolve(); if (!childDrained) transport.stop("VISITOR_SERVER_FAILED"); });
    await wait(ready); report = await wait(checkVisitorResponses(plan, transport.fetch, localOrigin, bridge.nonce));
    unchanged(await wait(readPublicationState(db)), plan.state);
    unchanged(await (dependencies.buildBinding ?? visitorBuildBinding)(), buildBinding);
    if (previousSha256 && sha(await readPrivateFile(join(operation, "pre.json"))) !== previousSha256) fail("VISITOR_PRE_CHANGED");
    transport.guard();
  } catch (e) { failure = e instanceof VisitorError ? e.code : "VISITOR_UNAVAILABLE"; transport.stop(failure); }
  finally {
    child?.kill("SIGTERM");
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (async () => { await client.end(); await connect?.catch(() => {}); await transport.drain(); if (child) await exited; })();
    const bounded = new Promise<boolean>(ok => { cleanupTimer = setTimeout(() => ok(false), Math.max(0, Math.min(5000, deadline - Date.now()))); });
    const drained = await Promise.race([cleanup.then(() => true, () => false), bounded]); clearTimeout(cleanupTimer);
    if (!drained) { failure ??= "VISITOR_ACCOUNTING_INCOMPLETE"; child?.kill("SIGKILL"); if (child && !childGone) await exited; }
    accountingComplete = drained && transport.accountingComplete() && (!child || childDrained && childAccounting && childCode === 0);
    if (!accountingComplete) failure ??= "VISITOR_ACCOUNTING_INCOMPLETE";
    if (budget.read().failure || transport.failure() || Date.now() >= deadline) failure ??= "VISITOR_BUDGET_STOPPED";
    process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); transport.restore();
    const result = snapshot(); await writePrivate(receiptPath, result);
    console.log(JSON.stringify({ outcome: result.outcome, planDigest: executionDigest, phase, failure, accountingComplete, counters: result.counters, combinedCounters: result.combinedCounters, thumbnail400Verified: failure ? false : plan.thumbnail400SampleAvailable,
      cloudRouteVerified: false, browserHydrationVerified: false, regionalNetworkVerified: false }));
  }
  return failure ? 1 : 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) visitorMain(process.argv.slice(2)).then(code => { process.exitCode = code; })
  .catch(() => { console.error(JSON.stringify({ outcome: "failed", errorCode: "VISITOR_INPUT_OR_STATE_INVALID" })); process.exitCode = 1; });
