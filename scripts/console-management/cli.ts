import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { ManagementBackend, managementError, type ManagementConfig } from "./backend.ts";
import { FreezeError } from "../../src/server/database/freeze.ts";
import { createDatabasePool } from "../../src/server/database/connection.ts";
import { INCREMENTAL_LOGIN_SQL } from "../../src/server/database/incremental-connection.ts";
import { createLocalMediaStorage } from "../../src/server/database/local-storage.ts";
import { createSupabaseStorage, verifyMediaBytes, type ObjectStorage } from "../../src/server/database/storage.ts";
import { configuredCosStorage, storageProvider, thumbnailStorageProvider } from "../../src/server/database/cos-config.ts";
import { createStorageReaderToken } from "../../src/server/database/reader-auth.ts";
import { parseWebsiteNotionConfig } from "../../src/server/notion/website-config.ts";
import { configDigest } from "../../src/server/database/website-validation.ts";
import { readPrivateFile, privateDirectory } from "../notion-sync/state.ts";
import { openIncrementalQueue } from "../website-incremental-sync/queue.ts";
import { createHostBudget } from "../website-incremental-sync/host-budget.ts";
import { createIncrementalNotionTransport } from "../website-incremental-sync/notion-transport.ts";
import { readHostJson, validateHostReport } from "../website-incremental-sync/host-state.ts";
import { closeOwnerPool } from "../cleanup.ts";

export async function loadManagementConfig(path: string): Promise<ManagementConfig> {
  if (!isAbsolute(path) || resolve(path) !== path) throw new FreezeError("FREEZE_INPUT_INVALID");
  const config = JSON.parse(await readPrivateFile(path)) as ManagementConfig;
  if (!config || config.version !== 1 || typeof config.enabled !== "boolean" ||
      [config.stateDir, config.lockDirectory, config.runtimeDirectory, config.sourceConfigPath].some(p => typeof p !== "string" || !isAbsolute(p) || resolve(p) !== p) ||
      !config.stateDir.split("/").includes(".local") || config.lockDirectory === config.runtimeDirectory ||
      !Number.isSafeInteger(config.durationMs) || config.durationMs < 1000 || config.durationMs > 899000 ||
      !Number.isSafeInteger(config.mediaBytes) || config.mediaBytes < 1 || config.mediaBytes > 2 * 1024 ** 3) throw new FreezeError("FREEZE_INPUT_INVALID");
  const site = new URL(config.siteOrigin);
  if (site.protocol !== "https:" || site.origin !== config.siteOrigin) throw new FreezeError("FREEZE_INPUT_INVALID");
  return config;
}

async function childReport(args: string[], env: NodeJS.ProcessEnv, signal: AbortSignal) {
  signal.throwIfAborted();
  const cwd = fileURLToPath(new URL("../../", import.meta.url));
  const child = spawn(process.execPath, [join(cwd, "scripts/website-incremental-sync/cli.ts"), ...args], {cwd, env, stdio: ["ignore", "pipe", "ignore"]});
  let output = "", overflow = false;
  const stop = () => child.kill("SIGTERM"); signal.addEventListener("abort", stop, {once: true});
  child.stdout.on("data", chunk => { output += chunk; if (Buffer.byteLength(output) > 2 * 1024 * 1024) { overflow = true; stop(); } });
  try {
    await new Promise<void>((done, fail) => { child.once("error", fail); child.once("exit", () => done()); });
    if (overflow || !output.trim()) throw new FreezeError("FREEZE_UNAVAILABLE");
    return validateHostReport(JSON.parse(output));
  } finally { signal.removeEventListener("abort", stop); }
}

