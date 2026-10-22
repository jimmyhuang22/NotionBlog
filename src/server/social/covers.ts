import { createHash } from "node:crypto";
import type { ImageAsset } from "../../../contracts/content.ts";
import type { SocialWork } from "../../../contracts/social.ts";
import type { SocialTimelineWork } from "../../../contracts/social-timeline.ts";
import type { FeedSnapshot } from "../../../contracts/home-feed.ts";
import type { StoredMedia } from "../../../contracts/sync.ts";
import { ContentServiceError } from "../../../contracts/repository.ts";
import type { SqlExecutor } from "../database/sql.ts";
import { validateMedia } from "../database/validation.ts";
import { eligibleCollectionMemberSql, latestCollectionMemberOrderSql } from "./collection-members.ts";

export type CoverMode = "trial" | "retained";
export type CoverKind = "publication" | "collection";
export interface CoverFiles { original: StoredMedia; previews: { "400": StoredMedia; "800": StoredMedia } }
export const coverOwner = (kind: CoverKind, key: string) => `social_${kind}_${key}`;
/** Page references follow the currently qualified binding, not a temporary upstream URL generation. */
export const coverReference = (kind: CoverKind, key: string) => `s2.${kind}.${key}`;
/** Renewed upstream URLs do not change the browser address of identical files. */
export function coverContentVersion(files: CoverFiles): string {
  return createHash("sha256").update(JSON.stringify([files.original, files.previews["400"], files.previews["800"]]
    .map(file => [file.sha256, file.byteSize, file.mime, file.width, file.height]))).digest("hex");
}
export const versionedCoverReference = (kind: CoverKind, key: string, files: CoverFiles) => `s3.${kind}.${key}.${coverContentVersion(files)}`;
export function coverAssetId(kind: CoverKind, key: string, sourceSha256: string, originalSha256: string): string {
  return `s1.${createHash("sha256").update(JSON.stringify([kind, key, sourceSha256, originalSha256])).digest("hex")}`;
}
export function socialMediaEnabled(value: string | undefined): boolean {
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new ContentServiceError("MISCONFIGURED", "Unsupported social media configuration.");
}
export function validateCoverFiles(value: unknown, kind: CoverKind, key: string): asserts value is CoverFiles {
  const bad = () => { throw new ContentServiceError("CONTENT_UNAVAILABLE", "Social media metadata is invalid."); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return bad();
  const v = value as CoverFiles;
  if (Object.keys(v).sort().join(",") !== "original,previews" || !v.previews ||
      Object.keys(v.previews).sort().join(",") !== "400,800") return bad();
  for (const [cap, media] of [[null, v.original], [400, v.previews["400"]], [800, v.previews["800"]]] as const) {
    validateMedia(media);
    if (media.ownerPageId !== coverOwner(kind, key) || !Number.isSafeInteger(media.width) || !Number.isSafeInteger(media.height) ||
        media.width! < 1 || media.height! < 1 || media.width! * media.height! > 40_000_000 || (cap && media.width! > cap)) return bad();
  }
}

/** Fixed invoker views. The only variable SQL input is a bounded JSON array of requested identities. */
export function coverSelectionSql(mode: CoverMode, playback = false): string {
  const prefix = mode === "retained" ? "retained_" : "";
  return `WITH wanted AS MATERIALIZED (SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(id text, collection_id text, publication_key text)),
    c AS MATERIALIZED (
      SELECT c.* FROM social_sync.${prefix}website_collections c
      WHERE EXISTS(SELECT 1 FROM wanted w WHERE w.collection_id=c.collection->>'id')
    ), members AS MATERIALIZED (
      SELECT m.* FROM social_sync.${prefix}website_collection_members m
      WHERE EXISTS(SELECT 1 FROM c WHERE c.collection_key=m.collection_key)
    ), p AS MATERIALIZED (
      SELECT p.* FROM social_sync.${prefix}website_publications p
      WHERE EXISTS(SELECT 1 FROM wanted w WHERE w.collection_id IS NULL AND w.id=p.work_id AND w.publication_key=p.publication->>'id')
        OR EXISTS(SELECT 1 FROM members m WHERE m.publication_key=p.publication->>'id')
    ),
    -- Resolve each requested owner once before checking bindings. Otherwise the
    -- planner can repeat the member lookup for every work/binding combination.
    chosen AS MATERIALIZED (
      SELECT w.id,CASE WHEN own.source_sha256 IS NOT NULL THEN 'collection' ELSE 'publication' END AS owner_kind,
        CASE WHEN own.source_sha256 IS NOT NULL THEN c.collection_key ELSE coalesce(w.publication_key,member.publication_key) END AS owner_key
      FROM wanted w LEFT JOIN c ON c.collection->>'id'=w.collection_id
      LEFT JOIN social_sync.cover_sources own ON own.owner_kind='collection' AND own.owner_key=c.collection_key
        AND own.display_mode=$2 AND own.observed_at=c.collection->>'observedAt'
      LEFT JOIN LATERAL (
        ${playback ? `SELECT candidate.publication_key FROM (
          SELECT publication_key FROM social_sync.${prefix}website_collection_playbacks WHERE collection_key=c.collection_key AND c.kind='season'
          UNION ALL
          SELECT p.publication->>'id' AS publication_key FROM members m JOIN p ON p.publication->>'id'=m.publication_key
          WHERE m.collection_key=c.collection_key AND c.kind='multi-part' AND p.publication->>'publicationId'=c.collection_id
        ) candidate WHERE own.source_sha256 IS NULL LIMIT 1` : `SELECT p.publication->>'id' AS publication_key FROM members m
        JOIN p ON p.publication->>'id'=m.publication_key WHERE own.source_sha256 IS NULL AND m.collection_key=c.collection_key
        AND ${eligibleCollectionMemberSql}
        ORDER BY ${latestCollectionMemberOrderSql} LIMIT 1`}
      ) member ON true
      WHERE (w.collection_id IS NOT NULL AND c.collection_key IS NOT NULL) OR
        (w.collection_id IS NULL AND EXISTS(SELECT 1 FROM p WHERE p.work_id=w.id AND p.publication->>'id'=w.publication_key))
    ) SELECT x.id,b.asset_id,b.owner_kind,b.owner_key,b.files FROM chosen x
      CROSS JOIN LATERAL (
        SELECT asset_id,owner_kind,owner_key,files FROM social_sync.cover_bindings b
        WHERE b.owner_kind=x.owner_kind AND b.owner_key=x.owner_key AND b.display_mode=$2
        OFFSET 0
      ) b`;
}
/** Cover decoration deliberately happens AFTER the existing pagination digest is computed. */
export async function withSocialCovers<T extends SocialWork>(snapshot: FeedSnapshot<T>, sql: SqlExecutor, mode: CoverMode, playback = false): Promise<FeedSnapshot<T>> {
  if (!snapshot.items.length) return snapshot;
  const wanted = snapshot.items.map(item => {
    const collection = (item as SocialWork & Partial<SocialTimelineWork>).collection;
    return { id: item.id, collection_id: collection?.id ?? null, publication_key: collection ? null : item.publications[0]!.id };
  });
  try {
    const meta = (await sql.query<{ version: number }>("SELECT version FROM social_sync.cover_meta WHERE singleton")).rows;
    if (meta.length !== 1 || meta[0]!.version !== 1) throw Error();
    const rows = (await sql.query<{ id: string; asset_id: string; owner_kind: CoverKind; owner_key: string; files: unknown }>(coverSelectionSql(mode,playback), [JSON.stringify(wanted), mode])).rows;
    if (rows.length > wanted.length || Buffer.byteLength(JSON.stringify(rows)) > 2 * 1024 * 1024) throw Error();
    const covers = new Map<string, ImageAsset>();
    for (const row of rows) {
      if (!wanted.some(w => w.id === row.id) || covers.has(row.id) || !["publication", "collection"].includes(row.owner_kind) ||
          !/^[a-f0-9]{64}$/.test(row.owner_key) || !/^s1\.[a-f0-9]{64}$/.test(row.asset_id)) throw Error();
      validateCoverFiles(row.files, row.owner_kind, row.owner_key);
      covers.set(row.id, { id: row.asset_id, src: `/media/social/${versionedCoverReference(row.owner_kind, row.owner_key, row.files)}`, alt: "", width: row.files.original.width, height: row.files.original.height });
    }
    return { version: snapshot.version, items: snapshot.items.map(item => ({ ...item, cover: covers.get(item.id) ?? null })) };
  } catch { throw new ContentServiceError("CONTENT_UNAVAILABLE", "Social covers are temporarily unavailable."); }
}
