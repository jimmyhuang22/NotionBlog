import test from "node:test";
import assert from "node:assert/strict";
import { fixtureItems } from "../fixtures/content.ts";
import type { ContentBlock } from "../contracts/content.ts";
import { planBodyImageThumbnails } from "../scripts/media-thumbnails/body-image-plan.ts";

test("body 1600 discovery excludes covers, ordinary pages, exact-width and unknown images", () => {
  const image = (n: number, width: number | null = 2400): Extract<ContentBlock, { type: "image" }> => {
    const id = `a1.${n.toString(16).padStart(64, "0")}`;
    return { id: `image-${n}`, type: "image", image: { id, src: `/media/v2/${id}`, alt: "Fictional image", width, height: 1800 }, caption: [] };
  };
  const blocks: ContentBlock[] = [{ id: "toggle", type: "toggle", title: [], children: [image(1), image(2, 1600), image(3, null)] }];
  const album = structuredClone(fixtureItems.album[0]); album.cover = image(4).image;
  const status = structuredClone(fixtureItems.status[0]); status.cover = null;
  const page = structuredClone(fixtureItems.page[0]); page.cover = null;
  const document = (blocks: ContentBlock[]) => ({ blocks, toc: [], completeness: "complete" as const });
  const snapshot = { version: "fictional-batch", records: [{ item: album, document: document(blocks) },
    { item: status, document: document(Array.from({ length: 10 }, (_, i) => image(i + 10))) },
    { item: page, document: document([image(30)]) }] };
  const result = planBodyImageThumbnails("11111111-1111-4111-8111-111111111111", snapshot);
  assert.deepEqual(result.plan!.assetIds, [image(1), ...Array.from({ length: 10 }, (_, i) => image(i + 10))].map(block => block.image.id).sort());
  assert(result.widths!.assets.every(asset => asset.widthCaps.length === 1 && asset.widthCaps[0] === 1600));
  assert.equal(result.recordsConsidered, 2); assert.equal(result.unloadedDocuments, 0);
  assert.equal(planBodyImageThumbnails(result.plan!.runId, { version: "empty", records: [] }).plan, null);
});
