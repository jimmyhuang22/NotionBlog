import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { WorkerError } from "../notion-sync/errors.ts";
import { privateDirectory, readPrivateFile } from "../notion-sync/state.ts";

/** Native-only coordination with an existing recovery program. The incremental
 * host/backend still owns its canonical worker.lock, acquired AFTER these three.
 * No stale lock removal, waiting, source counters or scheduling changes. */
export async function acquireManagementCoordination(path: string | undefined): Promise<() => Promise<void>> {
  if (path === undefined) return async () => {};
  if (!isAbsolute(path) || resolve(path) !== path) throw new WorkerError("MISCONFIGURED");
  const config = JSON.parse(await readPrivateFile(path, 16384));
  const names = ["maintenance.lock", "manual-run.lock", "writer-session.lock"];
  if (config?.version !== 1 || Object.keys(config).length !== 2 || !Array.isArray(config.locks) || config.locks.length !== 3 ||
      new Set(config.locks).size !== 3 || config.locks.some((p: unknown, i: number) => typeof p !== "string" ||
        !isAbsolute(p) || resolve(p) !== p || !p.endsWith("/" + names[i]))) throw new WorkerError("MISCONFIGURED");
  const held: {path: string; ino: number; dev: number; bytes: string}[] = [];
  const release = async () => {
    let failure: unknown;
    for (const lock of [...held].reverse()) {
      try {
        const now = await lstat(lock.path);
        if (now.isSymbolicLink() || now.ino !== lock.ino || now.dev !== lock.dev || await readPrivateFile(lock.path, 16384) !== lock.bytes) throw new WorkerError("MISCONFIGURED");
        await unlink(lock.path);
      } catch (e) { failure ??= e; }
    }
    if (failure) throw failure;
  };
  try {
    for (const lock of config.locks as string[]) {
      // A typo must not create another directory with an unrelated lock set.
      await lstat(dirname(lock));
      await privateDirectory(dirname(lock));
      let file;
      try { file = await open(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new WorkerError("BUSY"); throw e; }
      const info = await file.stat(), bytes = JSON.stringify({pid: process.pid, runId: randomUUID(), kind: "console-management", startedAt: new Date().toISOString()}) + "\n";
      held.push({path: lock, ino: info.ino, dev: info.dev, bytes});
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    }
    return release;
  } catch (e) { await release(); throw e; }
}
export async function withManagementCoordination<T>(path: string | undefined, work: () => Promise<T>): Promise<T> {
  const release = await acquireManagementCoordination(path);
  try { return await work(); } finally { await release(); }
}
