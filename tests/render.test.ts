import test from "node:test";
import assert from "node:assert/strict";
import { colorReplacements, highlightCode, normalizeLanguage } from "../src/lib/render/highlight.ts";
import { renderEquation } from "../src/lib/render/equation.ts";
import { renderSnippets } from "../src/lib/render/actions.ts";
import { MAX_SNIPPETS, MAX_SNIPPET_CHARS, collectSnippets, withinLimits, type Snippet } from "../src/lib/render/snippets.ts";
import type { ContentBlock } from "../contracts/content.ts";
import { headingShift, headingTag } from "../src/lib/headings.ts";

test("source language names map to a bundled grammar or to plain text", () => {
  assert.equal(normalizeLanguage("Java"), "java");
  assert.equal(normalizeLanguage(" C++ "), "cpp");
  assert.equal(normalizeLanguage("shell"), "bash");
  assert.equal(normalizeLanguage("plain text"), null);
  assert.equal(normalizeLanguage("constructor"), null);
  assert.equal(normalizeLanguage(""), null);
});

test("highlighting escapes code and falls back for unknown or oversized input", async () => {
  const html = await highlightCode('String s = "<script>alert(1)</script>";', "java");
  assert.ok(html && html.includes("--shiki-light") && html.includes("--shiki-dark"));
  assert.ok(!html.includes("<script>") && !/<pre|<code/u.test(html));
  assert.equal(await highlightCode("x = 1", "plain text"), null);
  assert.equal(await highlightCode("x".repeat(40_001), "java"), null);
  assert.ok((await highlightCode("print('hi')", "python"))?.includes("print"));
});

test("formulas are typeset, and unsafe or broken input falls back to source text", () => {
  const html = renderEquation("a^2 + b^2 = c^2");
  assert.ok(html && html.includes("katex") && html.includes("<math"));
  assert.equal(renderEquation("\\frac{"), null);
  assert.equal(renderEquation("   "), null);
  assert.equal(renderEquation("x".repeat(4_001)), null);
  for (const hostile of ["\\href{javascript:alert(1)}{x}", "\\url{https://example.test}", "\\includegraphics{https://example.test/a.png}", "\\htmlClass{evil}{x}"]) {
    const result = renderEquation(hostile);
    assert.ok(result === null || !/<a[\s>]|\shref=|\ssrc=/iu.test(result), hostile);
  }
});

test("snippets are collected in reading order from nested blocks and capped per request", () => {
  const code = (id: string, source = "x = 1"): ContentBlock => ({ id, type: "code", language: "python", code: source, caption: [] });
  const blocks: ContentBlock[] = [
    { id: "p", type: "paragraph", text: [] },
    code("top"),
    { id: "list", type: "list", ordered: false, items: [{ id: "item", text: [], checked: null, children: [{ id: "eq", type: "equation", expression: "a+b" }] }] },
    { id: "callout", type: "callout", tone: "info", icon: null, text: [], children: [{ id: "toggle", type: "toggle", title: [], children: [code("deep")] }] },
    { id: "columns", type: "columns", columns: [{ ratio: null, blocks: [code("left")] }, { ratio: null, blocks: [code("right")] }] },
  ];
  assert.deepEqual(collectSnippets(blocks).map(snippet => snippet.id), ["top", "eq", "deep", "left", "right"]);
  // Inline formulas are found in every kind of text, and each distinct expression is sent once.
  const formula = (text: string) => ({ text, equation: true as const });
  const withInline: ContentBlock[] = [
    { id: "p1", type: "paragraph", text: [{ text: "设 " }, formula("x^2"), { text: " 与 " }, formula("y")] },
    code("c"),
    { id: "t", type: "table", hasColumnHeader: false, hasRowHeader: false, rows: [[[formula("x^2")], [formula("z")]]] },
    { id: "l", type: "list", ordered: true, items: [{ id: "li", text: [formula("y")], checked: null, children: [{ id: "q", type: "quote", text: [formula("w")] }] }] },
  ];
  assert.deepEqual(collectSnippets(withInline).map(snippet => [snippet.id, snippet.kind === "code" ? "code" : snippet.expression]),
    [["inline:1", "x^2"], ["inline:2", "y"], ["c", "code"], ["inline:3", "z"], ["inline:4", "w"]]);
  const many = Array.from({ length: MAX_SNIPPETS + 3 }, (_, index) => code(`c${index}`));
  assert.equal(withinLimits(collectSnippets(many)).length, MAX_SNIPPETS);
  const long = [code("a", "x".repeat(MAX_SNIPPET_CHARS - 10)), code("b", "y".repeat(20)), code("c")];
  assert.deepEqual(withinLimits(collectSnippets(long)).map(snippet => snippet.id), ["a"]);
});

