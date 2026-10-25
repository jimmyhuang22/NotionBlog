import assert from "node:assert/strict";
import test from "node:test";
import type { AnyContent, ContentBlock, ContentDetail, ContentDocument, ContentKind, ImageAsset, TextRun } from "../contracts/content.ts";
import type { PublicContentSnapshot } from "../contracts/website.ts";
import { ContentServiceError } from "../contracts/repository.ts";
import { selectThumbnailCandidates } from "../scripts/media-thumbnails/coverage.ts";

const OWNER = "00000000000000000000000000000010";
const OTHER = "00000000000000000000000000000020";
const ALL: ContentKind[] = ["post", "status", "album", "book", "movie", "game", "course", "study-note", "project", "page"];
const id = (n: number) => `a1.${n.toString(16).padStart(64, "0")}`;
const image = (n: number, version: "v1" | "v2" = "v2"): ImageAsset => ({ id: id(n), src: `/media/${version === "v2" ? "v2/" : ""}${id(n)}`, alt: "Synthetic image", width: null, height: null });
const direct = (): ImageAsset => ({ id: "direct-image", src: "https://images.example.test/public.png?revision=1", alt: "Direct image", width: 300, height: 200 });
const block = (n: number, value: ImageAsset = image(n)): ContentBlock => ({ id: `image-${n}`, type: "image", image: value, caption: [] });
const body = (blocks: ContentBlock[], completeness: ContentDocument["completeness"] = "complete"): ContentDocument => ({ blocks, toc: [], completeness });
function record(kind: ContentKind, cover: ImageAsset | null = null, document: ContentDocument | null = body([]), owner = OWNER): ContentDetail<AnyContent> {
  const base = { id: owner, kind, slug: owner, href: `/status#${owner}`, title: "Private synthetic title", summary: null, tags: [], cover, updatedAt: null };
  return { item: { ...base, ...(kind === "status" ? { recordedAt: null, text: [] } : {}) } as AnyContent, document };
}
const snapshot = (...records: ContentDetail<AnyContent>[]): PublicContentSnapshot => ({ version: "synthetic-published-snapshot", records });
const rejected = (error: unknown) => error instanceof ContentServiceError && error.code === "CONTENT_UNAVAILABLE" && error.message === "Thumbnail coverage input is invalid.";

test("the coverage selector matches cover/grid caps and includes 800 body images in every enabled kind", () => {
  const rows = ALL.map((kind, index) => record(kind, image(index + 1), body([block(index + 100)]), `owner-${index}`));
  const result = selectThumbnailCandidates(snapshot(...rows), "v2", ALL);
  const widths = new Map(result.assets.map(asset => [asset.assetId, asset.neededWidths]));
  for (const [n, expected] of [[1, [400, 800]], [2, [800]], [3, [400, 800]], [4, [400, 800]], [5, [400, 800]], [6, [400, 800]], [7, [800]], [10, []], [8, []], [9, [400, 800]]] as const) {
    assert.deepEqual(widths.get(id(n)) ?? [], expected);
  }
  assert.deepEqual(widths.get(id(101)), [400, 800]); // Status body.
  assert.deepEqual(widths.get(id(102)), [400, 800]); // Album body.
  assert.equal(result.assets.length, 18);
  for (let n = 100; n < 110; n++) assert.ok(widths.get(id(n))?.includes(800));
  assert.equal(result.recordsConsidered, 10);
  assert.equal(result.directExternalOccurrences, 0);
});

test("Status limits 400 previews to nine appearances while all body images retain 800 coverage", () => {
  const blocks = [block(1, direct()), ...Array.from({ length: 8 }, (_, n) => block(n + 2, image(20))), block(10, image(99))];
  const result = selectThumbnailCandidates(snapshot(record("status", image(20), body(blocks))), "v2", ["status"]);
  assert.deepEqual(result.assets, [{ assetId: id(20), ownerPageId: OWNER, neededWidths: [400, 800], kinds: ["status"], occurrences: 17 },
    { assetId: id(99), ownerPageId: OWNER, neededWidths: [800], kinds: ["status"], occurrences: 1 }]);
  assert.equal(result.directExternalOccurrences, 2);
  assert.ok(!JSON.stringify(result).includes("Private synthetic title"));
  assert.ok(!JSON.stringify(result).includes("images.example.test"));
});

