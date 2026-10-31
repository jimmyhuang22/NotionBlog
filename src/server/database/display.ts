import {ContentServiceError} from "../../../contracts/repository.ts";
import type {SqlExecutor} from "./sql.ts";
import type {PublicationMode} from "./publication.ts";
import {displayAssetId,displayRunId,validateDisplayManifest,type DisplayAsset} from "../self-hosted-media/manifest.ts";
// Read-only website protocol; install/registration/publishing stay in the private runtime.
// Exact digest of the reviewed display migration, checked by each SQL read RPC.
const protocolSHA256="ae599beef7a9f273e3d41f9a6d95c5f822b8005e4939cf98771b64edc40387a5";
export class DisplayError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; this.name = "DisplayError"; }
}
export function displayDeliveryMode(value: string | undefined): boolean {
  if (value === undefined || value === "legacy") return false;
  if (value === "display-only") return true;
  throw new ContentServiceError("MISCONFIGURED", "Invalid media delivery mode.");
}
export function validateDisplayAsset(asset: unknown): asserts asset is DisplayAsset {
  validateDisplayManifest({format: "notionblog-display-v1", runId: "00000000-0000-0000-0000-000000000001",
    recipe: "display-webp-v1:" + "0".repeat(64), assets: [asset]});
  const a = asset as DisplayAsset;
  if ([a.base, ...Object.values(a.variants)].some(f => f.sha256 === a.sourceSha256)) throw new DisplayError("DISPLAY_ORIGINAL_UPLOAD_FORBIDDEN");
}
export async function displayQuery<T>(db: SqlExecutor, sql: string, values: unknown[] = []): Promise<T> {
  try {
    const rows = (await db.query<{result: T}>(sql, values)).rows;
    if (rows.length !== 1 || !Object.hasOwn(rows[0], "result")) throw new DisplayError("DISPLAY_UNAVAILABLE");
    return rows[0].result;
  } catch (e) {
    if (e instanceof DisplayError) throw e;
    if (e instanceof Error && (e as {code?: string}).code === "P0001" && /^NB_(DISPLAY_[A-Z_]+|FREEZE_[A-Z_]+|DELTA_[A-Z_]+|BUSY)$/.test(e.message)) throw new DisplayError(e.message.slice(3));
    throw new DisplayError("DISPLAY_UNAVAILABLE");
  }
}
export interface DisplayProjection {runId: string; revision: string; asset: DisplayAsset}
export async function readDisplayMedia(db: SqlExecutor, assetId: string, mode: PublicationMode): Promise<DisplayProjection | null> {
  if (!displayAssetId(assetId)) return null;
  const value = await displayQuery<DisplayProjection | null>(db,"SELECT nb_display_api.read_media($1,$2,$3) AS result",[assetId,mode,protocolSHA256]);
  if (value === null) return null;
  if (!value || Object.keys(value).length !== 3 || !displayRunId(value.runId) || !/^[0-9]+$/.test(value.revision)) throw new DisplayError("DISPLAY_UNAVAILABLE");
  validateDisplayAsset(value.asset);
  if (value.asset.assetId !== assetId) throw new DisplayError("DISPLAY_UNAVAILABLE");
  return value;
}
export async function readDisplayAssets(db: SqlExecutor, runId: string, ids: string[], mode: PublicationMode) {
  if (!displayRunId(runId) || ids.length>20000 || ids.some(id=>!displayAssetId(id))) throw new DisplayError("DISPLAY_QUERY_INVALID");
  const result=await displayQuery<{runId: string;revision: string;assets: DisplayAsset[]}>(db,
    "SELECT nb_display_api.read_assets($1,$2::text[],$3,$4) AS result",[runId,ids,mode,protocolSHA256]);
  if (!result || Object.keys(result).length!==3 || result.runId!==runId || !/^[0-9]+$/.test(result.revision) || !Array.isArray(result.assets) ||
    result.assets.length>ids.length || new Set(result.assets.map(a=>a.assetId)).size!==result.assets.length) throw new DisplayError("DISPLAY_UNAVAILABLE");
  for(const asset of result.assets){validateDisplayAsset(asset);if(!ids.includes(asset.assetId))throw new DisplayError("DISPLAY_UNAVAILABLE");}
  return result;
}
