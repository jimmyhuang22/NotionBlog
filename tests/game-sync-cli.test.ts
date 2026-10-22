import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile, rm, stat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readJson, writeJson } from "../scripts/game-sync/private.ts";

test("formal CLI rejects legacy plans and expired snapshots without leaking credentials", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "game-sync-cli-")));
  await chmod(root, 0o700);
  const config = { recordsSourceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", gamesSourceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", bindings: {}, excluded: [] };
  const rows = [{ provider: "PSN", account: "test", platform: "PS5", productId: "EXAMPLE", name: "Example", minutes: 0,
    precision: "Second", firstPlayed: null, lastPlayed: null, sourceUpdated: null, syncedAt: new Date().toISOString(),
    visibility: "allowed", scope: "Played", ownership: null }];
  try {
    await writeFile(join(root, "credentials.env"), "NOTION_GAME_SYNC_TOKEN=test-secret-must-stay-private\n", { mode: 0o600 });
    await writeJson(join(root, "config.json"), config); await writeJson(join(root, "psn-snapshot.json"), rows);
    await writeJson(join(root, "psn-plan.json"), { digest: createHash("sha256").update(JSON.stringify([config, rows])).digest("hex"), report: { update: 1 } });
    function run() { return spawnSync(process.execPath, ["scripts/game-sync/cli.ts", "apply", root, "psn"], { encoding: "utf8", timeout: 10000 }); }
    let result = run();
    assert.equal(result.status, 1); assert.equal(result.stdout, "");
    assert.deepEqual(JSON.parse(result.stderr), { code: "DRY_RUN_REQUIRED" });
    assert.equal((result.stderr + result.stdout).includes("test-secret"), false);
    rows[0].syncedAt = "2000-01-01T00:00:00Z"; await writeJson(join(root, "psn-snapshot.json"), rows);
    result = run(); assert.deepEqual(JSON.parse(result.stderr), { code: "SNAPSHOT_EXPIRED" });
    assert.equal(await readJson(join(root, "psn-receipt.json")), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("larger private plans remain bounded and are written atomically with private permissions", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "game-sync-plan-"))), path = join(root, "plan.json");
  await chmod(root, 0o700);
  try {
    const value = { version: 2, padding: "x".repeat(2 * 1024 * 1024) };
    await writeJson(path, value);
    await assert.rejects(readJson(path), { code: "PRIVATE_CONFIG_INVALID" });
    assert.deepEqual(await readJson(path, 16 * 1024 * 1024), value);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(root)).mode & 0o777, 0o700);
  } finally { await rm(root, { recursive: true, force: true }); }
});
