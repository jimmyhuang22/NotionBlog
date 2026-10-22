import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpath } from "node:fs/promises";
import { savePrivateJson } from "../scripts/website-sync/private-json.ts";

test("private progress replacement always exposes complete JSON and leaves no temporary files", async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "website-progress-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "progress-private.json");
  await savePrivateJson(dir, "progress-private.json", { revision: 0 });
  let done = false, reads = 0;
  const observer = (async () => { while (!done) { const value = JSON.parse(await readFile(path, "utf8")); assert.ok(Number.isInteger(value.revision)); reads++; } })();
  try { for (let revision = 1; revision <= 8; revision++) await savePrivateJson(dir, "progress-private.json", { revision, padding: "x".repeat(10000) }); }
  finally { done = true; await observer; }
  assert.ok(reads > 0); assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(path, "utf8")).revision, 8);
  assert.deepEqual(await readdir(dir), ["progress-private.json"]);
  const other = join(dir, "other.json"); await writeFile(other, "unchanged", { mode: 0o600 });
  await symlink(other, join(dir, "receipt-private.json"));
  await savePrivateJson(dir, "receipt-private.json", { revision: 1 });
  assert.equal(await readFile(other, "utf8"), "unchanged");
  await assert.rejects(savePrivateJson(dir, "../escaped.json", {}));
});
