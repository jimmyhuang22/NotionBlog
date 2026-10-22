import { constants, type Stats } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { ContentServiceError } from "../../contracts/repository.ts";
import type { MediaSourceVersion } from "../../src/server/media/notion-source.ts";
import { canonicalJson } from "../../src/server/database/validation.ts";
import { parseThumbnailPlan, type ThumbnailPlan } from "./plan.ts";

export interface ThumbnailBudgetLimits {
  maxParents: number;
  maxOriginalBytes: number;
  maxUploadRequests: number;
  maxUploadBodyBytes: number;
  maxDurationSeconds: number;
  maxTotalParentAttempts: number;
  maxTotalOriginalBytes: number;
  maxTotalUploadRequests: number;
  maxTotalUploadBodyBytes: number;
  maxTotalReservedDurationSeconds: number;
}
export interface ThumbnailExecutionBudget {
  format: "notionblog-thumbnail-execution-budget-v1";
  budgetId: string;
  version: MediaSourceVersion;
  runId: string;
  planSHA256: string[];
  limits: ThumbnailBudgetLimits;
}
export interface ThumbnailBudgetSnapshot {
  attemptCount: number;
  totalParentAttempts: number;
  totalOriginalBytes: number;
  totalUploadRequests: number;
  totalUploadBodyBytes: number;
  totalReservedDurationSeconds: number;
  attemptParentAttempts: number;
  attemptOriginalBytes: number;
  attemptUploadRequests: number;
  attemptUploadBodyBytes: number;
  attemptReservedDurationSeconds: number;
}
export interface ThumbnailBudgetGuard {
  readonly signal: AbortSignal;
  readonly deadlineSignal: AbortSignal;
  check(): void;
  reserveOriginal(byteSize: number): Promise<void>;
  reserveUpload(byteSize: number): Promise<void>;
  snapshot(): Readonly<ThumbnailBudgetSnapshot>;
  close(): Promise<void>;
}
interface Counters {
  parentAttempts: number;
  originalBytes: number;
  uploadRequests: number;
  uploadBodyBytes: number;
  reservedDurationSeconds: number;
}
interface Attempt extends Counters { attemptId: string; planSHA256: string }
interface Ledger {
  format: "notionblog-thumbnail-execution-ledger-v1";
  budgetId: string;
  budgetSHA256: string;
  version: MediaSourceVersion;
  runId: string;
  totals: Counters;
  attempts: Attempt[];
}
const LEDGER = "thumbnail-execution-ledger.json";
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const GIB = 1024 ** 3;
const COUNTERS = ["parentAttempts", "originalBytes", "uploadRequests", "uploadBodyBytes", "reservedDurationSeconds"] as const;
const MAXIMA: ThumbnailBudgetLimits = {
  maxParents: 20_000, maxOriginalBytes: GIB, maxUploadRequests: 40_000, maxUploadBodyBytes: 2 * GIB,
  maxDurationSeconds: 480, maxTotalParentAttempts: 20_000, maxTotalOriginalBytes: 64 * GIB,
  maxTotalUploadRequests: 40_000, maxTotalUploadBodyBytes: 64 * GIB, maxTotalReservedDurationSeconds: 86400,
};
// Cache reuse still needs a bounded attempt, but must not require image I/O.
const ZERO_ALLOWED = new Set([
  "maxOriginalBytes", "maxUploadRequests", "maxUploadBodyBytes",
  "maxTotalOriginalBytes", "maxTotalUploadRequests", "maxTotalUploadBodyBytes",
]);
function fail(): never {
  throw new ContentServiceError("CONTENT_UNAVAILABLE", "Thumbnail execution budget could not safely permit this attempt.");
}
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function uuid(value: unknown): value is string {
  return typeof value === "string" && value.length === 36 && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
}
function digest(value: unknown): value is string {
  return typeof value === "string" && value.length === 64 && /^[a-f0-9]{64}$/.test(value);
}
function hash(value: unknown): string { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }
export function thumbnailPlanDigest(plan: unknown): string {
  try { return hash(parseThumbnailPlan(plan)); } catch { return fail(); }
}
/** A budget selects permitted plan bytes; it grants no source or publication qualification. */
export function parseThumbnailExecutionBudget(value: unknown): ThumbnailExecutionBudget {
  try {
    if (!exact(value, ["format", "budgetId", "version", "runId", "planSHA256", "limits"]) ||
        value.format !== "notionblog-thumbnail-execution-budget-v1" || !uuid(value.budgetId) || !uuid(value.runId) ||
        (value.version !== "v1" && value.version !== "v2") || !Array.isArray(value.planSHA256) ||
        value.planSHA256.length < 1 || value.planSHA256.length > 20_000 ||
        !Array.from(value.planSHA256).every(digest) || new Set(value.planSHA256).size !== value.planSHA256.length ||
        !exact(value.limits, Object.keys(MAXIMA))) fail();
    for (const [key, maximum] of Object.entries(MAXIMA)) {
      const n = value.limits[key];
      if (!Number.isSafeInteger(n) || (n as number) < (ZERO_ALLOWED.has(key) ? 0 : 1) || (n as number) > maximum) fail();
    }
    return { format: "notionblog-thumbnail-execution-budget-v1", budgetId: value.budgetId, version: value.version,
      runId: value.runId, planSHA256: [...value.planSHA256], limits: { ...value.limits } as unknown as ThumbnailBudgetLimits };
  } catch { return fail(); }
}
function zero(): Counters { return { parentAttempts: 0, originalBytes: 0, uploadRequests: 0, uploadBodyBytes: 0, reservedDurationSeconds: 0 }; }
function limits(budget: ThumbnailExecutionBudget, total: boolean): Counters {
  const n = budget.limits;
  return total ? { parentAttempts: n.maxTotalParentAttempts, originalBytes: n.maxTotalOriginalBytes,
    uploadRequests: n.maxTotalUploadRequests, uploadBodyBytes: n.maxTotalUploadBodyBytes, reservedDurationSeconds: n.maxTotalReservedDurationSeconds } :
    { parentAttempts: n.maxParents, originalBytes: n.maxOriginalBytes, uploadRequests: n.maxUploadRequests,
      uploadBodyBytes: n.maxUploadBodyBytes, reservedDurationSeconds: n.maxDurationSeconds };
}
function validateCounters(value: unknown, maxima: Counters, extraKeys: string[] = []): asserts value is Counters {
  if (!exact(value, [...COUNTERS, ...extraKeys])) fail();
  for (const key of COUNTERS) if (!Number.isSafeInteger(value[key]) || (value[key] as number) < 0 || (value[key] as number) > maxima[key]) fail();
  if ((value.uploadRequests === 0 && value.uploadBodyBytes !== 0) ||
      (value.uploadBodyBytes as number) < (value.uploadRequests as number)) fail();
}
function parseLedger(value: unknown, budget: ThumbnailExecutionBudget): Ledger {
  if (!exact(value, ["format", "budgetId", "budgetSHA256", "version", "runId", "totals", "attempts"]) ||
      value.format !== "notionblog-thumbnail-execution-ledger-v1" || value.budgetId !== budget.budgetId ||
      value.budgetSHA256 !== hash(budget) || value.version !== budget.version || value.runId !== budget.runId ||
      !Array.isArray(value.attempts) || value.attempts.length > budget.limits.maxTotalParentAttempts) fail();
  validateCounters(value.totals, limits(budget, true));
  const sum = zero(), seen = new Set<string>();
  for (const a of value.attempts) {
    validateCounters(a, limits(budget, false), ["attemptId", "planSHA256"]);
    const entry = a as Attempt;
    if (!uuid(entry.attemptId) || seen.has(entry.attemptId) || !budget.planSHA256.includes(entry.planSHA256) ||
        entry.parentAttempts < 1 || entry.reservedDurationSeconds !== budget.limits.maxDurationSeconds) fail();
    seen.add(entry.attemptId);
    for (const key of COUNTERS) sum[key] += entry[key];
  }
  for (const key of COUNTERS) if (sum[key] !== value.totals[key]) fail();
  return structuredClone(value) as unknown as Ledger;
}
function privateFile(info: Stats): boolean {
  return info.isFile() && !info.isSymbolicLink() && (info.mode & 0o7777) === 0o600 && info.nlink === 1 &&
    (!process.getuid || info.uid === process.getuid());
}
function sameFile(a: Stats, b: Stats): boolean {
  return a.ino === b.ino && a.dev === b.dev && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
async function directory(path: string, previous?: Stats): Promise<Stats> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o7777) !== 0o700 ||
      (process.getuid && info.uid !== process.getuid()) || await realpath(path) !== path ||
      (previous && (previous.ino !== info.ino || previous.dev !== info.dev))) fail();
  return info;
}
async function readFile(path: string, maxBytes = MAX_FILE_BYTES): Promise<{ value: unknown; info: Stats }> {
  const before = await lstat(path);
  if (!privateFile(before) || before.size > maxBytes) fail();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const first = await handle.stat();
    if (!privateFile(first) || !sameFile(first, before)) fail();
    const chunks: Buffer[] = []; let bytes = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(65536, maxBytes + 1 - bytes));
      const read = await handle.read(chunk, 0, chunk.length, null);
      if (!read.bytesRead) break;
      bytes += read.bytesRead;
      if (bytes > maxBytes) fail(); chunks.push(chunk.subarray(0, read.bytesRead));
    }
    const last = await handle.stat(), current = await lstat(path);
    if (!privateFile(last) || !privateFile(current) || !sameFile(first, last) || !sameFile(last, current) || bytes !== last.size) fail();
    return { value: JSON.parse(Buffer.concat(chunks).toString("utf8")), info: last };
  } finally { await handle.close(); }
}
async function readBudget(path: string) {
  if (!isAbsolute(path) || resolve(path) !== path || path === join(dirname(path), LEDGER)) fail();
  const dir = dirname(path), info = await directory(dir);
  const file = await readFile(path, 2 * 1024 * 1024);
  return { budget: parseThumbnailExecutionBudget(file.value), dir, info };
}
async function syncDirectory(dir: string): Promise<void> {
  const handle = await open(dir, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function removeOwn(path: string, info: Stats): Promise<void> {
  try { const current = await lstat(path); if (current.ino === info.ino && current.dev === info.dev && !current.isSymbolicLink()) await unlink(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
/** Keep the creating descriptor alive: an unlinked lock inode cannot be recycled before release. */
async function acquireBudgetLock(dir: string, runId: string): Promise<() => Promise<void>> {
  const path = join(dir, "worker.lock");
  const handle = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let owned: Stats | undefined;
  const body = Buffer.from(JSON.stringify({ pid: process.pid, runId, startedAt: new Date().toISOString(), nonce: randomUUID() }));
  try {
    owned = await handle.stat();
    await handle.writeFile(body); await handle.sync();
  } catch (error) {
    try { if (owned) await removeOwn(path, owned); } finally { await handle.close(); }
    throw error;
  }
  const identity = owned;
  let closing: Promise<void> | undefined;
  return () => {
    closing ??= (async () => {
      try {
        const before = await lstat(path);
        if (!privateFile(before) || before.ino !== identity.ino || before.dev !== identity.dev || before.size !== body.length) return;
        const current = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const first = await current.stat();
          if (!privateFile(first) || !sameFile(before, first)) return;
          const bytes = Buffer.alloc(body.length + 1); let count = 0;
          while (count < bytes.length) {
            const read = await current.read(bytes, count, bytes.length - count, count);
            if (!read.bytesRead) break; count += read.bytesRead;
          }
          if (count !== body.length || !bytes.subarray(0, count).equals(body)) return;
          const after = await current.stat(), entry = await lstat(path);
          if (privateFile(after) && privateFile(entry) && sameFile(first, after) && sameFile(after, entry)) await removeOwn(path, identity);
        } finally { await current.close(); }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      finally { await handle.close(); }
    })();
    return closing;
  };
}
/** Explicit offline initialization only; an existing ledger is never reset or replaced. */
export async function initializeThumbnailBudgetLedger(budgetFile: string): Promise<{ status: "BUDGET_INITIALIZED" }> {
  let release: (() => Promise<void>) | undefined;
  try {
    const { budget, dir, info } = await readBudget(budgetFile);
    release = await acquireBudgetLock(dir, budget.budgetId);
    await directory(dir, info);
    if (hash((await readBudget(budgetFile)).budget) !== hash(budget)) fail();
    const path = join(dir, LEDGER);
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const owned = await handle.stat();
    try {
      const ledger: Ledger = { format: "notionblog-thumbnail-execution-ledger-v1", budgetId: budget.budgetId,
        budgetSHA256: hash(budget), version: budget.version, runId: budget.runId, totals: zero(), attempts: [] };
      try { await handle.writeFile(JSON.stringify(ledger) + "\n"); await handle.sync(); }
      finally { await handle.close(); }
      await syncDirectory(dir);
    } catch { await removeOwn(path, owned); fail(); }
    return { status: "BUDGET_INITIALIZED" };
  } catch { return fail(); }
  finally { if (release) { try { await release(); } catch { fail(); } } }
}

/** Holds the local budget lock. Every attempt and request is charged before any external side effect. */
export async function openThumbnailBudgetAttempt(budgetFile: string, input: ThumbnailPlan): Promise<ThumbnailBudgetGuard> {
  let release: (() => Promise<void>) | undefined;
  try {
    const started = performance.now();
    const plan = parseThumbnailPlan(input), planSHA256 = thumbnailPlanDigest(plan);
    const { budget, dir, info } = await readBudget(budgetFile);
    if (plan.version !== budget.version || plan.runId !== budget.runId || !budget.planSHA256.includes(planSHA256) ||
        plan.assetIds.length > budget.limits.maxParents) fail();
    release = await acquireBudgetLock(dir, budget.budgetId);
    await directory(dir, info);
    const budgetSHA256 = hash(budget), path = join(dir, LEDGER);
    if (hash((await readBudget(budgetFile)).budget) !== budgetSHA256) fail();
    const loaded = await readFile(path);
    let ledger = parseLedger(loaded.value, budget), ledgerInfo = loaded.info;
    const attempt: Attempt = { ...zero(), attemptId: randomUUID(), planSHA256,
      parentAttempts: plan.assetIds.length, reservedDurationSeconds: budget.limits.maxDurationSeconds };
    const attemptIndex = ledger.attempts.length;
    const controller = new AbortController(), deadlineController = new AbortController();
    const deadline = started + budget.limits.maxDurationSeconds * 1000;
    let failed = false, closed = false, closePromise: Promise<void> | undefined;
    const abort = (timedOut = false) => {
      failed = true;
      if (!controller.signal.aborted) controller.abort(timedOut ?
        new DOMException("Thumbnail execution deadline exceeded.", "TimeoutError") :
        new ContentServiceError("CONTENT_UNAVAILABLE", "Thumbnail execution budget stopped this attempt."));
    };
    const expire = () => {
      if (!deadlineController.signal.aborted) deadlineController.abort(new DOMException("Thumbnail execution deadline exceeded.", "TimeoutError"));
      abort(true);
    };
    const check = () => {
      if (!closed && performance.now() >= deadline) { expire(); fail(); }
      if (closed || failed) fail();
    };
    const persist = async (next: Ledger) => {
      parseLedger(next, budget);
      await directory(dir, info);
      if (hash((await readBudget(budgetFile)).budget) !== budgetSHA256) fail();
      const previous = await lstat(path);
      if (!privateFile(previous) || !sameFile(previous, ledgerInfo)) fail();
      const temp = join(dir, `.thumbnail-budget-${process.pid}-${randomUUID()}`);
      const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      const owned = await handle.stat();
      try {
        const bytes = Buffer.from(JSON.stringify(next) + "\n");
        if (bytes.length > MAX_FILE_BYTES) fail();
        let written: Stats;
        try { await handle.writeFile(bytes); await handle.sync(); written = await handle.stat(); }
        finally { await handle.close(); }
        await directory(dir, info);
        const current = await lstat(path);
        if (!privateFile(current) || !sameFile(current, ledgerInfo)) fail();
        await rename(temp, path);
        await syncDirectory(dir);
        const saved = await lstat(path);
        if (!privateFile(saved) || saved.ino !== written.ino || saved.dev !== written.dev || saved.size !== written.size) fail();
        ledger = next; ledgerInfo = saved;
      } finally { await removeOwn(temp, owned); }
    };
    const begun = structuredClone(ledger); begun.attempts.push(attempt);
    begun.totals.parentAttempts += attempt.parentAttempts;
    begun.totals.reservedDurationSeconds += attempt.reservedDurationSeconds;
    await persist(begun);
    check();
    const timer = setTimeout(expire, Math.max(1, deadline - performance.now()));
    let tail: Promise<void> = Promise.resolve();
    const reserve = (bytes: number, upload: boolean): Promise<void> => {
      const task = tail.then(async () => {
        check();
        if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > (upload ? 2 * GIB : GIB)) fail();
        const next = structuredClone(ledger), a = next.attempts[attemptIndex];
        if (upload) { a.uploadRequests++; a.uploadBodyBytes += bytes; next.totals.uploadRequests++; next.totals.uploadBodyBytes += bytes; }
        else { a.originalBytes += bytes; next.totals.originalBytes += bytes; }
        await persist(next);
        check();
      }).catch(() => { abort(); return fail(); });
      tail = task.catch(() => {});
      return task;
    };
    const ownedRelease = release; release = undefined;
    return {
      signal: controller.signal, deadlineSignal: deadlineController.signal, check,
      reserveOriginal: bytes => reserve(bytes, false), reserveUpload: bytes => reserve(bytes, true),
      snapshot: () => {
        const a = ledger.attempts[attemptIndex], t = ledger.totals;
        return Object.freeze({ attemptCount: ledger.attempts.length, totalParentAttempts: t.parentAttempts,
          totalOriginalBytes: t.originalBytes, totalUploadRequests: t.uploadRequests, totalUploadBodyBytes: t.uploadBodyBytes,
          totalReservedDurationSeconds: t.reservedDurationSeconds, attemptParentAttempts: a.parentAttempts,
          attemptOriginalBytes: a.originalBytes, attemptUploadRequests: a.uploadRequests, attemptUploadBodyBytes: a.uploadBodyBytes,
          attemptReservedDurationSeconds: a.reservedDurationSeconds });
      },
      close: () => {
        if (!closePromise) {
          closed = true; abort();
          closePromise = tail.then(ownedRelease).catch(() => fail()).finally(() => {
            if (performance.now() >= deadline) expire();
            clearTimeout(timer);
          });
        }
        return closePromise;
      },
    };
  } catch { return fail(); }
  finally { if (release) { try { await release(); } catch { fail(); } } }
}
