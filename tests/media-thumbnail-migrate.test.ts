import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import core from "../database/protocol.json" with { type: "json" };
import website from "../database/website-protocol.json" with { type: "json" };
import thumbnail from "../database/thumbnail-protocol.json" with { type: "json" };
import { migrateThumbnails, verifyThumbnailProtocol } from "../scripts/media-thumbnails/migrate.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const FILE = "20261011123536_media_thumbnails.sql";
async function temporaryRepository() {
  const root = await mkdtemp(resolve(tmpdir(), "notionblog-thumbnail-protocol-"));
  await mkdir(resolve(root, "database")); await mkdir(resolve(root, "supabase/migrations"), { recursive: true });
  await copyFile(resolve(ROOT, "database/thumbnail-protocol.json"), resolve(root, "database/thumbnail-protocol.json"));
  await copyFile(resolve(ROOT, "supabase/migrations", FILE), resolve(root, "supabase/migrations", FILE));
  return root;
}
async function database(versions: ("v1" | "v2")[]) {
  const db = await PGlite.create();
  for (const version of versions) {
    const namespace = version === "v1" ? "nb" : "nb_v2";
    await db.exec(await readFile(resolve(ROOT, version === "v1" ? "database/migrations/001_content.sql" : "database/website-migrations/001_website.sql"), "utf8"));
    await db.query(`UPDATE ${namespace}.state SET schema_digest=$1`, [version === "v1" ? core.schemaDigest : website.schemaDigest]);
    await db.query(`UPDATE ${namespace}.migrations SET digest=$1 WHERE version='001'`, [version === "v1" ? core.migrations[0].sha256 : website.migration.sha256]);
    await db.exec(await readFile(resolve(ROOT, version === "v1" ? "database/media-migrations/001_media_sources.sql" : "database/website-media-migrations/001_website_media_sources.sql"), "utf8"));
  }
  const calls: string[] = [];
  // PGlite's prepared query API accepts one statement; exec executes the verified
  // multi-statement migration on the same real PostgreSQL transaction.
  const executor: SqlExecutor = { async query<T>(sql: string, values?: unknown[]) {
    calls.push(sql);
    if (sql.startsWith("CREATE SCHEMA nb_thumbnails;")) { await db.exec(sql); return { rows: [] as T[] }; }
    return db.query<T>(sql, values);
  } };
  return { db, executor, calls };
}
const sanitized = (error: unknown) => error instanceof Error &&
  error.message === "Thumbnail migration verification failed; private provider details are withheld.";

