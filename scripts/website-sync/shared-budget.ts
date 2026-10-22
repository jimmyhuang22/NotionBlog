import { constants, openSync, closeSync, fstatSync, lstatSync, readFileSync, readSync, writeFileSync, fsyncSync, renameSync, unlinkSync, realpathSync, mkdirSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { createHash, randomUUID } from "node:crypto";

export class SharedBudgetError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = "SharedBudgetError"; this.code = code; }
}
export function budgetFail(code: string): never { throw new SharedBudgetError(code); }
export interface SharedLimits {
  notionRequests: number; storageRequests: number; authRequests: number; imageRequests: number; httpRequests: number;
  notionResponseBytes: number; storageResponseBytes: number; authResponseBytes: number; imageResponseBytes: number; uploadBodyBytes: number;
  sqlRequests: number; sqlRequestBytes: number; sqlResponseBytes: number;
  cleanupSqlRequests: number; cleanupSqlRequestBytes: number; cleanupSqlResponseBytes: number;
}
export interface SharedPlan { format: "qualified-shared-budget-v1"; parentPid: number; nonce: string; deadline: number;
  cleanupMs: number; runtimeSha256: string; storageOrigin: string; limits: SharedLimits }
const names: (keyof SharedLimits)[] = ["notionRequests", "storageRequests", "authRequests", "imageRequests", "httpRequests", "notionResponseBytes", "storageResponseBytes", "authResponseBytes",
  "imageResponseBytes", "uploadBodyBytes", "sqlRequests", "sqlRequestBytes", "sqlResponseBytes", "cleanupSqlRequests", "cleanupSqlRequestBytes", "cleanupSqlResponseBytes"];
const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function privateFile(path: string, maximum = 65536, atomicState = false) {
  for (let attempt = 0; attempt < (atomicState ? 3 : 1); attempt++) {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const s = fstatSync(fd);
      if (!s.isFile() || (s.mode & 0o777) !== 0o600 || s.uid !== process.getuid?.() || s.size > maximum) budgetFail("SHARED_BUDGET_INPUT_INVALID");
      // The other actor may atomically replace state.json between open and
      // fstat. Close that unlinked generation and reopen the current path.
      // Never accept zero-link bytes or relax immutable input/hardlink checks.
      if (atomicState && s.nlink === 0) continue;
      if (s.nlink !== 1) budgetFail("SHARED_BUDGET_INPUT_INVALID");
      return readFileSync(fd, "utf8");
    } finally { closeSync(fd); }
  }
  return budgetFail("SHARED_BUDGET_INPUT_INVALID");
}
function directory(path: string) {
  if (!isAbsolute(path) || realpathSync(path) !== path) budgetFail("SHARED_BUDGET_INPUT_INVALID");
  const s = lstatSync(path); if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o777) !== 0o700 || s.uid !== process.getuid?.()) budgetFail("SHARED_BUDGET_INPUT_INVALID");
}
export function validateSharedPlan(plan: SharedPlan) {
  if (!plan || Object.keys(plan).length !== 8 || plan.format !== "qualified-shared-budget-v1" || !Number.isSafeInteger(plan.parentPid) || plan.parentPid < 1 ||
    !/^[a-f0-9-]{36}$/.test(plan.nonce) || !/^[a-f0-9]{64}$/.test(plan.runtimeSha256) || !Number.isSafeInteger(plan.deadline) ||
    !Number.isInteger(plan.cleanupMs) || plan.cleanupMs < 0 || plan.cleanupMs > 20000 || !plan.limits || Object.keys(plan.limits).length !== names.length ||
    names.some(k => !Number.isSafeInteger(plan.limits[k]) || plan.limits[k] < 0 || plan.limits[k] > 16 * 1024 ** 3) ||
    plan.limits.httpRequests > 50000 || plan.limits.sqlRequests > 50000 || plan.limits.cleanupSqlRequests > 4 ||
    plan.limits.cleanupSqlRequestBytes > 65536 || plan.limits.cleanupSqlResponseBytes > 65536) budgetFail("SHARED_BUDGET_INPUT_INVALID");
  const url = new URL(plan.storageOrigin);
  if (url.protocol !== "https:" || url.origin !== plan.storageOrigin || url.origin === "https://api.notion.com") budgetFail("SHARED_BUDGET_INPUT_INVALID");
}
function atomic(path: string, value: unknown, dir: string) {
  const temp = join(dir, `.budget-${randomUUID()}`), fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, JSON.stringify(value) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameSync(temp, path); const parent = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY); try { fsyncSync(parent); } finally { closeSync(parent); } }
  finally { try { unlinkSync(temp); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; } }
}
export function initializeSharedBudget(path: string, plan: SharedPlan) {
  validateSharedPlan(plan); mkdirSync(path, { mode: 0o700 }); directory(path);
  atomic(join(path, "plan.json"), plan, path);
  const planDigest = sha(privateFile(join(path, "plan.json")));
  const counters = Object.fromEntries(names.map(k => [k, 0])) as unknown as SharedLimits;
  atomic(join(path, "state.json"), { format: "qualified-budget-state-v1", planDigest, revision: 0, failure: null, stoppedAt: null, counters }, path);
  return { directory: path, planDigest, nonce: plan.nonce, runtimeSha256: plan.runtimeSha256 };
}
export type BudgetBridge = ReturnType<typeof initializeSharedBudget>;

