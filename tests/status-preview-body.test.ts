import test from "node:test";
import assert from "node:assert/strict";
import type { ContentBlock, StatusEntry } from "../contracts/content.ts";
import { statusBodyPreview, statusPreview, statusPreviewWithoutImages } from "../src/lib/content/status.ts";
const paragraph = (text: string, id = "p"): ContentBlock => ({ id, type: "paragraph", text: [{ text }] });
const photo = (id: string): Extract<ContentBlock, { type: "image" }> => ({
  id, type: "image", image: { id, src: "/mock-media/sample.svg", alt: "Sample", width: 1, height: 1 }, caption: [],
});
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
    photo("img"),
    { id: "code", type: "code", code: "PRIVATE_DETAIL_ONLY", language: "text", caption: [] },
    { id: "eq", type: "equation", expression: "DETAIL_EQUATION" },
    { id: "list", type: "list", ordered: true, items: [{ id: "row", checked: true, text: [{ text: "Item" }], children: [paragraph("Nested")] }] },
    { id: "d", type: "divider" },
  ];
  const result = statusBodyPreview(blocks)!;
  assert.deepEqual(result.blocks.map(x => x.id), ["q", "img", "list", "d"]);
  assert.deepEqual(result.blocks[0], blocks[0]); assert.notEqual(result.blocks[0], blocks[0]);
  assert.ok(!JSON.stringify(result).includes("PRIVATE_DETAIL_ONLY")); assert.ok(!JSON.stringify(result).includes("DETAIL_EQUATION"));
  assert.equal(result.truncated, false);
});
test("mixed previews retain photo position and the same public assets as the image list", () => {
  const first = photo("first"), middle = photo("middle"), last = photo("last");
  const nested: ContentBlock = { id: "toggle", type: "toggle", title: [{ text: "Nested" }], children: [middle] };
  const blocks = [first, paragraph("Short"), nested, last];
  const entry = statusPreview({ ...item, text: [{ text: "Short" }] }, { blocks, toc: [], completeness: "complete" });
  assert.deepEqual(entry.previewBody, blocks);
  assert.equal(entry.previewBody?.[0].type === "image" && entry.previewBody[0].image, entry.images?.[0]);
  assert.deepEqual(entry.images, [first.image, middle.image, last.image]);
  assert.equal(entry.previewBodyTruncated, false);
  assert.deepEqual(statusPreviewWithoutImages(entry.previewBody!), [paragraph("Short"), { ...nested, children: [] }]);
  assert.deepEqual(statusBodyPreview([paragraph("Short"), last])?.blocks.map(block => block.id), ["p", "last"]);
});
test("photos before the text boundary use separate node and byte budgets", () => {
  const photos = Array.from({ length: 10 }, (_, n) => photo(`image-${n}`));
  const text = Array.from({ length: 11 }, (_, n) => paragraph("short", `p${n}`));
  const preview = statusBodyPreview([...photos, ...text, paragraph("final", "final"), photo("after-text")])!;
  assert.deepEqual(preview.blocks, [...photos.slice(0, 9), ...text, paragraph("final", "final")]);
  assert.equal(preview.truncated, true);

  const atLimit = statusBodyPreview([photos[0], paragraph("🙂".repeat(400)), photos[1]])!;
  assert.deepEqual(atLimit.blocks.map(block => block.id), [photos[0].id, "p"]);
  assert.equal(atLimit.truncated, true);

  const large = { ...photos[0], caption: [{ text: "x".repeat(7500) }] };
  const callout: ContentBlock = { id: "box", type: "callout", icon: null, tone: "info", text: [], children: [large] };
  const link: ContentBlock = { id: "link", type: "paragraph", text: [{ text: "Later text", link: { kind: "external", url: "https://example.test/" + "a".repeat(1000) } }] };
  assert.deepEqual(statusBodyPreview([callout, link]), { blocks: [callout, link], truncated: false });
  const oversized = { ...large, caption: [{ text: "x".repeat(9000) }] };
  assert.deepEqual(statusBodyPreview([oversized, link]), { blocks: [link], truncated: true });
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
