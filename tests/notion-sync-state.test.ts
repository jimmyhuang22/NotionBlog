import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, realpath, rm, writeFile, symlink, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { acquireLock, readPrivateFile, readStatus, saveReport, unlockStale } from "../scripts/notion-sync/state.ts";
import { loadSourceConfig } from "../scripts/notion-sync/inputs.ts";
import { WorkerError } from "../scripts/notion-sync/errors.ts";
const exec = promisify(execFile);
const code = (expected: string) => (e: unknown) => e instanceof Error && "code" in e && e.code === expected;
const misconfigured = (error: unknown) => error instanceof WorkerError && error.code === "MISCONFIGURED" && error.message === "MISCONFIGURED";
async function directory() { return realpath(await mkdtemp(join(tmpdir(), "notion-sync-test-"))); }
test("local lock excludes a second process, releases cleanly and allows a subsequent run", async () => {
  const dir = await directory();
  try {
    const release = await acquireLock(dir, randomUUID());
    const child = await exec(process.execPath, ["--input-type=module", "-e", `import {acquireLock} from ${JSON.stringify(new URL("../scripts/notion-sync/state.ts", import.meta.url).href)};try {await acquireLock(${JSON.stringify(dir)},'synthetic');process.exitCode=2;}catch(e){console.log(e.code);}`]);
    assert.equal(child.stdout.trim(), "BUSY"); assert.equal((await readStatus(dir)).locked, true);
    await assert.rejects(unlockStale(dir), code("BUSY")); await release();
    const again = await acquireLock(dir, randomUUID()); await again(); assert.equal((await readStatus(dir)).locked, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("explicit stale recovery checks owner PID, reports rotate and files remain private", async () => {
  const dir = await directory();
  try {
    await writeFile(join(dir, "worker.lock"), JSON.stringify({ pid: 2147483647 }), { mode: 0o600 });
    await unlockStale(dir);
    for (let n = 0; n < 12; n++) await saveReport(dir, { runId: randomUUID(), code: "CONTENT_UNAVAILABLE", outcome: "failed" });
    const status = await readStatus(dir); assert.equal(status.locked, false); assert.equal(status.latestRun.code, "CONTENT_UNAVAILABLE");
    const { readdir, stat } = await import("node:fs/promises");
    const reports = (await readdir(dir)).filter(f => f.startsWith("run-")); assert.equal(reports.length, 10);
    assert.equal((await stat(join(dir, "latest-run.json"))).mode & 0o077, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("empty, damaged and invalid lock owners have fixed errors and remain untouched", async () => {
  const dir = await directory(), path = join(dir, "worker.lock");
  try {
    for (const bytes of ["", '{"private":"fictional-sensitive-fragment",', "null", "[]", '"not-an-owner"',
      ...[{}, { pid: "42" }, { pid: 0 }, { pid: -1 }, { pid: 1.5 }, { pid: 2147483648 }, { pid: Number.MAX_SAFE_INTEGER }].map(value => JSON.stringify(value))]) {
      await writeFile(path, bytes, { mode: 0o600 });
      await assert.rejects(unlockStale(dir), misconfigured);
      await assert.rejects(readStatus(dir), misconfigured);
      assert.equal(await readFile(path, "utf8"), bytes);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("legacy pid-only live locks remain busy and status preserves absent-file semantics", async () => {
  const dir = await directory(), path = join(dir, "worker.lock");
  try {
    await assert.rejects(unlockStale(dir), { code: "ENOENT" });
    assert.deepEqual(await readStatus(dir), { locked: false, latestRun: null, lastSuccess: null });
    const bytes = JSON.stringify({ pid: process.pid }); await writeFile(path, bytes, { mode: 0o600 });
    await assert.rejects(unlockStale(dir), code("BUSY"));
    assert.deepEqual(await readStatus(dir), { locked: true, latestRun: null, lastSuccess: null });
    assert.equal(await readFile(path, "utf8"), bytes);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("damaged report JSON never exposes parser input and is not rewritten by status", async () => {
  const dir = await directory();
  try {
    for (const name of ["latest-run.json", "last-success.json"]) {
      const path = join(dir, name), bytes = '{"private":"fictional-report-fragment",';
      await writeFile(path, bytes, { mode: 0o600 });
      await assert.rejects(readStatus(dir), misconfigured); assert.equal(await readFile(path, "utf8"), bytes);
      await writeFile(path, "null", { mode: 0o600 });
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("secret files with unsafe permissions or a symlink are rejected", async () => {
  const dir = await directory();
  try {
    const file = join(dir, "input"), link = join(dir, "link");
    await writeFile(file, "synthetic", { mode: 0o600 }); assert.equal(await readPrivateFile(file), "synthetic");
    await symlink(file, link); await assert.rejects(readPrivateFile(link));
    await chmod(file, 0o644); await assert.rejects(readPrivateFile(file), code("MISCONFIGURED"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("CLI offline dry-run and status report no content or environment values", async () => {
  const dir = await directory();
  try {
    const cli = new URL("../scripts/notion-sync/cli.ts", import.meta.url).pathname;
    const result = await exec(process.execPath, [cli, "--demo", "--mode", "dry-run", "--reconcile", "--state-dir", dir]);
    const report = JSON.parse(result.stdout); assert.equal(report.records, 129); assert.equal(report.backend, "offline-memory");
    assert.equal(/Synthetic|images\.example|NOTION_TOKEN/.test(result.stdout + result.stderr), false);
    const status = JSON.parse((await exec(process.execPath, [cli, "--status", "--state-dir", dir])).stdout);
    assert.equal(status.locked, false); assert.equal(status.lastSuccess, null); assert.equal(status.latestRun.mode, "dry-run");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("blank JSON alternative in env template loads private file; conflicting/malformed inputs fail", async () => {
  const dir = await directory(), config = { schemaVersion: 1, sources: [] };
  try {
    const path = join(dir, "sources.json"); await writeFile(path, JSON.stringify(config), { mode: 0o600 });
    assert.deepEqual(await loadSourceConfig({ NOTION_SOURCES_CONFIG: path, NOTION_SOURCES_JSON: "" }), config);
    assert.deepEqual(await loadSourceConfig({ NOTION_SOURCES_CONFIG: "", NOTION_SOURCES_JSON: JSON.stringify(config) }), config);
    await assert.rejects(loadSourceConfig({ NOTION_SOURCES_CONFIG: path, NOTION_SOURCES_JSON: "{}" }), code("MISCONFIGURED"));
    await assert.rejects(loadSourceConfig({}), code("MISCONFIGURED"));
    await assert.rejects(loadSourceConfig({ NOTION_SOURCES_JSON: "broken" }), code("MISCONFIGURED"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
