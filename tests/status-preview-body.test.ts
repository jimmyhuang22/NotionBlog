import test from "node:test";
import assert from "node:assert/strict";
import type { ContentBlock, StatusEntry } from "../contracts/content.ts";
import { statusBodyPreview, statusPreview } from "../src/lib/content/status.ts";
const paragraph = (text: string, id = "p"): ContentBlock => ({ id, type: "paragraph", text: [{ text }] });
const item: StatusEntry = { id: "status", kind: "status", slug: "status", href: "/status#status", title: "Sample", cover: null, summary: null, tags: [], updatedAt: null, recordedAt: null, text: [{ text: "a".repeat(401) }] };
test("rich preview clips a Unicode prefix without changing full text or hasMoreBody semantics", () => {
  const blocks = [paragraph("🙂".repeat(401))], before = structuredClone(blocks);
  const preview = statusBodyPreview(blocks)!;
  assert.equal((preview.blocks[0] as Extract<ContentBlock, { type: "paragraph" }>).text[0].text, "🙂".repeat(400));
  assert.equal(preview.truncated, true); assert.deepEqual(blocks, before);
  const plain = statusPreview(item, { blocks: [paragraph(item.text[0].text)], toc: [], completeness: "complete" });
  assert.equal(plain.text[0].text.length, 401); assert.equal(plain.hasMoreBody, false); assert.equal(plain.previewBodyTruncated, true);
  assert.equal(statusBodyPreview([paragraph("a".repeat(400))]), undefined);
  assert.equal(statusBodyPreview([paragraph("Short")]), undefined);
});
test("preview retains annotations, nesting and redacted links, but excludes detail-only blocks", () => {
  const blocks: ContentBlock[] = [
    { id: "q", type: "quote", text: [{ text: "Quote", bold: true, link: { kind: "unavailable" } }] },
    { id: "img", type: "image", image: { id: "img", src: "/mock-media/sample.svg", alt: "Sample", width: 1, height: 1 }, caption: [] },
    { id: "code", type: "code", code: "PRIVATE_DETAIL_ONLY", language: "text", caption: [] },
    { id: "eq", type: "equation", expression: "DETAIL_EQUATION" },
    { id: "list", type: "list", ordered: true, items: [{ id: "row", checked: true, text: [{ text: "Item" }], children: [paragraph("Nested")] }] },
    { id: "d", type: "divider" },
  ];
  const result = statusBodyPreview(blocks)!;
  assert.deepEqual(result.blocks.map(x => x.id), ["q", "list", "d"]);
  assert.deepEqual(result.blocks[0], blocks[0]); assert.notEqual(result.blocks[0], blocks[0]);
  assert.ok(!JSON.stringify(result).includes("PRIVATE_DETAIL_ONLY")); assert.ok(!JSON.stringify(result).includes("DETAIL_EQUATION"));
  assert.equal(result.truncated, false);
});
test("preview bounds node count, nesting, serialized bytes and text-run fragmentation", () => {
  const many = statusBodyPreview(Array.from({ length: 50 }, (_, n) => paragraph("short", `p${n}`)))!;
  assert.equal(many.blocks.length, 12); assert.equal(many.truncated, true);
  const runs: ContentBlock[] = [{ id: "q", type: "quote", text: Array.from({ length: 80 }, () => ({ text: "x", bold: true })) }];
  assert.equal((statusBodyPreview(runs)!.blocks[0] as { text: unknown[] }).text.length, 40);
  let deep: ContentBlock = paragraph("Deep");
  for (let n = 0; n < 10; n++) deep = { id: `t${n}`, type: "toggle", title: [{ text: "Title" }], children: [deep] };
  const nested = statusBodyPreview([deep])!; assert.equal(nested.truncated, true); assert.ok(!JSON.stringify(nested).includes("Deep"));
  const hugeLink: ContentBlock = { id: "q", type: "quote", text: [{ text: "Link", link: { kind: "external", url: "https://example.test/" + "x".repeat(10000) } }] };
  assert.equal(statusBodyPreview([hugeLink]), undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(nested.blocks)) <= 8192);
});
test("inline equations are kept whole and stale previews are removed without a body", () => {
  const input: ContentBlock[] = [{ id: "q", type: "quote", text: [{ text: "a".repeat(399) }, { text: "x^2", equation: true }] }];
  const result = statusBodyPreview(input)!;
  assert.deepEqual((result.blocks[0] as { text: unknown[] }).text, [{ text: "a".repeat(399) }]);
  assert.equal(result.truncated, true);
  const stale = statusPreview({ ...item, previewBody: [paragraph("Stale")], previewBodyTruncated: true }, null);
  assert.ok(!Object.hasOwn(stale, "previewBody")); assert.ok(!Object.hasOwn(stale, "previewBodyTruncated"));
});
