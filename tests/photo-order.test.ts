import assert from "node:assert/strict";
import test from "node:test";
import { nearestShown } from "../src/lib/photo-order.ts";

test("a photo that leaves the page while on show hands over to the next one still there, else the one before", () => {
  const order = ["a", "b", "c", "d"];
  const on = (...keys: string[]) => (key: string) => keys.includes(key);
  assert.equal(nearestShown(order, "b", on("a", "b", "c", "d")), "b");
  // The next one still on the page, skipping any that left as well.
  assert.equal(nearestShown(order, "b", on("a", "d")), "d");
  // At the end: the last one before it.
  assert.equal(nearestShown(order, "d", on("a", "b")), "b");
  // None left: nothing to show, so the viewer closes.
  assert.equal(nearestShown(order, "b", on()), undefined);
  // A key not in the order (it left before the order was read) still finds what is there.
  assert.equal(nearestShown(order, "x", on("c")), "c");
});