test("nested Status and album images retain document order without following child pages or text URLs", () => {
  const containers: ContentBlock[] = [
    block(1),
    { id: "callout", type: "callout", tone: "info", icon: null, text: [], children: [block(2)] },
    { id: "toggle", type: "toggle", title: [], children: [
      { id: "columns", type: "columns", columns: [{ ratio: null, blocks: [
        { id: "list", type: "list", ordered: false, items: [{ id: "row", text: [], checked: null, children: [block(3), block(4)] }] },
      ] }] },
    ] },
    { id: "child", type: "child-page", title: "Synthetic linked page", target: { title: "Linked", href: "/photos/other" } },
    { id: "paragraph", type: "paragraph", text: [{ text: "Link", link: { kind: "external", url: image(98).src } }] },
    { id: "embed", type: "embed", title: "Embed", url: image(97).src, display: "link" },
    { id: "bookmark", type: "bookmark", title: "Bookmark", url: image(96).src, description: null },
    ...Array.from({ length: 7 }, (_, n) => block(n + 5)),
  ];
  const statuses = selectThumbnailCandidates(snapshot(record("status", null, body(containers))), "v2", ["status"]);
  assert.deepEqual(statuses.assets.map(asset => asset.assetId), Array.from({ length: 11 }, (_, n) => id(n + 1)));
  const albums = selectThumbnailCandidates(snapshot(record("album", image(12), body(containers))), "v2", ["album"]);
  assert.deepEqual(albums.assets.map(asset => asset.assetId), Array.from({ length: 12 }, (_, n) => id(n + 1)));
  assert.ok(albums.assets.every(asset => JSON.stringify(asset.neededWidths) === "[400,800]"));
  assert.deepEqual(statuses.assets.find(asset => asset.assetId === id(10))!.neededWidths, [800]);
});

test("only enabled records contribute coverage and document-completeness counts", () => {
  const rows = [record("status", image(1), null), record("album", image(2), body([], "partial"), OTHER), record("course", null, null, "course-owner")];
  const result = selectThumbnailCandidates(snapshot(...rows), "v2", ["status", "course"]);
  assert.equal(result.recordsConsidered, 2); assert.equal(result.unloadedDocuments, 2); assert.equal(result.partialDocuments, 0);
  assert.deepEqual(result.assets.map(asset => asset.assetId), [id(1)]);
  const album = selectThumbnailCandidates(snapshot(...rows), "v2", ["album"]);
  assert.equal(album.partialDocuments, 1); assert.equal(album.recordsConsidered, 1);
  assert.deepEqual(selectThumbnailCandidates(snapshot(...rows), "v2", []), { assets: [], directExternalOccurrences: 0, unloadedDocuments: 0, partialDocuments: 0, recordsConsidered: 0 });
});

test("all selected body images are validated, including the tenth Status image", () => {
  const malformedImage = null as unknown as ImageAsset;
  const status = record("status", null, body([...Array.from({ length: 9 }, (_, n) => block(n + 1)), block(10, malformedImage)]));
  assert.throws(() => selectThumbnailCandidates(snapshot(status), "v2", ["status"]), rejected);
  for (const kind of ["course", "study-note", "book", "movie", "game", "page", "post", "project"] as const) {
    const row = record(kind, null, body([block(1, malformedImage)]));
    assert.throws(() => selectThumbnailCandidates(snapshot(row), "v2", [kind]), rejected);
  }
  assert.throws(() => selectThumbnailCandidates(snapshot(record("album", null, body([block(1, malformedImage)]))), "v2", ["album"]), rejected);
});

test("valid direct HTTPS covers stay external and count selected occurrences without body URLs leaking", () => {
  const result = selectThumbnailCandidates(snapshot(record("movie", direct(), body([block(1, direct())]))), "v2", ["movie"]);
  assert.equal(result.directExternalOccurrences, 2); assert.deepEqual(result.assets, []);
  const status = selectThumbnailCandidates(snapshot(record("status", direct(), body([block(1, direct())]))), "v2", ["status"]);
  assert.equal(status.directExternalOccurrences, 3);
});

test("v1 and v2 canonical media namespaces are matched exactly", () => {
  assert.equal(selectThumbnailCandidates(snapshot(record("status", image(1, "v1"))), "v1", ["status"]).assets[0]!.assetId, id(1));
  assert.throws(() => selectThumbnailCandidates(snapshot(record("status", image(1, "v1"))), "v2", ["status"]), rejected);
  assert.throws(() => selectThumbnailCandidates(snapshot(record("status", image(1))), "v1", ["status"]), rejected);
});