test("the browser-facing renderer returns markup by block id and ignores anything malformed", async () => {
  const snippets: Snippet[] = [
    { id: "code", kind: "code", code: 'String s = "<img src=x onerror=alert(1)>";', language: "java" },
    { id: "plain", kind: "code", code: "hello", language: "plain text" },
    { id: "eq", kind: "equation", expression: "a^2 + b^2 = c^2" },
    { id: "broken", kind: "equation", expression: "\\frac{" },
    { id: "__proto__", kind: "equation", expression: "x" },
  ];
  const html = await renderSnippets(snippets);
  assert.deepEqual(Object.keys(html).sort(), ["__proto__", "code", "eq"]);
  assert.ok(html.code?.includes("--shiki-light") && !html.code.includes("<img"));
  assert.ok(html.eq?.includes("katex"));
  const inline = await renderSnippets([{ id: "inline:1", kind: "inline-equation", expression: "a^2" }, { id: "block", kind: "equation", expression: "a^2" }]);
  assert.ok(inline["inline:1"]?.includes("katex") && !inline["inline:1"].includes("katex-display") && inline.block?.includes("katex-display"));
  assert.ok(Object.hasOwn(html, "__proto__") && Object.getPrototypeOf(html) === Object.prototype);
  const oversized = [{ id: "a", kind: "code", code: "x".repeat(MAX_SNIPPET_CHARS), language: "java" }, { id: "b", kind: "equation", expression: "x" }];
  for (const invalid of [null, "text", {}, [null], [{ id: "", kind: "equation", expression: "x" }], [{ id: "a", kind: "image" }],
    [{ id: "a", kind: "code", code: 1, language: "java" }], [{ id: 7, kind: "equation", expression: "x" }],
    Array.from({ length: MAX_SNIPPETS + 1 }, (_, index) => ({ id: `e${index}`, kind: "equation", expression: "x" })), oversized]) {
    assert.deepEqual(await renderSnippets(invalid), {});
  }
});

test("body headings continue the outline above them without skipping a level", () => {
  const toc = (...levels: (1 | 2 | 3)[]) => levels.map((level, index) => ({ id: `h${index}`, title: "t", level }));
  // Under a page title (h1) the shallowest heading becomes h2, whatever level the writer started at.
  assert.equal(headingTag(1, headingShift(toc(1, 2, 3), 2)), "h2");
  assert.equal(headingTag(3, headingShift(toc(1, 2, 3), 2)), "h4");
  assert.equal(headingTag(2, headingShift(toc(2, 3), 2)), "h2");
  assert.equal(headingTag(3, headingShift(toc(3), 2)), "h2");
  assert.equal(headingTag(1, headingShift([], 2)), "h2");
  // Inside a timeline entry whose title is h4, a body starts at h5 and stops at h6.
  assert.equal(headingTag(1, headingShift(toc(1, 2, 3), 5)), "h5");
  assert.equal(headingTag(3, headingShift(toc(1, 2, 3), 5)), "h6");
  // A heading the outline did not list never becomes a second h1.
  assert.equal(headingTag(1, headingShift(toc(2), 2)), "h2");
});

test("highlight colours keep at least 4.5:1 on the code block background in both themes", async () => {
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a: string, b: string) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]; return (hi + 0.05) / (lo + 0.05); };
  // The code block sits on --code: #f4f0e6 in the light theme, #23272e in the dark one (src/app/globals.css).
  const samples: [string, string][] = [
    ["// note\nconst total: number = items.length + 1;\nexport function run(input: string) { return `${input}!`; }", "typescript"],
    ["<!-- note -->\n<a href=\"/x\" class=\"y\">text</a>", "html"],
    ["# note\ndef run(value):\n    return [value, None, 3.5, 'text']", "python"],
    ["- item\n\n**bold** and `code` with a [link](https://example.test)", "markdown"],
  ];
  for (const [code, language] of samples) {
    const html = await highlightCode(code, language);
    assert.ok(html, language);
    for (const [variable, background] of [["--shiki-light", "#f4f0e6"], ["--shiki-dark", "#23272e"]] as const) {
      const colours: Set<string> = new Set([...html.matchAll(new RegExp(`${variable}:(#[0-9a-fA-F]{6})`, "gu"))].map(match => match[1]!.toLowerCase()));
      assert.ok(colours.size > 1, `${language} ${variable}`);
      for (const colour of colours) assert.ok(contrast(colour, background) >= 4.5, `${language} ${variable} ${colour}`);
    }
  }
  for (const replaced of Object.values(colorReplacements).flatMap(Object.keys)) assert.ok(!(await highlightCode(samples[0]![0], "typescript"))!.toLowerCase().includes(replaced), replaced);
});
