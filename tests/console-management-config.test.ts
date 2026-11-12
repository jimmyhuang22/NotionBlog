import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, mkdir, writeFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {loadManagementConfig} from "../scripts/console-management/cli.ts";

test("whole-course management accepts a bounded longer operation without allowing unlimited work", async t => {
  const root = await mkdtemp(join(tmpdir(), "management-duration-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(join(root, ".local"));
  const path = join(root, ".local", "management.json");
  const config = {version: 1, enabled: true, stateDir: join(root, ".local"), lockDirectory: join(root, "lock"),
    runtimeDirectory: join(root, "state"), sourceConfigPath: join(root, "sources.json"), siteOrigin: "https://example.test",
    durationMs: 1799000, mediaBytes: 1048576};
  await writeFile(path, JSON.stringify(config), {mode: 0o600});
  assert.equal((await loadManagementConfig(path)).durationMs, 1799000);
  await writeFile(path, JSON.stringify({...config, durationMs: 1799001}));
  await assert.rejects(loadManagementConfig(path), /FREEZE_INPUT_INVALID/);
});
