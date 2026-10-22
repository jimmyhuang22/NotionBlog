import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import protocol from "../../database/published-thumbnails-protocol.json" with { type: "json" };
import thumbnailProtocol from "../../database/thumbnail-protocol.json" with { type: "json" };
import { verifyPublication } from "../../src/server/database/publication.ts";
import { verifyPublishedThumbnails } from "../../src/server/database/published-thumbnails.ts";
import type { SqlExecutor } from "../../src/server/database/sql.ts";

/** Explicit migration-owner operation. No connection, activation or cloud default. */
export async function installPublishedThumbnails(db: SqlExecutor): Promise<void> {
  const sql = await readFile(new URL(`../../supabase/migrations/${protocol.migration.file}`, import.meta.url), "utf8");
  if (createHash("sha256").update(sql).digest("hex") !== protocol.migration.sha256 || !/\nCOMMIT;\s*$/.test(sql)) throw new Error("Published thumbnail migration differs.");
  await verifyPublication(db);
  const base = (await db.query<{version: string; digest: string}>("SELECT version,digest FROM nb_thumbnails.migrations")).rows;
  if (base.length !== 1 || base[0].version !== thumbnailProtocol.migrations[0].version || base[0].digest !== thumbnailProtocol.migrations[0].sha256) throw new Error("Thumbnail migration differs.");
  const installed = (await db.query<{installed: string | null}>("SELECT to_regprocedure('nb_publication_api.read_thumbnail(text,integer,text)')::text AS installed")).rows[0]?.installed;
  if (!installed) {
    // The function comment is a deployment identity, not new user data. Stamp
    // it inside the same DDL transaction; legacy thumbnail registry is unchanged.
    const stamped = sql.replace(/\nCOMMIT;\s*$/, `\nCOMMENT ON FUNCTION nb_publication_api.read_thumbnail(text,integer,text) IS '${protocol.migration.sha256}';\nCOMMIT;`);
    try { await db.query(stamped); }
    catch (error) { await db.query("ROLLBACK").catch(() => {}); throw error; }
  }
  await verifyPublishedThumbnails(db);
}
