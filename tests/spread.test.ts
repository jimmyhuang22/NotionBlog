import test from "node:test";
import assert from "node:assert/strict";
import { spreadRadius } from "../src/lib/spread.ts";

test("the ink spread reaches the farthest corner from where it starts", () => {
  // From a corner the far corner is the diagonal away; from the centre it is half of that.
  assert.equal(spreadRadius(0, 0, 300, 400), 500);
  assert.equal(spreadRadius(300, 0, 300, 400), 500);
  assert.equal(spreadRadius(150, 200, 300, 400), 250);
  // The soft edge is added on top, and a start point outside the viewport still covers it.
  assert.equal(spreadRadius(0, 0, 300, 400, 60), 560);
  assert.equal(spreadRadius(-30, 0, 300, 400), Math.ceil(Math.hypot(330, 400)));
});
