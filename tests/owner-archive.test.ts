import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import type { PoolClient } from "pg";
import { databasePoolConfig } from "../src/server/database/connection.ts";
import { configureOwnerArchive, ownerArchivePoolConfig, ownerArchiveSql, OWNER_ARCHIVE_LIMITS, startOwnerArchiveDeadline } from "../scripts/owner-archive.ts";

const url = "postgresql://fixture_owner:example@localhost:5432/postgres";
test("owner archive limits are independent of website limits and reject a known transaction pooler", () => {
  const reader = databasePoolConfig(url, "disable");
  const exported = ownerArchivePoolConfig("export", url, "disable"), restored = ownerArchivePoolConfig("restore", url, "disable");
  assert.equal(reader.statement_timeout, 15000); assert.equal(reader.query_timeout, 20000); assert.equal(reader.max, 2);
  assert.equal(exported.statement_timeout, 60000); assert.equal(exported.query_timeout, 65000); assert.equal(exported.max, 1);
  assert.equal(restored.statement_timeout, 120000); assert.equal(restored.query_timeout, 125000); assert.equal(restored.max, 1);
  assert.equal(OWNER_ARCHIVE_LIMITS.export.totalMs, 300000); assert.equal(OWNER_ARCHIVE_LIMITS.restore.totalMs, 1800000);
  const pooled = "postgresql://fixture_owner:example@aws-0-example.pooler.supabase.com:6543/postgres";
  assert.throws(() => ownerArchivePoolConfig("restore", pooled, "verify", "synthetic-ca"), /OWNER_ARCHIVE_SESSION_REQUIRED/);
  const verified = ownerArchivePoolConfig("export", pooled.replace(":6543", ":5432"), "verify", "synthetic-ca");
  assert.deepEqual(verified.ssl, { rejectUnauthorized: true, ca: "synthetic-ca" });
  assert.throws(() => ownerArchivePoolConfig("export", pooled, "disable"), { code: "MISCONFIGURED" });
});

test("dedicated owner checkout applies and inspects its session setting before archive work", async () => {
  const calls: { text: string; values?: unknown[]; query_timeout: number }[] = [];
  const client = { async query(config: typeof calls[number]) {
    calls.push(config); return { rows: calls.length === 1 ? [{ statement_timeout: "2min", lock_timeout: "5s" }] : [{ milliseconds: 120000 }] };
  } } as unknown as PoolClient;
  await configureOwnerArchive(client, "restore");
  assert.equal(calls.length, 2); assert.deepEqual(calls[0].values, ["120000"]);
  assert.ok(calls.every(c => c.query_timeout === 20000));
  const bad = { query: async () => ({ rows: [{ milliseconds: 15000 }] }) } as unknown as PoolClient;
  await assert.rejects(configureOwnerArchive(bad, "restore"), /OWNER_ARCHIVE_TIMEOUT_NOT_APPLIED/);
});

test("lost restore COMMIT acknowledgement is fixed unknown outcome and never retried", async () => {
  let calls = 0; const privateError = new Error("synthetic private database detail");
  const client = { async query() { calls++; throw privateError; } } as unknown as PoolClient;
  await assert.rejects(ownerArchiveSql(client).query("COMMIT"), e => (e as { code?: string }).code === "OWNER_ARCHIVE_OUTCOME_UNKNOWN" && !String(e).includes("private"));
  assert.equal(calls, 1);
  await assert.rejects(ownerArchiveSql(client).query("ROLLBACK"), e => e === privateError);
  assert.equal(calls, 2);
});

test("end-to-end deadlines stop stalled owner processes with safe distinct restore status", () => {
  for (const operation of ["export", "restore"] as const) {
    const source = `import { startOwnerArchiveDeadline } from ${JSON.stringify(new URL("../scripts/owner-archive.ts", import.meta.url).href)};
      startOwnerArchiveDeadline(${JSON.stringify(operation)}, 30); await new Promise(() => {});`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], { timeout: 3000, encoding: "utf8" });
    assert.equal(result.error, undefined); assert.equal(result.status, 2); assert.equal(result.stdout, "");
    assert.equal(result.stderr.trim(), operation === "restore" ? "OWNER_ARCHIVE_DEADLINE_OUTCOME_UNKNOWN" : "OWNER_ARCHIVE_DEADLINE");
  }
});

test("normal completion cancels the operation timer and deadlines cannot be widened", async () => {
  const finish = startOwnerArchiveDeadline("export", 10); finish();
  await new Promise(resolve => setTimeout(resolve, 20));
  for (const value of [0, -1, NaN, 300001]) assert.throws(() => startOwnerArchiveDeadline("export", value), /OWNER_ARCHIVE_DEADLINE_INVALID/);
});
