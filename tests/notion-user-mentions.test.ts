import assert from "node:assert/strict";
import test from "node:test";
import type { BlockObjectResponse, DataSourceObjectResponse, PageObjectResponse, RichTextItemResponse } from "@notionhq/client";
import { buildNotionDocument, convertNotionRichText } from "../src/server/notion/blocks.ts";
import { getSelect, getTitle, plainText } from "../src/server/notion/properties.ts";
import { parseNotionSourcesConfig } from "../src/server/notion/config.ts";
import { parseWebsiteNotionConfig } from "../src/server/notion/website-config.ts";
import { createNotionRepository } from "../src/server/notion/repository.ts";
import { createWebsiteNotionRepository } from "../src/server/notion/website-repository.ts";
import type { NotionReadClient } from "../src/server/notion/types.ts";

// Fictional API objects only. These markers deliberately differ from the public label.
const id = (n: number) => n.toString(16).padStart(32, "0");
const owner = id(10), sourceId = id(20), personId = id(30);
const displayName = "Fictional Mentioned Person", email = "mentioned-person@example.test";
const profile = "https://profiles.example.test/fictional-person";
const annotations = { bold: false, italic: false, code: false, underline: false, strikethrough: false, color: "default" as const };
const text = (content: string): RichTextItemResponse => ({ type: "text", plain_text: content, href: null, text: { content, link: null }, annotations });
const user = (partial = false): RichTextItemResponse => ({ type: "mention", mention: { type: "user", user: partial
  ? { object: "user", id: personId }
  : { object: "user", id: personId, type: "person", name: displayName, avatar_url: profile, person: { email } } },
  plain_text: displayName, href: profile, annotations });
const noIdentity = (value: unknown) => {
  const serialized = JSON.stringify(value);
  for (const marker of [displayName, email, profile, personId]) assert.equal(serialized.includes(marker), false, marker);
};
function block(n: number, type: string, payload: unknown, parent = owner, children = false): BlockObjectResponse {
  return { object: "block", id: id(n), type, [type]: payload, parent: { type: parent === owner ? "page_id" : "block_id", [parent === owner ? "page_id" : "block_id"]: parent },
    has_children: children, archived: false, in_trash: false } as unknown as BlockObjectResponse;
}
const context = () => ({ resolvePageLink: async () => assert.fail("User mentions must not resolve identities or links"),
  registerImage: async () => assert.fail("This fixture must not fetch an image") });

test("full and partial user mentions use neutral unlinked text without changing authored text, dates or styles", async () => {
  for (const partial of [false, true]) {
    const mention = user(partial);
    mention.annotations = { ...annotations, bold: true, italic: true, underline: true, code: true, strikethrough: true, color: "red_background" };
    const date: RichTextItemResponse = { type: "mention", mention: { type: "date", date: { start: "2026-01-01", end: null, time_zone: null } },
      plain_text: "January 1, 2026", href: null, annotations };
    const result = await convertNotionRichText([text("With "), mention, date], context());
    assert.deepEqual(result[1], { text: "User", bold: true, italic: true, underline: true, code: true, strike: true, color: "warning" });
    assert.equal(result[0].text, "With "); assert.equal(result[2].text, date.plain_text);
    noIdentity(result);
    assert.equal((await convertNotionRichText([text(displayName)], context()))[0].text, displayName, "Ordinary authored names are not guessed or scrubbed");
  }
});

