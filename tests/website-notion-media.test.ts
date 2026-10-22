import assert from "node:assert/strict";
import test from "node:test";
import type { BlockObjectResponse, DataSourceObjectResponse, PageObjectResponse } from "@notionhq/client";
import type { ContentKind } from "../contracts/content.ts";
import { ContentServiceError } from "../contracts/repository.ts";
import { demoPage, demoParagraph } from "../scripts/notion-sync/demo.ts";
import { mediaIdentity } from "../src/server/database/validation.ts";
import { sourceFingerprint, type MediaSourceBinding } from "../src/server/media/notion-source.ts";
import { resolveNotionMediaSource } from "../src/server/notion/media-source.ts";
import { parseWebsiteNotionConfig } from "../src/server/notion/website-config.ts";
import { createWebsiteNotionRepository } from "../src/server/notion/website-repository.ts";
import type { NotionReadClient } from "../src/server/notion/types.ts";

// Fictional identities, pages and media only; all reads use this local client.
const id = (value: number) => value.toString(16).padStart(32, "0");
const owner = id(100), blockId = id(200), sourceId = id(10);
const imageUrl = "https://assets.example.test/fictional-website-image.png";
const date = "2026-10-01T00:00:00.000Z";
const parentSource = (identity = sourceId): PageObjectResponse["parent"] => ({ type: "data_source_id", data_source_id: identity, database_id: id(900) });
function schema(identity: string, course?: string): DataSourceObjectResponse {
  return {
    object: "data_source", id: identity, title: [], description: [],
    parent: { type: "database_id", database_id: id(900) },
    database_parent: course ? { type: "page_id", page_id: course } : { type: "workspace", workspace: true },
    is_inline: false, database_type: null, in_trash: false, archived: false,
    created_time: date, last_edited_time: date,
    created_by: { object: "user", id: id(999) }, last_edited_by: { object: "user", id: id(999) },
    icon: null, cover: null, url: "https://example.test/fictional-source", public_url: null,
    properties: {
      Name: { id: "title", name: "Name", description: null, type: "title", title: {} },
      Picture: { id: "picture", name: "Picture", description: null, type: "files", files: {} },
    },
  };
}

function setup(kind: ContentKind = "game", mode: "all" | "allowlist" = "all") {
  const config = parseWebsiteNotionConfig({ schemaVersion: 2, sources: [{
    key: "fictional-website-source", kind, enabled: true,
    ...(kind === "page" ? { pageId: owner, pageKey: "about" } : { dataSourceId: sourceId }),
    fields: { title: "Name" },
    cover: kind === "page" ? { strategy: "none" } : { strategy: "native-page-cover" },
    publication: { mode: kind === "page" ? "allowlist" : mode, allowlistPageIds: kind === "page" || mode === "allowlist" ? [owner] : [] },
  }] });
  const page = demoPage(owner, "Fictional website owner", kind === "page" ? { type: "page_id", page_id: id(901) } : parentSource());
  page.cover = { type: "external", external: { url: imageUrl } };
  const image: BlockObjectResponse = { ...demoParagraph(blockId, owner, ""), type: "image", image: { type: "external", external: { url: imageUrl }, caption: [] } };
  const pages = new Map<string, PageObjectResponse>([[owner, page]]);
  const schemas = new Map<string, DataSourceObjectResponse>([[sourceId, schema(sourceId)]]);
  const blocks = new Map<string, BlockObjectResponse>([[blockId, image]]);
  const reads = { pages: [] as string[], schemas: [] as string[], blocks: [] as string[], queries: 0 };
  const client: NotionReadClient = {
    getPage: async identity => { reads.pages.push(identity); return structuredClone(pages.get(identity) ?? null); },
    getDataSource: async identity => {
      reads.schemas.push(identity);
      const value = schemas.get(identity);
      assert.ok(value, "Only configured source schemas may be read");
      return structuredClone(value);
    },
    getBlock: async identity => { reads.blocks.push(identity); return structuredClone(blocks.get(identity) ?? null); },
    listPages: async () => { reads.queries++; assert.fail("A media owner must never enumerate a whole source"); },
    listBlocks: async () => { assert.fail("A media owner must never read the document body"); },
  };
  const repository = createWebsiteNotionRepository({ client, config });
  const sha256 = "a".repeat(64);
  const binding: MediaSourceBinding = { assetId: mediaIdentity(owner, `block:${blockId}`, sha256), ownerPageId: owner, sha256,
    locator: { kind: "block", id: blockId }, delivery: "notion", sourceFingerprint: sourceFingerprint(imageUrl, false) };
  return { config, pages, schemas, blocks, reads, client, repository, binding };
}
const errorCode = (code: string) => (error: unknown) => error instanceof ContentServiceError && error.code === code;

