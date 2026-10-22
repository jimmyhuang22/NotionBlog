import type { SqlExecutor } from "../../src/server/database/sql.ts";
import { validateCoverFiles, coverAssetId, type CoverMode } from "../../src/server/social/covers.ts";
import { SocialSyncError } from "../social-sync/model.ts";
import { sourceDigest, validateCoverSource } from "./sources.ts";
import { refreshUnchangedCollectionSources } from "./collection-refresh.ts";
import type { CoverWriter } from "./worker.ts";

export function createCoverWriter(sql: SqlExecutor): CoverWriter {
  const scope = async (mode: CoverMode, kind: string, key: string) => {
    const rows = (await sql.query<{ visible: boolean }>("SELECT social_sync.cover_owner_visible($1,$2,$3) AS visible", [mode, kind, key])).rows;
    if (rows.length !== 1 || rows[0]!.visible !== true) throw new SocialSyncError("COVER_SCOPE_CHANGED");
  };
  return {
    refreshUnchangedCollections: (sources, mode) => refreshUnchangedCollectionSources(sql, sources, mode),
    async collectionSource(source, mode) {
      validateCoverSource(source); if (source.kind !== "collection") throw new SocialSyncError("COVER_SOURCE_INVALID");
      await scope(mode, source.kind, source.key);
      const rows = (await sql.query<{ current: boolean }>("SELECT social_sync.cover_collection_time($1,$2,$3) AS current", [mode, source.key, source.observedAt])).rows;
      if (rows.length !== 1 || rows[0]!.current !== true) throw new SocialSyncError("COVER_SCOPE_CHANGED");
      await sql.query(`INSERT INTO social_sync.cover_sources(display_mode,owner_kind,owner_key,source_sha256,observed_at) VALUES($4,'collection',$1,$2,$3)
        ON CONFLICT(display_mode,owner_kind,owner_key) DO UPDATE SET source_sha256=EXCLUDED.source_sha256,observed_at=EXCLUDED.observed_at`, [source.key, sourceDigest(source), source.observedAt, mode]);
    },
    async source(source, mode) {
      validateCoverSource(source); await scope(mode, source.kind, source.key);
      const rows = (await sql.query<{ source_sha256: string | null }>("SELECT source_sha256 FROM social_sync.cover_sources WHERE owner_kind=$1 AND owner_key=$2 AND display_mode=$3 AND social_sync.cover_source_matches($3,owner_kind,owner_key,source_sha256)", [source.kind, source.key, mode])).rows;
      if (rows.length > 1) throw new SocialSyncError("COVER_SOURCE_INVALID");
      return rows.length ? { sha256: rows[0]!.source_sha256 } : null;
    },
    async read(source, mode) {
      const rows = (await sql.query<{ source_sha256: string; files: unknown }>("SELECT source_sha256,files FROM social_sync.cover_bindings WHERE display_mode=$1 AND owner_kind=$2 AND owner_key=$3", [mode, source.kind, source.key])).rows;
      if (rows.length > 1) throw new SocialSyncError("COVER_SOURCE_INVALID");
      if (!rows.length) return null;
      const row = rows[0]!; validateCoverFiles(row.files, source.kind, source.key); return { sourceSha256: row.source_sha256, files: row.files };
    },
    async register(source, mode, files) {
      validateCoverSource(source); validateCoverFiles(files, source.kind, source.key);
      const digest = sourceDigest(source); if (!digest) throw new SocialSyncError("COVER_MISSING");
      const rows = (await sql.query<{ asset_id: string }>(`INSERT INTO social_sync.cover_bindings(display_mode,owner_kind,owner_key,source_sha256,files) VALUES($1,$2,$3,$4,$5::jsonb)
        ON CONFLICT(display_mode,owner_kind,owner_key) DO UPDATE SET source_sha256=EXCLUDED.source_sha256,files=EXCLUDED.files RETURNING asset_id`,
        [mode, source.kind, source.key, digest, JSON.stringify(files)])).rows;
      if (rows.length !== 1 || rows[0]!.asset_id !== coverAssetId(source.kind, source.key, digest, files.original.sha256)) throw new SocialSyncError("COVER_ACK_MISMATCH");
    },
  };
}