test("headings, nested text, tables, code and media captions cannot derive an identity from a user mention", async () => {
  const tree: Record<string, BlockObjectResponse[]> = {
    [owner]: [block(101, "heading_1", { rich_text: [user()], color: "default", is_toggleable: false }),
      block(102, "toggle", { rich_text: [user()], color: "default" }, owner, true),
      block(103, "table", { table_width: 1, has_column_header: false, has_row_header: false }, owner, true),
      block(104, "code", { rich_text: [user()], caption: [user()], language: "plain text" }),
      block(105, "image", { type: "external", external: { url: "https://images.example.test/synthetic.png" }, caption: [user()] })],
    [id(102)]: [block(106, "paragraph", { rich_text: [user(true)], color: "default" }, id(102))],
    [id(103)]: [block(107, "table_row", { cells: [[user()]] }, id(103))],
  };
  const alts: string[] = [];
  const client = { listBlocks: async (key: string) => tree[key] } as NotionReadClient;
  const document = await buildNotionDocument(owner, client, { ...context(), registerImage: async input => {
    alts.push(input.alt); return { id: "synthetic-image", src: "/media/synthetic-image", alt: input.alt, width: null, height: null };
  } });
  assert.equal(document.completeness, "complete");
  assert.equal(document.toc[0].title, "User"); assert.deepEqual(alts, ["User"]);
  assert.equal(document.blocks.length, 5); noIdentity(document);
});

function fixture() {
  const rich = [text("With "), user()];
  const page = { object: "page", id: owner, parent: { type: "data_source_id", data_source_id: sourceId },
    properties: { Name: { id: "title", type: "title", title: rich }, Summary: { id: "summary", type: "rich_text", rich_text: rich } },
    cover: null, archived: false, in_trash: false, is_archived: false, last_edited_time: "2026-01-01T00:00:00Z" } as unknown as PageObjectResponse;
  const schema = { object: "data_source", id: sourceId, archived: false, in_trash: false, properties: {
    Name: { id: "title", name: "Name", type: "title", title: {} }, Summary: { id: "summary", name: "Summary", type: "rich_text", rich_text: {} },
  } } as unknown as DataSourceObjectResponse;
  const client: NotionReadClient = { getPage: async key => key === owner ? structuredClone(page) : null,
    getDataSource: async key => { assert.equal(key, sourceId); return structuredClone(schema); }, getBlock: async () => null,
    listPages: async () => [structuredClone(page)], listBlocks: async key => { assert.equal(key, owner);
      return [block(110, "paragraph", { rich_text: [text("Body "), user()], color: "default" })]; } };
  const source = { key: "statuses", kind: "status", dataSourceId: sourceId, enabled: true, fields: { title: "Name", summary: "Summary" },
    publication: { mode: "allowlist", allowlistPageIds: [owner] }, cover: { strategy: "none" } };
  return { page, client, source };
}

test("metadata titles and rich-text fields use the same neutral label", () => {
  const { page } = fixture();
  assert.equal(getTitle(page, "Name"), "With User"); assert.equal(getSelect(page, "Summary"), "With User");
  assert.equal(plainText([user(true)]), "User");
  assert.equal(plainText([text(displayName)]), displayName);
});

test("v1 public Status lists and details contain neither mention names nor profile locations", async () => {
  const f = fixture(), repository = createNotionRepository({ client: f.client,
    config: parseNotionSourcesConfig({ schemaVersion: 1, sources: [f.source] }) });
  const detail = await repository.get("status", owner), list = await repository.list("status");
  assert.equal(detail!.item.title, "With User"); assert.equal(detail!.item.summary, "With User");
  assert.equal(detail!.document!.blocks[0].type, "paragraph");
  noIdentity(detail); noIdentity(list);
});

test("v2 collected payloads, Status projections and search snapshots all use neutral user mentions", async () => {
  const f = fixture(), repository = createWebsiteNotionRepository({ client: f.client,
    config: parseWebsiteNotionConfig({ schemaVersion: 2, sources: [{ ...f.source, publication: { mode: "all", allowlistPageIds: [] } }] }) });
  const records = await repository.collectRecords(), detail = await repository.get("status", owner), list = await repository.list("status");
  assert.equal(records[0].detail.item.title, "With User"); assert.equal(records[0].detail.item.summary, "With User");
  assert.equal(list.items[0].title, "With User");
  noIdentity(records); noIdentity(detail); noIdentity(list); noIdentity(await repository.readSearchSnapshot!(["status"]));
});
