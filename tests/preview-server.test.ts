import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cleanEnvironment } from "../scripts/development/clean-environment.mjs";

test("protected preview denies unauthenticated requests and drains on SIGTERM", () => {
  const result = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--require", "./scripts/development/offline-network.cjs", "tests/helpers/preview-server.mjs"], {
    cwd: process.cwd(), env: { ...cleanEnvironment(), NODE_ENV: "test", NOTIONBLOG_DEVELOPMENT_MODE: "offline" }, encoding: "utf8", timeout: 15000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /preview_fixture_pass/);
});
