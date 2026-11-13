import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

test("29 simultaneous legacy missing thumbnails complete through the real v2 route and default Notion scheduler", { timeout: 60_000 }, async () => {
  const result = await promisify(execFile)(process.execPath, ["--conditions=react-server",
    fileURLToPath(new URL("./helpers/legacy-media-route.ts", import.meta.url)),
  ], { timeout: 55_000, maxBuffer: 65_536 });
  assert.deepEqual(JSON.parse(result.stdout), { redirects: 29, sourceReads: 29, originalReads: 58, transportReads: 58, externalRequests: 0 });
});
