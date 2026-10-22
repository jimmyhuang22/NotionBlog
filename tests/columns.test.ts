import test from "node:test";
import assert from "node:assert/strict";
import { columnGrowth } from "../src/lib/columns.ts";

test("columns grow in proportion, the narrowest by exactly one", () => {
  assert.deepEqual(columnGrowth([0.5, 0.5]), [1, 1]);
  assert.deepEqual(columnGrowth([50, 50]), [1, 1]);
  assert.deepEqual(columnGrowth([0.25, 0.75]), [1, 3]);
  assert.deepEqual(columnGrowth([0.3, 0.3, 0.4]), [1, 1, 1.333]);
});

test("a missing or unusable ratio counts as the narrowest column", () => {
  assert.deepEqual(columnGrowth([null, null]), [1, 1]);
  assert.deepEqual(columnGrowth([0.5, null]), [1, 1]);
  assert.deepEqual(columnGrowth([0, 2, 4]), [1, 1, 2]);
  assert.deepEqual(columnGrowth([]), []);
});