test("v2 page mentions in nested bodies and Status text preserve selection while v1 rejects the field", () => {
  for (const placement of ["body", "status"] as const) {
    const run: TextRun = { text: "Current title", pageMention: true, link: placement === "body"
      ? { kind: "internal", href: "/study/course/notes/note" } : { kind: "unavailable" } };
    const input = (version: "v1" | "v2", marked: boolean) => {
      const { pageMention: _marker, ...plain } = run, selected = marked ? run : plain;
      const row = record("status", image(1, version), body([{ id: "toggle", type: "toggle", title: [], children: placement === "body"
        ? [{ id: "mention", type: "paragraph", text: [selected] }] : [] }, block(2, image(2, version))]));
      if (row.item.kind !== "status") assert.fail(); row.item.text = placement === "status" ? [selected] : [];
      return snapshot(row);
    };
    assert.deepEqual(selectThumbnailCandidates(input("v2", true), "v2", ["status"]), selectThumbnailCandidates(input("v2", false), "v2", ["status"]));
    assert.doesNotThrow(() => selectThumbnailCandidates(input("v1", false), "v1", ["status"]));
    assert.throws(() => selectThumbnailCandidates(input("v1", true), "v1", ["status"]), rejected);
  }
});

test("coverage rejects malformed page-mention markers and incompatible links or equations", () => {
  const internal = { kind: "internal", href: "/study/course" };
  for (const run of [
    ...[false, "true", null, 1].map(pageMention => ({ text: "Title", pageMention, link: internal })),
    { text: "Title", pageMention: true },
    { text: "Title", pageMention: true, link: { kind: "external", url: "https://example.test/" } },
    { text: "Title", pageMention: true, equation: true, link: internal },
    { text: "Title", pageMention: true, link: internal, unexpected: true },
  ]) {
    const row = record("status", null, body([{ id: "mention", type: "paragraph", text: [run as TextRun] }]));
    assert.throws(() => selectThumbnailCandidates(snapshot(row), "v2", ["status"]), rejected);
  }
});

test("malformed selected media and unsafe direct URLs fail anonymously", async t => {
  const cases: [string, Partial<ImageAsset>][] = [
    ["id mismatch", { id: id(2) }], ["query", { src: image(1).src + "?thumbnail=400" }], ["hash", { src: image(1).src + "#image" }],
    ["newline", { src: image(1).src + "\n" }], ["uppercase", { src: "/media/v2/a1." + "A".repeat(64) }],
    ["encoded", { src: "/media/v2/%61" + id(1).slice(1) }], ["absolute app URL", { src: "http://site.example.test" + image(1).src }],
    ["mock", { src: "/mock-media/image.png" }], ["signed entry", { src: "/media/m1.synthetic" }], ["invalid dimensions", { width: -1 }],
    ["http direct", { src: "http://images.example.test/public.png" }], ["localhost", { src: "https://localhost/public.png" }],
    ["credentials", { src: "https://private:credential@images.example.test/public.png" }], ["external fragment", { src: "https://images.example.test/public.png#part" }],
    ["nonstandard port", { src: "https://images.example.test:444/public.png" }], ["backslash", { src: "https://images.example.test\\private.png" }],
  ];
  for (const [name, change] of cases) await t.test(name, () => {
    assert.throws(() => selectThumbnailCandidates(snapshot(record("status", { ...image(1), ...change })), "v2", ["status"]), rejected);
  });
});