export async function managementMain(args: string[], env: NodeJS.ProcessEnv = process.env) {
  if (args.length === 1 && args[0] === "--help") {
    console.log("node scripts/console-management/cli.ts --config ABSOLUTE_PRIVATE_JSON [--worker manage-ID]"); return;
  }
  if (args[0] !== "--config" || !args[1] || args.length !== 2 && (args.length !== 4 || args[2] !== "--worker")) throw new FreezeError("FREEZE_INPUT_INVALID");
  const configPath = args[1], config = await loadManagementConfig(configPath);
  if (!config.enabled || env.SYNC_PUBLICATION_MODE !== "published" || env.SYNC_MEDIA_PROVIDER !== "storage" || env.SYNC_FREEZE_ENABLED !== "1") throw new FreezeError("FREEZE_DISABLED");
  if (!env.CONSOLE_OPERATOR_DATABASE_URL) throw new FreezeError("FREEZE_DISABLED");
  const operator = new URL(env.CONSOLE_OPERATOR_DATABASE_URL), writer = new URL(env.SYNC_DATABASE_URL ?? "");
  if (operator.hostname !== writer.hostname || operator.pathname !== writer.pathname ||
      decodeURIComponent(operator.username).split(".").slice(1).join(".") !== decodeURIComponent(writer.username).split(".").slice(1).join(".")) throw new FreezeError("FREEZE_ROLE_INVALID");
  const pool = createDatabasePool(env.CONSOLE_OPERATOR_DATABASE_URL, env.DATABASE_TLS, env.DATABASE_CA_CERT); pool.options.max = 1;
  let client: PoolClient | undefined;
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await closeOwnerPool(pool, client, false); } };
  const stores = new Map<boolean, ObjectStorage>(); let sourceConfig: ReturnType<typeof parseWebsiteNotionConfig> | undefined;
  let storageToken: ReturnType<typeof createStorageReaderToken> | undefined;
  const settings = async () => sourceConfig ??= parseWebsiteNotionConfig(JSON.parse(await readPrivateFile(config.sourceConfigPath)));
  const queue = async () => { const source = await settings(); return openIncrementalQueue(join(config.runtimeDirectory, "queue"), {digest: configDigest(source), sourceKeys: source.sources.map(s => s.key)}); };
  const required = ["nb_freeze_api.check_capability(text)", "nb_freeze_api.read_state()", "nb_freeze_api.preview(text,text)",
    "nb_freeze_api.freeze(uuid,text,text,jsonb)", "nb_freeze_api.unfreeze(uuid,text,text)", "nb_freeze_api.read_operation(uuid)",
    "nb_freeze_api.resolve_item(text)", "nb_freeze_api.resolve_task(text)", "nb_freeze_api.list_content(text,text,text)", "nb_freeze_api.sections()"];
  const backend = new ManagementBackend(config, {
    async database() {
      if (!env.CONSOLE_OPERATOR_DATABASE_URL) throw new FreezeError("FREEZE_DISABLED");
      if (!client) {
        client = await pool.connect();
        const profile = (await client.query(INCREMENTAL_LOGIN_SQL, ["nb_freeze_operator", required])).rows;
        if (profile.length !== 1 || ["safe_login", "isolated_role", "create_denied", "private_data_denied", "required_functions", "group_functions_only"].some(k => profile[0][k] !== true)) throw new FreezeError("FREEZE_ROLE_INVALID");
      }
      const current = (await client.query("SELECT nb_freeze_api.read_state() AS result")).rows[0]?.result;
      if (current?.configDigest !== configDigest(await settings())) throw new FreezeError("FREEZE_ROLE_INVALID");
      return {query: async <T>(sql: string, values?: unknown[]) => ({rows: (await client!.query(sql, values)).rows as T[]})};
    },
    async verifyMedia(media, signal, thumbnail) {
      let storage = stores.get(thumbnail);
      if (!storage) {
        const fetcher: typeof fetch = (url, init) => fetch(url, {...init, signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])])});
        storage = env.DATABASE_MEDIA_DIRECTORY ? createLocalMediaStorage(env.DATABASE_MEDIA_DIRECTORY, env.SYNC_DATABASE_URL ?? "", "reader") :
          (thumbnail ? thumbnailStorageProvider(env) : storageProvider(env)) === "cos" ? configuredCosStorage(env, "reader", {fetch: fetcher}) :
          createSupabaseStorage({url: env.STORAGE_URL ?? "", bucket: env.STORAGE_BUCKET ?? "", apiKey: env.STORAGE_API_KEY ?? "",
            token: storageToken ??= createStorageReaderToken({storageUrl: env.STORAGE_URL ?? "", apiKey: env.STORAGE_API_KEY ?? "",
              email: env.STORAGE_READER_EMAIL, password: env.STORAGE_READER_PASSWORD, userId: env.STORAGE_READER_USER_ID,
              staticToken: env.STORAGE_READ_TOKEN, fetch: fetcher}), role: "reader", fetch: fetcher});
        stores.set(thumbnail, storage);
      }
      signal.throwIfAborted(); verifyMediaBytes(media, await storage.read(media)); signal.throwIfAborted();
    },
    async inspectSource(plan, signal) {
      if (!env.NOTION_TOKEN) throw new FreezeError("FREEZE_DISABLED");
      const budget = createHostBudget({durationMs: 50000, sourceRequests: 5000, signal});
      try {
        const source = createIncrementalNotionTransport({token: env.NOTION_TOKEN, notionVersion: env.NOTION_API_VERSION, budget, signal}).client;
        const versions: unknown[] = [], missing: {title: string}[] = [];
        for (const member of plan.members) {
          signal.throwIfAborted(); const page = await source.getPage(member.id);
          if (page && page.id.replace(/-/g, "").toLowerCase() !== member.id.replace(/-/g, "").toLowerCase()) throw new FreezeError("FREEZE_SOURCE_MISMATCH");
          versions.push(page ? [page.id, page.last_edited_time, page.parent, page.archived, page.in_trash, page.is_archived ?? false] : [member.id, null]);
          if (!page || page.archived || page.in_trash || page.is_archived) missing.push({title: member.title});
        }
        return {fingerprint: createHash("sha256").update(JSON.stringify(versions)).digest("hex"), missing};
      } finally { budget.close(); }
    },
    async runSync(input, signal) {
      const args = ["run", "--config", config.sourceConfigPath, "--lock-dir", config.lockDirectory, "--runtime-dir", config.runtimeDirectory,
        "--duration-ms", String(config.durationMs), "--media-bytes", String(config.mediaBytes)];
      if (input.target) args.push("--source", input.target.sourceKey, "--page", input.target.pageKey);
      if (input.refresh) args.push("--refresh-group", input.refresh.groupId, "--freeze-generation", input.refresh.generation);
      if (input.expectedRevision) args.push("--expected-revision", input.expectedRevision);
      const workerEnv: NodeJS.ProcessEnv = {NODE_ENV: env.NODE_ENV ?? "production"};
      for (const [key, value] of Object.entries(env)) if (/^(SYNC_|STORAGE_|COS_|NOTION_|DATABASE_)/.test(key) || ["PATH", "HOME", "NODE_OPTIONS", "NOTIONBLOG_DEVELOPMENT_MODE"].includes(key)) workerEnv[key] = value;
      return childReport(args, workerEnv, signal);
    },
    async enqueue(members, operation) {
      const store = await queue();
      try { for (let offset = 0; offset < members.length; offset += 200) store.enqueue(members.slice(offset, offset + 200).map(m => ({
        eventId: `${operation}:${m.id}`, sourceKey: m.sourceKey, pageKey: m.id, reason: "reconcile", observedAt: 0,
      }))); } finally { store.close(); }
    },
    async assertIdle() {
      const ready = await readHostJson(config.runtimeDirectory, "incremental-ready.json");
      if (!ready || ready.configDigest !== configDigest(await settings()) || ready.format !== "incremental-host-ready-v1") throw new FreezeError("FREEZE_DISABLED");
      const store = await queue();
      try {
        const state = store.status();
        if (state.leased || state.awaiting_verification || state.retirement_pending) throw new FreezeError("BUSY");
      } finally { store.close(); }
    },
    async dispatch(id) {
      await privateDirectory(config.stateDir);
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--config", configPath, "--worker", id], {cwd: fileURLToPath(new URL("../../", import.meta.url)), env, detached: true, stdio: "ignore"});
      await new Promise<void>((done, fail) => { child.once("spawn", done); child.once("error", fail); }); child.unref();
    },
    async latestReport() { const report = await readHostJson(config.runtimeDirectory, "incremental-latest.json"); return report ? validateHostReport(report) : null; },
    closeDatabase: close,
  });
  try {
    if (args[2] === "--worker") { await backend.work(args[3]); return; }
    let body = "";
    for await (const chunk of process.stdin) { body += chunk; if (Buffer.byteLength(body) > 65536) throw new FreezeError("FREEZE_INPUT_INVALID"); }
    const request = JSON.parse(body);
    if (request?.version !== 1 || typeof request.op !== "string" || !request.input || typeof request.input !== "object" || Array.isArray(request.input)) throw new FreezeError("FREEZE_INPUT_INVALID");
    const data = await backend.request(request.op, request.input);
    process.stdout.write(JSON.stringify({version: 1, ok: true, data}));
  } finally { await close(); }
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  managementMain(process.argv.slice(2)).catch(e => {
    if (process.argv.includes("--worker")) { process.exitCode = 1; return; }
    process.stdout.write(JSON.stringify({version: 1, ok: false, error: managementError(e)}));
  });
}
