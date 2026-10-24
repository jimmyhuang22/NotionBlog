import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parseWebsiteNotionConfig } from "../src/server/notion/website-config.ts";
import { configDigest } from "../src/server/database/website-validation.ts";
import { openIncrementalQueue } from "../scripts/website-incremental-sync/queue.ts";
import { acquireLock } from "../scripts/notion-sync/state.ts";

test("review CLI lists and resumes existing private work offline and honors the publisher lock", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "review-cli-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = parseWebsiteNotionConfig({ schemaVersion: 2, sources: [{ key: "status", kind: "status", enabled: true,
    dataSourceId: "a".repeat(32), fields: { title: "Name", recordedAt: "Date" }, publication: { mode: "all" } }] });
  const configPath = join(root, "config.json"), runtime = join(root, "runtime"), lock = join(root, "lock");
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 }); await mkdir(runtime, { mode: 0o700 });
  const queue = await openIncrementalQueue(join(runtime, "queue"), { digest: configDigest(config), sourceKeys: ["status"] });
  queue.enqueue([{ eventId: "event", sourceKey: "status", pageKey: "page", reason: "content", observedAt: 1000 }]);
  queue.requireReview(queue.claim()[0], "IMAGE_REJECTED"); queue.close();
  const call = (command: string, args: string[] = []) => spawnSync(process.execPath, ["--require", "./scripts/development/offline-network.cjs",
    "scripts/website-incremental-sync/cli.ts", command, "--config", configPath, "--runtime-dir", runtime, "--lock-dir", lock, ...args],
    { encoding: "utf8", timeout: 10000 });
  const listed = call("list-review"); assert.equal(listed.status, 0, listed.stderr);
  assert.equal(JSON.parse(listed.stdout).entries[0].errorCode, "IMAGE_REJECTED");
  const release = await acquireLock(lock, "other");
  try { assert.equal(call("resume", ["--source", "status", "--page", "page"]).status, 1); } finally { await release(); }
  const resumed = call("resume", ["--source", "status", "--page", "page"]); assert.equal(resumed.status, 0, resumed.stderr);
  assert.deepEqual(JSON.parse(resumed.stdout), { resumed: true });
  assert.deepEqual(JSON.parse(call("list-review").stdout), { entries: [] });
  assert.equal(call("resume").status, 1);
});
