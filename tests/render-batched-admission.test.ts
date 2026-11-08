import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createSnippetBatcher } from "../src/lib/render/batch.ts";
import { MAX_SNIPPETS, MAX_SNIPPET_CHARS, type Snippet } from "../src/lib/render/snippets.ts";
import { createSearchLimiter } from "../src/server/search-rate-limit.ts";
import { RENDER_LIMITS } from "../src/server/render-rate-limit.ts";

test("two serialized browser queues fit a formula-rich first screen, three scroll pages and an expanded body within admission", async () => {
  // No refill: this is stricter than a visitor reading between pages. Both tabs
  // share a visitor key and instance budget, as two tabs from one address do.
  const limiter = createSearchLimiter(RENDER_LIMITS, () => 0);
  let active = 0, peak = 0;
  const batches: { tab: number; size: number }[] = [];
  const tab = (index: number) => createSnippetBatcher(async snippets => {
    const admitted = limiter.admit("same-visitor");
    assert.ok("release" in admitted, "normal batched navigation was refused");
    active++; peak = Math.max(peak, active);
    try {
      assert.ok(snippets.length <= MAX_SNIPPETS);
      assert.ok(snippets.reduce((sum, snippet) => sum + (snippet.kind === "code" ? snippet.code.length : snippet.expression.length), 0) <= MAX_SNIPPET_CHARS);
      batches.push({ tab: index, size: snippets.length });
      await nextTurn();
      return Object.fromEntries(snippets.map(snippet => [snippet.id, "rendered"]));
    } finally { active--; admitted.release(); }
  }, 0);
  async function browse(index: number) {
    const render = tab(index);
    for (let page = 0; page < 4; page++) {
      await Promise.all(Array.from({ length: 12 }, (_, entry) => render(Array.from({ length: 2 }, (_, formula) => ({
        id: `${entry}-${formula}`, kind: "inline-equation", expression: `x_{${index},${page},${entry},${formula}}^2`,
      } as Snippet)))));
    }
    await render([
      { id: "code", kind: "code", language: "javascript", code: "const answer = 42;" },
      { id: "equation", kind: "equation", expression: `y_${index}=x^2` },
    ]);
  }
  await Promise.all([browse(0), browse(1)]);
  assert.equal(peak, 2);
  assert.equal(active, 0);
  for (const index of [0, 1]) assert.deepEqual(batches.filter(batch => batch.tab === index).map(batch => batch.size), [24, 24, 24, 24, 2]);
});
