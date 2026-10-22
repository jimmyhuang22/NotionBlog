import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, stat, mkdtemp, realpath, chmod, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { cloudConfig, createCloudTransport, pendingPayload } from "../scripts/social-sync/cloud.ts";
import { config, hash, publicationKey, SocialSyncError } from "../scripts/social-sync/model.ts";
import { observation } from "../scripts/social-sync/bilibili.ts";
import { snapshotObservation } from "../scripts/social-sync/xiaohongshu.ts";
import { openStore, flushOutbox } from "../scripts/social-sync/store.ts";
import type { Pending } from "../scripts/social-sync/store.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";

const migration = new URL("../supabase/migrations/20261012005001_social_sync_v1.sql", import.meta.url);
const at = "2026-01-02T03:04:05.000Z";
const bili = config({ version: 1, publications: [{ platform: "bilibili", workId: "example-work", accountId: "10001", url: "https://www.bilibili.com/video/BV0000000001/" }] })[0];
const xhs = config({ version: 1, publications: [{ platform: "xiaohongshu", workId: "example-work", accountId: "000000000000000000000001", url: "https://www.xiaohongshu.com/explore/000000000000000000000002" }] })[0];
function rows() {
  return [observation('<script>window.__INITIAL_STATE__={"videoData":{"bvid":"BV0000000001","owner":{"mid":10001},"title":"Example video","stat":{"like":0}}}</script>', bili, at),
    snapshotObservation({ version: 1, source: "browser-note-state", observedAt: at, pageUrl: xhs.url, note: { noteId: xhs.publicationId,
      userId: xhs.accountId, type: "normal", title: "Example image note", time: null, lastUpdateTime: null, coverUrl: null,
      interactInfo: { likedCount: "1.2万", commentCount: "0", shareCount: null, collectedCount: "4" } } }, xhs, at)];
}
function item(row = rows()[0]): Pending { return { key: publicationKey(row), sha256: hash(JSON.stringify(row)), observation: row }; }
const error = (code: string) => (e: unknown) => e instanceof SocialSyncError && e.code === code;
async function directory(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "nb-social-cloud-"))); await chmod(dir, 0o700);
  t.after(() => rm(dir, { recursive: true, force: true })); return dir;
}

