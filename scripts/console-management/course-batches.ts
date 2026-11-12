import type { FreezePlan } from "../../src/server/database/freeze.ts";
import { FreezeError } from "../../src/server/database/freeze.ts";

/** Leave room for dependent metadata; the publication layer still enforces its
 * hard 100-record / 100-asset limit on the actual prepared delta. */
export function courseBatches(plan: Pick<FreezePlan, "members" | "media" | "thumbnailIds" | "rootId">): string[][] {
  const thumbnails = new Set(plan.thumbnailIds), counts = new Map<string, number>();
  const members = new Set(plan.members.map(m => m.id));
  if (members.size !== plan.members.length || !members.has(plan.rootId)) throw new FreezeError("FREEZE_INPUT_INVALID");
  for (const media of plan.media) {
    if (!members.has(media.ownerPageId)) throw new FreezeError("FREEZE_INPUT_INVALID");
    if (!thumbnails.has(media.assetId)) counts.set(media.ownerPageId, (counts.get(media.ownerPageId) ?? 0) + 1);
  }
  const batches: string[][] = []; let batch: string[] = [], images = 0;
  // Root first, then stable member order: retries use a fresh preview and current data.
  for (const id of [plan.rootId, ...plan.members.map(m => m.id).filter(id => id !== plan.rootId)]) {
    const n = counts.get(id) ?? 0;
    if (n > 100) throw new FreezeError("FREEZE_PAGE_TOO_LARGE");
    if (batch.length && (batch.length >= 15 || images + n > 40)) { batches.push(batch); batch = []; images = 0; }
    batch.push(id); images += n;
  }
  if (batch.length) batches.push(batch);
  return batches;
}
