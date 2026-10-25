import { resolve } from "node:path";
import { ContentServiceError } from "../../../contracts/repository.ts";
import type { StoredMedia } from "../../../contracts/sync.ts";
import { WEBSITE_PROTOCOL, WEBSITE_SCHEMA_DIGEST } from "../../../contracts/website-sync.ts";
import coreProtocol from "../../../database/website-protocol.json" with {type: "json"};
import studyProtocol from "../../../database/website-study-protocol.json" with {type: "json"};
import publicationProtocol from "../../../database/publication-protocol.json" with {type: "json"};
import deltaProtocol from "../../../database/incremental-publication-protocol.json" with {type: "json"};
import readerIsolation from "../../../database/incremental-reader-isolation.json" with {type: "json"};
import withdrawalRecovery from "../../../database/incremental-withdrawal-recovery.json" with {type: "json"};
import readerProtocol from "../../../database/incremental-reader-protocol.json" with {type: "json"};
import mediaProtocol from "../../../database/website-media-protocol.json" with {type: "json"};
import thumbnailProtocol from "../../../database/thumbnail-protocol.json" with {type: "json"};
import publishedThumbnailProtocol from "../../../database/published-thumbnails-protocol.json" with {type: "json"};
import courseThumbnailProtocol from "../../../database/course-cover-thumbnails-protocol.json" with {type: "json"};
import bodyThumbnailProtocol from "../../../database/body-image-thumbnails-protocol.json" with {type: "json"};
import { preparePublicationDelta } from "./incremental-publication.ts";
import { canonicalJson, mediaIdentity, validateMedia } from "./website-validation.ts";
import { websiteArchiveColumns, validateWebsiteArchive, archivedWebsiteObjects, WEBSITE_ARCHIVE_MAX_BYTES, type WebsiteDatabaseArchive } from "./website-archive.ts";
import { createPrivateWebsiteArchiveStore } from "./website-archive-files.ts";
import type { SqlExecutor } from "./sql.ts";

