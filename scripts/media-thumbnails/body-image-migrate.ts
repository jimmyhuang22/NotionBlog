import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SqlExecutor } from "../../src/server/database/sql.ts";
import protocol from "../../database/body-image-thumbnails-protocol.json" with { type: "json" };
import course from "../../database/course-cover-thumbnails-protocol.json" with { type: "json" };

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
function unavailable(): never { throw new Error("Body-image thumbnail extension verification failed."); }
export async function verifyBodyImageThumbnailProtocol(projectRoot = ROOT) {
  const entry = protocol.migration;
  const bytes = await readFile(resolve(projectRoot, "supabase/migrations", entry.file));
  if (protocol.capability !== "notionblog-body-image-thumbnails-v1" || entry.version !== "001-body-image-1600" ||
      !/^\d{14}_body_image_thumbnails_1600\.sql$/.test(entry.file) ||
      createHash("sha256").update(bytes).digest("hex") !== entry.sha256) unavailable();
  const sql = bytes.toString("utf8");
  if (!/^--[^\n]*\nBEGIN;\n/.test(sql) || !/\nCOMMIT;\n$/.test(sql)) unavailable();
  return { ...entry, capability: protocol.capability, sql: sql.replace(/^--[^\n]*\nBEGIN;\n/, "").replace(/\nCOMMIT;\n$/, "") };
}

/** Explicit installation only. Does not alter the course registry, content state or expiry. */
export async function migrateBodyImageThumbnails(db: SqlExecutor, projectRoot = ROOT) {
  const verified = await verifyBodyImageThumbnailProtocol(projectRoot);
  let begun = false;
  try {
    await db.query("BEGIN"); begun = true;
    await db.query("SELECT pg_advisory_xact_lock(172904,3)");
    const prerequisite = (await db.query<{ version: string; digest: string }>("SELECT version,digest FROM nb_thumbnails.extensions ORDER BY version")).rows;
    if (prerequisite.length !== 1 || prerequisite[0].version !== course.migration.version || prerequisite[0].digest !== course.migration.sha256) unavailable();
    const present = (await db.query<{ present: boolean }>("SELECT to_regclass('nb_thumbnails.body_extensions') IS NOT NULL AS present")).rows[0];
    if (!present) unavailable();
    let installed = false;
    if (!present.present) {
      await db.query(verified.sql);
      await db.query("UPDATE nb_thumbnails.body_extensions SET digest=$1 WHERE version=$2", [verified.sha256, verified.version]);
      installed = true;
    }
    const rows = (await db.query<{ version: string; digest: string }>("SELECT version,digest FROM nb_thumbnails.body_extensions ORDER BY version")).rows;
    if (rows.length !== 1 || rows[0].version !== verified.version || rows[0].digest !== verified.sha256) unavailable();
    await db.query("COMMIT"); begun = false;
    return { capability: verified.capability, migrationVerified: true, installed };
  } catch {
    if (begun) await db.query("ROLLBACK").catch(() => {});
    return unavailable();
  }
}
