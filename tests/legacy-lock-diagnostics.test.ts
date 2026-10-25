import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { constants } from "node:fs";
import { promisify } from "node:util";
import { mkdtemp, realpath, rm, mkdir, writeFile, readFile, readdir, lstat, readlink, symlink, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inspectLegacyLocks } from "../scripts/notion-sync/lock-diagnostics.ts";

const execute = promisify(execFile);
const sourceUrl = new URL("../scripts/notion-sync/lock-diagnostics.ts", import.meta.url).href;
const cli = fileURLToPath(new URL("../scripts/notion-sync/lock-diagnostics.ts", import.meta.url));
const guard = fileURLToPath(new URL("../scripts/development/offline-network.cjs", import.meta.url));
const childEnv = () => ({ PATH: process.env.PATH, NOTIONBLOG_DEVELOPMENT_MODE: "offline", NODE_OPTIONS: `--require=${guard}` });
const instant = "2026-01-02T03:04:05.000Z";
const lock = (name: "worker.lock" | "manual-run.lock", status: string, reviewRequired: boolean, ownerFormat = "none", processPresence = "not-checked") =>
  ({ name, status, ownerFormat, processPresence, reviewRequired });

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "legacy-lock-test-")));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}
async function syntheticProcess(t: TestContext) {
  const child = spawn(process.execPath, ["-e", "process.send('ready');process.on('message',()=>process.exit(0));setInterval(()=>{},1000)"],
    { env: childEnv(), stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const closed = new Promise<void>(resolve => { child.once("close", () => resolve()); });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await closed; });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("Synthetic PID readiness deadline")), 10000);
    child.once("message", () => { clearTimeout(timer); resolve(); });
    child.once("error", error => { clearTimeout(timer); reject(error); });
  });
  assert.ok(child.pid);
  return { pid: child.pid, stop: async () => { child.send("stop"); await closed; } };
}
async function snapshot(directory: string) {
  const meta = async (path: string) => {
    const value = await lstat(path, { bigint: true });
    // Ordinary reads can update atime. These are the ownership/content identities.
    return { dev: value.dev, ino: value.ino, mode: value.mode, uid: value.uid, mtime: value.mtimeNs, ctime: value.ctimeNs, size: value.size };
  };
  const entries = await Promise.all((await readdir(directory)).sort().map(async name => {
    const path = join(directory, name), info = await lstat(path);
    return { name, meta: await meta(path), bytes: info.isFile() ? await readFile(path) : null, link: info.isSymbolicLink() ? await readlink(path) : null };
  }));
  return { directory: await meta(directory), entries };
}
async function unchanged(directory: string) {
  const before = await snapshot(directory), report = await inspectLegacyLocks(directory);
  assert.deepEqual(await snapshot(directory), before); return report;
}
function anonymous(report: unknown, values: (string | number)[]) {
  const output = JSON.stringify(report);
  for (const value of values) assert.equal(output.includes(String(value)), false);
  assert.equal(/"(?:pid|path|directory|runId|nonce|startedAt|payload)"\s*:/.test(output), false);
}

/** Only test-owned processes and explicit temporary paths are ever inspected. */
test("missing directories are not created and an empty private directory has a fixed anonymous report", async t => {
  const root = await fixture(t), missing = join(root, "never-created");
  assert.deepEqual(await inspectLegacyLocks(missing), { format: "legacy-lock-diagnostics-v1", directoryState: "missing",
    locks: [lock("worker.lock", "missing", true), lock("manual-run.lock", "missing", true)], reviewRequired: true, automaticUnlockAllowed: false });
  await assert.rejects(lstat(missing), { code: "ENOENT" });
  assert.deepEqual(await unchanged(root), { format: "legacy-lock-diagnostics-v1", directoryState: "verified",
    locks: [lock("worker.lock", "missing", false), lock("manual-run.lock", "missing", false)], reviewRequired: false, automaticUnlockAllowed: false });
});

