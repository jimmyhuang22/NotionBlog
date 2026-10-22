import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { runDaily } from "../scripts/game-sync/daily.ts";
import { readJson } from "../scripts/game-sync/private.ts";
import { acquireLock } from "../scripts/notion-sync/state.ts";
import { GameSyncError } from "../scripts/game-sync/model.ts";

const verified = { applied: true, create: 0, update: 0, archive: 0, verified: 0 };
// Cold CLI imports are functional checks, not ten-second startup benchmarks.
const cliTimeoutMs = 30_000;
function assertCliFailure(result: SpawnSyncReturns<string>, code: string): string {
  const error = result.error as NodeJS.ErrnoException | undefined;
  const diagnostic = JSON.stringify({
    error: error ? { name: error.name, code: error.code, message: error.message } : null,
    signal: result.signal,
    stderr: (result.stderr ?? "").slice(-2048).replace(/test-private[^\s"']*/g, "[redacted-test-value]"),
  });
  assert.equal(result.status, 1, diagnostic);
  assert.equal(result.error, undefined, diagnostic);
  assert.equal(result.signal, null, diagnostic);
  assert.equal(result.stdout, "", diagnostic);
  assert.doesNotThrow(() => JSON.parse(result.stderr), diagnostic);
  assert.deepEqual(JSON.parse(result.stderr), { code }, diagnostic);
  assert.equal(result.stderr.includes("test-private"), false, diagnostic);
  return diagnostic;
}
async function directory() { const root = await realpath(await mkdtemp(join(tmpdir(), "game-daily-"))); await chmod(root, 0o700); return root; }
test("daily cycle serializes fresh collection, exact planning and verified apply for PSN/Nintendo only", async () => {
  const root = await directory(), runId = randomUUID(), calls: string[] = [], release = await acquireLock(root, runId);
  try {
    const result = await runDaily(root, runId, {
      collect: async provider => { calls.push(`collect:${provider}`); await assert.rejects(acquireLock(root, "other"), { code: "BUSY" }); return { collected: 1 }; },
      sync: async (provider, apply) => {
        calls.push(`${apply ? "apply" : "dry-run"}:${provider}`);
        const receipt = await readJson(join(root, "daily-receipt.json")) as any;
        assert.equal(receipt.status, "running"); assert.equal(receipt.stages.at(-1).status, "running");
        return { ...verified, applied: apply };
      },
    });
    assert.deepEqual(calls, ["collect:psn", "dry-run:psn", "apply:psn", "collect:nintendo", "dry-run:nintendo", "apply:nintendo"]);
    assert.equal(result.status, "verified"); assert.equal(result.stages.length, 6);
    assert.equal((await stat(join(root, "daily-receipt.json"))).mode & 0o777, 0o600);
    assert.deepEqual(await readJson(join(root, "daily-receipts", `${runId}.json`)), result);
  } finally { await release(); await rm(root, { recursive: true, force: true }); }
});
test("failed fresh collection cannot replay an old snapshot or plan, and stops the cycle", async () => {
  const root = await directory(), calls: string[] = [];
  try {
    await assert.rejects(runDaily(root, randomUUID(), {
      collect: async provider => { calls.push(provider); throw new GameSyncError("LOGIN_REQUIRED"); },
      sync: async () => { assert.fail("No stale-snapshot sync is allowed"); },
    }), { code: "LOGIN_REQUIRED" });
    assert.deepEqual(calls, ["psn"]);
    const receipt = await readJson(join(root, "daily-receipt.json")) as any;
    assert.equal(receipt.status, "failed"); assert.equal(receipt.code, "LOGIN_REQUIRED"); assert.equal(receipt.stages[0].status, "failed");
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("a partial apply failure retains earlier stages and never starts the next account", async () => {
  const root = await directory();
  try {
    await assert.rejects(runDaily(root, randomUUID(), {
      collect: async () => ({ collected: 1 }),
      sync: async (_, apply) => { if (apply) throw new Error("private upstream details must not be logged"); return { applied: false }; },
    }));
    const receipt = await readJson(join(root, "daily-receipt.json")) as any;
    assert.equal(receipt.stages.length, 3); assert.equal(receipt.stages[1].status, "completed"); assert.equal(receipt.stages[2].status, "failed");
    assert.equal(receipt.code, "SYNC_FAILED"); assert.equal(JSON.stringify(receipt).includes("private upstream"), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("daily success requires all mutations to have passed readback", async () => {
  const root = await directory();
  try {
    await assert.rejects(runDaily(root, randomUUID(), {
      collect: async () => ({ collected: 1 }),
      sync: async (_, apply) => ({ ...verified, applied: apply, update: 1, verified: 0 }),
    }), { code: "READBACK_FAILED" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("formal daily CLI rejects invalid account auth before using stale plans, releases its lock and sanitizes stderr", async () => {
  const root = await directory();
  try {
    await writeFile(join(root, "credentials.env"), "NOTION_GAME_SYNC_TOKEN=test-private-value\n", { mode: 0o600 });
    const result = spawnSync(process.execPath, ["scripts/game-sync/cli.ts", "daily", root], { encoding: "utf8", timeout: cliTimeoutMs });
    const diagnostic = assertCliFailure(result, "LOGIN_REQUIRED");
    const receipt = await readJson(join(root, "daily-receipt.json")) as any;
    assert.equal(receipt.stages.length, 1, diagnostic); assert.equal(receipt.status, "failed", diagnostic);
    await assert.doesNotReject(async () => { const release = await acquireLock(root, "next"); await release(); }, diagnostic);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("daily CLI cannot be expanded to Steam through a provider argument", async () => {
  const root = await directory();
  try {
    const result = spawnSync(process.execPath, ["scripts/game-sync/cli.ts", "daily", root, "steam"], { encoding: "utf8", timeout: cliTimeoutMs });
    assertCliFailure(result, "SELECT_PROVIDER");
  } finally { await rm(root, { recursive: true, force: true }); }
});