/** One durable ledger across parent/child. Exclusive short synchronous updates;
 * contention or uncertainty fails closed, no stealing / refund / retry. */
export function openSharedBudget(bridge: BudgetBridge) {
  directory(bridge.directory); const bytes = privateFile(join(bridge.directory, "plan.json"));
  if (sha(bytes) !== bridge.planDigest) budgetFail("SHARED_BUDGET_INPUT_INVALID");
  const plan = JSON.parse(bytes) as SharedPlan; validateSharedPlan(plan);
  if (plan.nonce !== bridge.nonce || plan.runtimeSha256 !== bridge.runtimeSha256 ||
    !(process.pid === plan.parentPid || process.ppid === plan.parentPid)) budgetFail("SHARED_BUDGET_ACTOR_INVALID");
  const statePath = join(bridge.directory, "state.json"), lockPath = join(bridge.directory, "ledger.lock"), stopPath = join(bridge.directory, "stop.json");
  function read() {
    const state = JSON.parse(privateFile(statePath, 65536, true)) as { format: string; planDigest: string; revision: number; failure: string | null; stoppedAt: number | null; counters: SharedLimits };
    if (Object.keys(state).length !== 6 || state.format !== "qualified-budget-state-v1" || state.planDigest !== bridge.planDigest ||
      !Number.isSafeInteger(state.revision) || state.revision < 0 || !(state.failure === null || /^SHARED_BUDGET_[A-Z_]+$/.test(state.failure)) ||
      !(state.stoppedAt === null ? state.failure === null : Number.isSafeInteger(state.stoppedAt) && state.stoppedAt >= 0 && state.failure !== null) ||
      Object.keys(state.counters).length !== names.length || names.some(k => !Number.isSafeInteger(state.counters[k]) || state.counters[k] < 0)) budgetFail("SHARED_BUDGET_STATE_INVALID");
    try {
      const stop = JSON.parse(privateFile(stopPath)) as { planDigest: string; code: string; at: number };
      if (Object.keys(stop).length !== 3 || stop.planDigest !== bridge.planDigest || !/^SHARED_BUDGET_[A-Z_]+$/.test(stop.code) || !Number.isSafeInteger(stop.at)) budgetFail("SHARED_BUDGET_STATE_INVALID");
      state.failure ??= stop.code; state.stoppedAt ??= Math.min(stop.at, plan.deadline);
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    return state;
  }
  function update(charges: Partial<SharedLimits>, cleanup = false, reason?: string, observed = false) {
    let fd: number;
    try { fd = openSync(lockPath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch { return budgetFail("SHARED_BUDGET_LOCK_BUSY"); }
    const marker = JSON.stringify({ pid: process.pid, nonce: randomUUID() }) + "\n", inode = fstatSync(fd);
    try {
      writeFileSync(fd, marker); fsyncSync(fd); const state = read();
      const now = Date.now(), expired = now >= plan.deadline;
      state.failure ??= reason ?? (expired ? "SHARED_BUDGET_DEADLINE" : null);
      if (state.failure) state.stoppedAt ??= Math.min(now, plan.deadline);
      if (!observed && (cleanup ? now >= Math.min(plan.deadline, state.stoppedAt ?? plan.deadline) + plan.cleanupMs : state.failure !== null)) {
        state.revision++; atomic(statePath, state, bridge.directory); budgetFail(state.failure ?? "SHARED_BUDGET_DEADLINE");
      }
      const entries = Object.entries(charges);
      for (const [key, n] of entries) {
        if (!names.includes(key as keyof SharedLimits) || !Number.isSafeInteger(n) || n! < 0 ||
          key.startsWith("cleanup") !== cleanup || (observed && !key.endsWith("Bytes"))) budgetFail("SHARED_BUDGET_INPUT_INVALID");
      }
      if (!observed && entries.some(([key, n]) => state.counters[key as keyof SharedLimits] + n! > plan.limits[key as keyof SharedLimits])) {
        state.failure ??= "SHARED_BUDGET_LIMIT"; state.stoppedAt ??= Math.min(now, plan.deadline);
        state.revision++; atomic(statePath, state, bridge.directory); budgetFail("SHARED_BUDGET_LIMIT");
      }
      for (const [key, n] of entries) {
        state.counters[key as keyof SharedLimits] += n!;
        if (!Number.isSafeInteger(state.counters[key as keyof SharedLimits]) || state.counters[key as keyof SharedLimits] > plan.limits[key as keyof SharedLimits]) state.failure ??= "SHARED_BUDGET_LIMIT";
      }
      if (state.failure) state.stoppedAt ??= Math.min(now, plan.deadline);
      state.revision++; atomic(statePath, state, bridge.directory);
      if (state.failure && !cleanup) budgetFail(state.failure);
      if (cleanup && names.some(k => k.startsWith("cleanup") && state.counters[k] > plan.limits[k])) budgetFail("SHARED_BUDGET_LIMIT");
    } finally {
      // Retain the original FD and marker: an old owner never unlinks a reused inode.
      try { const current = lstatSync(lockPath), content = Buffer.alloc(Buffer.byteLength(marker));
        const n = readSync(fd, content, 0, content.length, 0);
        if (!current.isSymbolicLink() && current.ino === inode.ino && current.dev === inode.dev && n === content.length && content.toString() === marker) unlinkSync(lockPath); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
      finally { closeSync(fd); }
    }
  }
  return { plan, bridge, read, charge: update,
    observe(charges: Partial<SharedLimits>, cleanup = false) { update(charges, cleanup, undefined, true); },
    guard() { const s = read(); if (s.failure) budgetFail(s.failure); if (Date.now() >= plan.deadline) update({}, false, "SHARED_BUDGET_DEADLINE"); },
    stop(code = "SHARED_BUDGET_CANCELLED") {
      if (!/^SHARED_BUDGET_[A-Z_]+$/.test(code)) budgetFail("SHARED_BUDGET_INPUT_INVALID");
      // An independent immutable stop marker also stops the other actor when
      // the short counter lock is busy. Never reset or replace another marker.
      let fd: number | undefined;
      try { fd = openSync(stopPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
      if (fd !== undefined) { try { writeFileSync(fd, JSON.stringify({ planDigest: bridge.planDigest, code, at: Date.now() })); fsyncSync(fd); } finally { closeSync(fd); }
        const parent = openSync(bridge.directory, constants.O_RDONLY | constants.O_DIRECTORY); try { fsyncSync(parent); } finally { closeSync(parent); } }
      update({}, false, code);
    } };
}
export type SharedBudget = ReturnType<typeof openSharedBudget>;
