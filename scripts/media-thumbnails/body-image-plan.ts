import type { ContentBlock, ContentKind } from "../../contracts/content.ts";
import type { PublicContentSnapshot } from "../../contracts/website.ts";
import { selectThumbnailCandidates } from "./coverage.ts";
import type { ThumbnailPlan } from "./plan.ts";
import type { ThumbnailWidthSelection } from "./widths.ts";

const KINDS: readonly ContentKind[] = ["album", "study-note", "game", "movie", "book", "status"];

/** Offline queue discovery from a saved qualified snapshot. No new source/SQL/image reads.
 * The result is a candidate plan, not permission to generate or publish anything.
 */
export function planBodyImageThumbnails(runId: string, snapshot: PublicContentSnapshot) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(runId)) throw Error("Invalid body-image generation.");
  const selection = selectThumbnailCandidates(snapshot, "v2", KINDS);
  const wide = new Set<string>();
  function visit(blocks: ContentBlock[]) {
    for (const block of blocks) {
      if (block.type === "image" && (block.image.width ?? 0) > 1600) wide.add(block.image.id);
      else if (block.type === "list") for (const item of block.items) visit(item.children);
      else if (block.type === "callout" || block.type === "toggle") visit(block.children);
      else if (block.type === "columns") for (const column of block.columns) visit(column.blocks);
    }
  }
  for (const detail of snapshot.records) if (KINDS.includes(detail.item.kind) && detail.document) visit(detail.document.blocks);
  const assetIds = selection.assets.filter(asset => wide.has(asset.assetId)).map(asset => asset.assetId);
  const plan: ThumbnailPlan | null = assetIds.length ? { version: "v2", runId, assetIds } : null;
  const widths: ThumbnailWidthSelection | null = plan ? { format: "notionblog-thumbnail-widths-v1", version: "v2", runId,
    assets: assetIds.map(assetId => ({ assetId, widthCaps: [1600] })) } : null;
  return { plan, widths, recordsConsidered: selection.recordsConsidered,
    unloadedDocuments: selection.unloadedDocuments, partialDocuments: selection.partialDocuments };
}
