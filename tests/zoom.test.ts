import test from "node:test";
import assert from "node:assert/strict";
import { MAX_SCALE, UNZOOMED, clampPan, zoomAbout } from "../src/lib/zoom.ts";

test("zooming keeps the point under the fingers in place and stays within its limits", () => {
  const zoomed = zoomAbout(UNZOOMED, 2, 100, -40);
  assert.deepEqual(zoomed, { scale: 2, x: -100, y: 40 });
  // The photo point that was under (100, -40) is still there: (p - offset) / scale is unchanged.
  const further = zoomAbout(zoomed, 3, 100, -40);
  assert.equal((100 - further.x) / further.scale, (100 - zoomed.x) / zoomed.scale);
  assert.equal((-40 - further.y) / further.scale, (-40 - zoomed.y) / zoomed.scale);
  assert.deepEqual(zoomAbout(UNZOOMED, 2, 0, 0), { scale: 2, x: 0, y: 0 });
  assert.equal(zoomAbout(zoomed, 99, 0, 0).scale, MAX_SCALE);
  assert.equal(zoomAbout(zoomed, 0.4, 100, -40), UNZOOMED);
});

test("a zoomed photo pans only as far as it overhangs the stage", () => {
  const stage = { width: 400, height: 600 };
  const photo = { width: 400, height: 300 };
  // At 2x the photo is 800 x 600: 200 px of reach sideways, none vertically.
  assert.deepEqual(clampPan({ scale: 2, x: 999, y: 50 }, photo, stage), { scale: 2, x: 200, y: 0 });
  assert.deepEqual(clampPan({ scale: 2, x: -999, y: -50 }, photo, stage), { scale: 2, x: -200, y: 0 });
  assert.deepEqual(clampPan({ scale: 2, x: 120, y: 0 }, photo, stage), { scale: 2, x: 120, y: 0 });
  assert.deepEqual(clampPan({ scale: 1, x: 30, y: 30 }, photo, stage), { scale: 1, x: 0, y: 0 });
});
