import assert from "node:assert/strict";
import test from "node:test";
import type { BlockObjectResponse, RichTextItemResponse } from "@notionhq/client";
import type { ContentLink, ImageAsset } from "../contracts/content.ts";
import {
  buildNotionDocument, convertNotionRichText, resolveNotionTextLink,
  type BlockConversionContext, type RegisterBlockImageInput,
} from "../src/server/notion/blocks.ts";
import type { NotionReadClient } from "../src/server/notion/types.ts";

// All IDs, text, media locations, and API-shaped objects below are fictional.
const id = (index: number) => index.toString(16).padStart(32, "0");
const owner = id(1);
const notionOrigin = `https://${["www", "notion", "so"].join(".")}`;
const annotations = { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" as const };

function rich(content: string, href: string | null = null): RichTextItemResponse {
  return { type: "text", plain_text: content, href, text: { content, link: href ? { url: href } : null }, annotations };
}

function mention(pageId: string, label: string): RichTextItemResponse {
  return { type: "mention", mention: { type: "page", page: { id: pageId } },
    plain_text: label, href: `${notionOrigin}/${pageId}`, annotations };
}

function block(
  index: number,
  type: BlockObjectResponse["type"],
  payload: object,
  options: { parent?: string; children?: boolean; archived?: boolean } = {},
): BlockObjectResponse {
  const parent = options.parent ?? owner;
  return {
    object: "block", id: id(index), type, [type]: payload,
    parent: parent === owner ? { type: "page_id", page_id: parent } : { type: "block_id", block_id: parent },
    has_children: options.children ?? false, archived: options.archived ?? false, in_trash: false,
    created_time: "2026-01-01T00:00:00.000Z", last_edited_time: "2026-01-01T00:00:00.000Z",
    created_by: { object: "user", id: id(999) }, last_edited_by: { object: "user", id: id(999) },
  } as BlockObjectResponse;
}

const paragraph = (index: number, content: string, options?: Parameters<typeof block>[3]) =>
  block(index, "paragraph", { rich_text: [rich(content)], color: "default", icon: null }, options);

function harness(
  tree: Record<string, BlockObjectResponse[]>,
  links: Record<string, ContentLink> = {},
  imageFactory: (input: RegisterBlockImageInput) => ImageAsset | null = (input) =>
    ({ id: "public-media-reference", src: "/media/public-media-reference", alt: input.alt, width: null, height: null }),
) {
  const reads: string[] = [];
  const resolved: string[] = [];
  const images: RegisterBlockImageInput[] = [];
  const client: NotionReadClient = {
    async getPage() { throw new Error("Block conversion must not fetch page titles"); },
    async getDataSource() { throw new Error("Block conversion must not crawl databases"); },
    async getBlock() { throw new Error("Block conversion must not fetch referenced blocks"); },
    async listBlocks(parentId) {
      reads.push(parentId);
      assert.ok(Object.hasOwn(tree, parentId), "Unexpected child traversal");
      return tree[parentId]!;
    },
  };
  const context: BlockConversionContext = {
    async resolvePageLink(pageId) { resolved.push(pageId); return links[pageId] ?? null; },
    async registerImage(input) { images.push(input); return imageFactory(input); },
  };
  return { client, context, reads, resolved, images };
}

test("known empty page is complete, while unsupported blocks are explicit and partial", async () => {
  const empty = harness({ [owner]: [] });
  assert.deepEqual(await buildNotionDocument(owner, empty.client, empty.context), {
    blocks: [], toc: [], completeness: "complete",
  });
  const unknown = harness({ [owner]: [block(2, "unsupported", { block_type: "fictional future block" }, { children: true }), paragraph(3, "Still readable")] });
  const document = await buildNotionDocument(owner, unknown.client, unknown.context);
  assert.equal(document.completeness, "partial");
  assert.deepEqual(document.blocks.map((item) => item.type), ["unsupported", "paragraph"]);
  assert.deepEqual(unknown.reads, [owner]);
  const future = block(4, "unsupported", {});
  (future as unknown as { type: string }).type = "future_unknown_block";
  const futureSource = harness({ [owner]: [future] });
  assert.equal((await buildNotionDocument(owner, futureSource.client, futureSource.context)).blocks[0]?.type, "unsupported");
});

test("verified course databases use directory coverage without crawling or exposing database titles", async () => {
  const source = () => harness({ [owner]: [block(2, "child_database", { title: "Private database title" }, { children: true }), paragraph(3, "Introduction")] });
  const h = source(); h.context.isCourseDatabaseRepresented = async () => true;
  const document = await buildNotionDocument(owner, h.client, h.context);
  assert.equal(document.completeness, "complete");
  assert.deepEqual(document.blocks.map(b => b.type), ["paragraph"]);
  assert.deepEqual(h.reads, [owner]);
  assert.equal(JSON.stringify(document).includes("Private database title"), false);
  const unknown = source(); unknown.context.isCourseDatabaseRepresented = async () => false;
  const partial = await buildNotionDocument(owner, unknown.client, unknown.context);
  assert.equal(partial.completeness, "partial"); assert.equal(partial.blocks[0].type, "unsupported");
  assert.deepEqual(unknown.reads, [owner]);
});

test("rich text preserves annotations, coarse colors, and equation expressions", async () => {
  const { context } = harness({ [owner]: [] });
  const formatted = rich("Formatted");
  formatted.annotations = { bold: true, italic: true, code: true, underline: true, strikethrough: true, color: "red_background" };
  const equation: RichTextItemResponse = { type: "equation", equation: { expression: "E=mc^2" }, plain_text: "E=mc^2", href: null, annotations };
  const result = await convertNotionRichText([formatted, equation, rich("Block color")], context, "gray");
  assert.deepEqual(result[0], { text: "Formatted", bold: true, italic: true, code: true, underline: true, strike: true, color: "warning" });
  assert.equal(result[1]?.text, "E=mc^2");
  assert.equal(result[2]?.color, "muted");
});

test("mentions and Notion web links resolve only through independently authorized app routes", async () => {
  const allowed = id(20);
  const denied = id(21);
  const appLink = { title: "Published note", href: "/study/demo/note" };
  const source = harness({ [owner]: [] }, { [allowed]: appLink });
  const result = await convertNotionRichText([
    mention(allowed, "Note reference"), mention(denied, "Authored reference label"),
    rich("Web link", `${notionOrigin}/Example-${allowed}`),
    rich(`${notionOrigin}/${denied}`, `${notionOrigin}/${denied}`),
    rich("External", "https://example.test/resource"),
  ], source.context);
  assert.deepEqual(result.map((run) => run.link), [
    { kind: "internal", href: appLink.href }, { kind: "unavailable" },
    { kind: "internal", href: appLink.href }, { kind: "unavailable" },
    { kind: "external", url: "https://example.test/resource" },
  ]);
  assert.equal(result[0]?.text, appLink.title);
  assert.equal(result[1]?.text, "Unavailable page");
  assert.equal(result[3]?.text, "Notion page");
  assert.ok(!JSON.stringify(result).includes(notionOrigin));
  assert.deepEqual(await resolveNotionTextLink(`${notionOrigin}/workspace?p=${allowed}`, source.context), { kind: "internal", href: appLink.href });
});

test("unsafe protocols, credentialed URLs, and unresolved Notion locations are unavailable", async () => {
  const { context } = harness({ [owner]: [] });
  for (const url of ["javascript:alert(1)", "data:text/html,test", "file:///fictional", "https://user:password@example.test/", "//example.test", "https://example.test/\\evil", `${notionOrigin}/unresolvable`]) {
    assert.deepEqual(await resolveNotionTextLink(url, context), { kind: "unavailable" }, url);
  }
  const brokenResolver = { ...context, async resolvePageLink() { return { title: "Rejected", href: "//outside.test" }; } };
  assert.deepEqual(await resolveNotionTextLink(`${notionOrigin}/${id(20)}`, brokenResolver), { kind: "unavailable" });
});

test("child pages and page links never fetch private titles or follow descendants", async () => {
  const publicChild = id(3);
  const privateChild = id(4);
  const source = harness({ [owner]: [
    block(3, "child_page", { title: "Title from source" }, { children: true }),
    block(4, "child_page", { title: "Fictional private title" }, { children: true }),
    block(5, "link_to_page", { type: "page_id", page_id: publicChild }),
    block(6, "link_to_page", { type: "page_id", page_id: privateChild }),
    block(7, "link_to_page", { type: "database_id", database_id: id(50) }),
  ] }, { [publicChild]: { title: "Public child", href: "/study/demo/public-child" } });
  const document = await buildNotionDocument(owner, source.client, source.context);
  assert.equal(document.completeness, "complete");
  assert.ok(document.blocks.every((item) => item.type === "child-page"));
  assert.equal(document.blocks[0]?.type === "child-page" && document.blocks[0].target?.title, "Public child");
  assert.equal(document.blocks[1]?.type === "child-page" && document.blocks[1].target, null);
  assert.ok(!JSON.stringify(document).includes("Fictional private title"));
  assert.deepEqual(source.reads, [owner]);
  assert.deepEqual(source.resolved, [publicChild, privateChild]);
});

test("consecutive list items group by kind and preserve nested mixed lists and task state", async () => {
  const listPayload = (text: string) => ({ rich_text: [rich(text)], color: "default" });
  const source = harness({
    [owner]: [
      block(2, "bulleted_list_item", listPayload("First"), { children: true }),
      block(3, "bulleted_list_item", listPayload("Second")),
      block(4, "numbered_list_item", listPayload("Numbered")),
      block(5, "to_do", { ...listPayload("Checked task"), checked: true }),
      block(6, "to_do", { ...listPayload("Unchecked task"), checked: false }),
      paragraph(7, "Break"), block(8, "bulleted_list_item", listPayload("New list")),
    ],
    [id(2)]: [block(9, "numbered_list_item", listPayload("Nested"), { parent: id(2), children: true })],
    [id(9)]: [paragraph(10, "Nested paragraph", { parent: id(9) })],
  });
  const document = await buildNotionDocument(owner, source.client, source.context);
  assert.equal(document.completeness, "complete");
  assert.deepEqual(document.blocks.map((item) => item.type), ["list", "list", "list", "paragraph", "list"]);
  const first = document.blocks[0];
  assert.ok(first?.type === "list");
  assert.equal(first.items.length, 2);
  assert.equal(first.ordered, false);
  const nested = first.items[0]?.children[0];
  assert.ok(nested?.type === "list");
  assert.equal(nested.ordered, true);
  assert.equal(nested.items[0]?.children[0]?.type, "paragraph");
  const tasks = document.blocks[2];
  assert.ok(tasks?.type === "list");
  assert.deepEqual(tasks.items.map((item) => item.checked), [true, false]);
  assert.notEqual(first.id, first.items[0]?.id);
});

test("heading TOC follows source order, including toggle headings and columns", async () => {
  const heading = (title: string, toggleable = false) => ({ rich_text: [rich(title)], color: "default", is_toggleable: toggleable });
  const source = harness({
    [owner]: [block(2, "heading_1", heading("Overview")), block(3, "heading_2", heading("Expandable", true), { children: true }),
      block(5, "column_list", {}, { children: true }), block(10, "heading_3", heading("Final"))],
    [id(3)]: [block(4, "heading_3", heading("Inside toggle"), { parent: id(3) })],
    [id(5)]: [block(6, "column", { width_ratio: 0.6 }, { parent: id(5), children: true }), block(7, "column", {}, { parent: id(5), children: true })],
    [id(6)]: [block(8, "heading_2", heading("Left"), { parent: id(6) })],
    [id(7)]: [block(9, "heading_2", heading("Right"), { parent: id(7) })],
  });
  const document = await buildNotionDocument(owner, source.client, source.context);
  assert.equal(document.completeness, "complete");
  assert.deepEqual(document.toc.map((entry) => entry.title), ["Overview", "Expandable", "Inside toggle", "Left", "Right", "Final"]);
  assert.equal(document.toc[0]?.id, document.blocks[0]?.id);
  assert.equal(document.toc[1]?.id, document.blocks[1]?.id);
  const toggle = document.blocks[2];
  assert.ok(toggle?.type === "toggle");
  assert.equal(document.toc[2]?.id, toggle.children[0]?.id);
  const columns = document.blocks[3];
  assert.ok(columns?.type === "columns");
  assert.deepEqual(columns.columns.map((column) => column.ratio), [0.6, null]);
  assert.equal(document.toc[3]?.id, columns.columns[0]?.blocks[0]?.id);
  assert.ok(!JSON.stringify(document).includes(id(2)));
});

test("callouts, toggles, code, quotes, table, bookmarks, and embeds map to contract shapes", async () => {
  const source = harness({
    [owner]: [
      block(2, "callout", { rich_text: [rich("Attention")], color: "yellow_background", icon: { type: "emoji", emoji: "💡" } }, { children: true }),
      block(4, "toggle", { rich_text: [rich("More")], color: "default" }, { children: true }),
      block(6, "code", { rich_text: [rich("const value = 1;\n")], language: "typescript", caption: [rich("Example")] }),
      block(7, "quote", { rich_text: [rich("Quote")], color: "default" }), block(8, "divider", {}),
      block(9, "table", { has_column_header: true, has_row_header: false, table_width: 2 }, { children: true }),
      block(12, "bookmark", { url: "https://example.test/article", caption: [rich("Article")] }),
      block(13, "embed", { url: "https://example.test/video", caption: [] }),
      block(14, "table_of_contents", { color: "default" }), block(15, "equation", { expression: "x^2+y^2=z^2" }),
    ],
    [id(2)]: [paragraph(3, "Callout child", { parent: id(2) })],
    [id(4)]: [paragraph(5, "Toggle child", { parent: id(4) })],
    [id(9)]: [block(10, "table_row", { cells: [[rich("A")], [rich("B")]] }, { parent: id(9) }),
      block(11, "table_row", { cells: [[rich("C")], [rich("D")]] }, { parent: id(9) })],
  });
  const document = await buildNotionDocument(owner, source.client, source.context);
  assert.equal(document.completeness, "complete");
  assert.deepEqual(document.blocks.map((item) => item.type), ["callout", "toggle", "code", "quote", "divider", "table", "bookmark", "embed", "table-of-contents", "equation"]);
  const callout = document.blocks[0];
  assert.ok(callout?.type === "callout");
  assert.equal(callout.tone, "warning");
  assert.equal(callout.icon, "💡");
  assert.equal(callout.children[0]?.type, "paragraph");
  const table = document.blocks[5];
  assert.ok(table?.type === "table");
  assert.equal(table.hasColumnHeader, true);
  assert.deepEqual(table.rows.map((row) => row.map((cell) => cell.map((run) => run.text).join(""))), [["A", "B"], ["C", "D"]]);
  const embed = document.blocks[7];
  assert.ok(embed?.type === "embed");
  assert.equal(embed.display, "link");
});

test("website videos reuse stable link embeds while legacy and private files remain explicit", async () => {
  const make = () => harness({ [owner]: [
    block(2, "video", { type: "external", external: { url: "https://video.example.test/watch?v=sample" }, caption: [rich("Lesson video")] }),
    block(3, "video", { type: "file", file: { url: "https://private.example.test/asset?secret=fictional", expiry_time: "2026-01-02T00:00:00.000Z" }, caption: [] }),
  ] });
  const legacy = make();
  assert.deepEqual((await buildNotionDocument(owner, legacy.client, legacy.context)).blocks.map(b => b.type), ["unsupported", "unsupported"]);
  const website = make(); website.context.externalVideos = true;
  const result = await buildNotionDocument(owner, website.client, website.context);
  assert.equal(result.completeness, "partial");
  const video = result.blocks[0]; assert.equal(video.type, "embed");
  if (video.type !== "embed") assert.fail("Expected an external link embed");
  assert.equal(video.url, "https://video.example.test/watch?v=sample");
  assert.equal(video.title, "Lesson video"); assert.equal(video.display, "link");
  assert.equal(result.blocks[1].type, "unsupported");
  assert.equal(JSON.stringify(result).includes("secret=fictional"), false);
  assert.deepEqual(website.images, []); assert.deepEqual(website.reads, [owner]);
});

test("external videos reject unsafe and temporary URLs and resolve internal targets independently", async () => {
  const temporary = new URL("https://asset.example.test/file");
  temporary.searchParams.set("X-Amz-Signature", "fictional");
  for (const url of ["javascript:alert(1)", "data:video/mp4,test", "https://user:password@example.test/", temporary.href, `${notionOrigin}/${id(30)}`]) {
    const h = harness({ [owner]: [block(2, "video", { type: "external", external: { url }, caption: [] })] });
    h.context.externalVideos = true;
    const result = await buildNotionDocument(owner, h.client, h.context);
    assert.equal(result.completeness, "partial"); assert.equal(result.blocks[0].type, "unsupported");
    assert.equal(JSON.stringify(result).includes(url), false);
  }
  const h = harness({ [owner]: [block(2, "video", { type: "external", external: { url: `${notionOrigin}/${id(30)}` }, caption: [] })] }, { [id(30)]: { title: "Allowed lesson", href: "/study/demo/notes/allowed" } });
  h.context.externalVideos = true;
  const result = await buildNotionDocument(owner, h.client, h.context);
  assert.equal(result.completeness, "complete"); assert.equal(result.blocks[0].type, "child-page");
  assert.deepEqual(h.resolved, [id(30)]);
});

test("nested images keep the authorized owner and expose only stable media URLs", async () => {
  const location = new URL("https://assets.example.test/picture.png");
  location.searchParams.set("X-Amz-Signature", "fictional-signature");
  const signedUrl = location.href;
  const source = harness({
    [owner]: [block(2, "toggle", { rich_text: [rich("Pictures")], color: "default" }, { children: true })],
    [id(2)]: [block(3, "image", { type: "file", file: { url: signedUrl, expiry_time: "2026-01-02T00:00:00.000Z" }, caption: [rich("Diagram")] }, { parent: id(2) })],
  });
  const document = await buildNotionDocument(owner, source.client, source.context);
  assert.equal(document.completeness, "complete");
  assert.deepEqual(source.images, [{ ownerPageId: owner, blockId: id(3), url: signedUrl, expiryTime: "2026-01-02T00:00:00.000Z", alt: "Diagram" }]);
  const serialized = JSON.stringify(document);
  assert.ok(serialized.includes("/media/public-media-reference"));
  assert.ok(!serialized.includes(signedUrl));
  assert.ok(!serialized.includes("fictional-signature"));
  const invalidMedia = harness({ [owner]: [block(4, "image", { type: "external", external: { url: signedUrl }, caption: [] })] }, {},
    () => ({ id: "wrong", src: signedUrl, alt: "", width: null, height: null }));
  const invalidDocument = await buildNotionDocument(owner, invalidMedia.client, invalidMedia.context);
  assert.equal(invalidDocument.completeness, "partial");
  assert.equal(invalidDocument.blocks[0]?.type, "unsupported");
  assert.ok(!JSON.stringify(invalidDocument).includes(signedUrl));
  const blockedSource = harness({ [owner]: [block(5, "image", { type: "external", external: { url: "javascript:alert(1)" }, caption: [] })] });
  assert.equal((await buildNotionDocument(owner, blockedSource.client, blockedSource.context)).completeness, "partial");
  assert.deepEqual(blockedSource.images, []);
});

test("blocked bookmark and embed links remain explicit, authorized Notion links become app targets", async () => {
  const source = harness({ [owner]: [
    block(2, "bookmark", { url: "javascript:alert(1)", caption: [] }),
    block(3, "embed", { url: `${notionOrigin}/${id(30)}`, caption: [] }),
    block(4, "bookmark", { url: `${notionOrigin}/${id(31)}`, caption: [rich("Public note")] }),
  ] }, { [id(31)]: { title: "Allowed note", href: "/study/demo/allowed" } });
  const document = await buildNotionDocument(owner, source.client, source.context);
  assert.equal(document.completeness, "partial");
  assert.deepEqual(document.blocks.map((item) => item.type), ["unsupported", "unsupported", "child-page"]);
  assert.ok(!JSON.stringify(document).includes(notionOrigin));
});

test("referenced synced blocks and child databases are not traversed; original inline sync is safe", async () => {
  const source = harness({
    [owner]: [
      block(2, "synced_block", { synced_from: { type: "block_id", block_id: id(30) } }, { children: true }),
      block(3, "child_database", { title: "Private database" }, { children: true }),
      block(4, "synced_block", { synced_from: null }, { children: true }),
    ],
    [id(4)]: [paragraph(5, "Inline permitted content", { parent: id(4) })],
  });
  const document = await buildNotionDocument(owner, source.client, source.context);
  assert.equal(document.completeness, "partial");
  assert.deepEqual(document.blocks.map((item) => item.type), ["unsupported", "unsupported", "paragraph"]);
  assert.deepEqual(source.reads, [owner, id(4)]);
  assert.ok(!JSON.stringify(document).includes("Private database"));
});

test("unrepresentable nested children and heading level four report partial content", async () => {
  const source = harness({ [owner]: [
    block(2, "quote", { rich_text: [rich("Visible quote")], color: "default" }, { children: true }),
    paragraph(3, "Visible paragraph", { children: true }),
    block(4, "heading_4", { rich_text: [rich("Deeper heading")], color: "default", is_toggleable: false }),
  ] });
  const document = await buildNotionDocument(owner, source.client, source.context);
  assert.equal(document.completeness, "partial");
  assert.deepEqual(document.blocks.map((item) => item.type), ["quote", "unsupported", "paragraph", "unsupported", "heading"]);
  assert.equal(document.blocks[4]?.type === "heading" && document.blocks[4].level, 3);
  assert.deepEqual(source.reads, [owner]);
});

test("numbering styles that exceed the contract mark a document partial", async () => {
  const source = harness({ [owner]: [block(2, "numbered_list_item", {
    rich_text: [rich("Fourth step")], color: "default", list_start_index: 4, list_format: "roman",
  })] });
  const document = await buildNotionDocument(owner, source.client, source.context);
  assert.equal(document.completeness, "partial");
  assert.equal(document.blocks[0]?.type, "list");
});

test("recursion and content budgets stop unsafe or unexpectedly large traversals", async () => {
  const togglePayload = { rich_text: [rich("More")], color: "default" };
  const depth = harness({
    [owner]: [block(2, "toggle", togglePayload, { children: true })],
    [id(2)]: [block(3, "toggle", togglePayload, { parent: id(2), children: true })],
  });
  const depthDocument = await buildNotionDocument(owner, depth.client, { ...depth.context, maxDepth: 1 });
  assert.equal(depthDocument.completeness, "partial");
  assert.deepEqual(depth.reads, [owner, id(2)]);
  const budget = harness({ [owner]: [paragraph(2, "A"), paragraph(3, "B"), paragraph(4, "C")] });
  const budgetDocument = await buildNotionDocument(owner, budget.client, { ...budget.context, maxBlocks: 2 });
  assert.equal(budgetDocument.completeness, "partial");
  assert.deepEqual(budgetDocument.blocks.map((item) => item.type), ["paragraph", "paragraph", "unsupported"]);
  const cycle = harness({
    [owner]: [block(2, "toggle", togglePayload, { children: true })],
    [id(2)]: [block(3, "toggle", togglePayload, { parent: id(2), children: true })],
    [id(3)]: [block(2, "toggle", togglePayload, { parent: id(3), children: true })],
  });
  const cycleDocument = await buildNotionDocument(owner, cycle.client, cycle.context);
  assert.equal(cycleDocument.completeness, "partial");
  assert.equal(cycle.reads.length, 3);
});

test("mismatched parents and archived blocks cannot supply descendants or media", async () => {
  const source = harness({ [owner]: [
    block(2, "image", { type: "external", external: { url: "https://example.test/image.png" }, caption: [] }, { parent: id(40) }),
    block(3, "toggle", { rich_text: [rich("Archived")], color: "default" }, { children: true, archived: true }),
  ] });
  const document = await buildNotionDocument(owner, source.client, source.context);
  assert.deepEqual(document.blocks.map((item) => item.type), ["unsupported"]);
  assert.equal(document.completeness, "partial");
  assert.deepEqual(source.reads, [owner]);
  assert.deepEqual(source.images, []);
});

test("provider read errors propagate, rather than producing a misleading empty document", async () => {
  const source = harness({ [owner]: [] });
  source.client.listBlocks = async () => { throw new Error("Unavailable upstream"); };
  await assert.rejects(buildNotionDocument(owner, source.client, source.context), /Unavailable upstream/);
});
