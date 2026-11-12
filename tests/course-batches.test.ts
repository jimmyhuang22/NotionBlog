import test from "node:test";
import assert from "node:assert/strict";
import { courseBatches } from "../scripts/console-management/course-batches.ts";
import type { FreezePlan } from "../src/server/database/freeze.ts";

function plan(pages: number, images: number): Parameters<typeof courseBatches>[0] {
  const members = Array.from({length: pages}, (_, i) => ({id: String(i), sourceKey: "synthetic", title: "Synthetic"}));
  const media = Array.from({length: images}, (_, i) => ({assetId: `asset-${i}`, ownerPageId: String(i % pages)})) as FreezePlan["media"];
  return {rootId: "0", members, media, thumbnailIds: []};
}

test("a whole course is partitioned without losing or duplicating any page or exceeding asset limits", () => {
  const input = plan(58, 211), batches = courseBatches(input);
  assert.ok(batches.length > 1);
  assert.deepEqual(batches.flat(), input.members.map(m => m.id));
  for (const pages of batches) {
    assert.ok(pages.length <= 25);
    assert.ok(input.media.filter(m => pages.includes(m.ownerPageId)).length <= 60);
  }
});

test("thumbnails do not inflate source-asset batches; a single oversized page is rejected explicitly", () => {
  const input = plan(2, 100);
  input.thumbnailIds = input.media.map(m => m.assetId);
  assert.equal(courseBatches(input).length, 1);
  assert.throws(() => courseBatches(plan(1, 101)), /FREEZE_PAGE_TOO_LARGE/);
  assert.deepEqual(courseBatches(plan(1, 100)), [["0"]]);
});

test("foreign media and duplicate membership are never silently dropped", () => {
  const input = plan(2, 1); input.media[0].ownerPageId = "foreign";
  assert.throws(() => courseBatches(input), /FREEZE_INPUT_INVALID/);
  const duplicate = plan(2, 0); duplicate.members.push(duplicate.members[0]);
  assert.throws(() => courseBatches(duplicate), /FREEZE_INPUT_INVALID/);
});
