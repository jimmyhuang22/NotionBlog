import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, readFile, writeFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runLockedProcess } from "../scripts/notion-sync/locked-process.ts";
import { acquireLock } from "../scripts/notion-sync/state.ts";
import { runHttpCycleCli } from "../scripts/social-sync/http-cycle-cli.ts";

async function root(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "review-lock-")));
  t.after(() => rm(dir, { recursive: true, force: true })); return dir;
}

test("deadline kills a noncooperative worker before releasing its lock", async t => {
  const dir = await root(t), pidFile = join(dir, "pid");
  const code = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`;
  const running = runLockedProcess({ root: dir, runId: "fixture", args: ["-e", code], timeoutMs: 1200, graceMs: 100 });
  for (let i = 0; i < 100; i++) {
    try { await lstat(pidFile); break; } catch { await new Promise(r => setTimeout(r, 10)); }
  }
  const pid = Number(await readFile(pidFile, "utf8"));
  await assert.rejects(acquireLock(dir, "other"), { code: "BUSY" });
  assert.deepEqual(await running, { code: null, reason: "TIME_LIMIT" });
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  await assert.rejects(lstat(join(dir, "worker.lock")), { code: "ENOENT" });
  await (await acquireLock(dir, "next"))();
});

test("successful and failed workers both release the parent lock", async t => {
  const dir = await root(t);
  for (const code of [0, 7]) {
    const result = await runLockedProcess({ root: dir, runId: "fixture", args: ["-e", `process.exit(${code})`], timeoutMs: 5000 });
    assert.equal(result.code, code); assert.equal(result.reason, undefined);
    await assert.rejects(lstat(join(dir, "worker.lock")), { code: "ENOENT" });
  }
});

test("invalid HTTP cycle configuration releases lock and signal listeners on every attempt", async t => {
  const dir = await root(t);
  await writeFile(join(dir, "xiaohongshu-http.json"), JSON.stringify({ version: 1, enabled: true, baseScopeDigest: "a".repeat(64), linksDigest: "b".repeat(64), stateDirectory: join(dir, "state"), pythonExecutable: process.execPath }), { mode: 0o600 });
  await writeFile(join(dir, "refresh-config.json"), "invalid JSON", { mode: 0o600 });
  const listeners = [process.listenerCount("SIGTERM"), process.listenerCount("SIGINT")];
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(runHttpCycleCli(["run", dir]), SyntaxError);
    await assert.rejects(lstat(join(dir, "cycle-xiaohongshu-http", "worker.lock")), { code: "ENOENT" });
    assert.deepEqual([process.listenerCount("SIGTERM"), process.listenerCount("SIGINT")], listeners);
  }
});
