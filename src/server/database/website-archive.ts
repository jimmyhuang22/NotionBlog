import { WEBSITE_PROTOCOL, WEBSITE_SCHEMA_DIGEST } from "../../../contracts/website-sync.ts";
import type { StoredMedia } from "../../../contracts/sync.ts";
import { ContentServiceError } from "../../../contracts/repository.ts";
import protocol from "../../../database/website-protocol.json" with { type: "json" };
import mediaProtocol from "../../../database/website-media-protocol.json" with { type: "json" };
import { validateMediaSource, type MediaSourceBinding } from "../media/notion-source.ts";
import { validateMedia } from "./validation.ts";
import type { SqlExecutor } from "./sql.ts";

export const WEBSITE_ARCHIVE_MAX_BYTES = 64 * 1024 * 1024;
const MAX_ROWS = 200_000;
export const websiteArchiveColumns = {
  state: ["singleton", "protocol", "schema_digest", "revision", "epoch", "config_digest", "freshness_seconds", "current_run", "lease_run", "fence", "lease_until"],
  sources: ["key", "kind", "mode", "data_source_id", "database_parent_id", "page_id"],
  permits: ["id", "kind", "source_key", "course_id", "parent_id"],
  denied: ["id"],
  runs: ["id", "fence", "revision", "epoch", "config_digest", "started_at", "finished_at", "valid_until", "status", "record_count", "media_count"],
  records: ["run_id", "id", "kind", "source_key", "course_id", "parent_id", "ordinal", "item", "document"],
  media: ["run_id", "asset_id", "owner_page_id", "descriptor"],
  tombstones: ["run_id", "id", "reason"],
} as const;
const columns = websiteArchiveColumns;
const tables = Object.keys(columns) as (keyof typeof columns)[];
function supportedNamespace(hybrid: boolean): string {
  const allowed = hybrid ? "'nb_v2_api','nb_v2_media','nb_v2_media_api'" : "'nb_v2_api'";
  return `NOT EXISTS(SELECT FROM pg_namespace WHERE
    (nspname LIKE 'nb\\_v2\\_%' ESCAPE '\\' AND nspname NOT IN (${allowed})) OR
    nspname IN ('nb_publication','nb_publication_api','nb_delta','nb_delta_api','nb_study','nb_study_api'))`;
}
type Row = Record<string, unknown>;
interface WebsiteArchiveBase {
  protocol: string;
  schemaDigest: string;
  migrationDigest: string;
  /** PRIVATE: includes all historical batches, source identities, policy and bodies. */
  tables: Record<keyof typeof columns, Row[]>;
}
interface WebsiteCoreArchive extends WebsiteArchiveBase { format: "notionblog-website-archive-1" }
interface WebsiteHybridArchive extends WebsiteArchiveBase {
  format: "notionblog-website-archive-2";
  mediaSources: {
    capability: string;
    migrationDigest: string;
    /** PRIVATE: generation-bound locators; never contains signed URLs or credentials. */
    sources: { run_id: string; asset_id: string; binding: MediaSourceBinding }[];
  };
}
export type WebsiteDatabaseArchive = WebsiteCoreArchive | WebsiteHybridArchive;
function unavailable(): never {
  throw new ContentServiceError("CONTENT_UNAVAILABLE", "Website archive or restore target is incompatible.");
}
function object(value: unknown): value is Row {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(row: Row, keys: readonly string[]): boolean {
  return Object.keys(row).length === keys.length && keys.every(k => Object.hasOwn(row, k));
}
function compatibleState(row: Row): boolean {
  return row.singleton === true && row.protocol === WEBSITE_PROTOCOL && row.schema_digest === WEBSITE_SCHEMA_DIGEST;
}
function integer(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function jsonSafe(value: unknown, depth = 0): boolean {
  if (depth > 96) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(v => jsonSafe(v, depth + 1));
  return object(value) && Object.values(value).every(v => jsonSafe(v, depth + 1));
}
export function validateWebsiteArchive(value: unknown): asserts value is WebsiteDatabaseArchive {
  const hybrid = object(value) && value.format === "notionblog-website-archive-2";
  if (!object(value) || !exactKeys(value, ["format", "protocol", "schemaDigest", "migrationDigest", "tables", ...(hybrid ? ["mediaSources"] : [])]) ||
    !["notionblog-website-archive-1", "notionblog-website-archive-2"].includes(value.format as string) || value.protocol !== WEBSITE_PROTOCOL ||
    value.schemaDigest !== WEBSITE_SCHEMA_DIGEST || value.migrationDigest !== protocol.migration.sha256 ||
    !object(value.tables) || !exactKeys(value.tables, tables) || !jsonSafe(value)) unavailable();
  const archive = value as unknown as WebsiteDatabaseArchive;
  let count = 0;
  for (const table of tables) {
    const rows = archive.tables[table];
    if (!Array.isArray(rows) || (count += rows.length) > MAX_ROWS) unavailable();
    for (const row of rows) {
      if (!object(row) || !exactKeys(row, columns[table])) unavailable();
      for (const key of ["revision", "epoch", "fence", "freshness_seconds", "ordinal", "record_count", "media_count"]) {
        if (Object.hasOwn(row, key) && !(["record_count", "media_count"].includes(key) && row[key] === null) && !integer(row[key])) unavailable();
      }
      const numbers = ["revision", "epoch", "fence", "freshness_seconds", "ordinal", "record_count", "media_count"];
      const nullable = ["config_digest", "current_run", "lease_run", "lease_until", "data_source_id", "database_parent_id", "page_id", "course_id", "parent_id", "finished_at"];
      for (const [key, field] of Object.entries(row)) {
        if (numbers.includes(key) || key === "singleton") continue;
        if (["item", "document", "descriptor"].includes(key)) {
          if (!(key === "document" && field === null) && !object(field)) unavailable();
        } else if (!(nullable.includes(key) && field === null) && typeof field !== "string") unavailable();
      }
      for (const key of ["started_at", "finished_at", "valid_until", "lease_until"]) {
        if (row[key] !== undefined && row[key] !== null && !Number.isFinite(Date.parse(row[key] as string))) unavailable();
      }
      for (const key of ["run_id", "current_run", "lease_run", ...(table === "runs" ? ["id"] : [])]) {
        if (row[key] !== undefined && row[key] !== null && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(row[key] as string)) unavailable();
      }
      if (table === "records" && ((row.item as Row).id !== row.id || (row.item as Row).kind !== row.kind)) unavailable();
    }
  }
  if (archive.tables.state.length !== 1 || !compatibleState(archive.tables.state[0]) ||
    ["revision", "epoch", "fence"].some(k => Number(archive.tables.state[0][k]) >= Number.MAX_SAFE_INTEGER) ||
    Buffer.byteLength(JSON.stringify(archive)) > WEBSITE_ARCHIVE_MAX_BYTES) unavailable();
  archivedWebsiteObjects(archive);
  if (archive.format === "notionblog-website-archive-2") {
    const extension = archive.mediaSources;
    if (!object(extension) || !exactKeys(extension, ["capability", "migrationDigest", "sources"]) ||
      extension.capability !== mediaProtocol.capability || extension.migrationDigest !== mediaProtocol.migrations[0].sha256 ||
      !Array.isArray(extension.sources) || count + extension.sources.length > MAX_ROWS) unavailable();
    const descriptors = new Map<string, StoredMedia>();
    for (const row of archive.tables.media) {
      const key = `${row.run_id}/${row.asset_id}`;
      if (descriptors.has(key)) unavailable();
      descriptors.set(key, row.descriptor as StoredMedia);
    }
    const seen = new Set<string>();
    for (const row of extension.sources) {
      if (!object(row) || !exactKeys(row, ["run_id", "asset_id", "binding"]) || typeof row.run_id !== "string" || typeof row.asset_id !== "string") unavailable();
      const key = `${row.run_id}/${row.asset_id}`, media = descriptors.get(key);
      if (!media || seen.has(key)) unavailable();
      try { validateMediaSource(row.binding, media, "v2"); } catch { unavailable(); }
      seen.add(key);
    }
  }
}
/** One statement supplies an MVCC snapshot, including the installed migration identity. */
export async function exportWebsiteArchive(db: SqlExecutor): Promise<WebsiteDatabaseArchive> {
  // Preflight selects SQL that can reference optional tables; the final statement
  // re-checks namespaces and captures core, migration and locator rows together.
  const installed = (await db.query<{ hybrid: boolean }>("SELECT EXISTS(SELECT FROM pg_namespace WHERE nspname='nb_v2_media') AS hybrid")).rows[0]?.hybrid;
  if (typeof installed !== "boolean") unavailable();
  const extension = installed ? `,'mediaSources',jsonb_build_object('capability','${mediaProtocol.capability}',
    'migrationDigest',CASE WHEN (SELECT count(*) FROM nb_v2_media.migrations)=1 THEN
      (SELECT digest FROM nb_v2_media.migrations WHERE version='${mediaProtocol.migrations[0].version}') ELSE NULL END,
    'sources',(SELECT COALESCE(jsonb_agg(x),'[]') FROM nb_v2_media.sources x))` : "";
  const { rows } = await db.query<{ data: unknown }>(`WITH snapshot AS (SELECT jsonb_build_object(
    'format','notionblog-website-archive-${installed ? 2 : 1}','protocol','${WEBSITE_PROTOCOL}',
    'schemaDigest','${WEBSITE_SCHEMA_DIGEST}',
    'migrationDigest',CASE WHEN (SELECT count(*) FROM nb_v2.migrations)=1 THEN
      (SELECT digest FROM nb_v2.migrations WHERE version='001') ELSE NULL END,
    'tables',jsonb_build_object(${tables.map(t => `'${t}',(SELECT COALESCE(jsonb_agg(x),'[]') FROM nb_v2.${t} x)`).join(",")})${extension}) AS data)
    SELECT CASE WHEN ${supportedNamespace(installed)} AND octet_length(data::text)<=$1 THEN data ELSE NULL END AS data FROM snapshot`, [WEBSITE_ARCHIVE_MAX_BYTES]);
  const archive = rows[0]?.data;
  validateWebsiteArchive(archive);
  return archive;
}
/** Dedicated connection required. No storage/network operations occur inside this transaction. */
export async function restoreWebsiteArchive(db: SqlExecutor, archive: WebsiteDatabaseArchive): Promise<void> {
  validateWebsiteArchive(archive);
  const hybrid = archive.format === "notionblog-website-archive-2";
  await db.query("BEGIN");
  try {
    await db.query("SET LOCAL lock_timeout = '5s'");
    await db.query("SELECT pg_advisory_xact_lock(172904,2)");
    // Fixed order: policy/state first, then batches, owners and dependent rows.
    await db.query(`LOCK TABLE ${[...tables.map(t => `nb_v2.${t}`), ...(hybrid ? ["nb_v2_media.sources"] : [])].join(",")} IN EXCLUSIVE MODE`);
    await db.query(`LOCK TABLE nb_v2.migrations${hybrid ? ",nb_v2_media.migrations" : ""} IN SHARE MODE`);
    if ((await db.query<{ supported: boolean }>(`SELECT ${supportedNamespace(hybrid)} AS supported`)).rows[0]?.supported !== true) unavailable();
    const target = (await db.query<Row>("SELECT * FROM nb_v2.state FOR UPDATE")).rows;
    const migrations = (await db.query<{ version: string; digest: string }>("SELECT version,digest FROM nb_v2.migrations")).rows;
    if (target.length !== 1 || !compatibleState(target[0]) || migrations.length !== 1 ||
      migrations[0].version !== "001" || migrations[0].digest !== protocol.migration.sha256 ||
      ["current_run", "lease_run", "lease_until", "config_digest"].some(k => target[0][k] !== null) ||
      ["revision", "epoch", "fence", "freshness_seconds"].some(k => Number(target[0][k]) !== 0)) unavailable();
    if (hybrid) {
      const installed = (await db.query<{ version: string; digest: string }>("SELECT version,digest FROM nb_v2_media.migrations")).rows;
      if (installed.length !== 1 || installed[0].version !== mediaProtocol.migrations[0].version || installed[0].digest !== mediaProtocol.migrations[0].sha256) unavailable();
    }
    const { rows } = await db.query<{ empty: boolean }>(`SELECT ${tables.filter(t => t !== "state").map(t => `NOT EXISTS(SELECT FROM nb_v2.${t})`).join(" AND ")}${hybrid ? " AND NOT EXISTS(SELECT FROM nb_v2_media.sources)" : ""} AS empty`);
    if (rows[0]?.empty !== true) unavailable();
    await db.query("DELETE FROM nb_v2.state");
    for (const table of tables) {
      // Exact column validation above prevents jsonb_populate_recordset silently losing fields.
      await db.query(`INSERT INTO nb_v2.${table} SELECT * FROM jsonb_populate_recordset(NULL::nb_v2.${table},$1::jsonb)`, [JSON.stringify(archive.tables[table])]);
    }
    if (archive.format === "notionblog-website-archive-2") {
      await db.query("INSERT INTO nb_v2_media.sources SELECT * FROM jsonb_populate_recordset(NULL::nb_v2_media.sources,$1::jsonb)", [JSON.stringify(archive.mediaSources.sources)]);
    }
    await db.query("UPDATE nb_v2.state SET current_run=NULL,lease_run=NULL,lease_until=NULL,revision=revision+1,epoch=epoch+1,fence=fence+1");
    await db.query("UPDATE nb_v2.runs SET valid_until=statement_timestamp()-interval '1 second',status=CASE WHEN status='staging' THEN 'failed' ELSE status END");
    await db.query("COMMIT");
  } catch (cause) {
    await db.query("ROLLBACK");
    throw cause;
  }
}
/** Historical descriptors too; identical hashes cannot disagree about byte size or format. */
export function archivedWebsiteObjects(archive: WebsiteDatabaseArchive): StoredMedia[] {
  const objects = new Map<string, StoredMedia>();
  for (const row of archive.tables.media) {
    const media = row.descriptor as StoredMedia;
    validateMedia(media);
    if (row.asset_id !== media.assetId || row.owner_page_id !== media.ownerPageId) unavailable();
    const prior = objects.get(media.objectKey);
    if (prior && (prior.byteSize !== media.byteSize || prior.mime !== media.mime)) unavailable();
    objects.set(media.objectKey, media);
  }
  return [...objects.values()];
}
