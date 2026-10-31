import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

for (const [version, ...delivery] of [["1"], ["2"], ["2", "legacy"]]) test(`actual media v${version} route (${delivery[0] ?? "unset"}) preserves its SQL, bytes, cancellation and deadline`, async () => {
  const result = await promisify(execFile)(process.execPath, ["--conditions=react-server",
    fileURLToPath(new URL("./helpers/legacy-media-routes.ts", import.meta.url)), version!, ...delivery], { timeout: 45000 });
  assert.deepEqual(JSON.parse(result.stdout), { version, versionBlocked: true, abortedSqlDestroyed: true,
    lateObjectCannotRequery: true, deadlineStopped: true, subsequentRequestSucceeded: true });
});
