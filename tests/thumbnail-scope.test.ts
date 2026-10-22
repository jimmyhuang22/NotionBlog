import test from "node:test";
import assert from "node:assert/strict";
import { parseThumbnailScope } from "../scripts/website-incremental-sync/thumbnail-scope.ts";

test("scope accepts exact upper bounds and rejects malformed, zero, fractional and excessive limits", () => {
  const valid = { format: "thumbnail-scope-v1", maxBindings: 4000, maxObjects: 4000, maxBytes: 128 * 1024 ** 2 };
  assert.deepEqual(parseThumbnailScope(valid), valid);
  for (const input of [null, [], {}, { ...valid, unexpected: true }, { ...valid, format: "all" },
    ...["maxBindings", "maxObjects", "maxBytes"].flatMap(key => [0, -1, 1.5, "1", NaN, Infinity].map(value => ({ ...valid, [key]: value }))),
    { ...valid, maxBindings: 4001 }, { ...valid, maxObjects: 4001 }, { ...valid, maxBytes: valid.maxBytes + 1 }]) {
    assert.throws(() => parseThumbnailScope(input), /THUMBNAIL_SCOPE_INVALID/);
  }
  const copy = parseThumbnailScope(valid); copy.maxBytes--;
  assert.equal(valid.maxBytes, 128 * 1024 ** 2);
});
