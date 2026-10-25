import { ContentServiceError } from "../../../contracts/repository.ts";

export interface DisplayFile {
  sha256: string;
  byteSize: number;
  mime: "image/webp";
  width: number;
  height: number;
}
export interface DisplayAsset {
  assetId: string;
  ownerPageId: string;
  sourceSha256: string;
  sourceFingerprint: string;
  base: DisplayFile;
  variants: Partial<Record<"400" | "800" | "1600", DisplayFile>>;
}
export interface DisplayManifest {
  format: "notionblog-display-v1";
  runId: string;
  recipe: string;
  assets: DisplayAsset[];
}
export const MAX_DISPLAY_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_DISPLAY_MANIFEST_BYTES = 16 * 1024 * 1024;
export const displayAssetId = (value: unknown): value is string => typeof value === "string" && value.length === 67 && /^a1\.[a-f0-9]{64}$/.test(value);
export const displayHash = (value: unknown): value is string => typeof value === "string" && value.length === 64 && /^[a-f0-9]{64}$/.test(value);
export const displayRunId = (value: unknown): value is string => typeof value === "string" && value.length === 36 && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
export function displayUnavailable(): never { throw new ContentServiceError("CONTENT_UNAVAILABLE", "The display image is unavailable."); }
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function integer(value: unknown, max: number): value is number { return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= max; }
export function validateDisplayFile(value: unknown): asserts value is DisplayFile {
  if (!exact(value, ["sha256", "byteSize", "mime", "width", "height"]) || !displayHash(value.sha256) ||
      value.mime !== "image/webp" || !integer(value.byteSize, MAX_DISPLAY_FILE_BYTES) ||
      !integer(value.width, 1600) || !integer(value.height, 16383)) displayUnavailable();
}
export function validateDisplayManifest(value: unknown): asserts value is DisplayManifest {
  if (!exact(value, ["format", "runId", "recipe", "assets"]) || value.format !== "notionblog-display-v1" ||
      !displayRunId(value.runId) || typeof value.recipe !== "string" ||
      !/^display-webp-v1:[a-f0-9]{64}$/.test(value.recipe) || value.recipe.length !== 80 ||
      !Array.isArray(value.assets) || value.assets.length > 20000) displayUnavailable();
  const assets = new Set<string>(), objects = new Map<string, string>();
  let total = 0;
  for (const asset of value.assets) {
    if (!exact(asset, ["assetId", "ownerPageId", "sourceSha256", "sourceFingerprint", "base", "variants"]) ||
        !displayAssetId(asset.assetId) || assets.has(asset.assetId) || !displayHash(asset.sourceSha256) || !displayHash(asset.sourceFingerprint) ||
        typeof asset.ownerPageId !== "string" || !asset.ownerPageId.length || asset.ownerPageId.length > 512 || /[\u0000-\u001f\u007f]/.test(asset.ownerPageId) ||
        !asset.variants || typeof asset.variants !== "object" || Array.isArray(asset.variants) ||
        Object.keys(asset.variants).some(key => !["400", "800", "1600"].includes(key))) displayUnavailable();
    assets.add(asset.assetId); validateDisplayFile(asset.base);
    for (const [cap, file] of Object.entries(asset.variants)) {
      validateDisplayFile(file);
      if (file.width > Math.min(Number(cap), asset.base.width) || file.height > asset.base.height ||
          Math.abs(file.width * asset.base.height - file.height * asset.base.width) > asset.base.width + asset.base.height) displayUnavailable();
    }
    for (const file of [asset.base, ...Object.values(asset.variants)] as DisplayFile[]) {
      const identity = JSON.stringify([file.byteSize, file.mime, file.width, file.height]), previous = objects.get(file.sha256);
      if (previous !== undefined && previous !== identity) displayUnavailable();
      if (previous === undefined) { objects.set(file.sha256, identity); total += file.byteSize; }
      if (total > 1024 * 1024 * 1024) displayUnavailable();
    }
  }
}
export function selectDisplayFile(asset: DisplayAsset, width: 400 | 800 | 1600 | null): DisplayFile {
  if (width === null) return asset.base;
  const explicit = asset.variants[String(width) as "400" | "800" | "1600"];
  if (explicit) return explicit;
  const target = Math.min(width, asset.base.width);
  const candidates = [asset.base, ...Object.values(asset.variants)] as DisplayFile[];
  return candidates.filter(file => file.width >= target).sort((a, b) => a.width - b.width || a.byteSize - b.byteSize)[0] ?? asset.base;
}
