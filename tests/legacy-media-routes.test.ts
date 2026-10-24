import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

for (const version of ["1", "2"]) test(`actual media v${version} route rejects other versions and owns its cancellation/deadline`, async () => {
  const result = await promisify(execFile)(process.execPath, ["--conditions=react-server",
    fileURLToPath(new URL("./helpers/legacy-media-routes.ts", import.meta.url)), version], { timeout: 45000 });
  assert.deepEqual(JSON.parse(result.stdout), { version, versionBlocked: true, abortedSqlDestroyed: true,
    lateObjectCannotRequery: true, deadlineStopped: true, subsequentRequestSucceeded: true });
});
