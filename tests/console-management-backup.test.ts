import test from "node:test";
import assert from "node:assert/strict";
import { readFile, appendFile, access } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { hostFixture } from "./helpers/incremental-host.ts";
import { runIncrementalHost } from "../scripts/website-incremental-sync/host.ts";
import { installFreeze } from "../scripts/website-sync/freeze-migration.ts";
import { createFreezeStore } from "../src/server/database/freeze.ts";
import { createManagementBackup } from "../scripts/console-management/backup.ts";
import { installPublication } from "../scripts/website-sync/publication-migration.ts";
import { installIncrementalPublication } from "../scripts/website-sync/incremental-migration.ts";
import { installIncrementalReader } from "../scripts/website-sync/incremental-reader-migration.ts";
import { installIncrementalReaderIsolation } from "../scripts/website-sync/incremental-reader-isolation.ts";
import { withPGliteOwnerTransaction } from "../scripts/website-sync/owner-install-session.ts";
import { openIncrementalQueue } from "../scripts/website-incremental-sync/queue.ts";
import { DEMO } from "../scripts/notion-sync/demo.ts";
import { WEBSITE_SCHEMA_DIGEST } from "../contracts/website-sync.ts";
import core from "../database/website-protocol.json" with {type: "json"};
import study from "../database/website-study-protocol.json" with {type: "json"};
import type { SqlExecutor } from "../src/server/database/sql.ts";

test("paired backups verify local queues and checkpoints, restore inactive, and reject unknown work or damaged files", async t => {
  const f = await hostFixture(); t.after(() => f.close());
  const adapter = (db: PGlite): SqlExecutor => ({query: async <T>(sql: string, values?: unknown[]) => {
    if (sql.startsWith("--")) {await db.exec(sql); return {rows: [] as T[]};} return db.query<T>(sql, values);
  }});
  const owner = adapter(f.db);
  await f.db.query("UPDATE nb_v2.migrations SET digest=$1 WHERE version='001'", [core.migration.sha256]);
  assert.equal((await runIncrementalHost(f.options, f.deps)).outcome, "initialized");
  await installFreeze(owner); await f.db.query("UPDATE nb_freeze.state SET enabled=true");
  const frozen = createFreezeStore(owner), plan = await frozen.preview(DEMO.course, "freeze"); await frozen.freeze(randomUUID(), plan, []);
  const backup = createManagementBackup(join(f.root, ".local")), path = join(f.root, ".local", "backup");
  const saved = await backup.save(owner, f.options.runtimeDirectory, path, {read: async () => {throw Error("No fixture media");}});
  assert.equal(saved.runtimeFiles, 4); assert.equal(saved.mediaIncluded, true);
  const loaded = await backup.load(path); assert.equal(loaded.archive.freeze?.members.length, 2);

  const target = await PGlite.create(); t.after(() => target.close()); const empty = adapter(target);
  await target.exec(await readFile(new URL("../database/website-migrations/001_website.sql", import.meta.url), "utf8"));
  await target.query("UPDATE nb_v2.state SET schema_digest=$1", [WEBSITE_SCHEMA_DIGEST]);
  await target.query("UPDATE nb_v2.migrations SET digest=$1 WHERE version='001'", [core.migration.sha256]);
  await target.exec(await readFile(new URL(`../database/website-study-migrations/${study.migration.file}`, import.meta.url), "utf8"));
  await target.query("UPDATE nb_v2.migrations SET digest=$1 WHERE version=$2", [study.migration.sha256, study.migration.version]);
  await installPublication(empty); await installIncrementalPublication(empty); await installIncrementalReader(empty);
  await withPGliteOwnerTransaction(target, installIncrementalReaderIsolation); await installFreeze(empty);
  const restored = join(f.root, "restored");
  assert.equal((await backup.restore(empty, path, restored)).runtimeReady, false);
  await assert.rejects(access(join(restored, "incremental-ready.json")));
  assert.equal(JSON.parse(await readFile(join(restored, "restored-ready.json"), "utf8")).format, "incremental-host-ready-v1");
  assert.deepEqual((await target.query("SELECT run_id FROM nb_publication.state")).rows, [{run_id: null}]);
  assert.equal((await target.query<{enabled: boolean}>("SELECT enabled FROM nb_freeze.state")).rows[0].enabled, false);
  assert.equal((await target.query<{n: number}>("SELECT count(*)::int AS n FROM nb_freeze.members")).rows[0].n, 2);
  await assert.rejects(backup.restore(empty, path, restored));

  await appendFile(join(path, "runtime", "queue/incremental.sqlite"), "damage");
  await assert.rejects(backup.load(path), /MANAGEMENT_BACKUP_INVALID/);
  const queue = await openIncrementalQueue(join(f.options.runtimeDirectory, "queue"), {digest: f.digest, sourceKeys: f.config.sources.map(s => s.key)});
  try {queue.enqueue([{eventId: "unknown", sourceKey: "notes", pageKey: DEMO.week, reason: "reconcile", observedAt: Date.now()}]); queue.claim(1);} finally {queue.close();}
  const blocked = join(f.root, ".local", "blocked");
  await assert.rejects(backup.save(owner, f.options.runtimeDirectory, blocked), /MANAGEMENT_BACKUP_INVALID/);
  await assert.rejects(access(blocked));
});
