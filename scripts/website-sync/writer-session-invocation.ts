import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";

type IO = typeof fs;
interface Binding { directory: string; runId: string; moduleSha256: string; runtimeSha256: string }
interface Identity { ino: bigint; dev: bigint }
const fail = (code: string): never => { throw new Error(code); };
const same = (a: Identity, b: Identity) => a.ino === b.ino && a.dev === b.dev;

/** One qualified-run invocation. No credential loader, helper import, retry or rollback.
 * The journal proves local intent/outcome only; it cannot undo remote rotation or
 * hard-cancel filesystem I/O. Callers retain their host/worker locks throughout. */
export function createWriterSessionInvocation(binding: Binding, invoke: () => Promise<void>,
  guard: () => void, io: IO = fs) {
  const b = structuredClone(binding);
  if (Object.keys(b).sort().join(",") !== "directory,moduleSha256,runId,runtimeSha256" ||
      typeof b.directory !== "string" || resolve(b.directory) !== b.directory || /[\0\r\n]/.test(b.directory) ||
      ![b.runId, b.moduleSha256, b.runtimeSha256].every(value => typeof value === "string") ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(b.runId) ||
      !/^[a-f0-9]{64}$/.test(b.moduleSha256) || !/^[a-f0-9]{64}$/.test(b.runtimeSha256) ||
      typeof invoke !== "function" || typeof guard !== "function") fail("WRITER_SESSION_BINDING_INVALID");
  let used = false;
  return async (): Promise<void> => {
    if (used) fail("WRITER_SESSION_ALREADY_ATTEMPTED");
    used = true; // Consume before any await, including a failed journal preparation.
    let directoryIdentity: Identity | undefined, intentAcknowledged = false, invoked = false;
    const nonce = randomUUID();
    async function directory(path: string) {
      const s = await io.lstat(path, { bigint: true });
      if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== BigInt(process.getuid!()) ||
          (s.mode & 511n) !== 448n || await io.realpath(path) !== path) fail("WRITER_SESSION_JOURNAL_INVALID");
      return s;
    }
    async function verifyDirectory() {
      const current = await directory(b.directory);
      if (!directoryIdentity || !same(current, directoryIdentity)) fail("WRITER_SESSION_JOURNAL_CHANGED");
    }
    async function record(name: "intent" | "terminal", outcome: string) {
      await verifyDirectory();
      const raw = Buffer.from(JSON.stringify({ format: "writer-session-invocation-v1", runId: b.runId,
        moduleSha256: b.moduleSha256, runtimeSha256: b.runtimeSha256, nonce, outcome }) + "\n");
      if (raw.length > 4096) fail("WRITER_SESSION_JOURNAL_LIMIT");
      const path = join(b.directory, name + "-private.json");
      const writer = await io.open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await writer.writeFile(raw); await writer.sync(); } finally { await writer.close(); }
      const parent = await io.open(b.directory, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { if (!directoryIdentity || !same(await parent.stat({ bigint: true }), directoryIdentity)) fail("WRITER_SESSION_JOURNAL_CHANGED"); await parent.sync(); }
      finally { await parent.close(); }
      const reader = await io.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const before = await reader.stat({ bigint: true });
        if (!before.isFile() || before.uid !== BigInt(process.getuid!()) || (before.mode & 511n) !== 384n ||
            before.nlink !== 1n || before.size !== BigInt(raw.length)) fail("WRITER_SESSION_JOURNAL_INVALID");
        const bytes = Buffer.alloc(raw.length); let offset = 0;
        while (offset < bytes.length) { const part = await reader.read(bytes, offset, bytes.length - offset, offset); if (!part.bytesRead) fail("WRITER_SESSION_JOURNAL_CHANGED"); offset += part.bytesRead; }
        const after = await reader.stat({ bigint: true }), entry = await io.lstat(path, { bigint: true });
        if (!same(before, after) || !same(before, entry) || entry.isSymbolicLink() || entry.nlink !== 1n ||
            entry.size !== before.size || entry.mtimeNs !== before.mtimeNs || entry.ctimeNs !== before.ctimeNs || after.size !== before.size ||
            after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs || !bytes.equals(raw)) fail("WRITER_SESSION_JOURNAL_CHANGED");
      } finally { await reader.close(); }
      await verifyDirectory();
    }
    try {
      guard();
      const parent = await directory(dirname(b.directory));
      await io.mkdir(b.directory, { mode: 0o700 }); // Existing/uncertain attempts are never adopted.
      if (!same(parent, await directory(dirname(b.directory)))) fail("WRITER_SESSION_JOURNAL_CHANGED");
      const parentHandle = await io.open(dirname(b.directory), constants.O_RDONLY | constants.O_NOFOLLOW);
      try { if (!same(parent, await parentHandle.stat({ bigint: true }))) fail("WRITER_SESSION_JOURNAL_CHANGED"); await parentHandle.sync(); }
      finally { await parentHandle.close(); }
      directoryIdentity = await directory(b.directory);
      await record("intent", "INVOCATION_INTENT"); intentAcknowledged = true;
      guard(); invoked = true;
      await invoke();
      guard();
    } catch {
      if (!intentAcknowledged) fail("WRITER_SESSION_PREPARATION_UNCERTAIN");
      try { await record("terminal", invoked ? "UNKNOWN" : "NOT_INVOKED"); } catch { /* Immutable intent remains authoritative; no retry. */ }
      fail(invoked ? "WRITER_SESSION_OUTCOME_UNKNOWN" : "WRITER_SESSION_NOT_INVOKED");
    }
    try { await record("terminal", "COMPLETED"); }
    catch { fail("WRITER_SESSION_TERMINAL_UNCERTAIN"); }
  };
}

