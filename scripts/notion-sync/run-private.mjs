// Host adapter for split private inputs. No scheduler installation or provider migration.
import { constants } from "node:fs";
import { open, lstat, realpath, unlink } from "node:fs/promises";
import { join, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { parseArgs, parseEnv } from "node:util";
import { spawn } from "node:child_process";

const fail = code => { throw Object.assign(new Error(code), { code }); };
const allowedCodes = new Set(["INVALID_ARGUMENTS", "PRIVATE_DIRECTORY_INVALID", "PRIVATE_INPUT_INVALID",
  "RUN_BUSY", "JWT_RUN_BUDGET_TOO_SHORT", "WORKER_START_FAILED", "RUN_CANCELLED", "SESSION_BUSY",
  "REFRESH_REJECTED", "REFRESH_SERVER_VALIDATION_FAILED"]);
async function directory(path, privateMode) {
  const s = await lstat(path);
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid() ||
      (privateMode ? (s.mode & 0o777) !== 0o700 : (s.mode & 0o022) !== 0) || await realpath(path) !== path) {
    fail("PRIVATE_DIRECTORY_INVALID");
  }
}
async function readPrivate(path) {
  const h = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = await h.stat();
    if (!s.isFile() || (s.mode & 0o777) !== 0o600 || s.uid !== process.getuid() || s.size > 2 * 1024 * 1024) {
      fail("PRIVATE_INPUT_INVALID");
    }
    return await h.readFile("utf8");
  } finally { await h.close(); }
}
async function absent(path) {
  try { await lstat(path); fail("RUN_BUSY"); }
  catch (e) { if (e.code !== "ENOENT") throw e; }
}
function encode(env) {
  return Object.entries(env).map(([key, value]) => {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || typeof value !== "string" || /["\r\0]/.test(value)) {
      fail("PRIVATE_INPUT_INVALID");
    }
    return `${key}="${value}"\n`;
  }).join("");
}
function childRun(project, temp, state, mode, signal) {
  return new Promise((done, reject) => {
    if (signal.aborted) return reject(Object.assign(new Error(), { code: "RUN_CANCELLED" }));
    const child = spawn(process.execPath, [join(project, "scripts/notion-sync/cli.ts"),
      "--env", temp, "--state-dir", state, "--mode", mode, "--timeout-seconds", "1800", "--reconcile"], {
      cwd: project, shell: false, stdio: "inherit",
      // Inputs come from the private file, never inherited website or shell credentials.
      env: { PATH: "/usr/bin:/bin", NEXT_TELEMETRY_DISABLED: "1" },
    });
    let killTimer;
    const cancel = () => {
      child.kill("SIGTERM");
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), 30_000);
    };
    signal.addEventListener("abort", cancel, { once: true });
    // The worker's cooperative 1800s budget can include bounded SDK cleanup.
    const deadline = setTimeout(cancel, 1860_000);
    const cleanup = () => {
      clearTimeout(deadline); clearTimeout(killTimer);
      signal.removeEventListener("abort", cancel);
    };
    child.once("error", () => { cleanup(); reject(Object.assign(new Error(), { code: "WORKER_START_FAILED" })); });
    child.once("close", (code) => { cleanup(); done(code ?? 1); });
  });
}

