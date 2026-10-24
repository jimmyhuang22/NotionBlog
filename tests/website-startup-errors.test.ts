import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const child = fileURLToPath(new URL("../scripts/website-sync/run.ts", import.meta.url));
const guard = fileURLToPath(new URL("../scripts/development/offline-network.cjs", import.meta.url));
for (const failure of ["lock", "source", "recovery", "reader", "receipt"] as const) {
  test(`website startup ${failure} failure retains its code and closes the receipt lifecycle`, async t => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "website-startup-")));
    t.after(() => rm(root, { recursive: true, force: true }));
    const state = join(root, "state"), runId = randomUUID(), output = join(state, "website-v2", runId);
    await mkdir(output, { recursive: true, mode: 0o700 });
    const lock = JSON.stringify({ pid: failure === "lock" || failure === "receipt" ? 0 : process.pid, runId });
    for (const path of [join(root, "manual-run.lock"), join(state, "worker.lock")]) await writeFile(path, lock, { mode: 0o600 });
    const source = JSON.stringify({ schemaVersion: 2, sources: [] }), sourceFile = join(root, "source.json");
    await writeFile(sourceFile, source, { mode: 0o600 });
    if (failure === "receipt") await mkdir(join(output, "receipt-private.json"), { mode: 0o700 });
    const env: NodeJS.ProcessEnv = { NODE_ENV: "test",
      WEBSITE_PRIVATE_ROOT: root, WEBSITE_STATE_DIR: state, WEBSITE_OUTPUT_DIR: output, WEBSITE_RUN_ID: runId,
      WEBSITE_PARENT_PID: String(process.pid), WEBSITE_TIMEOUT_SECONDS: "30", WEBSITE_MEDIA_MAX_BYTES: "1024",
      NOTION_SOURCES_CONFIG: sourceFile, WEBSITE_SOURCE_SHA256: failure === "source" ? "0".repeat(64) : createHash("sha256").update(source).digest("hex"),
      WEBSITE_RELEASE_COMMIT: "a".repeat(40),
      ...(failure === "recovery" ? { WEBSITE_RESUME_RECOVERY_ID: "unapproved-fixture", WEBSITE_RESUME_RUN_ID: randomUUID(),
        WEBSITE_RESUME_QUALIFICATION: "fresh", WEBSITE_RESUME_PRODUCER_PROJECT: root } : {}),
      ...(failure === "reader" ? { WEBSITE_NOTION_INTERVAL_MS: "1" } : {}),
    };
    const result = spawnSync(process.execPath, ["--require", guard, child, "--mode", "dry-run"], { env, encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 1, result.stderr);
    const expected = failure === "lock" || failure === "receipt" ? "BUSY" : failure === "recovery" ? "RELEASE_INVALID" : "MISCONFIGURED";
    const consoleReport = JSON.parse(result.stdout.trim());
    assert.equal(consoleReport.code, expected);
    assert.equal(consoleReport.outcome, "failed");
    assert.equal(consoleReport.published, false);
    assert.equal(result.stderr.includes(root), false);
    assert.equal(result.stdout.includes(sourceFile), false);
    if (failure === "receipt") assert.equal(consoleReport.receiptWriteFailed, true);
    else {
      const receipt = JSON.parse(await readFile(join(output, "receipt-private.json"), "utf8"));
      assert.equal(receipt.code, expected); assert.equal(receipt.cleanupCompleted, true);
      assert.equal(receipt.promoteRequested, false); assert.equal(receipt.readerVerified, false);
      assert.equal(receipt.notion, undefined, "no reader or network request was started");
      assert.equal((await stat(join(output, "receipt-private.json"))).mode & 0o077, 0);
    }
    assert.equal((await readdir(output)).some(name => name.startsWith(".tmp-")), false);
    assert.equal(await readFile(join(root, "manual-run.lock"), "utf8"), lock, "the child never releases a parent lock");
  });
}