test("recognized historical owners remain review-only, including worker pid-only and optional full nonce", async t => {
  const root = await fixture(t), child = await syntheticProcess(t), worker = join(root, "worker.lock"), manual = join(root, "manual-run.lock");
  const marker = "synthetic-private-owner-marker";
  for (const [name, owner, format] of [
    ["worker.lock", { pid: child.pid }, "pid-only"],
    ["worker.lock", { pid: child.pid, runId: marker, startedAt: instant }, "worker-v1"],
    ["worker.lock", { pid: child.pid, runId: marker, startedAt: instant, nonce: "synthetic-private-nonce" }, "worker-v1"],
    ["manual-run.lock", { pid: child.pid, startedAt: instant }, "pid-started-at"],
    ["manual-run.lock", { pid: child.pid, runId: marker, startedAt: instant }, "worker-v1"],
    ["manual-run.lock", { pid: child.pid, runId: marker, adapter: "private-host-v2" }, "private-host-v2"],
  ] as const) {
    await writeFile(name === "worker.lock" ? worker : manual, JSON.stringify(owner), { mode: 0o600 });
    const report = await unchanged(root), found = report.locks.find(entry => entry.name === name)!;
    assert.deepEqual(found, lock(name, "recognized-owner", true, format, "present-identity-unverified"));
    assert.equal(report.reviewRequired, true); assert.equal(report.automaticUnlockAllowed, false);
    anonymous(report, [root, child.pid, marker, "synthetic-private-nonce", instant]);
    await rm(name === "worker.lock" ? worker : manual);
  }
  await writeFile(worker, JSON.stringify({ pid: child.pid }), { mode: 0o600 });
  await child.stop();
  const absent = await unchanged(root);
  assert.deepEqual(absent.locks[0], lock("worker.lock", "recognized-owner", true, "pid-only", "absent"));
  assert.equal(absent.automaticUnlockAllowed, false);
});

test("empty, malformed, invalid and unknown owners are distinct and never rewritten", async t => {
  const root = await fixture(t), child = await syntheticProcess(t), path = join(root, "worker.lock"), marker = "synthetic-private-payload";
  for (const [bytes, status, format] of [
    ["", "empty", "none"],
    ['{"payload":"' + marker + '",', "malformed", "none"],
    ["null", "invalid-owner", "unknown"],
    ["[]", "invalid-owner", "unknown"],
    [JSON.stringify({ pid: "123" }), "invalid-owner", "unknown"],
    [JSON.stringify({ pid: 0 }), "invalid-owner", "unknown"],
    [JSON.stringify({ pid: 2147483648 }), "invalid-owner", "unknown"],
    [JSON.stringify({ pid: child.pid, runId: "", startedAt: instant }), "invalid-owner", "unknown"],
    [JSON.stringify({ pid: child.pid, runId: "fixture", startedAt: "2026-02-30T00:00:00.000Z" }), "invalid-owner", "unknown"],
    [JSON.stringify({ pid: child.pid, nonce: "fixture" }), "unknown-owner", "unknown"],
    [JSON.stringify({ pid: child.pid, extra: marker }), "unknown-owner", "unknown"],
  ]) {
    await writeFile(path, bytes, { mode: 0o600 }); const report = await unchanged(root);
    assert.deepEqual(report.locks[0], lock("worker.lock", status, true, format)); anonymous(report, [root, child.pid, marker]);
  }
  await rm(path);
  for (const owner of [{ pid: child.pid }, { pid: child.pid, startedAt: instant, nonce: "fixture" }, { pid: child.pid, runId: "fixture", adapter: "private-host-v2", startedAt: instant }]) {
    await writeFile(join(root, "manual-run.lock"), JSON.stringify(owner), { mode: 0o600 });
    assert.deepEqual((await unchanged(root)).locks[1], lock("manual-run.lock", "unknown-owner", true, "unknown"));
  }
});

test("unsafe directories, symlinks, nonregular files and modes never become readable lock owners", async t => {
  const root = await fixture(t), target = join(root, "target"), directory = join(root, "locks"), link = join(root, "linked-directory");
  await mkdir(directory, { mode: 0o700 }); await writeFile(target, "synthetic-private-target", { mode: 0o600 });
  await symlink(directory, link); assert.equal((await inspectLegacyLocks(link)).directoryState, "unsafe");
  await chmod(directory, 0o755); assert.equal((await inspectLegacyLocks(directory)).directoryState, "unsafe"); await chmod(directory, 0o700);
  const path = join(directory, "worker.lock"); await symlink(target, path);
  assert.deepEqual((await unchanged(directory)).locks[0], lock("worker.lock", "unsafe", true));
  assert.equal(await readFile(target, "utf8"), "synthetic-private-target"); await rm(path);
  await mkdir(path, { mode: 0o700 }); assert.equal((await unchanged(directory)).locks[0].status, "unsafe"); await rm(path, { recursive: true });
  await writeFile(path, "{}", { mode: 0o644 }); assert.equal((await unchanged(directory)).locks[0].status, "unsafe"); await rm(path);
  await execute("mkfifo", ["-m", "600", path]);
  assert.deepEqual((await unchanged(directory)).locks[0], lock("worker.lock", "unsafe", true));
});

test("the 8192-byte boundary is accepted while byte 8193 rejects without exposing or changing content", async t => {
  const root = await fixture(t), child = await syntheticProcess(t), path = join(root, "worker.lock"), json = JSON.stringify({ pid: child.pid });
  await writeFile(path, json + " ".repeat(8192 - Buffer.byteLength(json)), { mode: 0o600 });
  assert.deepEqual((await unchanged(root)).locks[0], lock("worker.lock", "recognized-owner", true, "pid-only", "present-identity-unverified"));
  await writeFile(path, json + " ".repeat(8193 - Buffer.byteLength(json)), { mode: 0o600 });
  assert.deepEqual((await unchanged(root)).locks[0], lock("worker.lock", "oversized", true));
});