test("v2 game, photo, Status and every allowed whole-source media kind avoid source enumeration", async t => {
  for (const kind of ["game", "album", "status", "book", "movie", "post", "project"] as const) await t.test(kind, async () => {
    const s = setup(kind);
    assert.equal((await resolveNotionMediaSource(s.binding, s.repository, s.client))?.url, imageUrl);
    assert.deepEqual(s.reads.pages, [owner]);
    assert.deepEqual(s.reads.schemas, [sourceId]);
    assert.deepEqual(s.reads.blocks, [blockId]);
    assert.equal(s.reads.queries, 0);
  });
});

test("v2 whole-source media still rejects foreign sources, moves, inactive pages and identity mismatch", async t => {
  for (const change of ["foreign-source", "ordinary-child", "archived", "trash", "inactive", "wrong-id", "missing"] as const) await t.test(change, async () => {
    const s = setup("game"), page = s.pages.get(owner)!;
    if (change === "foreign-source") page.parent = parentSource(id(11));
    if (change === "ordinary-child") page.parent = { type: "page_id", page_id: id(101) };
    if (change === "archived") page.archived = true;
    if (change === "trash") page.in_trash = true;
    if (change === "inactive") page.is_archived = true;
    if (change === "wrong-id") page.id = id(102);
    if (change === "missing") s.pages.delete(owner);
    assert.equal(await resolveNotionMediaSource(s.binding, s.repository, s.client), null);
    assert.deepEqual(s.reads.blocks, []);
    assert.equal(s.reads.queries, 0);
  });
});

test("v2 media qualifies only its actual direct source among unrelated whole-source sections", async () => {
  const s = setup("game");
  const config = parseWebsiteNotionConfig({ schemaVersion: 2, sources: [
    { key: "fictional-status", kind: "status", enabled: true, dataSourceId: id(11), fields: { title: "Name" }, publication: { mode: "all", allowlistPageIds: [] } },
    { key: "fictional-photos", kind: "album", enabled: true, dataSourceId: id(12), fields: { title: "Name" }, publication: { mode: "all", allowlistPageIds: [] } },
    ...s.config.sources,
  ] });
  const repository = createWebsiteNotionRepository({ client: s.client, config });
  // Unrelated schemas are deliberately absent: the client rejects those reads.
  assert.equal((await resolveNotionMediaSource(s.binding, repository, s.client))?.url, imageUrl);
  assert.deepEqual(s.reads.pages, [owner]);
  assert.deepEqual(s.reads.schemas, [sourceId]);
  assert.equal(s.reads.queries, 0);
  const disabledConfig = parseWebsiteNotionConfig({ schemaVersion: 2,
    sources: config.sources.map(source => ({ ...source, enabled: source.dataSourceId !== sourceId })) });
  const disabledRepository = createWebsiteNotionRepository({ client: s.client, config: disabledConfig });
  assert.equal(await resolveNotionMediaSource(s.binding, disabledRepository, s.client), null);
  assert.deepEqual(s.reads.schemas, [sourceId]);
});

test("v2 source schema, token access failures and later revocation remain fresh for media", async () => {
  const s = setup("album");
  assert.ok(await resolveNotionMediaSource(s.binding, s.repository, s.client));
  s.pages.get(owner)!.archived = true;
  assert.equal(await resolveNotionMediaSource(s.binding, s.repository, s.client), null);
  s.pages.get(owner)!.archived = false;
  for (const broken of [{ ...schema(sourceId), id: id(11) }, { ...schema(sourceId), archived: true },
    { ...schema(sourceId), in_trash: true }, { ...schema(sourceId), properties: {} }]) {
    s.schemas.set(sourceId, broken);
    await assert.rejects(resolveNotionMediaSource(s.binding, s.repository, s.client), errorCode("MISCONFIGURED"));
  }
  s.client.getDataSource = async () => { throw new ContentServiceError("CONTENT_UNAVAILABLE", "Fictional schema access denial"); };
  await assert.rejects(resolveNotionMediaSource(s.binding, s.repository, s.client), errorCode("CONTENT_UNAVAILABLE"));
  assert.equal(s.reads.queries, 0);
});

test("v2 files-property media matches only its current configured mapping", async () => {
  const s = setup("game");
  s.config.sources[0].cover = { strategy: "files-property", property: "Picture" };
  s.pages.get(owner)!.properties.Picture = { id: "picture", type: "files", files: [{ name: "Fictional cover", type: "external", external: { url: imageUrl } }] };
  s.binding.locator = { kind: "property", name: "Picture" };
  s.binding.assetId = mediaIdentity(owner, "property:Picture", s.binding.sha256);
  assert.equal((await resolveNotionMediaSource(s.binding, s.repository, s.client))?.url, imageUrl);
  s.binding.locator = { kind: "property", name: "Old name" };
  assert.equal(await resolveNotionMediaSource(s.binding, s.repository, s.client), null);
  s.config.sources[0].cover.property = "Missing";
  await assert.rejects(resolveNotionMediaSource(s.binding, s.repository, s.client), errorCode("MISCONFIGURED"));
  assert.equal(s.reads.queries, 0);
});