test("cloud configuration rejects reused privileged credentials, unknown keys and unverified remote TLS", async t => {
  const value = cloudConfig("SOCIAL_DATABASE_URL=postgresql://nb_social_worker:example@localhost:5432/postgres\nDATABASE_TLS=disable");
  assert.equal(value.max, 1); assert.equal(value.ssl, false); assert.equal(value.statement_timeout, 10000);
  for (const raw of ["", "SOCIAL_DATABASE_URL=postgresql://postgres:example@localhost/postgres", "SYNC_DATABASE_URL=example",
    "SOCIAL_DATABASE_URL=postgresql://nb_social_worker:example@remote.example/postgres\nDATABASE_TLS=disable",
    "SOCIAL_DATABASE_URL=postgresql://nb_social_worker:example@localhost/postgres?sslmode=no-verify",
    "SOCIAL_DATABASE_URL=postgresql://nb_social_worker:example@localhost/postgres\nNOTION_TOKEN=example"]) assert.throws(() => cloudConfig(raw), error("CLOUD_CONFIG_INVALID"));
  const verify = cloudConfig("SOCIAL_DATABASE_URL=postgresql://nb_social_worker.project:example@remote.example/postgres\nDATABASE_TLS=verify");
  assert.equal((verify.ssl as { rejectUnauthorized: boolean }).rejectUnauthorized, true);
  const dir = await directory(t);
  await writeFile(join(dir, "config.json"), JSON.stringify({ version: 1, publications: [{ platform: bili.platform, workId: bili.workId, accountId: bili.accountId, url: bili.url }] }), { mode: 0o600 });
  await writeFile(join(dir, "cloud.env"), "SOCIAL_DATABASE_URL=postgresql://postgres:example@localhost/postgres", { mode: 0o600 });
  const cli = fileURLToPath(new URL("../scripts/social-sync/cli.ts", import.meta.url));
  const invalid = spawnSync(process.execPath, [cli, "upload", dir], { encoding: "utf8" });
  assert.equal(invalid.status, 1); assert.deepEqual(JSON.parse(invalid.stderr), { code: "CLOUD_CONFIG_INVALID" });
  await assert.rejects(stat(join(dir, "social.sqlite")), { code: "ENOENT" });
});
test("transport rejects corrupt queued payloads before sending any row", () => {
  const p = item(); assert.equal(pendingPayload(p), JSON.stringify(p.observation));
  assert.throws(() => pendingPayload({ ...p, sha256: "0".repeat(64) }), error("LOCAL_DATA_INVALID"));
  assert.throws(() => pendingPayload({ ...p, key: "0".repeat(64) }), error("LOCAL_DATA_INVALID"));
});
test("transport verifies the dedicated login, schema and privilege flags before writing", async () => {
  for (const value of [{ role: "postgres", login: "postgres", version: 1, elevated: true },
    { role: "nb_social_worker", login: "postgres", version: 1, elevated: false },
    { role: "nb_social_worker", login: "nb_social_worker", version: 2, elevated: false }]) {
    const sql = { query: async () => ({ rows: [value] }) } as unknown as SqlExecutor;
    await assert.rejects(createCloudTransport(sql), error("CLOUD_HANDSHAKE_INVALID"));
  }
  const sql = { query: async () => { throw new Error("private connection detail"); } } as SqlExecutor;
  await assert.rejects(createCloudTransport(sql), error("CLOUD_UNAVAILABLE"));
});
test("Postgres social projection enforces bindings, null semantics, monotonic writes and isolated role permissions", async t => {
  const db = await PGlite.create(); t.after(() => db.close());
  await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;
    CREATE ROLE nb_writer;CREATE ROLE nb_reader;
    ALTER DEFAULT PRIVILEGES GRANT ALL ON TABLES TO anon,authenticated,service_role;
    ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO anon,authenticated,service_role;
    CREATE SCHEMA nb;REVOKE ALL ON SCHEMA nb FROM PUBLIC;CREATE TABLE nb.private_content(secret text);
    GRANT USAGE ON SCHEMA nb TO nb_writer,nb_reader;GRANT SELECT ON nb.private_content TO nb_reader;`);
  await db.exec(await readFile(migration, "utf8"));
  const role = (name: string): SqlExecutor => ({ query: <T>(sql: string, values?: unknown[]) => db.transaction(async tx => {
    await tx.exec(`SET LOCAL ROLE ${name}`); return tx.query<T>(sql, values);
  }) });
  const worker = role("nb_social_worker");
  async function bind(enabled = true) {
    for (const target of [bili, xhs]) await db.query(`INSERT INTO social_sync.bindings(platform,account_id,publication_id,work_id,enabled)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(publication_key) DO UPDATE SET enabled=excluded.enabled`, [target.platform, target.accountId, target.publicationId, target.workId, enabled]);
  }
  async function ingest(p: Pending, executor = worker) { return executor.query<{ key: string; sha256: string }>("SELECT key,sha256 FROM social_sync.ingest($1,$2,$3)", [p.key, p.sha256, JSON.stringify(p.observation)]); }
  await t.test("unregistered and disabled bindings refuse writes", async () => {
    await assert.rejects(ingest(item()), /NB_SOCIAL_UNREGISTERED/); await bind(false);
    await assert.rejects(ingest(item()), /NB_SOCIAL_UNREGISTERED/); await bind();
  });
  await t.test("mixed v1/v2 rows preserve exact zero and rounded unknown counts with idempotent receipts", async () => {
    for (const row of rows()) { const p = item(row); assert.deepEqual((await ingest(p)).rows, [{ key: p.key, sha256: p.sha256 }]); await ingest(p); }
    const stored = await worker.query<{ payload: Record<string, unknown> }>("SELECT payload FROM social_sync.publications ORDER BY publication_key");
    assert.equal(stored.rows.length, 2); const note = stored.rows.find(r => r.payload.platform === "xiaohongshu")!.payload;
    const expected = rows()[1]; assert.deepEqual(note.metrics, expected.metrics);
    assert.equal(expected.platform, "xiaohongshu");
    if (expected.platform === "xiaohongshu") assert.deepEqual(note.metricDisplay, expected.metricDisplay);
    assert.equal(note.websitePublicationApproved, false);
  });
  await t.test("wrong SHA, foreign identities, changed work mapping and null required strings fail without mutation", async () => {
    await assert.rejects(ingest({ ...item(), sha256: "0".repeat(64) }), /NB_SOCIAL_BAD_DIGEST/);
    const row = rows()[0]; const different = { ...row, workId: "other-work" }; await assert.rejects(ingest(item(different)), /NB_SOCIAL_UNREGISTERED/);
    const foreign = { ...row, accountId: "10002" }; await assert.rejects(ingest(item(foreign)), /NB_SOCIAL_UNREGISTERED/);
    for (const field of ["platform", "kind", "metricsScope", "source", "originalUrl"]) {
      const malformed = { ...row, [field]: null }; const payload = JSON.stringify(malformed);
      await assert.rejects(worker.query("SELECT * FROM social_sync.ingest($1,$2,$3)", [publicationKey(row), hash(payload), payload]), /NB_SOCIAL_BAD_PAYLOAD/);
    }
    assert.equal((await db.query<{ n: number }>("SELECT count(*)::int n FROM social_sync.publications")).rows[0].n, 2);
  });
  await t.test("newer updates win, old/time-conflicting/future rows cannot replace them", async () => {
    const newer = { ...rows()[0], observedAt: "2026-01-03T00:00:00.000Z", title: "Updated title" }; await ingest(item(newer));
    await assert.rejects(ingest(item()), /NB_SOCIAL_STALE/);
    await assert.rejects(ingest(item({ ...newer, title: "Conflict at same time" })), /NB_SOCIAL_CONFLICT/);
    await assert.rejects(ingest(item({ ...newer, observedAt: new Date(Date.now() + 60000).toISOString() })), /NB_SOCIAL_BAD_PAYLOAD/);
  });
  await t.test("direct SQL cannot bypass shape, public-approval, identity or write monotonicity constraints", async () => {
    for (const change of [{ websitePublicationApproved: true }, { secret: "unrequested field" }, { accountId: "10002" }, { metrics: { ...rows()[0].metrics, likes: -1 } }]) {
      const p = { ...rows()[0], ...change, observedAt: "2026-01-04T00:00:00.000Z" };
      await assert.rejects(worker.query("UPDATE social_sync.publications SET payload=$1::jsonb,observed_at=$2 WHERE publication_key=$3", [JSON.stringify(p), p.observedAt, publicationKey(rows()[0]) ]));
    }
    await assert.rejects(worker.query("UPDATE social_sync.publications SET observed_at=$1,payload=$2::jsonb WHERE publication_key=$3", [at, JSON.stringify(rows()[0]), publicationKey(rows()[0])]), /NB_SOCIAL_STALE/);
  });
  await t.test("worker cannot edit binding/credentials/schema, delete rows or reach existing content", async () => {
    for (const sql of ["UPDATE social_sync.bindings SET enabled=false", "DELETE FROM social_sync.publications", "SELECT * FROM nb.private_content",
      "SELECT social_sync.configure_password(repeat('x',64))", "CREATE TABLE social_sync.unwanted(id int)"]) await assert.rejects(worker.query(sql), /permission denied/);
    for (const name of ["anon", "authenticated", "service_role", "nb_writer", "nb_reader"]) {
      await assert.rejects(role(name).query("SELECT * FROM social_sync.publications"), /permission denied/);
      await assert.rejects(ingest(item(), role(name)), /permission denied/);
    }
  });
  await t.test("revocation hides private rows and prevents retry acknowledgements", async () => {
    await bind(false); assert.equal((await worker.query("SELECT * FROM social_sync.publications")).rows.length, 0);
    await assert.rejects(ingest(item(rows()[1])), /NB_SOCIAL_UNREGISTERED/); await bind();
  });
  await t.test("lost response after actual database commit leaves local pending and a duplicate retry recovers", async () => {
    const store = (await openStore(await directory(t)))!;
    try {
      const row = { ...rows()[0], observedAt: "2026-01-05T00:00:00.000Z" }; store.ingest(row);
      await db.exec("SET SESSION AUTHORIZATION nb_social_worker");
      let lose = true;
      const sql: SqlExecutor = { query: async <T>(text: string, values?: unknown[]) => {
        const result = await db.query<T>(text, values);
        if (text.includes("social_sync.ingest") && lose) { lose = false; throw new Error("private response failure"); }
        return result;
      } };
      const send = await createCloudTransport(sql);
      assert.equal((await flushOutbox(store, send)).failed, 1); assert.equal(store.status().pending, 1);
      assert.equal((await db.query("SELECT * FROM social_sync.publications WHERE publication_key=$1", [publicationKey(row)])).rows.length, 1);
      assert.equal((await flushOutbox(store, send)).acknowledged, 1); assert.equal(store.status().pending, 0);
    } finally { await db.exec("RESET SESSION AUTHORIZATION"); store.close(); }
  });
});
test("removed targets and cancellations keep unsent local rows pending", async t => {
  const store = (await openStore(await directory(t)))!; t.after(async () => store.close());
  for (const row of rows()) store.ingest(row);
  const result = await flushOutbox(store, async p => ({ key: p.key, sha256: p.sha256 }), { allowedKeys: new Set([publicationKey(rows()[0])]) });
  assert.equal(result.acknowledged, 1); assert.equal(result.skipped, 1); assert.equal(store.status().pending, 1);
  const abort = new AbortController(); abort.abort(); let calls = 0;
  const cancelled = await flushOutbox(store, async p => { calls++; return p; }, { signal: abort.signal });
  assert.equal(cancelled.cancelled, true); assert.equal(calls, 0); assert.equal(store.status().pending, 1);
});
test("unexpected cloud receipt fails safely and a cancelled committed response is not acknowledged", async t => {
  const store = (await openStore(await directory(t)))!; t.after(async () => store.close()); store.ingest(rows()[0]);
  let calls = 0;
  const sql = { query: async () => ({ rows: ++calls === 1 ? [{ role: "nb_social_worker", login: "nb_social_worker", version: 1, elevated: false }] : [{ key: "wrong", sha256: "wrong" }] }) } as unknown as SqlExecutor;
  const send = await createCloudTransport(sql); assert.equal((await flushOutbox(store, send)).failed, 1); assert.equal(store.status().pending, 1);
  const abort = new AbortController();
  const result = await flushOutbox(store, async p => { abort.abort(); return p; }, { signal: abort.signal });
  assert.equal(result.cancelled, true); assert.equal(result.acknowledged, 0); assert.equal(store.status().pending, 1);
});
