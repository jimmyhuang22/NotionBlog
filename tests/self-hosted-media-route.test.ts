import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cleanEnvironment } from "../scripts/development/clean-environment.mjs";
test("self-hosted production media route connects qualified PostgreSQL semantics, private disk and actual HTTP without original/object transports", () => {
  const result = spawnSync(process.execPath, ["--conditions=react-server", "--require", "./scripts/development/offline-network.cjs", "tests/helpers/self-hosted-media-route.ts"],
    { cwd: process.cwd(), env: { ...cleanEnvironment(), NODE_ENV: "test", NOTIONBLOG_DEVELOPMENT_MODE: "offline" }, encoding: "utf8", timeout: 90000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout.trim().split("\n").at(-1)!); assert.equal(report.status, "ACTUAL_MEDIA_ROUTE_PGLITE_HTTP_PASS"); assert.equal(report.remoteCalls, 0);
});
