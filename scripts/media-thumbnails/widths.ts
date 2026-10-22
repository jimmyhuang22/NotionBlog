import { ContentServiceError } from "../../contracts/repository.ts";
import type { ThumbnailWidth } from "../../src/server/database/thumbnail-index.ts";
import type { ThumbnailPlan } from "./plan.ts";

/** An explicit v2 width selection or narrowing of the existing two-cap plan, never additional assets. */
export interface ThumbnailWidthSelection {
  format: "notionblog-thumbnail-widths-v1";
  version: ThumbnailPlan["version"];
  runId: string;
  assets: { assetId: string; widthCaps: ThumbnailWidth[] }[];
}

function invalid(): never {
  throw new ContentServiceError("MISCONFIGURED", "The private thumbnail width selection is invalid.");
}
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

export function parseThumbnailWidthSelection(value: unknown, plan: ThumbnailPlan): ThumbnailWidthSelection {
  if (!exact(value, ["format", "version", "runId", "assets"]) ||
      value.format !== "notionblog-thumbnail-widths-v1" || value.version !== plan.version || value.runId !== plan.runId ||
      !Array.isArray(value.assets) || value.assets.length !== plan.assetIds.length) invalid();
  const selected = new Map<string, ThumbnailWidth[]>();
  const allowed = new Set(plan.assetIds);
  for (const entry of value.assets) {
    if (!exact(entry, ["assetId", "widthCaps"]) || typeof entry.assetId !== "string" ||
        !allowed.has(entry.assetId) || selected.has(entry.assetId) || !Array.isArray(entry.widthCaps) ||
        entry.widthCaps.length < 1 || entry.widthCaps.length > (plan.version === "v2" ? 3 : 2) ||
        Array.from(entry.widthCaps).some(width => width !== 400 && width !== 800 && !(plan.version === "v2" && width === 1600)) ||
        new Set(entry.widthCaps).size !== entry.widthCaps.length) invalid();
    const widthCaps = entry.widthCaps;
    selected.set(entry.assetId, [400, 800, 1600].filter(width => widthCaps.includes(width)) as ThumbnailWidth[]);
  }
  return { format: "notionblog-thumbnail-widths-v1", version: plan.version, runId: plan.runId,
    assets: plan.assetIds.map(assetId => ({ assetId, widthCaps: [...selected.get(assetId)!] })) };
}
