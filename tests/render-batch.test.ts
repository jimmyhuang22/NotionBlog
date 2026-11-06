import test from "node:test";
import assert from "node:assert/strict";
import { createSnippetBatcher } from "../src/lib/render/batch.ts";
import { MAX_SNIPPETS, MAX_SNIPPET_CHARS, type Snippet } from "../src/lib/render/snippets.ts";

const formula = (id: string, expression: string): Snippet => ({ id, kind: "inline-equation", expression });
const code = (id: string, text: string): Snippet => ({ id, kind: "code", code: text, language: "java" });
const echo = (snippets: Snippet[]) => Object.fromEntries(snippets.map(snippet =>
  [snippet.id, snippet.kind === "code" ? `<c>${snippet.code}</c>` : `<m>${snippet.expression}</m>`]));

function recorder(answer: (snippets: Snippet[]) => Record<string, string> | Promise<Record<string, string>> = echo) {
  const calls: Snippet[][] = [];
  let running = 0, most = 0;
  const send = async (snippets: Snippet[]) => {
    calls.push(snippets);
    running += 1;
    most = Math.max(most, running);
    try {
      await new Promise(resolve => setTimeout(resolve, 5));
      return await answer(snippets);
    } finally {
      running -= 1;
    }
  };
  return { calls, send, most: () => most };
}

test("entries that ask at the same time share one request, each getting its own ids back", async () => {
  const server = recorder();
  const render = createSnippetBatcher(server.send, 0);
  const results = await Promise.all(Array.from({ length: 20 }, (_, index) => render([formula("inline:0", `x_${index}`)])));
  assert.equal(server.calls.length, 1);
  assert.equal(server.calls[0].length, 20);
  results.forEach((html, index) => assert.deepEqual(html, { "inline:0": `<m>x_${index}</m>` }));
});

test("the same formula or code asked for by two entries is sent once", async () => {
  const server = recorder();
  const render = createSnippetBatcher(server.send, 0);
  const [a, b] = await Promise.all([render([formula("inline:0", "a^2"), code("c1", "int x;")]), render([code("other", "int x;"), formula("inline:0", "a^2")])]);
  assert.equal(server.calls[0].length, 2);
  assert.deepEqual(a, { "inline:0": "<m>a^2</m>", c1: "<c>int x;</c>" });
  assert.deepEqual(b, { other: "<c>int x;</c>", "inline:0": "<m>a^2</m>" });
});

test("a block formula and an inline formula with the same source stay separate", async () => {
  const server = recorder();
  const render = createSnippetBatcher(server.send, 0);
  await Promise.all([render([formula("inline:0", "a")]), render([{ id: "eq", kind: "equation", expression: "a" }])]);
  assert.equal(server.calls[0].length, 2);
});

test("more than one request's worth is split without breaking an entry apart, and sent one at a time", async () => {
  const server = recorder();
  const render = createSnippetBatcher(server.send, 0);
  const entries = Array.from({ length: 5 }, (_, entry) => Array.from({ length: 10 }, (_, index) => formula(`inline:${index}`, `e${entry}_${index}`)));
  const results = await Promise.all(entries.map(snippets => render(snippets)));
  assert.deepEqual(server.calls.map(call => call.length), [20, 20, 10]);
  assert.ok(server.calls.every(call => call.length <= MAX_SNIPPETS));
  assert.equal(server.most(), 1);
  results.forEach((html, entry) => assert.equal(html["inline:9"], `<m>e${entry}_9</m>`));

  const long = recorder();
  const renderLong = createSnippetBatcher(long.send, 0);
  const half = "x".repeat(MAX_SNIPPET_CHARS / 2);
  await Promise.all([renderLong([code("a", half)]), renderLong([code("b", `${half}y`)])]);
  assert.equal(long.calls.length, 2);
});

test("a failed request leaves only its own entries as plain text", async () => {
  let call = 0;
  const server = recorder(snippets => { call += 1; if (call === 1) throw new Error("busy"); return echo(snippets); });
  const render = createSnippetBatcher(server.send, 0);
  const many = (prefix: string) => Array.from({ length: 20 }, (_, index) => formula(`inline:${index}`, `${prefix}${index}`));
  const [first, second] = await Promise.allSettled([render(many("a")), render(many("b"))]);
  assert.equal(first.status, "rejected");
  assert.equal(second.status, "fulfilled");
  // The next ask goes out again rather than reusing the failure.
  assert.deepEqual(await render([formula("inline:0", "a0")]), { "inline:0": "<m>a0</m>" });
});

test("snippets the server could not render, and empty asks, come back as nothing", async () => {
  const server = recorder(() => ({}));
  const render = createSnippetBatcher(server.send, 0);
  assert.deepEqual(await render([formula("inline:0", "\\bad")]), {});
  assert.deepEqual(await render([]), {});
  assert.equal(server.calls.length, 1);
});

test("asks that arrive while a request is out go in the next one", async () => {
  const server = recorder();
  const render = createSnippetBatcher(server.send, 0);
  const first = render([formula("inline:0", "a")]);
  await new Promise(resolve => setTimeout(resolve, 1));
  const later = await Promise.all([render([formula("inline:0", "b")]), render([formula("inline:0", "c")])]);
  await first;
  assert.deepEqual(server.calls.map(call => call.length), [1, 2]);
  assert.deepEqual(later, [{ "inline:0": "<m>b</m>" }, { "inline:0": "<m>c</m>" }]);
  assert.equal(server.most(), 1);
});