async function runChild(args: string[], options: { preload?: string } = {}) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [...(options.preload ? ["--import", pathToFileURL(options.preload).href] : []), ...args], { env: childEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
    child.stdout.setEncoding("utf8").on("data", value => { stdout += value; }); child.stderr.setEncoding("utf8").on("data", value => { stderr += value; });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}

/** Child-only module loader seams retain native FS. They never add an injectable
 * capability to the production inspector and never touch an actual runtime. */
async function fsPreload(root: string, wrapper: string, setup = "") {
  const fake = join(root, "fs-wrapper.mjs"), preload = join(root, "preload.mjs");
  await writeFile(fake, wrapper, { mode: 0o600 });
  await writeFile(preload, `import {registerHooks} from 'node:module';${setup}\nregisterHooks({resolve(s,c,next){if(s==='node:fs/promises'&&c.parentURL===${JSON.stringify(sourceUrl)})return {url:${JSON.stringify(pathToFileURL(fake).href)},shortCircuit:true};return next(s,c);}});`, { mode: 0o600 });
  return preload;
}

test("EPERM stays unknown and unknown lock combinations never query a PID", async t => {
  const root = await fixture(t), locks = join(root, "locks"), driver = join(root, "inspect-child.mjs"); await mkdir(locks, { mode: 0o700 });
  await writeFile(driver, `let calls=0;process.kill=(_pid,signal)=>{if(signal!==0)throw Error('unexpected signal');calls++;throw Object.assign(Error('synthetic-private-error'),{code:'EPERM'});};const {inspectLegacyLocks}=await import(${JSON.stringify(sourceUrl)});console.log(JSON.stringify({report:await inspectLegacyLocks(${JSON.stringify(locks)}),calls}));`, { mode: 0o600 });
  await writeFile(join(locks, "worker.lock"), JSON.stringify({ pid: process.pid }), { mode: 0o600 });
  let child = await runChild([driver]); assert.equal(child.code, 0); assert.equal(child.signal, null);
  let result = JSON.parse(child.stdout); assert.equal(result.calls, 1); assert.deepEqual(result.report.locks[0], lock("worker.lock", "recognized-owner", true, "pid-only", "unknown"));
  anonymous(result.report, [root, process.pid, "synthetic-private-error"]);
  await writeFile(join(locks, "worker.lock"), JSON.stringify({ pid: process.pid, nonce: "fixture" }), { mode: 0o600 });
  await writeFile(join(locks, "manual-run.lock"), JSON.stringify({ pid: process.pid }), { mode: 0o600 });
  child = await runChild([driver]); assert.equal(child.code, 0); result = JSON.parse(child.stdout); assert.equal(result.calls, 0);
  assert.ok(result.report.locks.every((entry: { status: string; processPresence: string }) => entry.status === "unknown-owner" && entry.processPresence === "not-checked"));
  await writeFile(join(locks, "worker.lock"), JSON.stringify({ pid: process.pid }), { mode: 0o600 });
  const beforeUid = await snapshot(locks);
  const wrongUid = await fsPreload(root, `export * from 'node:fs/promises';import * as fs from 'node:fs/promises';export async function lstat(path,options){const info=await fs.lstat(path,options);if(path!==${JSON.stringify(join(locks, "worker.lock"))})return info;return new Proxy(info,{get(target,key){if(key==='uid')return target.uid+1n;const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});}`);
  child = await runChild([driver], { preload: wrongUid }); assert.equal(child.code, 0); assert.equal(child.signal, null);
  result = JSON.parse(child.stdout); assert.equal(result.calls, 0); assert.deepEqual(result.report.locks[0], lock("worker.lock", "unsafe", true));
  assert.deepEqual(await snapshot(locks), beforeUid);
});