test("thumbnail protocol verifies the frozen migration and strict manifest shape offline", async t => {
  const verified = await verifyThumbnailProtocol();
  assert.deepEqual(verified, { capability: thumbnail.capability, version: thumbnail.migrations[0].version, sha256: thumbnail.migrations[0].sha256 });
  assert.equal(createHash("sha256").update(await readFile(resolve(ROOT, "supabase/migrations", FILE))).digest("hex"), verified.sha256);
  const changes = [
    { ...thumbnail, capability: "incorrect" }, { ...thumbnail, migrations: [] },
    { ...thumbnail, migrations: [...thumbnail.migrations, ...thumbnail.migrations] },
    { ...thumbnail, migrations: [{ ...thumbnail.migrations[0], version: "unknown" }] },
    { ...thumbnail, migrations: [{ ...thumbnail.migrations[0], file: "../private.sql" }] },
    { ...thumbnail, migrations: [{ ...thumbnail.migrations[0], file: "other.sql" }] },
    { ...thumbnail, migrations: [{ ...thumbnail.migrations[0], sha256: "a".repeat(64) }] },
    { ...thumbnail, migrations: [{ ...thumbnail.migrations[0], sha256: "bad" }] },
    { ...thumbnail, migrations: [{ ...thumbnail.migrations[0], secret: "fictional" }] },
    { ...thumbnail, secret: "fictional" },
  ];
  for (const invalid of changes) await t.test("reject incompatible manifest", async () => {
    const root = await temporaryRepository();
    try { await writeFile(resolve(root, "database/thumbnail-protocol.json"), JSON.stringify(invalid)); await assert.rejects(verifyThumbnailProtocol(root), sanitized); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  await t.test("changed migration bytes fail before any database request", async () => {
    const root = await temporaryRepository(); let called = false;
    try {
      await writeFile(resolve(root, "supabase/migrations", FILE), "-- changed bytes\n", { flag: "a" });
      await assert.rejects(migrateThumbnails({ async query() { called = true; throw new Error(); } }, root), sanitized);
      assert.equal(called, false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  await t.test("a verified file still requires exactly one outer transaction boundary", async () => {
    const root = await temporaryRepository();
    try {
      const sql = (await readFile(resolve(root, "supabase/migrations", FILE), "utf8")).replace("BEGIN;", "BEGIN;\nCOMMIT;\nBEGIN;");
      await writeFile(resolve(root, "supabase/migrations", FILE), sql);
      await writeFile(resolve(root, "database/thumbnail-protocol.json"), JSON.stringify({ ...thumbnail,
        migrations: [{ ...thumbnail.migrations[0], sha256: createHash("sha256").update(sql).digest("hex") }] }));
      await assert.rejects(verifyThumbnailProtocol(root), sanitized);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

for (const versions of [["v1"], ["v2"], ["v1", "v2"]] as ("v1" | "v2")[][]) test(`thumbnail migration is atomic and idempotent with ${versions.join("+")} core`, async () => {
  const { db, executor, calls } = await database(versions);
  try {
    const before: Record<string, unknown> = {};
    for (const version of versions) {
      const namespace = version === "v1" ? "nb" : "nb_v2";
      before[namespace] = (await db.query(`SELECT row_to_json(s) AS state FROM ${namespace}.state s`)).rows;
      before[`${namespace}.migrations`] = (await db.query(`SELECT * FROM ${namespace}.migrations`)).rows;
    }
    assert.deepEqual(await migrateThumbnails(executor), { thumbnailCapability: thumbnail.capability, migrationVerified: true, installed: true, coreVersions: versions });
    assert.equal((await db.query<{ version: string; digest: string }>("SELECT version,digest FROM nb_thumbnails.migrations")).rows[0].digest, thumbnail.migrations[0].sha256);
    const prior = (await db.query("SELECT * FROM nb_thumbnails.migrations")).rows;
    calls.length = 0;
    assert.deepEqual(await migrateThumbnails(executor), { thumbnailCapability: thumbnail.capability, migrationVerified: true, installed: false, coreVersions: versions });
    assert.deepEqual((await db.query("SELECT * FROM nb_thumbnails.migrations")).rows, prior);
    assert.equal(calls.some(sql => sql.startsWith("CREATE SCHEMA") || sql.startsWith("UPDATE")), false);
    assert.equal(calls[0], "BEGIN"); assert.equal(calls[1], "SELECT pg_advisory_xact_lock(172904,3)");
    assert.equal(calls.at(-1), "COMMIT");
    for (const version of versions) {
      const namespace = version === "v1" ? "nb" : "nb_v2";
      assert.deepEqual((await db.query(`SELECT row_to_json(s) AS state FROM ${namespace}.state s`)).rows, before[namespace]);
      assert.deepEqual((await db.query(`SELECT * FROM ${namespace}.migrations`)).rows, before[`${namespace}.migrations`]);
    }
  } finally { await db.close(); }
});

test("mismatched or incomplete installed cores fail before installing thumbnails", async t => {
  const changes = [
    { versions: [] as ("v1" | "v2")[], sql: undefined },
    { versions: ["v1"] as const, sql: "UPDATE nb.state SET schema_digest='wrong'" },
    { versions: ["v1"] as const, sql: "UPDATE nb.state SET protocol='wrong'" },
    { versions: ["v2"] as const, sql: "UPDATE nb_v2.migrations SET digest=NULL" },
    { versions: ["v2"] as const, sql: "UPDATE nb_v2.migrations SET digest='wrong'" },
    { versions: ["v1", "v2"] as const, sql: "UPDATE nb.state SET schema_digest='wrong'" },
    { versions: ["v1", "v2"] as const, sql: "UPDATE nb_v2.state SET schema_digest='wrong'" },
    { versions: ["v1"] as const, sql: "CREATE SCHEMA nb_v2" },
    { versions: ["v1"] as const, sql: "DROP FUNCTION nb_media_api.read_source(text)" },
  ];
  for (const change of changes) await t.test("reject incompatible core", async () => {
    const { db, executor } = await database([...change.versions]);
    try {
      if (change.sql) await db.exec(change.sql);
      await assert.rejects(migrateThumbnails(executor), sanitized);
      assert.equal((await db.query<{ schema: string | null }>("SELECT to_regnamespace('nb_thumbnails') AS schema")).rows[0].schema, null);
      assert.equal((await db.query<{ usable: number }>("SELECT 1 AS usable")).rows[0].usable, 1);
    } finally { await db.close(); }
  });
});

test("existing partial or mismatched thumbnail registries are rejected without repair", async t => {
  const changes = ["UPDATE nb_thumbnails.migrations SET digest=NULL", "UPDATE nb_thumbnails.migrations SET digest='wrong'",
    "DELETE FROM nb_thumbnails.migrations", "INSERT INTO nb_thumbnails.migrations(version,digest) VALUES('unknown','wrong')",
    "DROP FUNCTION nb_thumbnail_api.read_media(text,text,integer)", "DROP FUNCTION nb_thumbnails.qualified_source(text,text)"];
  for (const sql of changes) await t.test("reject incompatible registry", async () => {
    const { db, executor } = await database(["v1"]);
    try {
      await migrateThumbnails(executor); await db.exec(sql);
      const prior = (await db.query("SELECT version,digest FROM nb_thumbnails.migrations ORDER BY version")).rows;
      await assert.rejects(migrateThumbnails(executor), sanitized);
      assert.deepEqual((await db.query("SELECT version,digest FROM nb_thumbnails.migrations ORDER BY version")).rows, prior);
    } finally { await db.close(); }
  });
  await t.test("a schema without its registry is not blindly recreated", async () => {
    const { db, executor } = await database(["v1"]);
    try { await db.exec("CREATE SCHEMA nb_thumbnails"); await assert.rejects(migrateThumbnails(executor), sanitized); }
    finally { await db.close(); }
  });
});

test("registry-write failure rolls back the complete real SQL installation", async () => {
  const { db, executor, calls } = await database(["v1"]);
  try {
    const failing: SqlExecutor = { async query<T>(sql: string, values?: unknown[]) {
      if (sql.startsWith("UPDATE nb_thumbnails.migrations")) return db.query<T>("SELECT 1/0");
      return executor.query<T>(sql, values);
    } };
    await assert.rejects(migrateThumbnails(failing), sanitized);
    assert.equal(calls.at(-1), "ROLLBACK");
    assert.deepEqual((await db.query("SELECT to_regnamespace('nb_thumbnails') AS schema,to_regnamespace('nb_thumbnail_api') AS api")).rows[0], { schema: null, api: null });
    assert.equal((await db.query<{ intact: boolean }>("SELECT to_regclass('nb.state') IS NOT NULL AS intact")).rows[0].intact, true);
    assert.equal((await migrateThumbnails(executor)).installed, true);
  } finally { await db.close(); }
});

test("migration failures do not leak private driver text or perform unrelated writes", async () => {
  const calls: string[] = [];
  const failed: SqlExecutor = { async query(sql) { calls.push(sql); if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [] }; throw new Error("fictional private database connection password"); } };
  await assert.rejects(migrateThumbnails(failed), sanitized);
  assert.deepEqual(calls, ["BEGIN", "SELECT pg_advisory_xact_lock(172904,3)", "ROLLBACK"]);
});
