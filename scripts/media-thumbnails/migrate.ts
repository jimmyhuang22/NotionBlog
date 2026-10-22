import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import coreProtocol from "../../database/protocol.json" with { type: "json" };
import websiteProtocol from "../../database/website-protocol.json" with { type: "json" };
import { THUMBNAIL_CAPABILITY } from "../../src/server/database/thumbnail-index.ts";
import type { SqlExecutor } from "../../src/server/database/sql.ts";
import type { MediaSourceVersion } from "../../src/server/media/notion-source.ts";

const FILE = "20261011123536_media_thumbnails.sql";
const VERSION = "001-media-thumbnails";
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
interface VerifiedProtocol { capability: string; version: string; sha256: string }
export interface ThumbnailMigrationReport {
  thumbnailCapability: string;
  migrationVerified: true;
  installed: boolean;
  coreVersions: MediaSourceVersion[];
}
function failed(): never { throw new Error("Thumbnail migration verification failed; private provider details are withheld."); }
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
async function loadProtocol(projectRoot: string): Promise<VerifiedProtocol & { sql: string }> {
  try {
    const manifest: unknown = JSON.parse(await readFile(resolve(projectRoot, "database/thumbnail-protocol.json"), "utf8"));
    if (!exact(manifest, ["capability", "migrations"]) || manifest.capability !== THUMBNAIL_CAPABILITY ||
        !Array.isArray(manifest.migrations) || manifest.migrations.length !== 1) throw new Error();
    const entry: unknown = manifest.migrations[0];
    if (!exact(entry, ["version", "file", "sha256"]) || entry.version !== VERSION || entry.file !== FILE ||
        typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error();
    const bytes = await readFile(resolve(projectRoot, "supabase/migrations", FILE));
    if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256) throw new Error();
    const sql = bytes.toString("utf8");
    // This verified migration contains one outer transaction. Strip only its exact
    // boundary lines so schema creation and the registry digest commit together.
    const prefix = /^(?:--[^\r\n]*\r?\n)*BEGIN;\r?\n/;
    if (!prefix.test(sql) || !/\r?\nCOMMIT;\s*$/.test(sql)) throw new Error();
    const body = sql.replace(prefix, "").replace(/\r?\nCOMMIT;\s*$/, "");
    if (/^\s*(?:BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION|END)\s*;/im.test(body)) throw new Error();
    return { capability: THUMBNAIL_CAPABILITY, version: VERSION, sha256: entry.sha256, sql: body };
  } catch { return failed(); }
}

/** Offline public-file verification; never opens a database or reads environment credentials. */
export async function verifyThumbnailProtocol(projectRoot = ROOT): Promise<VerifiedProtocol> {
  const { sql: _sql, ...protocol } = await loadProtocol(resolve(projectRoot));
  return protocol;
}

async function verifyCores(db: SqlExecutor): Promise<MediaSourceVersion[]> {
  const versions: MediaSourceVersion[] = [];
  let indexed = false;
  for (const version of ["v1", "v2"] as const) {
    const namespace = version === "v1" ? "nb" : "nb_v2";
    const presence = (await db.query<{ namespace: string | null; state: string | null; migrations: string | null }>(
      "SELECT to_regnamespace($1)::text AS namespace,to_regclass($2)::text AS state,to_regclass($3)::text AS migrations",
      [namespace, `${namespace}.state`, `${namespace}.migrations`])).rows[0];
    if (!presence) failed();
    if (!presence.namespace && !presence.state && !presence.migrations) continue;
    if (!presence.namespace || !presence.state || !presence.migrations) failed();
    const state = (await db.query<{ protocol: string; schema_digest: string }>(`SELECT protocol,schema_digest FROM ${namespace}.state`)).rows;
    const expected = version === "v1" ? coreProtocol : websiteProtocol;
    if (state.length !== 1 || state[0].protocol !== expected.protocol || state[0].schema_digest !== expected.schemaDigest) failed();
    const migrations = (await db.query<{ version: string; digest: string }>(`SELECT version,digest FROM ${namespace}.migrations ORDER BY version`)).rows;
    const wanted = version === "v1" ? coreProtocol.migrations : [{ version: "001", sha256: websiteProtocol.migration.sha256 }];
    if (migrations.length !== wanted.length || wanted.some(entry => !migrations.some(row => row.version === entry.version && row.digest === entry.sha256))) failed();
    const source = (await db.query<{ available: boolean }>("SELECT to_regprocedure($1) IS NOT NULL AS available",
      [`${version === "v1" ? "nb_media_api" : "nb_v2_media_api"}.read_source(text)`])).rows[0];
    indexed ||= source?.available === true;
    versions.push(version);
  }
  if (!versions.length || !indexed) failed();
  return versions;
}

/** Requires one dedicated operator connection. Does not close it or alter core state. */
export async function migrateThumbnails(db: SqlExecutor, projectRoot = ROOT): Promise<ThumbnailMigrationReport> {
  const protocol = await loadProtocol(resolve(projectRoot));
  let begun = false;
  try {
    await db.query("BEGIN"); begun = true;
    await db.query("SELECT pg_advisory_xact_lock(172904,3)");
    const coreVersions = await verifyCores(db);
    const presence = (await db.query<{ registry: string | null; schema: string | null; api: string | null }>(
      "SELECT to_regclass('nb_thumbnails.migrations')::text AS registry,to_regnamespace('nb_thumbnails')::text AS schema,to_regnamespace('nb_thumbnail_api')::text AS api")).rows[0];
    if (!presence) failed();
    let installed = false;
    if (!presence.registry && !presence.schema && !presence.api) {
      await db.query(protocol.sql);
      await db.query("UPDATE nb_thumbnails.migrations SET digest=$1 WHERE version=$2", [protocol.sha256, protocol.version]);
      installed = true;
    } else if (!presence.registry || !presence.schema || !presence.api) failed();
    const prior = (await db.query<{ version: string; digest: string }>("SELECT version,digest FROM nb_thumbnails.migrations ORDER BY version")).rows;
    if (prior.length !== 1 || prior[0].version !== protocol.version || prior[0].digest !== protocol.sha256) failed();
    const functions = (await db.query<{ available: boolean }>("SELECT to_regprocedure('nb_thumbnail_api.read_media(text,text,integer)') IS NOT NULL AND to_regprocedure('nb_thumbnail_api.register_media(text,uuid,text,text,text,integer,jsonb)') IS NOT NULL AND to_regprocedure('nb_thumbnails.qualified_source(text,text)') IS NOT NULL AND to_regclass('nb_thumbnails.media') IS NOT NULL AS available")).rows[0];
    if (functions?.available !== true) failed();
    await db.query("COMMIT"); begun = false;
    return { thumbnailCapability: protocol.capability, migrationVerified: true, installed, coreVersions };
  } catch {
    if (begun) await db.query("ROLLBACK").catch(() => {});
    return failed();
  }
}