test("concurrent writes and a FIFO replacement between lstat and open stop before any PID check", async t => {
  const root = await fixture(t), locks = join(root, "locks"), driver = join(root, "inspect-child.mjs"); await mkdir(locks, { mode: 0o700 });
  const path = join(locks, "worker.lock"), bytes = JSON.stringify({ pid: process.pid }); await writeFile(path, bytes, { mode: 0o600 });
  const preload = await fsPreload(root, `export * from 'node:fs/promises';import * as fs from 'node:fs/promises';let changed=false;export async function open(path,flags,...args){globalThis.__fixtureOpenFlags=flags;const handle=await fs.open(path,flags,...args);if(path!==${JSON.stringify(path)})return handle;return new Proxy(handle,{get(target,key){if(key==='read')return async(...values)=>{globalThis.__fixtureReadMaximum=Math.max(globalThis.__fixtureReadMaximum??0,values[2]);const result=await target.read(...values);if(!changed){changed=true;await fs.appendFile(path,' ');}return result;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});}`);
  await writeFile(driver, `let calls=0;process.kill=()=>{calls++;throw Error('PID check after changed snapshot');};const {inspectLegacyLocks}=await import(${JSON.stringify(sourceUrl)});console.log(JSON.stringify({report:await inspectLegacyLocks(${JSON.stringify(locks)}),calls,flags:globalThis.__fixtureOpenFlags,readMaximum:globalThis.__fixtureReadMaximum}));`, { mode: 0o600 });
  const child = await runChild([driver], { preload }); assert.equal(child.code, 0); assert.equal(child.signal, null);
  const result = JSON.parse(child.stdout); assert.equal(result.calls, 0); assert.deepEqual(result.report.locks[0], lock("worker.lock", "changed", true));
  assert.equal(await readFile(path, "utf8"), bytes + " ");
  assert.equal(result.flags & constants.O_NOFOLLOW, constants.O_NOFOLLOW);
  assert.equal(result.flags & constants.O_NONBLOCK, constants.O_NONBLOCK);
  assert.ok(result.readMaximum > 0 && result.readMaximum <= 8193);
  // Replace only this fixture after the inspector's initial lstat. A missing
  // NONBLOCK would hang open until the child-only watchdog rejects the test.
  await writeFile(path, bytes, { mode: 0o600 });
  const fifoPreload = await fsPreload(root, `export * from 'node:fs/promises';import * as fs from 'node:fs/promises';import {execFileSync} from 'node:child_process';let swapped=false;export async function open(path,flags,...args){globalThis.__fixtureOpenFlags=flags;if(path===${JSON.stringify(path)}&&!swapped){swapped=true;await fs.unlink(path);execFileSync('mkfifo',['-m','600',path]);}return fs.open(path,flags,...args);}`);
  const fifoChild = await runChild([driver], { preload: fifoPreload });
  assert.equal(fifoChild.code, 0); assert.equal(fifoChild.signal, null);
  const fifo = JSON.parse(fifoChild.stdout); assert.equal(fifo.calls, 0);
  assert.ok(["changed", "unsafe"].includes(fifo.report.locks[0].status));
  assert.equal(fifo.flags & constants.O_NONBLOCK, constants.O_NONBLOCK);
  assert.equal((await lstat(path)).isFIFO(), true);
});

test("the explicit CLI has fixed exits; help and rejected arguments perform no diagnostic filesystem calls", async t => {
  const root = await fixture(t), empty = join(root, "empty"), occupied = join(root, "occupied");
  await mkdir(empty, { mode: 0o700 }); await mkdir(occupied, { mode: 0o700 }); await writeFile(join(occupied, "worker.lock"), "", { mode: 0o600 });
  const safe = await runChild([cli, "--directory", empty]); assert.equal(safe.code, 0); assert.equal(safe.signal, null); assert.equal(JSON.parse(safe.stdout).reviewRequired, false);
  const review = await runChild([cli, "--directory", occupied]); assert.equal(review.code, 2); assert.equal(review.signal, null); assert.equal(JSON.parse(review.stdout).reviewRequired, true); anonymous(JSON.parse(review.stdout), [root]);
  const preload = await fsPreload(root, `export * from 'node:fs/promises';const forbidden=()=>{globalThis.__diagnosticFsCalls++;throw Error('diagnostic FS forbidden');};export const open=forbidden,lstat=forbidden,realpath=forbidden;`, `globalThis.__diagnosticFsCalls=0;process.once('beforeExit',()=>console.error('DIAGNOSTIC_FS_CALLS:'+globalThis.__diagnosticFsCalls));`);
  const help = await runChild([cli, "--help"], { preload }); assert.equal(help.code, 0); assert.match(help.stdout, /--directory/); assert.equal(help.stderr.trim(), "DIAGNOSTIC_FS_CALLS:0");
  for (const args of [[], ["--directory", "relative-private-marker"], ["--directory", root, "--force"], ["--help", "--directory", root]]) {
    const bad = await runChild([cli, ...args], { preload }); assert.equal(bad.code, 1); assert.equal(bad.signal, null);
    assert.deepEqual(JSON.parse(bad.stdout), { format: "legacy-lock-diagnostics-v1", error: "INVALID_ARGUMENTS" });
    assert.equal(bad.stderr.trim(), "DIAGNOSTIC_FS_CALLS:0"); anonymous(JSON.parse(bad.stdout), [root, "relative-private-marker"]);
  }
});
