import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

test("actual content and image route handlers work with Notion absent and all fetches blocked", async () => {
  const result = await new Promise<{exit: number | null; stdout: string; stderr: string}>((resolve, reject) => {
    const child = spawn(process.execPath, ["--conditions=react-server", fileURLToPath(new URL("./helpers/published-thumbnail-routes.ts", import.meta.url))], {cwd: fileURLToPath(new URL("../", import.meta.url)), stdio: ["ignore", "pipe", "pipe"]});
    let stdout = "", stderr = "";
    child.stdout.on("data", data => {stdout += data;}); child.stderr.on("data", data => {stderr += data;}); child.on("error", reject);
    const timer = setTimeout(() => child.kill("SIGKILL"), 120000);
    child.on("close", exit => {clearTimeout(timer); resolve({exit, stdout, stderr});});
  });
  assert.equal(result.exit, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {imageRoutes: 5, contentRoutes: 1, sourceRequests: 0, independentVariants: 2, original: true});
});
