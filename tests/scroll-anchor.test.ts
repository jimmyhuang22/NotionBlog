import test from "node:test";
import assert from "node:assert/strict";
import { holdScrollAnchor } from "../src/lib/scroll-anchor.ts";

/** A stand-in page: the root and body elements with just the inline style calls this uses. */
function page() {
  const style = () => {
    const values = new Map<string, string>();
    return { values, setProperty: (name: string, value: string) => void values.set(name, value), removeProperty: (name: string) => void values.delete(name) };
  };
  const root = { style: style() }, body = { style: style() };
  (globalThis as { document?: unknown }).document = { documentElement: root, body };
  return { root, body };
}

test("scroll anchoring is off on the page while held, and back once every hold is released", () => {
  const { root, body } = page();
  const first = holdScrollAnchor();
  assert.equal(root.style.values.get("overflow-anchor"), "none");
  assert.equal(body.style.values.get("overflow-anchor"), "none");
  const second = holdScrollAnchor();
  first();
  first();
  assert.equal(root.style.values.get("overflow-anchor"), "none", "a second card is still moving");
  second();
  assert.equal(root.style.values.has("overflow-anchor"), false);
  assert.equal(body.style.values.has("overflow-anchor"), false);
  delete (globalThis as { document?: unknown }).document;
});
