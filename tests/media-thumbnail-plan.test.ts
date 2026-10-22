import test from "node:test";
import assert from "node:assert/strict";
import { parseThumbnailPlan } from "../scripts/media-thumbnails/plan.ts";
import { parseThumbnailWidthSelection } from "../scripts/media-thumbnails/widths.ts";

const plan = {version:"v2", runId:"11111111-1111-4111-8111-111111111111", assetIds:[`a1.${"a".repeat(64)}`]};
test("thumbnail plans contain only explicit canonical assets from one generation", () => {
  const result = parseThumbnailPlan(plan);
  assert.deepEqual(result, plan);
  result.assetIds.push(`a1.${"b".repeat(64)}`);
  assert.equal(plan.assetIds.length, 1);
  for (const value of [null, [], {...plan,version:"v3"}, {...plan,runId:"latest"}, {...plan,assetIds:[]},
    {...plan,assetIds:[...plan.assetIds,...plan.assetIds]}, {...plan,assetIds:["https://images.example.test/photo.jpg"]},
    {...plan,assetIds:[`a1.${"A".repeat(64)}`]}, {...plan,sourceUrl:"https://images.example.test/photo.jpg"},
    {...plan,assetIds:Array.from({length:20001}, (_, index)=>`a1.${index.toString(16).padStart(64,"0")}`)}]) {
    assert.throws(() => parseThumbnailPlan(value));
  }
});

test("width selections only narrow the exact generation and asset list, with copied canonical caps", () => {
  const chosen=parseThumbnailPlan(plan);
  const selection={format:"notionblog-thumbnail-widths-v1",version:chosen.version,runId:chosen.runId,
    assets:[{assetId:chosen.assetIds[0],widthCaps:[800,400]}]};
  const parsed=parseThumbnailWidthSelection(selection,chosen);
  assert.deepEqual(parsed.assets[0].widthCaps,[400,800]);
  parsed.assets[0].widthCaps.pop();assert.deepEqual(selection.assets[0].widthCaps,[800,400]);
  for(const value of [null,{...selection,version:"v1"},{...selection,runId:"00000000-0000-4000-8000-000000000001"},
    {...selection,assets:[]},{...selection,extra:true},
    ...[[],[401],[400,400],[400,800,400]].map(widthCaps=>({...selection,assets:[{assetId:chosen.assetIds[0],widthCaps}]})),
    {...selection,assets:[{assetId:`a1.${"b".repeat(64)}`,widthCaps:[400]}]}]) {
    assert.throws(()=>parseThumbnailWidthSelection(value,chosen));
  }
  assert.deepEqual(parseThumbnailPlan(plan),plan,"the three-field plan remains unchanged");
});


test("1600 selection is explicit and restricted to v2 plans", () => {
  const assetId = `a1.${"a".repeat(64)}`;
  const plan = { version: "v2" as const, runId: "11111111-1111-4111-8111-111111111111", assetIds: [assetId] };
  const widths = { format: "notionblog-thumbnail-widths-v1", version: "v2", runId: plan.runId, assets: [{ assetId, widthCaps: [1600] }] };
  assert.deepEqual(parseThumbnailWidthSelection(widths, plan).assets[0].widthCaps, [1600]);
  assert.throws(() => parseThumbnailWidthSelection({ ...widths, version: "v1" }, { ...plan, version: "v1" }));
});
