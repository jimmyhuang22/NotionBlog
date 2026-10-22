import test from "node:test";
import assert from "node:assert/strict";
import { planCourseCoverThumbnails } from "../scripts/media-thumbnails/course-cover-plan.ts";
const run = "11111111-1111-4111-8111-111111111111";
const image = (n: string, width = 1672) => ({ id: `a1.${n.repeat(64)}`, src: `/media/v2/a1.${n.repeat(64)}`, alt: "Fictional course", width, height: 941 });
const item = (n: string, kind = "course", width = 1672) => ({ item: { id: n.repeat(32), kind, cover: image(n, width) } });
test("course-cover planning adds only explicit full-sized course assets", () => {
  const result = planCourseCoverThumbnails(run, [item("a"), item("b", "study-note"), item("c", "status"), item("d", "course", 800)]);
  assert.deepEqual(result.plan.assetIds, [image("a").id]);
  assert.deepEqual(result.widths.assets, [{ assetId: image("a").id, widthCaps: [1600] }]);
  assert.throws(() => planCourseCoverThumbnails(run, [item("a"), item("a")]));
  assert.throws(() => planCourseCoverThumbnails(run, [item("a", "status")]));
  const direct = item("a"); direct.item.cover.src = "https://example.test/course.png";
  assert.throws(() => planCourseCoverThumbnails(run, [direct]));
});
