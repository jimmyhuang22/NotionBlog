import test from "node:test";
import assert from "node:assert/strict";
import { coverFailureAction } from "../src/lib/content/cover-failure.ts";

test("qualified v2 preview failures retry once at the same tier without an extra original request", () => {
  const original = `/media/v2/a1.${"a".repeat(64)}`;
  for (const width of [400, 800, 1600]) {
    assert.equal(coverFailureAction(`${original}?thumbnail=${width}`, original, 0), "retry");
    assert.equal(coverFailureAction(`${original}?thumbnail=${width}`, original, 1), "failed");
  }
  assert.equal(coverFailureAction(original, original, 0), "failed");
  for (const legacy of [`/media/a1.${"a".repeat(64)}`, `/media/social/s1.${"a".repeat(64)}`])
    assert.equal(coverFailureAction(`${legacy}?thumbnail=400`, legacy, 0), "original");
  assert.equal(coverFailureAction(`${original}\n?thumbnail=400`, `${original}\n`, 0), "original");
});
