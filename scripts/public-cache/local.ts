import { constants } from "node:fs";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { createDatabasePool, sqlExecutor } from "../../src/server/database/connection.ts";
import { privateDirectory, readPrivateFile } from "../notion-sync/state.ts";
import { cacheControlOrigin, type CacheClientConfig } from "./control.ts";
import { publicCacheSecret } from "../../src/server/public-cache/policy.ts";

export function privateCachePath(path: string): string {
  if (!isAbsolute(path) || resolve(path) !== path || !path.split(sep).includes(".local")) throw Error("CACHE_PRIVATE_PATH");
  return path;
}
export async function saveCacheJournal(path: string, value: unknown, createOnly = false) {
  privateCachePath(path); await privateDirectory(dirname(path));
  const temp = createOnly ? path : `${path}.tmp-${randomUUID()}`;
  const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2) + "\n"); await handle.sync(); }
  finally { await handle.close(); }
  if (!createOnly) { try { await rename(temp, path); } finally { await unlink(temp).catch(() => {}); } }
}
export async function readCacheJournal(path: string) { return JSON.parse(await readPrivateFile(privateCachePath(path), 10 * 1024 * 1024)); }

export function cacheClientConfig(): CacheClientConfig {
  const config = { origin: cacheControlOrigin(process.env.PUBLIC_CACHE_ORIGIN ?? ""), siteKey: process.env.PUBLIC_CACHE_SITE_KEY ?? "", secret: publicCacheSecret() ?? "" };
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(config.siteKey) || !/^[a-f0-9]{64}$/.test(config.secret)) throw Error("CACHE_CONTROL_CONFIG");
  return config;
}
export async function cacheOperatorConnection(role: "nb_cache_operator" | "nb_cache_publisher") {
  const url = process.env.PUBLIC_CACHE_OPERATOR_DATABASE_URL;
  if (!url) throw Error("CACHE_DATABASE_CONFIG");
  const pool = createDatabasePool(url, process.env.DATABASE_TLS, process.env.DATABASE_CA_CERT);
  pool.options.max = 1;
  try {
    const r = await pool.query("SELECT current_user AS role,session_user AS login,(rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication OR rolinherit OR EXISTS(SELECT FROM pg_auth_members WHERE member=pg_roles.oid)) AS elevated FROM pg_roles WHERE rolname=current_user");
    if (r.rows.length !== 1 || r.rows[0].role !== role || r.rows[0].login !== role || r.rows[0].elevated !== false) throw Error("CACHE_OPERATOR_ROLE");
    return { db: sqlExecutor(pool), close: () => pool.end(), url };
  } catch (error) { await pool.end(); throw error; }
}
/** The same six existing locks, acquired without stealing or waiting. No schedule is changed. */
export async function acquireWithdrawalLocks(): Promise<() => Promise<void>> {
  const files = process.env.PUBLIC_CACHE_SYNC_LOCK_PATHS_JSON, legacy = process.env.PUBLIC_CACHE_SYNC_LOCK_DIRECTORIES_JSON;
  if (files !== undefined && legacy !== undefined) throw Error("CACHE_SYNC_LOCK_CONFIG");
  const configured: unknown = JSON.parse(files ?? legacy ?? "null");
  if (!Array.isArray(configured) || configured.length !== 6 || configured.some(p => typeof p !== "string")) throw Error("CACHE_SYNC_LOCK_CONFIG");
  const paths: string[] = files === undefined ? configured.map(path => join(path, "worker.lock")) : configured;
  if (new Set(paths).size !== 6) throw Error("CACHE_SYNC_LOCK_CONFIG");
  // Validate the raw input before join can normalize a legacy directory's '..' components.
  for (const path of configured) if (!isAbsolute(path) || resolve(path) !== path) throw Error("CACHE_SYNC_LOCK_CONFIG");
  // A configured lock is a file, not a directory: preserve maintenance/manual/session names.
  await Promise.all(paths.map(async path => {
    if (!isAbsolute(path) || resolve(path) !== path) throw Error("CACHE_SYNC_LOCK_CONFIG");
    const parent = dirname(path), info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) ||
        (process.getuid && info.uid !== process.getuid()) || await realpath(parent) !== parent) throw Error("CACHE_SYNC_LOCK_CONFIG");
  }));
  const releases: (() => Promise<void>)[] = [];
  const releaseAll = async () => {
    let failed = false;
    for (const release of [...releases].reverse()) { try { await release(); } catch { failed = true; } }
    if (failed) throw Error("CACHE_SYNC_LOCK_RELEASE_FAILED");
  };
  try { for (const path of paths) releases.push(await acquireWithdrawalFileLock(path)); }
  catch (error) { await releaseAll(); throw error; }
  return releaseAll;
}

async function acquireWithdrawalFileLock(path: string): Promise<() => Promise<void>> {
  const bytes = JSON.stringify({ pid: process.pid, runId: randomUUID(), startedAt: new Date().toISOString() });
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  const inode = await handle.stat();
  const removeOwn = async (checkBytes: boolean) => {
    let current;
    try { current = await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (current.isSymbolicLink() || current.ino !== inode.ino || current.dev !== inode.dev ||
        (checkBytes && await readPrivateFile(path, 4096) !== bytes)) throw Error("CACHE_SYNC_LOCK_CHANGED");
    await unlink(path);
  };
  try { await handle.writeFile(bytes); await handle.sync(); }
  catch (error) { await removeOwn(false); throw error; }
  finally { await handle.close(); }
  return () => removeOwn(true);
}
