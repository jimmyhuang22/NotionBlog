import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readdir, readFile, lstat, rename, rm, symlink, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PGlite } from "@electric-sql/pglite";
import { commitSQL } from "./helpers/cache-commit-fixture.ts";
import { setupCacheRolloutFixture } from "./helpers/cache-rollout-fixture.ts";
import { commitCatalogDigest } from "../scripts/public-cache/commit-catalog.ts";
import { prepareCommitMigration, readCommitRolloutFacts, runCommitRollout, type CommitRolloutPlan, type CommitRolloutAuthority, type CommitRolloutPorts, type CommitRolloutConnection, type CommitRolloutReport } from "../scripts/public-cache/commit-rollout.ts";
import { createCommitRolloutJournal } from "../scripts/public-cache/commit-rollout-journal.ts";

test("commit rollout uses the real migration, catalog, transaction and flag boundary", async t => {
  const db = new PGlite();
  try {
    await setupCacheRolloutFixture(db, sql => db.exec(sql));
    const originalRetention = (await db.query("SELECT * FROM nb_retention.config")).rows;
    const sql = await commitSQL(), prepared = prepareCommitMigration(sql), before = await readCommitRolloutFacts(db);
    await db.exec("BEGIN"); await db.exec(prepared.body); const after = await readCommitRolloutFacts(db); await db.exec("ROLLBACK");
    const plan = (action: CommitRolloutPlan["action"]): CommitRolloutPlan => ({ version: 1, operation: randomUUID(), action, environment: "isolated", targetSHA256: "a".repeat(64), packageSHA256: "b".repeat(64), runtimeSHA256: "c".repeat(64), migrationBodySHA256: prepared.bodySHA256,
      beforeFactsSHA256: commitCatalogDigest(action === "install" ? before : after), afterFactsSHA256: commitCatalogDigest(after), beforeTables: (action === "install" ? before : after).tables, afterTables: after.tables });
    const authority = (p: CommitRolloutPlan): CommitRolloutAuthority => ({ approved: true, nonce: randomUUID(), planSHA256: commitCatalogDigest(p), issuedAt: 1_000, startBefore: 2_000, businessEnd: 10_000, cleanupEnd: 11_000, maxConnections: 2, maxDriverCalls: 80, maxLogicalBytes: 262144 });
    const state = async () => (await db.query<{ enabled: boolean }>("SELECT enabled FROM nb_cache.commit_config")).rows[0]?.enabled;
    const exists = async () => (await db.query<{ name: string | null }>("SELECT to_regclass('nb_cache.commit_config') AS name")).rows[0].name !== null;
    function harness(fault: { command?: (sql: string) => Promise<string | undefined>; script?: () => Promise<void>; save?: (r: CommitRolloutReport) => void; verify?: () => void; close?: () => Promise<void>; connect?: (n: number) => void } = {}) {
      const reports: CommitRolloutReport[] = [], commands: string[] = [], claimed = new Set<string>(); let connects = 0, releases = 0, clock = 1500, scripts = 0, closes = 0;
      const port: CommitRolloutConnection = { targetSHA256: "a".repeat(64), transport: "private-unix-fixture", query: (q, v) => db.query(q, v),
        command: async (q, v) => { commands.push(q); const replacement = await fault.command?.(q); if (replacement !== undefined) return replacement;
          const result = await db.query(q, v); const tag = q.split(" ")[0]; return tag === "UPDATE" ? `UPDATE ${result.rows.length}` : tag; },
        script: async body => { scripts++; await db.exec(body); await fault.script?.(); },
        close: async () => { closes++; await fault.close?.(); await db.exec("ROLLBACK"); } };
      const ports: CommitRolloutPorts = { now: () => clock, claim: async nonce => { assert.ok(!claimed.has(nonce)); claimed.add(nonce); },
        hold: async () => ({ verify: async () => { fault.verify?.(); }, release: async () => { releases++; } }),
        connect: async () => { connects++; fault.connect?.(connects); return port; }, save: async r => { fault.save?.(r); reports.push(structuredClone(r)); } };
      return { ports, port, reports, commands, get connects() { return connects; }, get releases() { return releases; }, get scripts() { return scripts; }, get closes() { return closes; }, expire: () => { clock = 10_001; } };
    }
    await t.test("invalid authorities and identifiers reject early; a project cannot use fixture transport", async () => {
      for (const invalid of ["approval", "time", "hash", "identifier", "environment"] as const) {
        const p = plan("install"), a = authority(p), h = harness();
        if (invalid === "approval") a.approved = false;
        if (invalid === "time") a.startBefore = 1400;
        if (invalid === "hash") a.planSHA256 = "d".repeat(64);
        if (invalid === "identifier") { p.beforeTables = [...p.beforeTables, "public.injection;COMMIT"]; a.planSHA256 = commitCatalogDigest(p); }
        if (invalid === "environment") { p.environment = "project"; a.planSHA256 = commitCatalogDigest(p); }
        if (invalid === "environment") { const r = await runCommitRollout(p, a, sql, h.ports); assert.equal(r.error, "CACHE_ROLLOUT_TARGET"); }
        else { await assert.rejects(runCommitRollout(p, a, sql, h.ports)); assert.equal(h.connects, 0); }
      }
    });
    await t.test("tampered SQL is rejected before any connection", async () => { const p = plan("install"), h = harness(); await assert.rejects(runCommitRollout(p, authority(p), sql + "\n", h.ports), /CACHE_ROLLOUT_MIGRATION/); assert.equal(h.connects, 0); });
    await t.test("an exclusive nonce cannot be replayed", async () => { const p = plan("install"), a = authority(p), h = harness(); await h.ports.claim(a.nonce, a.planSHA256); await assert.rejects(runCommitRollout(p, a, sql, h.ports)); assert.equal(h.connects, 0); });
    await t.test("local hold drift refuses before credentials/connect", async () => { const p = plan("install"), h = harness({ verify: () => { throw Error("private runtime path must not escape"); } }); const r = await runCommitRollout(p, authority(p), sql, h.ports); assert.equal(h.connects, 0); assert.equal(r.error, "CACHE_ROLLOUT_HOLD"); assert.ok(!JSON.stringify(r).includes("private runtime")); });
    await t.test("partial DDL failure rolls back all new objects", async () => { const p = plan("install"), h = harness({ script: async () => { throw Error("DDL lost"); } }); const r = await runCommitRollout(p, authority(p), sql, h.ports); assert.equal(r.outcome, "rolled-back"); assert.equal(await exists(), false); assert.equal(h.releases, 1); });
    await t.test("runtime drift after DDL rolls back rather than committing", async () => { let n = 0; const p = plan("install"), h = harness({ verify: () => { if (++n === 3) throw Error("changed"); } }); const r = await runCommitRollout(p, authority(p), sql, h.ports); assert.equal(r.outcome, "rolled-back"); assert.equal(await exists(), false); });
    await t.test("expired business window reserves rollback capacity", async () => { const p = plan("install"); const h = harness({ script: async () => h.expire() }); const r = await runCommitRollout(p, authority(p), sql, h.ports); assert.equal(r.outcome, "rolled-back"); assert.equal(await exists(), false); });
    await t.test("installation keeps locks through the only COMMIT and independently verifies disabled state", async () => { const p = plan("install"), h = harness(); const r = await runCommitRollout(p, authority(p), sql, h.ports); assert.equal(r.error, null); assert.equal(r.outcome, "committed"); assert.equal(r.verified, true); assert.equal(r.connectionClosed, true); assert.equal(r.holdReleased, true); assert.equal(await state(), false); assert.equal(h.scripts, 1); assert.equal(h.commands.filter(q => q === "COMMIT").length, 1); assert.equal(h.connects, 2); assert.ok(!/^BEGIN;$/m.test(prepared.body)); assert.ok(!/^COMMIT;$/m.test(prepared.body)); });
    await t.test("already installed is refused without replaying migration", async () => { const p = plan("install"), h = harness(); const r = await runCommitRollout(p, authority(p), sql, h.ports); assert.equal(r.outcome, "rolled-back"); assert.equal(h.scripts, 0); assert.equal(await state(), false); });
    await t.test("retention guard and configuration remain unchanged and reject the new function catalog", async () => { assert.deepEqual((await db.query("SELECT * FROM nb_retention.config")).rows, originalRetention); await assert.rejects(db.query("SELECT nb_retention.assert_enabled()"), /RETENTION_DISABLED_OR_CATALOG_CHANGED/); });
    await t.test("role drift and an unreviewed extra trigger reject before mutation", async () => {
      for (const [add, remove] of [["CREATE ROLE fixture_drift", "DROP ROLE fixture_drift"], ["CREATE TRIGGER fixture_drift AFTER UPDATE ON nb_thumbnails.media FOR EACH ROW EXECUTE FUNCTION nb_cache.on_projection_change('media')", "DROP TRIGGER fixture_drift ON nb_thumbnails.media"]]) {
        await db.exec(add); const p = plan("enable"), h = harness(); const r = await runCommitRollout(p, authority(p), sql, h.ports); assert.equal(r.outcome, "rolled-back"); assert.equal(r.error, "CACHE_ROLLOUT_BASELINE"); assert.equal(await state(), false); await db.exec(remove);
      }
    });
    await t.test("unreviewed retention guard replacement rejects before activation", async () => { const original = (await db.query<{ sql: string }>("SELECT pg_get_functiondef('nb_retention.assert_enabled()'::regprocedure) AS sql")).rows[0].sql; await db.exec("CREATE OR REPLACE FUNCTION nb_retention.assert_enabled() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ BEGIN RETURN; END $$"); const p = plan("enable"), h = harness(); const r = await runCommitRollout(p, authority(p), sql, h.ports); assert.equal(r.error, "CACHE_ROLLOUT_BASELINE"); assert.equal(await state(), false); await db.exec(original); });
    await t.test("base cache table ACL drift is rejected even though the B10-only catalog still matches", async () => { await db.exec("GRANT SELECT ON nb_cache.events TO nb_reader"); const p = plan("enable"), h = harness(); const r = await runCommitRollout(p, authority(p), sql, h.ports); assert.equal(r.error, "CACHE_ROLLOUT_BASELINE"); assert.equal(await state(), false); await db.exec("REVOKE SELECT ON nb_cache.events FROM nb_reader"); });
    await t.test("an unchanged supplied busy source fingerprint cannot bypass the explicit idle check", async () => { await db.exec("UPDATE nb_v2.state SET lease_run=current_run,lease_until=clock_timestamp()+interval '1 minute'"); const p = plan("enable"), h = harness(); p.beforeFactsSHA256 = commitCatalogDigest(await readCommitRolloutFacts(db)); const r = await runCommitRollout(p, authority(p), sql, h.ports); assert.equal(r.error, "CACHE_ROLLOUT_BASELINE"); assert.equal(await state(), false); await db.exec("UPDATE nb_v2.state SET lease_run=NULL,lease_until=NULL"); });
    await t.test("a nonempty intent fails closed without deleting or flushing it", async () => { await db.exec("ALTER TABLE nb_cache.commit_intents DISABLE TRIGGER nb_cache_commit_refresh;INSERT INTO nb_cache.commit_intents VALUES('10000000-0000-0000-0000-000000000001','social',repeat('a',64),1);ALTER TABLE nb_cache.commit_intents ENABLE TRIGGER nb_cache_commit_refresh"); const p = plan("enable"), h = harness(); const r = await runCommitRollout(p, authority(p), sql, h.ports); assert.equal(r.error, "CACHE_ROLLOUT_STATE"); assert.equal((await db.query("SELECT id FROM nb_cache.commit_intents")).rows.length, 1); await db.exec("DELETE FROM nb_cache.commit_intents"); });
    await t.test("logical byte overflow rolls back before the flag mutation", async () => { const p = plan("enable"), h = harness(); h.port.query = async <T>() => ({ rows: [{ result: "x".repeat(32769) }] as T[] }); const r = await runCommitRollout(p, authority(p), sql, h.ports); assert.equal(r.error, "CACHE_ROLLOUT_BYTES"); assert.equal(r.outcome, "rolled-back"); assert.equal(await state(), false); });
    await t.test("caller mutation of the approved plan while holding cannot change identifiers or action", async () => { const p = plan("enable"), a = authority(p), h = harness({ verify: () => { p.beforeTables = ["x;COMMIT"]; p.action = "disable"; a.approved = false; } }); const r = await runCommitRollout(p, a, sql, h.ports); assert.equal(r.verified, true); assert.equal(await state(), true); await db.exec("UPDATE nb_cache.commit_config SET enabled=false"); });
    await t.test("journal failure before the flag mutation leaves it disabled", async () => { const p = plan("enable"), h = harness({ save: r => { if (r.stage === "mutation-intent") throw Error("disk full"); } }); const r = await runCommitRollout(p, authority(p), sql, h.ports); assert.equal(r.outcome, "rolled-back"); assert.equal(r.journalFailed, true); assert.equal(r.holdReleased, false); assert.equal(await state(), false); });
    await t.test("COMMIT lost before execution stays unknown even when connection cleanup rolls it back", async () => { const p = plan("enable"), h = harness({ command: async q => { if (q === "COMMIT") throw Error("connection lost"); } }); const r = await runCommitRollout(p, authority(p), sql, h.ports); assert.equal(r.outcome, "unknown"); assert.equal(r.holdReleased, false); assert.equal(h.connects, 1); assert.equal(await state(), false); });
    await t.test("COMMIT lost after execution stays unknown and is never replayed", async () => { const p = plan("enable"), h = harness({ command: async q => { if (q === "COMMIT") { await db.exec(q); throw Error("reply lost"); } } }); const r = await runCommitRollout(p, authority(p), sql, h.ports); assert.equal(r.outcome, "unknown"); assert.equal(r.holdReleased, false); assert.equal(h.commands.filter(q => q === "COMMIT").length, 1); assert.equal(await state(), true); await db.exec("UPDATE nb_cache.commit_config SET enabled=false"); });
    await t.test("ROLLBACK returned for COMMIT is never accepted as a committed success", async () => { const p = plan("enable"), h = harness({ command: async q => { if (q === "COMMIT") { await db.exec("ROLLBACK"); return "ROLLBACK"; } } }); const r = await runCommitRollout(p, authority(p), sql, h.ports); assert.equal(r.outcome, "unknown"); assert.equal(await state(), false); });
    await t.test("failed close preserves acknowledged commit, skips fresh query and retains hold", async () => { const p = plan("enable"), h = harness({ close: async () => { throw Error("socket unknown"); } }); const r = await runCommitRollout(p, authority(p), sql, h.ports); assert.equal(r.outcome, "committed"); assert.equal(r.verified, false); assert.equal(r.connectionClosed, false); assert.equal(r.holdReleased, false); assert.equal(h.connects, 1); assert.equal(h.closes, 1); assert.equal(await state(), true); await db.exec("UPDATE nb_cache.commit_config SET enabled=false"); });
    await t.test("journal failure after COMMIT retains the acknowledged outcome and hold", async () => { const p = plan("enable"), h = harness({ save: r => { if (r.stage === "committed") throw Error("disk lost"); } }); const r = await runCommitRollout(p, authority(p), sql, h.ports); assert.equal(r.outcome, "committed"); assert.equal(r.journalFailed, true); assert.equal(r.holdReleased, false); assert.equal(await state(), true); await db.exec("UPDATE nb_cache.commit_config SET enabled=false"); });
    await t.test("last receipt failure after release remains an explicit error while preserving confirmed commit and verification", async () => { const p = plan("enable"), h = harness({ save: r => { if (r.holdReleased) throw Error("last receipt lost"); } }); const r = await runCommitRollout(p, authority(p), sql, h.ports); assert.equal(r.outcome, "committed"); assert.equal(r.verified, true); assert.equal(r.holdReleased, true); assert.equal(r.journalFailed, true); assert.equal(r.error, "CACHE_ROLLOUT_JOURNAL"); await db.exec("UPDATE nb_cache.commit_config SET enabled=false"); });
    await t.test("post-commit drift reports committed but unverified without undoing it", async () => { const p = plan("enable"), h = harness({ connect: n => { if (n === 2) h.port.targetSHA256 = "e".repeat(64); } }); const r = await runCommitRollout(p, authority(p), sql, h.ports); assert.equal(r.outcome, "committed"); assert.equal(r.verified, false); assert.equal(r.holdReleased, false); assert.equal(await state(), true); await db.exec("UPDATE nb_cache.commit_config SET enabled=false"); });
    await t.test("enable and mode rollback each verify an exact one-row transition, leaving schema and generation intact", async () => {
      const generation = (await db.query("SELECT generation FROM nb_cache.state")).rows;
      for (const action of ["enable", "disable"] as const) { const p = plan(action), h = harness(), r = await runCommitRollout(p, authority(p), sql, h.ports); assert.equal(r.verified, true); assert.equal(await state(), action === "enable"); assert.equal(r.holdReleased, true); }
      assert.equal(await exists(), true); assert.deepEqual((await db.query("SELECT generation FROM nb_cache.state")).rows, generation);
    });
  } finally { await db.close(); }
});