type Row = Record<string, unknown>;
type Migration = {version: string; digest: string};
export interface PublicationArchive {
  format: "notionblog-publication-archive-1";
  /** PRIVATE: policy, historical bodies, source evidence and operation payloads. */
  core: WebsiteDatabaseArchive;
  migrations: Migration[];
  publication: Row[];
  incremental: {state: Row[]; operations: Row[]};
  thumbnails: null | {migrationDigest: string; media: Row[]; publishedMigrationDigest?: string;
    course1600MigrationDigest?: string; body1600MigrationDigest?: string};
}
const coreTables = Object.keys(websiteArchiveColumns) as (keyof typeof websiteArchiveColumns)[];
const pubKeys = ["singleton", "version", "migration_digest", "run_id", "published_at"];
const deltaKeys = ["singleton", "version", "migration_digest", "reader_digest"];
const deltaExtensions: Record<string, string> = { reader_isolation_digest: readerIsolation.migration.sha256, withdrawal_recovery_digest: withdrawalRecovery.migration.sha256 };
const operationKeys = ["operation_id", "payload_digest", "expected_revision", "config_digest", "records", "media", "withdrawals", "receipt", "committed_at"];
const thumbnailKeys = ["version", "run_id", "parent_asset_id", "parent_sha", "source_fingerprint", "width_cap", "descriptor"];
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const uuid = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const revision = (v: unknown): v is string => typeof v === "string" && v.split(":").length === 2 && uuid(v.split(":")[0]) && /^[0-9]+$/.test(v.split(":")[1] ?? "");
const timestamp = (v: unknown): boolean => typeof v === "string" && Number.isFinite(Date.parse(v));
function fail(): never { throw new ContentServiceError("CONTENT_UNAVAILABLE", "Publication archive or empty restore target is incompatible."); }
function object(v: unknown): v is Row { return !!v && typeof v === "object" && !Array.isArray(v); }
function exact(v: unknown, keys: string[]): v is Row { return object(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k)); }
function migrations(rows: unknown): rows is Migration[] {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 2 || rows.some(r => !exact(r, ["version", "digest"]))) return false;
  const expected = new Map([["001", coreProtocol.migration.sha256], [studyProtocol.migration.version, studyProtocol.migration.sha256]]);
  const seen = new Set<string>();
  for (const r of rows) {
    if (typeof r.version !== "string" || expected.get(r.version) !== r.digest || seen.has(r.version)) return false;
    seen.add(r.version);
  }
  return seen.has("001");
}
/** Validate complete extension identities before any restore transaction opens. */
export function validatePublicationArchive(value: unknown): asserts value is PublicationArchive {
  if (!exact(value, ["format", "core", "migrations", "publication", "incremental", "thumbnails"]) || value.format !== "notionblog-publication-archive-1" ||
      !migrations(value.migrations) || !Array.isArray(value.publication) || value.publication.length !== 1 ||
      !exact(value.incremental, ["state", "operations"]) || !Array.isArray(value.incremental.state) || value.incremental.state.length !== 1 ||
      !Array.isArray(value.incremental.operations)) fail();
  validateWebsiteArchive(value.core);
  const a = value as unknown as PublicationArchive, p = a.publication[0], d = a.incremental.state[0];
  const extensions = object(d) ? Object.keys(deltaExtensions).filter(key => Object.hasOwn(d, key)) : [];
  if (!exact(p, pubKeys) || p.singleton !== true || p.version !== 1 || p.migration_digest !== publicationProtocol.migration.sha256 ||
      !(p.run_id === null || uuid(p.run_id)) || !(p.published_at === null || timestamp(p.published_at)) ||
      (p.run_id === null) !== (p.published_at === null) || !exact(d, [...deltaKeys, ...extensions]) || d.singleton !== true || d.version !== 1 ||
      d.migration_digest !== deltaProtocol.migration.sha256 || d.reader_digest !== readerProtocol.migration.sha256 ||
      extensions.some(key => d[key] !== deltaExtensions[key])) fail();
  if (p.run_id !== null && !a.core.tables.runs.some(r => r.id === p.run_id && r.status === "published")) fail();
  if (!a.migrations.some(m => m.version === studyProtocol.migration.version) &&
      a.core.tables.sources.some(s => s.mode === "course-descendants" || s.kind === "course" && s.mode === "all")) fail();
  let count = Object.values(a.core.tables).reduce((n, rows) => n + rows.length, 0) + a.incremental.operations.length;
  if (a.core.format === "notionblog-website-archive-2") count += a.core.mediaSources.sources.length;
  const operations = new Set<string>();
  for (const o of a.incremental.operations) {
    if (!exact(o, operationKeys) || !uuid(o.operation_id) || operations.has(o.operation_id) || !hash(o.payload_digest) ||
        !revision(o.expected_revision) || !hash(o.config_digest) || !timestamp(o.committed_at) || !exact(o.receipt,
          ["operationId", "payloadDigest", "publicationRevision", "upserts", "withdrawals", "removedRecords", "records", "media", "committed"])) fail();
    const r = o.receipt;
    if (r.operationId !== o.operation_id || r.payloadDigest !== o.payload_digest || r.committed !== true || !revision(r.publicationRevision) ||
        !r.publicationRevision.startsWith(`${o.operation_id}:`) ||
        ![r.upserts, r.withdrawals, r.removedRecords, r.records, r.media].every(n => Number.isSafeInteger(n) && Number(n) >= 0 && Number(n) <= 20000) ||
        !a.core.tables.runs.some(run => run.id === o.operation_id && run.status === "published" && run.config_digest === o.config_digest)) fail();
    try { preparePublicationDelta({expectedRevision: o.expected_revision, configDigest: o.config_digest,
      upserts: o.records as Parameters<typeof preparePublicationDelta>[0]["upserts"], media: o.media as StoredMedia[],
      withdrawals: o.withdrawals as Parameters<typeof preparePublicationDelta>[0]["withdrawals"]}); } catch { fail(); }
    if (r.upserts !== (o.records as unknown[]).length || r.withdrawals !== (o.withdrawals as unknown[]).length) fail();
    operations.add(o.operation_id);
  }
  if (a.thumbnails !== null) {
    const optional = ["publishedMigrationDigest", "course1600MigrationDigest", "body1600MigrationDigest"].filter(key => Object.hasOwn(a.thumbnails!, key));
    if (!exact(a.thumbnails, ["migrationDigest", "media", ...optional]) ||
        a.thumbnails.migrationDigest !== thumbnailProtocol.migrations[0].sha256 || !Array.isArray(a.thumbnails.media) ||
        Object.hasOwn(a.thumbnails, "publishedMigrationDigest") && a.thumbnails.publishedMigrationDigest !== publishedThumbnailProtocol.migration.sha256 ||
        Object.hasOwn(a.thumbnails, "course1600MigrationDigest") && a.thumbnails.course1600MigrationDigest !== courseThumbnailProtocol.migration.sha256 ||
        Object.hasOwn(a.thumbnails, "body1600MigrationDigest") && (a.thumbnails.body1600MigrationDigest !== bodyThumbnailProtocol.migration.sha256 ||
          a.thumbnails.course1600MigrationDigest !== courseThumbnailProtocol.migration.sha256)) fail();
    count += a.thumbnails.media.length;
    const seen = new Set<string>();
    for (const t of a.thumbnails.media) {
      if (!exact(t, thumbnailKeys) || t.version !== "v2" || !uuid(t.run_id) || typeof t.parent_asset_id !== "string" ||
          !/^a1\.[a-f0-9]{64}$/.test(t.parent_asset_id) || !hash(t.parent_sha) || !hash(t.source_fingerprint) ||
          typeof t.width_cap !== "number" || ![400, 800, ...(a.thumbnails.course1600MigrationDigest ? [1600] : [])].includes(t.width_cap)) fail();
      const m = t.descriptor as StoredMedia;
      try { validateMedia(m); } catch { fail(); }
      const key = `${t.run_id}/${t.parent_asset_id}/${t.width_cap}`;
      if (seen.has(key) || m.mime !== "image/webp" || m.width === null || m.height === null || m.width > Number(t.width_cap) ||
          t.width_cap === 1600 && m.width !== 1600 ||
          m.assetId !== mediaIdentity(m.ownerPageId, `thumbnail:${t.width_cap}:${t.parent_asset_id}`, m.sha256)) fail();
      seen.add(key);
    }
  }
  if (count > 200_000 || Buffer.byteLength(JSON.stringify(a)) > WEBSITE_ARCHIVE_MAX_BYTES) fail();
  archivedPublicationObjects(a);
}
export function archivedPublicationObjects(archive: PublicationArchive): StoredMedia[] {
  const objects = new Map(archivedWebsiteObjects(archive.core).map(m => [m.objectKey, m]));
  for (const t of archive.thumbnails?.media ?? []) {
    const m = t.descriptor as StoredMedia, old = objects.get(m.objectKey);
    if (old && (old.byteSize !== m.byteSize || old.mime !== m.mime)) fail();
    objects.set(m.objectKey, m);
  }
  return [...objects.values()];
}
function supported(hybrid: boolean, study: boolean, thumbnails: boolean) {
  const names = ["nb_v2", "nb_v2_api", "nb_publication", "nb_publication_api", "nb_delta", "nb_delta_api",
    ...(hybrid ? ["nb_v2_media", "nb_v2_media_api"] : []), ...(study ? ["nb_study", "nb_study_api"] : []),
    ...(thumbnails ? ["nb_thumbnails", "nb_thumbnail_api"] : [])];
  return `NOT EXISTS(SELECT FROM pg_namespace WHERE nspname ~ '^nb_(v2|publication|delta|study|thumbnail)' AND nspname NOT IN (${names.map(n => `'${n}'`).join(",")}))`;
}
/** Preflight only chooses optional SQL; one statement captures all data and identities. */
export async function exportPublicationArchive(db: SqlExecutor): Promise<PublicationArchive> {
  const f = (await db.query<{hybrid: boolean; study: boolean; thumbnails: boolean; publishedThumbnails: boolean; course1600: boolean; body1600: boolean}>(`SELECT
    to_regnamespace('nb_v2_media') IS NOT NULL AS hybrid,to_regnamespace('nb_study') IS NOT NULL AS study,
    to_regnamespace('nb_thumbnails') IS NOT NULL AS thumbnails,
    (to_regprocedure('nb_publication_api.read_thumbnail(text,integer,text)') IS NOT NULL OR
     to_regprocedure('nb_publication_api.check_thumbnail_capability(text)') IS NOT NULL) AS "publishedThumbnails",
    to_regclass('nb_thumbnails.extensions') IS NOT NULL AS "course1600",
    to_regclass('nb_thumbnails.body_extensions') IS NOT NULL AS "body1600"`)).rows[0];
  if (!f || ![f.hybrid, f.study, f.thumbnails, f.publishedThumbnails, f.course1600, f.body1600].every(v => typeof v === "boolean") ||
      f.publishedThumbnails && !f.thumbnails || f.body1600 && !f.course1600 || f.course1600 && !f.thumbnails) fail();
  const core = `jsonb_build_object('format','notionblog-website-archive-${f.hybrid ? 2 : 1}',
    'protocol','${WEBSITE_PROTOCOL}','schemaDigest','${WEBSITE_SCHEMA_DIGEST}','migrationDigest','${coreProtocol.migration.sha256}',
    'tables',jsonb_build_object(${coreTables.map(t => `'${t}',(SELECT COALESCE(jsonb_agg(x),'[]') FROM nb_v2.${t} x)`).join(",")})
    ${f.hybrid ? `,'mediaSources',jsonb_build_object('capability','${mediaProtocol.capability}',
      'migrationDigest',CASE WHEN (SELECT count(*) FROM nb_v2_media.migrations)=1 THEN (SELECT digest FROM nb_v2_media.migrations WHERE version='${mediaProtocol.migrations[0].version}') END,
      'sources',(SELECT COALESCE(jsonb_agg(x),'[]') FROM nb_v2_media.sources x))` : ""})`;
  const {rows} = await db.query<{data: unknown}>(`WITH archive AS(SELECT jsonb_build_object('format','notionblog-publication-archive-1',
    'core',${core},'migrations',(SELECT jsonb_agg(jsonb_build_object('version',version,'digest',digest) ORDER BY version) FROM nb_v2.migrations),
    'publication',(SELECT jsonb_agg(x) FROM nb_publication.state x),
    'incremental',jsonb_build_object('state',(SELECT jsonb_agg(x) FROM nb_delta.state x),'operations',(SELECT COALESCE(jsonb_agg(x),'[]') FROM nb_delta.operations x)),
    'thumbnails',${f.thumbnails ? `jsonb_build_object('migrationDigest',CASE WHEN (SELECT count(*) FROM nb_thumbnails.migrations)=1 THEN
      (SELECT digest FROM nb_thumbnails.migrations WHERE version='${thumbnailProtocol.migrations[0].version}') END,
      'media',(SELECT COALESCE(jsonb_agg(x),'[]') FROM nb_thumbnails.media x WHERE version='v2')
      ${f.publishedThumbnails ? `,'publishedMigrationDigest',CASE WHEN nb_publication_api.check_thumbnail_capability('${publishedThumbnailProtocol.migration.sha256}') THEN '${publishedThumbnailProtocol.migration.sha256}' END` : ""}
      ${f.course1600 ? `,'course1600MigrationDigest',CASE WHEN (SELECT count(*) FROM nb_thumbnails.extensions)=1 THEN (SELECT digest FROM nb_thumbnails.extensions WHERE version='${courseThumbnailProtocol.migration.version}') END` : ""}
      ${f.body1600 ? `,'body1600MigrationDigest',CASE WHEN (SELECT count(*) FROM nb_thumbnails.body_extensions)=1 THEN (SELECT digest FROM nb_thumbnails.body_extensions WHERE version='${bodyThumbnailProtocol.migration.version}') END` : ""})` : "NULL"}) AS data)
    SELECT CASE WHEN ${supported(f.hybrid, f.study, f.thumbnails)} AND octet_length(data::text)<=$1 THEN data ELSE NULL END AS data FROM archive`, [WEBSITE_ARCHIVE_MAX_BYTES]);
  const result = rows[0]?.data; validatePublicationArchive(result);
  if (f.study !== result.migrations.some(m => m.version === studyProtocol.migration.version)) fail();
  return result;
}
/** Dedicated migration-owner connection. Restored history never reactivates publication. */
export async function restorePublicationArchive(db: SqlExecutor, archive: PublicationArchive): Promise<void> {
  validatePublicationArchive(archive);
  const hybrid = archive.core.format === "notionblog-website-archive-2", study = archive.migrations.length === 2, thumbnails = archive.thumbnails !== null;
  await db.query("BEGIN");
  try {
    await db.query("SET LOCAL lock_timeout='5s'"); await db.query("SELECT pg_advisory_xact_lock(172904,2)");
    await db.query(`LOCK TABLE ${[...coreTables.map(t => `nb_v2.${t}`), "nb_publication.state", "nb_delta.state", "nb_delta.operations",
      ...(hybrid ? ["nb_v2_media.sources"] : []), ...(thumbnails ? ["nb_thumbnails.media"] : [])].join(",")} IN EXCLUSIVE MODE`);
    await db.query(`LOCK TABLE ${["nb_v2.migrations", ...(hybrid ? ["nb_v2_media.migrations"] : []), ...(thumbnails ? ["nb_thumbnails.migrations"] : []),
      ...(archive.thumbnails?.course1600MigrationDigest ? ["nb_thumbnails.extensions"] : []),
      ...(archive.thumbnails?.body1600MigrationDigest ? ["nb_thumbnails.body_extensions"] : [])].join(",")} IN SHARE MODE`);
    const target = await exportPublicationArchive(db);
    if (target.core.format !== archive.core.format || canonicalJson(target.migrations.map(m => [m.version, m.digest]).sort()) !== canonicalJson(archive.migrations.map(m => [m.version, m.digest]).sort()) ||
        (target.thumbnails !== null) !== thumbnails || target.thumbnails?.publishedMigrationDigest !== archive.thumbnails?.publishedMigrationDigest ||
        target.thumbnails?.course1600MigrationDigest !== archive.thumbnails?.course1600MigrationDigest ||
        target.thumbnails?.body1600MigrationDigest !== archive.thumbnails?.body1600MigrationDigest ||
        target.publication[0].run_id !== null || target.publication[0].published_at !== null ||
        Object.keys(deltaExtensions).some(key => target.incremental.state[0][key] !== archive.incremental.state[0][key]) ||
        target.incremental.operations.length || (target.thumbnails?.media.length ?? 0) ||
        (target.core.format === "notionblog-website-archive-2" && target.core.mediaSources.sources.length) ||
        coreTables.some(t => t !== "state" && target.core.tables[t].length)) fail();
    const state = target.core.tables.state[0];
    if (["current_run", "lease_run", "lease_until", "config_digest"].some(k => state[k] !== null) ||
        ["revision", "epoch", "fence", "freshness_seconds"].some(k => state[k] !== 0)) fail();
    await db.query("DELETE FROM nb_v2.state");
    for (const table of coreTables) await db.query(`INSERT INTO nb_v2.${table} SELECT * FROM jsonb_populate_recordset(NULL::nb_v2.${table},$1::jsonb)`, [JSON.stringify(archive.core.tables[table])]);
    if (archive.core.format === "notionblog-website-archive-2") await db.query("INSERT INTO nb_v2_media.sources SELECT * FROM jsonb_populate_recordset(NULL::nb_v2_media.sources,$1::jsonb)", [JSON.stringify(archive.core.mediaSources.sources)]);
    await db.query("DELETE FROM nb_publication.state");
    await db.query("INSERT INTO nb_publication.state SELECT * FROM jsonb_populate_recordset(NULL::nb_publication.state,$1::jsonb)", [JSON.stringify(archive.publication)]);
    await db.query("INSERT INTO nb_delta.operations SELECT * FROM jsonb_populate_recordset(NULL::nb_delta.operations,$1::jsonb)", [JSON.stringify(archive.incremental.operations)]);
    if (archive.thumbnails) await db.query("INSERT INTO nb_thumbnails.media SELECT * FROM jsonb_populate_recordset(NULL::nb_thumbnails.media,$1::jsonb)", [JSON.stringify(archive.thumbnails.media)]);
    await db.query("UPDATE nb_publication.state SET run_id=NULL,published_at=NULL");
    await db.query("UPDATE nb_v2.state SET current_run=NULL,lease_run=NULL,lease_until=NULL,revision=revision+1,epoch=epoch+1,fence=fence+1");
    await db.query("UPDATE nb_v2.runs SET valid_until=statement_timestamp()-interval '1 second',status=CASE WHEN status='staging' THEN 'failed' ELSE status END");
    await db.query("COMMIT");
  } catch (error) { try { await db.query("ROLLBACK"); } catch { /* Preserve the restore failure; the caller must discard this connection. */ } throw error; }
}
export function createPublicationArchiveStore(privateRoot = resolve(".local")) {
  return createPrivateWebsiteArchiveStore<PublicationArchive>(privateRoot, {validate: validatePublicationArchive, objects: archivedPublicationObjects});
}
