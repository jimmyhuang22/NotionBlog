import { createHash } from "node:crypto";
import { cacheableMediaHeaders, revalidatedMediaHeaders } from "../media/cache.ts";
import { ContentServiceError } from "../../../contracts/repository.ts";
import type { SqlExecutor } from "../database/sql.ts";
import { verifyMediaBytes, type ObjectStorage } from "../database/storage.ts";
import { coverContentVersion, validateCoverFiles, type CoverKind, type CoverMode } from "./covers.ts";
import { readThumbnailBytes } from "../media/thumbnail-bytes.ts";

const noStore = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };
/** GET validators use weak comparison. Invalid/oversized lists fall back to full reads. */
function matchesEtag(value: string | null, etag: string): boolean {
  if (!value || value.length > 8192) return false;
  const list = value.trim();
  if (list === "*") return true;
  // RFC list recipients tolerate empty members; commas inside an opaque tag are not separators.
  if (!/^(?:(?:W\/)?"[\x21\x23-\x7e\x80-\xff]*")?[ \t]*(?:,[ \t]*(?:(?:W\/)?"[\x21\x23-\x7e\x80-\xff]*")?[ \t]*)*$/.test(list)) return false;
  return (list.match(/(?:W\/)?"[^"]*"/g) ?? []).some(tag => tag.replace(/^W\//, "") === etag);
}
/** Unknown parameters and duplicate thumbnail caps are rejected before touching storage. */
export function socialThumbnailWidth(url: string): 400 | 800 | null {
  const params = new URL(url).searchParams;
  if (!params.size) return null;
  const values = params.getAll("thumbnail");
  if (params.size !== 1 || values.length !== 1 || !["400", "800"].includes(values[0]!)) {
    throw new ContentServiceError("INVALID_QUERY", "Unsupported social image preview.");
  }
  return Number(values[0]) as 400 | 800;
}
export async function socialMediaResponse(assetId: string, width: 400 | 800 | null, mode: CoverMode, db: SqlExecutor, storage: () => ObjectStorage, ifNoneMatch: string | null = null): Promise<Response> {
  const missing = () => new Response(null, { status: 404, headers: noStore });
  const reference = /^s2\.(publication|collection)\.([a-f0-9]{64})$/.exec(assetId);
  const versioned = /^s3\.(publication|collection)\.([a-f0-9]{64})\.([a-f0-9]{64})$/.exec(assetId);
  const immutable = versioned?.[0] === assetId ? versioned : null;
  const stable = immutable ?? (reference?.[0] === assetId ? reference : null);
  if (!stable && /^s1\.[a-f0-9]{64}$/.exec(assetId)?.[0] !== assetId) return missing();
  const read = async () => {
    try {
      const rows = (await db.query<{ owner_kind: CoverKind; owner_key: string; files: unknown }>(
        stable
          ? "SELECT owner_kind,owner_key,files FROM social_sync.cover_bindings WHERE owner_kind=$1 AND owner_key=$2 AND display_mode=$3"
          : "SELECT owner_kind,owner_key,files FROM social_sync.cover_bindings WHERE asset_id=$1 AND display_mode=$2",
        stable ? [stable[1], stable[2], mode] : [assetId, mode])).rows;
      if (rows.length > 1) throw Error();
      if (!rows.length) return null;
      const row = rows[0]!; validateCoverFiles(row.files, row.owner_kind, row.owner_key);
      if (immutable && coverContentVersion(row.files) !== immutable[3]) return null;
      return width ? row.files.previews[String(width) as "400" | "800"] : row.files.original;
    } catch { throw new ContentServiceError("CONTENT_UNAVAILABLE", "Social media is temporarily unavailable."); }
  };
  const media = await read(); if (!media) return missing();
  // Bind to bytes and representation, not the upstream URL or registration generation.
  const etag = `"sc1-${createHash("sha256").update(JSON.stringify([assetId, mode, width, media.sha256, media.mime, media.byteSize])).digest("hex")}"`;
  const headers = immutable ? { ...cacheableMediaHeaders(noStore), ETag: etag }
    : stable ? revalidatedMediaHeaders(noStore, etag) : cacheableMediaHeaders(noStore);
  const recheck = async () => {
    const current = await read();
    if (current && JSON.stringify(current) !== JSON.stringify(media)) throw new ContentServiceError("CONTENT_UNAVAILABLE", "Social media changed during the request.");
    return current;
  };
  if (stable && matchesEtag(ifNoneMatch, etag)) {
    // A validator never grants access: recheck current RLS even when no object is read.
    if (!await recheck()) return missing();
    return new Response(null, { status: 304, headers });
  }
  // Cache only verified immutable bytes, never reader identity or positive eligibility.
  const bytes = immutable && width ? (await readThumbnailBytes(storage(), media)).bytes : await storage().read(media);
  verifyMediaBytes(media, bytes);
  // Recheck after a slow private object read; no withdrawal can start a new body.
  if (!await recheck()) return missing();
  return new Response(Buffer.from(bytes), { headers: { ...headers, "Content-Type": media.mime, "Content-Length": String(bytes.length) } });
}