interface SeriesBinding extends Binding { maximumInvocations: 1 | 2 | 3 }

/** Normal expiry rotations, each protected by the original one-attempt journal.
 * No failed/unknown invocation is retried; a restarted process cannot adopt the
 * series directory. This limit does not itself authorize any network request. */
export function createBoundedWriterSessionInvocations(binding: SeriesBinding, invoke: () => Promise<void>,
  guard: () => void, io: IO = fs) {
  const b = structuredClone(binding);
  if (Object.keys(b).sort().join(",") !== "directory,maximumInvocations,moduleSha256,runId,runtimeSha256" ||
      ![1, 2, 3].includes(b.maximumInvocations) || typeof b.maximumInvocations !== "number") fail("WRITER_SESSION_SERIES_BINDING_INVALID");
  const originalBinding = { directory: b.directory, runId: b.runId, moduleSha256: b.moduleSha256, runtimeSha256: b.runtimeSha256 };
  // Reuse the exact original identity/hash validator without performing I/O.
  createWriterSessionInvocation(originalBinding, invoke, guard, io);
  const raw = Buffer.from(JSON.stringify({ format: "writer-session-series-v1", ...originalBinding,
    maximumInvocations: b.maximumInvocations, failedInvocationRetry: false }) + "\n");
  let initialized = false, rootIdentity: Identity | undefined, busy = false, stopped = false, attempted = 0, completed = 0;
  async function directory(path: string) {
    const s = await io.lstat(path, { bigint: true });
    if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== BigInt(process.getuid!()) ||
        (s.mode & 511n) !== 448n || await io.realpath(path) !== path) fail("WRITER_SESSION_SERIES_DIRECTORY_INVALID");
    return s;
  }
  async function verifyRoot() {
    const current = await directory(b.directory);
    if (!rootIdentity || !same(current, rootIdentity)) fail("WRITER_SESSION_SERIES_CHANGED");
    const path = join(b.directory, "series-private.json");
    const h = await io.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await h.stat({ bigint: true });
      if (!before.isFile() || before.uid !== BigInt(process.getuid!()) || (before.mode & 511n) !== 384n ||
          before.nlink !== 1n || before.size !== BigInt(raw.length)) fail("WRITER_SESSION_SERIES_CHANGED");
      const bytes = await h.readFile();
      const after = await h.stat({ bigint: true }), entry = await io.lstat(path, { bigint: true });
      if (!same(before, after) || !same(before, entry) || entry.isSymbolicLink() || entry.nlink !== 1n ||
          after.size !== before.size || entry.size !== before.size || before.mtimeNs !== after.mtimeNs ||
          before.ctimeNs !== after.ctimeNs || before.mtimeNs !== entry.mtimeNs || before.ctimeNs !== entry.ctimeNs ||
          !bytes.equals(raw)) fail("WRITER_SESSION_SERIES_CHANGED");
    } finally { await h.close(); }
  }
  async function initialize() {
    const parent = await directory(dirname(b.directory));
    await io.mkdir(b.directory, { mode: 0o700 });
    if (!same(parent, await directory(dirname(b.directory)))) fail("WRITER_SESSION_SERIES_CHANGED");
    const d = await io.open(dirname(b.directory), constants.O_RDONLY | constants.O_NOFOLLOW);
    try { if (!same(parent, await d.stat({ bigint: true }))) fail("WRITER_SESSION_SERIES_CHANGED"); await d.sync(); }
    finally { await d.close(); }
    rootIdentity = await directory(b.directory);
    const h = await io.open(join(b.directory, "series-private.json"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await h.writeFile(raw); await h.sync(); } finally { await h.close(); }
    const root = await io.open(b.directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { if (!same(rootIdentity, await root.stat({ bigint: true }))) fail("WRITER_SESSION_SERIES_CHANGED"); await root.sync(); }
    finally { await root.close(); }
    await verifyRoot(); initialized = true;
  }
  const checkedGuard = () => { if (stopped) fail("WRITER_SESSION_SERIES_STOPPED"); guard(); };
  const refresh = async () => {
    if (stopped) fail("WRITER_SESSION_SERIES_STOPPED");
    if (busy) { stopped = true; fail("WRITER_SESSION_SERIES_CONCURRENT"); }
    if (attempted >= b.maximumInvocations) { stopped = true; fail("WRITER_SESSION_SERIES_LIMIT"); }
    busy = true;
    try {
      checkedGuard();
      if (!initialized) await initialize();
      await verifyRoot(); checkedGuard();
      const slot = ++attempted;
      await createWriterSessionInvocation({ ...originalBinding, directory: join(b.directory, "attempt-" + slot.toString().padStart(3, "0")) }, invoke, checkedGuard, io)();
      checkedGuard(); await verifyRoot(); completed++;
    } catch {
      stopped = true;
      // The original slot journal retains its exact local intent/outcome.
      // Never include helper exceptions or token/URL details in public errors.
      fail("WRITER_SESSION_SERIES_UNRESOLVED");
    } finally { busy = false; }
  };
  return Object.assign(refresh, { statistics: () => Object.freeze({ maximumInvocations: b.maximumInvocations, attempted, completed, pending: busy, stopped }) });
}