test("rollout journal persists exclusive, immutable private records and rejects replaced directories", async () => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "nb-rollout-journal-")));
  try {
    const root = join(temporary, ".local"), operation = randomUUID(), nonce = randomUUID();
    const journal = await createCommitRolloutJournal(root, operation);
    await journal.claim(nonce, "a".repeat(64));
    const report: CommitRolloutReport = { operation, action: "install", outcome: "not-started", stage: "claim", verified: false, connectionClosed: true, holdReleased: false, journalFailed: false, connections: 0, driverCalls: 0, logicalBytes: 0, error: null };
    await journal.save(report); await journal.save({ ...report, stage: "mutation-intent" });
    const directory = join(root, `operation-${operation}`), names = await readdir(directory);
    assert.deepEqual(names.sort(), ["step-0001.json", "step-0002.json"]);
    assert.equal((await lstat(join(directory, names[0]))).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await readFile(join(directory, names[0]), "utf8")).stage, "claim");
    await assert.rejects(journal.claim(nonce, "a".repeat(64)));
    const other = await createCommitRolloutJournal(root, randomUUID()); await assert.rejects(other.claim(nonce, "a".repeat(64)));
    const sameOperation = await createCommitRolloutJournal(root, operation); await assert.rejects(sameOperation.claim(randomUUID(), "a".repeat(64)));
    await assert.rejects(journal.save({ ...report, error: "secret driver text" }));
    await rename(directory, directory + "-saved"); await mkdir(directory, { mode: 0o700 }); await assert.rejects(journal.save(report));
    const link = join(temporary, "link.local"); await symlink(root, link); await assert.rejects(createCommitRolloutJournal(link, randomUUID()));
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
