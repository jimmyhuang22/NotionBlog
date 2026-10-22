import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

test("actual published routes use COS for original and variants, with no Notion or Supabase session and no reads after withdrawal", async () => {
  // This checks route/storage behavior. A background worker's cold imports are
  // not an application deadline; retain a separate bounded fixture watchdog.
  const watchdogMs = 120000;
  const result = await new Promise<{exit: number | null; signal: NodeJS.Signals | null; timedOut: boolean; stdout: string; stderr: string}>((resolve, reject) => {
    const child = spawn(process.execPath, ["--conditions=react-server", fileURLToPath(new URL("./helpers/cos-media-routes.ts", import.meta.url))],
      {cwd: fileURLToPath(new URL("../", import.meta.url)), stdio: ["ignore", "pipe", "pipe"]});
    let stdout = "", stderr = "", timedOut = false;
    child.stdout.on("data", data => {stdout += data;}); child.stderr.on("data", data => {stderr += data;}); child.on("error", reject);
    const timer = setTimeout(() => {timedOut = true; child.kill("SIGKILL");}, watchdogMs);
    child.on("close", (exit, signal) => {clearTimeout(timer); resolve({exit, signal, timedOut, stdout, stderr});});
  });
  assert.equal(result.timedOut, false, `COS route fixture exceeded its ${watchdogMs}ms watchdog: ${result.stderr}`);
  assert.equal(result.signal, null, `COS route fixture stopped by ${result.signal}: ${result.stderr}`);
  assert.equal(result.exit, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {imageRoutes: 5, contentRoutes: 1, sourceRequests: 0, objectReads: 3, independentVariants: 2, withdrawalBlocked: true});
});