test("snapshot structure, explicit feature list, duplicate owners and cross-owner assets fail closed", () => {
  const row = record("status", image(1));
  for (const value of [null, {}, { version: "x", records: {} }, { ...snapshot(row), unexpected: "private" }, { ...snapshot(row), version: "" }]) {
    assert.throws(() => selectThumbnailCandidates(value as PublicContentSnapshot, "v2", ["status"]), rejected);
  }
  for (const kinds of [undefined, ["unknown"], ["status", "status"], Array<ContentKind>(1)]) {
    assert.throws(() => selectThumbnailCandidates(snapshot(row), "v2", kinds as ContentKind[]), rejected);
  }
  assert.throws(() => selectThumbnailCandidates(snapshot(row), "v3" as "v2", ["status"]), rejected);
  assert.throws(() => selectThumbnailCandidates(snapshot(row, row), "v2", ["status"]), rejected);
  assert.throws(() => selectThumbnailCandidates(snapshot(record("status", null, body([]), "owner\n")), "v2", ["status"]), rejected);
  assert.throws(() => selectThumbnailCandidates(snapshot(row, record("album", image(1), body([]), OTHER)), "v2", ["status", "album"]), rejected);
  assert.throws(() => selectThumbnailCandidates(snapshot({ ...row, item: { ...row.item, kind: "unknown" } as unknown as AnyContent }), "v2", []), rejected);
  assert.throws(() => selectThumbnailCandidates(snapshot({ ...row, document: { ...body([]), completeness: "invalid" } as unknown as ContentDocument }), "v2", ["status"]), rejected);
});

test("known AST shapes reject extra child fields, malformed arrays and unknown node types", () => {
  for (const value of [
    { id: "paragraph", type: "paragraph", text: [], children: [block(1)] },
    { id: "unknown", type: "future-block", children: [block(1)] },
    { id: "toggle", type: "toggle", title: [], children: null },
    { id: "list", type: "list", ordered: false, items: [{ id: "row", text: [], checked: null, children: {} }] },
    { id: "image", type: "image", image: image(1), caption: [{ text: 42 }] },
    { id: "columns", type: "columns", columns: [{ ratio: Number.NaN, blocks: [] }] },
  ]) assert.throws(() => selectThumbnailCandidates(snapshot(record("status", null, body([value as ContentBlock]))), "v2", ["status"]), rejected);
});

test("cyclic, excessively deep and oversized ASTs or record sets are bounded", () => {
  const cycle: ContentBlock[] = [];
  cycle.push({ id: "cycle", type: "toggle", title: [], children: cycle });
  assert.throws(() => selectThumbnailCandidates(snapshot(record("status", null, body(cycle))), "v2", ["status"]), rejected);
  let nested: ContentBlock[] = [block(1)];
  for (let n = 0; n < 33; n++) nested = [{ id: `depth-${n}`, type: "toggle", title: [], children: nested }];
  assert.throws(() => selectThumbnailCandidates(snapshot(record("album", null, body(nested))), "v2", ["album"]), rejected);
  const oversized = Array.from({ length: 20_001 }, (_, n) => ({ id: `block-${n}`, type: "divider" as const }));
  assert.throws(() => selectThumbnailCandidates(snapshot(record("status", null, body(oversized))), "v2", ["status"]), rejected);
  assert.throws(() => selectThumbnailCandidates(snapshot(...Array.from({ length: 20_001 }, (_, n) => record("status", null, body([]), `owner-${n}`))), "v2", ["status"]), rejected);
  const shared = Array.from({ length: 20_000 }, (_, n) => ({ id: `block-${n}`, type: "divider" as const }));
  const many = Array.from({ length: 11 }, (_, n) => record("album", null, body(shared), `owner-${n}`));
  assert.throws(() => selectThumbnailCandidates(snapshot(...many), "v2", ["album"]), rejected);
});

test("aggregate AST text is bounded before Status preview concatenates repeated strings", () => {
  // The input deliberately shares one string; its small in-memory footprint
  // must not permit an enormous join allocation inside statusPreview.
  const large = "x".repeat(200_000);
  const text = Array.from({ length: 168 }, () => ({ text: large }));
  const paragraph: ContentBlock = { id: "paragraph", type: "paragraph", text };
  assert.throws(() => selectThumbnailCandidates(snapshot(record("status", null, body([paragraph]))), "v2", ["status"]), rejected);
  const row = record("status");
  (row.item as AnyContent & { text: { text: string }[] }).text = text;
  assert.throws(() => selectThumbnailCandidates(snapshot(row), "v2", ["status"]), rejected);
});

test("selection preserves caller data and returns no mutable references into it", () => {
  const input = snapshot(record("album", image(1), body([block(1), block(2)])));
  const before = JSON.stringify(input);
  const result = selectThumbnailCandidates(input, "v2", ["album"]);
  assert.equal(result.assets[0]!.occurrences, 2);
  result.assets[0]!.neededWidths.push(800); result.assets[0]!.kinds.push("status");
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(selectThumbnailCandidates(input, "v2", ["album"]).assets[0]!.neededWidths, [400, 800]);
});
