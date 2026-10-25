import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const FORMAT = "legacy-lock-diagnostics-v1" as const;
const NAMES = ["worker.lock", "manual-run.lock"] as const;
const LIMIT = 8192;
type Name = typeof NAMES[number];
type DirectoryState = "verified" | "missing" | "unsafe" | "changed" | "unavailable";
type Status = "missing" | "empty" | "malformed" | "invalid-owner" | "recognized-owner" | "unknown-owner" |
  "unsafe" | "changed" | "unavailable" | "oversized";
type OwnerFormat = "none" | "unknown" | "pid-only" | "pid-started-at" | "worker-v1" | "private-host-v2";
type Presence = "not-checked" | "present-identity-unverified" | "absent" | "unknown";
export interface LegacyLockDiagnostic {
  name: Name; status: Status; ownerFormat: OwnerFormat; processPresence: Presence; reviewRequired: boolean;
}
export interface LegacyLockReport {
  format: typeof FORMAT; directoryState: DirectoryState; locks: LegacyLockDiagnostic[];
  reviewRequired: boolean; automaticUnlockAllowed: false;
}
interface Snapshot { report: LegacyLockDiagnostic; metadata?: BigIntStats; pid?: number }
class InputError extends Error {
  readonly code = "INVALID_ARGUMENTS";
  constructor() { super("INVALID_ARGUMENTS"); }
}
class SnapshotError extends Error {
  readonly status: "unsafe" | "changed" | "unavailable";
  constructor(status: SnapshotError["status"]) { super(status); this.status = status; }
}
const errorCode = (error: unknown) => error && typeof error === "object" && "code" in error ? error.code : undefined;
const diagnostic = (name: Name, status: Status, ownerFormat: OwnerFormat = "none"): LegacyLockDiagnostic =>
  ({ name, status, ownerFormat, processPresence: "not-checked", reviewRequired: status !== "missing" });
function report(state: DirectoryState, locks = NAMES.map(name => diagnostic(name, state === "verified" ? "missing" : state))) : LegacyLockReport {
  const reviewRequired = state !== "verified" || locks.some(lock => lock.reviewRequired);
  if (state !== "verified") locks = locks.map(lock => ({ ...lock, reviewRequired: true }));
  return { format: FORMAT, directoryState: state, locks, reviewRequired, automaticUnlockAllowed: false };
}
function same(a: BigIntStats, b: BigIntStats) {
  // Reading may update atime. It is deliberately not an identity comparison.
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid &&
    a.nlink === b.nlink && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
function privateOwner(info: BigIntStats) {
  return typeof process.getuid === "function" && info.uid === BigInt(process.getuid()) && (info.mode & 0o077n) === 0n && !info.isSymbolicLink();
}
async function verifyDirectory(directory: string, before: BigIntStats) {
  try {
    const after = await lstat(directory, { bigint: true });
    if (!after.isDirectory() || !privateOwner(after) || !same(before, after) || await realpath(directory) !== directory ||
        !same(after, await lstat(directory, { bigint: true }))) throw new SnapshotError("changed");
  } catch (error) {
    if (error instanceof SnapshotError) throw error;
    throw new SnapshotError(["ENOENT", "ENOTDIR", "ELOOP"].includes(String(errorCode(error))) ? "changed" : "unavailable");
  }
}
const identifier = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(value);
function isoDate(value: unknown) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function classify(name: Name, bytes: Buffer): { report: LegacyLockDiagnostic; pid?: number } {
  if (!bytes.length) return { report: diagnostic(name, "empty") };
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { return { report: diagnostic(name, "malformed") }; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { report: diagnostic(name, "invalid-owner", "unknown") };
  const owner = value as Record<string, unknown>, pid = owner.pid;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 1 || pid > 2147483647 ||
      ("runId" in owner && !identifier(owner.runId)) || ("nonce" in owner && !identifier(owner.nonce)) ||
      ("startedAt" in owner && !isoDate(owner.startedAt)) || ("adapter" in owner && !identifier(owner.adapter))) {
    return { report: diagnostic(name, "invalid-owner", "unknown") };
  }
  const keys = Object.keys(owner), shape = (required: string[], optional: string[] = []) =>
    required.every(key => Object.hasOwn(owner, key)) && keys.every(key => required.includes(key) || optional.includes(key));
  let format: OwnerFormat = "unknown";
  if (name === "worker.lock" && shape(["pid"])) format = "pid-only";
  else if (shape(["pid", "runId", "startedAt"], name === "worker.lock" ? ["nonce"] : [])) format = "worker-v1";
  else if (name === "manual-run.lock" && shape(["pid", "startedAt"])) format = "pid-started-at";
  else if (name === "manual-run.lock" && shape(["pid", "runId", "adapter"]) && owner.adapter === "private-host-v2") format = "private-host-v2";
  // Format names describe bytes only: a withdrawal operation can also write the
  // worker-v1 shape at a manual filename. No format proves the business owner.
  return format === "unknown" ? { report: diagnostic(name, "unknown-owner", "unknown") } :
    { report: diagnostic(name, "recognized-owner", format), pid };
}
async function readLock(directory: string, name: Name): Promise<Snapshot> {
  const path = join(directory, name);
  let metadata: BigIntStats | undefined;
  try {
    metadata = await lstat(path, { bigint: true });
    if (!metadata.isFile() || !privateOwner(metadata)) return { report: diagnostic(name, "unsafe"), metadata };
    if (metadata.size > BigInt(LIMIT)) return { report: diagnostic(name, "oversized"), metadata };
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = await handle.stat({ bigint: true });
      if (!same(metadata, opened)) throw new SnapshotError("changed");
      if (!opened.isFile() || !privateOwner(opened)) throw new SnapshotError("unsafe");
      const bytes = Buffer.alloc(LIMIT + 1); let size = 0;
      while (size < bytes.length) {
        const result = await handle.read(bytes, size, bytes.length - size, size);
        if (!result.bytesRead) break;
        size += result.bytesRead;
      }
      const after = await handle.stat({ bigint: true }), entry = await lstat(path, { bigint: true });
      if (!same(opened, after) || !same(after, entry)) throw new SnapshotError("changed");
      if (size > LIMIT) return { report: diagnostic(name, "oversized"), metadata };
      if (BigInt(size) !== after.size) throw new SnapshotError("changed");
      return { ...classify(name, bytes.subarray(0, size)), metadata };
    } finally { await handle.close(); }
  } catch (error) {
    const status = error instanceof SnapshotError ? error.status : errorCode(error) === "ENOENT" ? metadata ? "changed" : "missing" :
      errorCode(error) === "ELOOP" ? "changed" : "unavailable";
    return { report: diagnostic(name, status), metadata };
  }
}
async function recheck(directory: string, snapshot: Snapshot): Promise<void> {
  try {
    const current = await lstat(join(directory, snapshot.report.name), { bigint: true });
    if (!snapshot.metadata || !same(snapshot.metadata, current)) snapshot.report = diagnostic(snapshot.report.name, "changed");
  } catch (error) {
    if (errorCode(error) !== "ENOENT" || snapshot.metadata) snapshot.report = diagnostic(snapshot.report.name, errorCode(error) === "ENOENT" ? "changed" : "unavailable");
  }
}

