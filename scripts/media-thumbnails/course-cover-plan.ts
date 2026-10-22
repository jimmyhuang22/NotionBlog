import type { ImageAsset } from "../../contracts/content.ts";
import type { ThumbnailPlan } from "./plan.ts";
import type { ThumbnailWidthSelection } from "./widths.ts";

/** Explicit operator opt-in; old global coverage/planning remains 400/800 only.
 * This snapshot selects candidates, never eligibility or permission to upload. */
export function planCourseCoverThumbnails(runId: string, records: readonly { item: {
  id: string; kind: string; cover: ImageAsset | null;
} }[]): { plan: ThumbnailPlan; widths: ThumbnailWidthSelection } {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(runId)) throw Error("Invalid course-cover generation.");
  const owners = new Set<string>(), assets = new Set<string>();
  for (const { item } of records) {
    if (item.kind !== "course") continue;
    if (!/^[a-f0-9]{32}$/.test(item.id) || owners.has(item.id)) throw Error("Invalid course-cover owner.");
    owners.add(item.id);
    if (!item.cover) continue;
    const image = item.cover;
    if (!/^a1\.[a-f0-9]{64}$/.test(image.id) || image.src !== `/media/v2/${image.id}`) continue;
    // Small originals enter the existing qualified original path.
    if (image.width === null) continue;
    if (!Number.isSafeInteger(image.width) || image.width < 1) throw Error("Invalid course-cover dimensions.");
    if (image.width < 1600) continue;
    assets.add(image.id);
  }
  if (!assets.size || assets.size > 20000) throw Error("No eligible course-cover candidates.");
  const assetIds = [...assets].sort();
  return { plan: { version: "v2", runId, assetIds }, widths: {
    format: "notionblog-thumbnail-widths-v1", version: "v2", runId,
    assets: assetIds.map(assetId => ({ assetId, widthCaps: [1600] })),
  } };
}