test("v2 About media requires the fixed page and its allowlist and never grants descendants", async () => {
  const s = setup("page");
  assert.equal((await resolveNotionMediaSource(s.binding, s.repository, s.client))?.url, imageUrl);
  assert.deepEqual(s.reads.schemas, []);
  const child = id(101);
  s.pages.set(child, demoPage(child, "Fictional private child", { type: "page_id", page_id: owner }));
  assert.equal(await s.repository.resolveMediaOwner!(child), null);
  s.config.sources[0].publication.allowlistPageIds = [child];
  assert.equal(await s.repository.resolveMediaOwner!(child), null);
  s.config.sources[0].publication.allowlistPageIds = [];
  assert.equal(await resolveNotionMediaSource(s.binding, s.repository, s.client), null);
  s.config.sources[0].publication.allowlistPageIds = [owner];
  s.config.sources[0].pageId = child;
  assert.equal(await resolveNotionMediaSource(s.binding, s.repository, s.client), null);
  assert.equal(s.reads.queries, 0);
});

test("v2 game allowlists remain exact instead of inheriting whole-source media publication", async () => {
  const s = setup("game", "allowlist");
  assert.ok(await resolveNotionMediaSource(s.binding, s.repository, s.client));
  const other = id(101);
  s.pages.set(other, demoPage(other, "Fictional unlisted game", parentSource()));
  assert.equal(await s.repository.resolveMediaOwner!(other), null);
  s.config.sources[0].publication.allowlistPageIds = [];
  assert.equal(await resolveNotionMediaSource(s.binding, s.repository, s.client), null);
  assert.equal(s.reads.queries, 0);
});

test("v2 learning media retains course and all ancestor allowlists without widening source scope", async () => {
  const s = setup("page");
  const course = id(300), week = id(301), child = id(302), notes = id(31), courses = id(30);
  const config = parseWebsiteNotionConfig({ schemaVersion: 2, sources: [
    { key: "fictional-course", kind: "course", enabled: true, dataSourceId: courses, fields: { title: "Name" }, publication: { mode: "allowlist", allowlistPageIds: [course] } },
    { key: "fictional-notes", kind: "study-note", enabled: true, dataSourceId: notes, coursePageId: course, fields: { title: "Name" }, publication: { mode: "allowlist", allowlistPageIds: [week, child] } },
  ] });
  s.pages.set(course, demoPage(course, "Fictional course", parentSource(courses)));
  s.pages.set(week, demoPage(week, "Fictional week", parentSource(notes)));
  s.pages.set(child, demoPage(child, "Fictional child", { type: "page_id", page_id: week }));
  s.schemas.set(courses, schema(courses)); s.schemas.set(notes, schema(notes, course));
  s.blocks.set(blockId, { ...s.blocks.get(blockId)!, parent: { type: "page_id", page_id: child } });
  const repository = createWebsiteNotionRepository({ client: s.client, config });
  const binding = { ...s.binding, ownerPageId: child, assetId: mediaIdentity(child, `block:${blockId}`, s.binding.sha256) };
  assert.equal((await resolveNotionMediaSource(binding, repository, s.client))?.url, imageUrl);
  config.sources[1].publication.allowlistPageIds = [child];
  assert.equal(await resolveNotionMediaSource(binding, repository, s.client), null);
  config.sources[1].publication.allowlistPageIds = [week, child];
  config.sources[0].publication.allowlistPageIds = [];
  assert.equal(await resolveNotionMediaSource(binding, repository, s.client), null);
  config.sources[0].publication.allowlistPageIds = [course];
  s.pages.get(week)!.parent = parentSource(id(32));
  assert.equal(await resolveNotionMediaSource(binding, repository, s.client), null);
  assert.equal(s.reads.queries, 0);
});

test("v2 generic page qualification and source listing still enumerate their explicit source", async () => {
  const s = setup("game");
  s.client.listBlocks = async () => [];
  s.client.listPages = async identity => {
    s.reads.queries++;
    assert.equal(identity, sourceId);
    return [...s.pages.values()].filter(page => page.parent.type === "data_source_id" && page.parent.data_source_id === identity);
  };
  assert.ok(await s.repository.resolveMediaOwner!(owner));
  assert.equal(s.reads.queries, 0);
  assert.ok(await s.repository.resolvePublicPage(owner));
  assert.equal(s.reads.queries, 1);
  assert.equal((await s.repository.list("game")).total, 1);
  assert.equal(s.reads.queries, 2);
});