/** An anonymous, read-only snapshot, never permission to unlock or resume work. */
export async function inspectLegacyLocks(directory: string): Promise<LegacyLockReport> {
  if (typeof directory !== "string" || !isAbsolute(directory) || directory.includes("\0")) throw new InputError();
  if (resolve(directory) !== directory) return report("unsafe");
  let before: BigIntStats, found = false;
  try {
    before = await lstat(directory, { bigint: true });
    found = true;
    if (!before.isDirectory() || !privateOwner(before) || await realpath(directory) !== directory) return report("unsafe");
  } catch (error) {
    const code = errorCode(error);
    return report(found && ["ENOENT", "ENOTDIR", "ELOOP"].includes(String(code)) ? "changed" : code === "ENOENT" ? "missing" : "unavailable");
  }
  try {
    await verifyDirectory(directory, before);
    const snapshots: Snapshot[] = [];
    for (const name of NAMES) {
      snapshots.push(await readLock(directory, name));
      await verifyDirectory(directory, before);
    }
    for (const snapshot of snapshots) await recheck(directory, snapshot);
    await verifyDirectory(directory, before);
    for (const snapshot of snapshots) {
      if (snapshot.report.status !== "recognized-owner" || snapshot.pid === undefined) continue;
      try { process.kill(snapshot.pid, 0); snapshot.report.processPresence = "present-identity-unverified"; }
      catch (error) { snapshot.report.processPresence = errorCode(error) === "ESRCH" ? "absent" : "unknown"; }
    }
    // Check again after presence observations. Existing-file edits need their
    // own metadata check; they do not necessarily alter directory timestamps.
    for (const snapshot of snapshots) await recheck(directory, snapshot);
    await verifyDirectory(directory, before);
    return report("verified", snapshots.map(snapshot => snapshot.report));
  } catch (error) { return report(error instanceof SnapshotError ? error.status : "unavailable"); }
}

async function main(args: string[]): Promise<number> {
  if (args.length === 1 && args[0] === "--help") {
    console.log("Usage: node scripts/notion-sync/lock-diagnostics.ts --directory ABSOLUTE_PATH\nRead-only diagnostics; no unlock, recovery or business-health proof."); return 0;
  }
  try {
    if (args.length !== 2 || args[0] !== "--directory") throw new InputError();
    const result = await inspectLegacyLocks(args[1]); console.log(JSON.stringify(result)); return result.reviewRequired ? 2 : 0;
  } catch (error) {
    console.log(JSON.stringify({ format: FORMAT, error: error instanceof InputError ? "INVALID_ARGUMENTS" : "DIAGNOSTICS_UNAVAILABLE" })); return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