/** Uses the same input-root lock and state as the existing manual host adapter. */
export async function runPrivateWorker({ project, privateRoot, stateDir, mode = "dry-run", mediaProvider = "storage", check = false }) {
  if (![project, privateRoot, stateDir].every(p => typeof p === "string" && isAbsolute(p) && resolve(p) === p) ||
      !["dry-run", "stage", "publish"].includes(mode) || !["storage", "notion"].includes(mediaProvider) ||
      ![24, 25, 26].includes(Number(process.versions.node.split(".")[0]))) fail("INVALID_ARGUMENTS");
  await directory(project, false); await directory(privateRoot, true); await directory(stateDir, true);
  const notionPath = join(privateRoot, "notion-readonly.env");
  const writerPath = join(privateRoot, "supabase-worker.env");
  const sourcesPath = join(privateRoot, "notion-sources.json");
  const refreshPath = join(privateRoot, "refresh-writer-session.mjs");
  const notion = parseEnv(await readPrivate(notionPath));
  JSON.parse(await readPrivate(sourcesPath));
  let writer = parseEnv(await readPrivate(writerPath));
  if (!notion.NOTION_TOKEN || !writer.SYNC_DATABASE_URL || !writer.STORAGE_URL || !writer.STORAGE_API_KEY ||
      !writer.STORAGE_BUCKET) fail("PRIVATE_INPUT_INVALID");
  // Check code before import; the host's current rotating session remains authoritative.
  if (mode !== "dry-run") await readPrivate(refreshPath);
  if (check) return { offlineCheck: true, mode, mediaProvider, nodeVersion: process.versions.node,
    networkChecked: false, publicationEnabled: false };

  let temp, lockHandle, lockInode;
  const lockPath = join(privateRoot, "manual-run.lock");
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on("SIGINT", cancel); process.on("SIGTERM", cancel);
  try {
    try {
      lockHandle = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    } catch (e) { if (e.code === "EEXIST") fail("RUN_BUSY"); throw e; }
    lockInode = await lockHandle.stat();
    await lockHandle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + "\n");
    await lockHandle.sync();
    // Avoid rotating Auth while a directly invoked CLI or refresher is already active.
    await absent(join(stateDir, "worker.lock")); await absent(join(privateRoot, "writer-session.lock"));
    if (controller.signal.aborted) fail("RUN_CANCELLED");
    if (mode !== "dry-run") {
      const { refreshWriterSession } = await import(pathToFileURL(refreshPath).href);
      await refreshWriterSession(writerPath);
      writer = parseEnv(await readPrivate(writerPath));
      const claims = JSON.parse(Buffer.from((writer.STORAGE_WRITE_TOKEN ?? "").split(".")[1] ?? "", "base64url").toString());
      if (!Number.isFinite(claims.exp) || claims.exp * 1000 - Date.now() < 2100_000) fail("JWT_RUN_BUDGET_TOO_SHORT");
    }
    if (controller.signal.aborted) fail("RUN_CANCELLED");
    const env = { ...notion, ...writer, NOTION_SOURCES_CONFIG: sourcesPath,
      SYNC_HEIC_CONVERTER_PATH: join(privateRoot, "bin/heic-to-jpeg"),
      SYNC_IMAGE_TIMEOUT_MS: "60000", SYNC_IMAGE_HEADER_TIMEOUT_MS: "15000",
      SYNC_MODE: "dry-run", SYNC_MEDIA_PROVIDER: mediaProvider };
    delete env.NOTION_SOURCES_JSON;
    const encoded = encode(env);
    temp = join(privateRoot, `.runtime-env-${randomUUID()}`);
    const h = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await h.writeFile(encoded); await h.sync(); } finally { await h.close(); }
    return { exitCode: await childRun(project, temp, stateDir, mode, controller.signal), mode, mediaProvider };
  } finally {
    process.off("SIGINT", cancel); process.off("SIGTERM", cancel);
    if (temp) await unlink(temp).catch(() => {});
    await lockHandle?.close();
    if (lockInode) {
      const now = await lstat(lockPath).catch(() => null);
      if (now?.ino === lockInode.ino && now?.dev === lockInode.dev && !now.isSymbolicLink()) await unlink(lockPath);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { project: { type: "string" }, "private-root": { type: "string" },
      "state-dir": { type: "string" }, mode: { type: "string" }, "media-provider": { type: "string" }, check: { type: "boolean" } },
      strict: true, allowPositionals: false });
    const result = await runPrivateWorker({ project: values.project, privateRoot: values["private-root"],
      stateDir: values["state-dir"], mode: values.mode, mediaProvider: values["media-provider"], check: values.check });
    console.log(JSON.stringify({ adapter: "private-host-v1", ...result }));
    process.exitCode = result.exitCode ?? 0;
  } catch (e) {
    console.error(JSON.stringify({ adapter: "private-host-v1", outcome: "preparation-failed",
      code: allowedCodes.has(e.code) ? e.code : "PREPARATION_FAILED" }));
    process.exitCode = e.code === "RUN_BUSY" ? 75 : 1;
  }
}
