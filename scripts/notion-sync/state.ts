import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdir, lstat, open, rename, readdir, unlink, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { RunLease } from "../../contracts/sync.ts";
import type { RunReport } from "./worker.ts";
import { WorkerError } from "./errors.ts";

export async function privateDirectory(path: string): Promise<void> {
  if (!isAbsolute(path)) throw new WorkerError("MISCONFIGURED");
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) ||
      (process.getuid && info.uid !== process.getuid()) || await realpath(path) !== path) throw new WorkerError("MISCONFIGURED");
}
export async function readPrivateFile(path: string, maxBytes = 2 * 1024 * 1024): Promise<string> {
  if (!isAbsolute(path)) throw new WorkerError("MISCONFIGURED");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o077) || info.size > maxBytes ||
        (process.getuid && info.uid !== process.getuid())) throw new WorkerError("MISCONFIGURED");
    return await handle.readFile("utf8");
  } finally { await handle.close(); }
}
function privateJson(text: string) {
  try { return JSON.parse(text); }
  catch { throw new WorkerError("MISCONFIGURED"); }
}
function lockPid(owner: unknown): number {
  if (!owner || typeof owner !== "object" || Array.isArray(owner)) throw new WorkerError("MISCONFIGURED");
  const pid = (owner as Record<string, unknown>).pid;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 1 || pid > 2147483647) throw new WorkerError("MISCONFIGURED");
  return pid;
}
async function atomicJson(dir: string, name: string, data: unknown) {
  const temp = join(dir, `.tmp-${process.pid}-${randomUUID()}`);
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try { await handle.writeFile(JSON.stringify(data) + "\n"); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temp, join(dir, name));
  } finally { await unlink(temp).catch(() => {}); }
}

/** Atomic local process lock. Never automatically steals a possibly-live lock. */
export async function acquireLock(dir: string, runId: string): Promise<() => Promise<void>> {
  await privateDirectory(dir);
  const path = join(dir, "worker.lock");
  let handle;
  try { handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new WorkerError("BUSY"); throw error; }
  const inode = await handle.stat();
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, runId, startedAt: new Date().toISOString() }));
    await handle.sync();
  } catch (error) {
    await unlink(path).catch(() => {}); throw error;
  } finally { await handle.close(); }
  return async () => {
    try {
      const now = await lstat(path);
      if (now.ino === inode.ino && now.dev === inode.dev && !now.isSymbolicLink()) await unlink(path);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  };
}
export async function unlockStale(dir: string): Promise<void> {
  await privateDirectory(dir);
  const path = join(dir, "worker.lock"), before = await lstat(path);
  const pid = lockPid(privateJson(await readPrivateFile(path)));
  try { process.kill(pid, 0); throw new WorkerError("BUSY"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  const after = await lstat(path);
  if (before.ino !== after.ino || before.dev !== after.dev) throw new WorkerError("BUSY");
  await unlink(path);
}
export async function saveCheckpoint(dir: string, lease: RunLease, report: RunReport) {
  await atomicJson(dir, "last-success.json", { protocol: report.protocol, schemaDigest: report.schemaDigest,
    runId: lease.runId, revision: lease.revision, configDigest: lease.configDigest, publishedAt: new Date().toISOString() });
}
export async function saveReport(dir: string, report: RunReport | { runId: string; code: string; outcome: string }) {
  await atomicJson(dir, "latest-run.json", report);
  await atomicJson(dir, `run-${report.runId}.json`, report);
  const files = (await readdir(dir)).filter(f => /^run-[a-f\d-]{36}\.json$/.test(f));
  const entries = await Promise.all(files.map(async name => ({ name, info: await lstat(join(dir, name)) })));
  entries.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs);
  for (const entry of entries.slice(10)) if (entry.info.isFile() && !entry.info.isSymbolicLink()) await unlink(join(dir, entry.name));
  // launchd opens these files; truncate in place to keep its descriptor valid.
  for (const name of ["stdout.log", "stderr.log"]) {
    try {
      const handle = await open(join(dir, name), constants.O_WRONLY | constants.O_NOFOLLOW);
      try { if ((await handle.stat()).size > 1024 * 1024) await handle.truncate(0); }
      finally { await handle.close(); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
export async function readStatus(dir: string) {
  await privateDirectory(dir);
  const read = async (name: string) => {
    try { return privateJson(await readPrivateFile(join(dir, name))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  };
  const lock = await read("worker.lock");
  if (lock !== undefined) lockPid(lock);
  return { locked: lock !== undefined, latestRun: await read("latest-run.json") ?? null, lastSuccess: await read("last-success.json") ?? null };
}
