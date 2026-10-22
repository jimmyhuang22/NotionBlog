import assert from "node:assert/strict";
import test from "node:test";
import type { BlockObjectResponse, PageObjectResponse } from "@notionhq/client";
import { sourceFingerprint, type MediaSourceBinding, type NotionMediaLocator } from "../src/server/media/notion-source.ts";
import { resolveNotionMediaSource } from "../src/server/notion/media-source.ts";
import type { NotionRepository, PublicNotionPage } from "../src/server/notion/repository.ts";
import type { NotionReadClient, NotionSource } from "../src/server/notion/types.ts";

// Entirely fictional source objects. The injected client cannot reach a network.
const id = (index: number) => index.toString(16).padStart(32, "0");
const ownerId = id(1);
const imageId = id(2);
const sourceUrl = "https://assets.example.test/fictional-image.png";
const external = (url = sourceUrl): NonNullable<PageObjectResponse["cover"]> => ({ type: "external", external: { url } });
const uploaded = (expiry: string, url = sourceUrl): NonNullable<PageObjectResponse["cover"]> => ({ type: "file", file: { url, expiry_time: expiry } });

function signedUrl(signature: string, expiry: string): string {
  const url = new URL("https://assets.example.test/original.png");
  url.searchParams.set("X-Amz-Signature", signature);
  url.searchParams.set("expires", expiry);
  return url.href;
}

function page(): PageObjectResponse {
  return {
    object: "page", id: ownerId, parent: { type: "data_source_id", data_source_id: id(10), database_id: id(11) },
    properties: {}, icon: null, cover: external(), url: "https://example.test/fictional-page", public_url: null,
    created_time: "2026-01-01T00:00:00.000Z", last_edited_time: "2026-01-01T00:00:00.000Z",
    in_trash: false, archived: false, is_archived: false, is_locked: false,
    created_by: { object: "user", id: id(999) }, last_edited_by: { object: "user", id: id(999) },
  };
}

function image(parent: BlockObjectResponse["parent"] = { type: "page_id", page_id: ownerId }): BlockObjectResponse {
  return {
    object: "block", id: imageId, type: "image", image: { ...external(), caption: [] }, parent,
    has_children: false, archived: false, in_trash: false,
    created_time: "2026-01-01T00:00:00.000Z", last_edited_time: "2026-01-01T00:00:00.000Z",
    created_by: { object: "user", id: id(999) }, last_edited_by: { object: "user", id: id(999) },
  };
}

function ancestor(index: number, parent: BlockObjectResponse["parent"] = { type: "page_id", page_id: ownerId }): BlockObjectResponse {
  return { ...image(parent), id: id(index), type: "toggle", toggle: { rich_text: [], color: "default" }, has_children: true } as BlockObjectResponse;
}

function harness(cover: NotionSource["cover"] = { strategy: "native-page-cover" }) {
  const source: NotionSource = {
    key: "fictional-source", kind: "status", dataSourceId: id(10), enabled: true, coursePageId: null,
    fields: { title: "Name" }, cover, publication: { mode: "allowlist", allowlistPageIds: [ownerId] },
  };
  const record: PublicNotionPage = { page: page(), source, course: null, ancestors: [] };
  const state = { published: true, record };
  const reads = { owners: [] as string[], blocks: [] as string[] };
  const blocks = new Map<string, BlockObjectResponse | null>([[imageId, image()]]);
  const repository = {
    async resolvePublicPage(pageId: string) {
      reads.owners.push(pageId);
      return state.published && pageId === ownerId ? state.record : null;
    },
  } as unknown as NotionRepository;
  const client: NotionReadClient = {
    async getPage() { throw new Error("Authorization belongs to the repository"); },
    async getDataSource() { throw new Error("Media resolution must not enumerate sources"); },
    async listBlocks() { throw new Error("Media resolution must not download document bodies"); },
    async getBlock(blockId) { reads.blocks.push(blockId); return blocks.get(blockId) ?? null; },
  };
  return { state, reads, blocks, repository, client };
}

function binding(locator: NotionMediaLocator = { kind: "cover" }): MediaSourceBinding {
  return { assetId: `dbm1.${"a".repeat(64)}`, ownerPageId: ownerId, sha256: "b".repeat(64), locator,
    delivery: "notion", sourceFingerprint: sourceFingerprint(sourceUrl, false) };
}

test("every source resolution rechecks the public owner, including Storage delivery bindings", async () => {
  const scenario = harness();
  const stored = { ...binding({ kind: "block", id: imageId }), delivery: "storage" as const };
  assert.equal((await resolveNotionMediaSource(stored, scenario.repository, scenario.client))?.url, sourceUrl);
  scenario.state.published = false;
  assert.equal(await resolveNotionMediaSource(stored, scenario.repository, scenario.client), null);
  assert.deepEqual(scenario.reads.owners, [ownerId, ownerId]);
  assert.deepEqual(scenario.reads.blocks, [imageId]);
});

test("unpublished owners are rejected before any image block read", async () => {
  const scenario = harness();
  scenario.state.published = false;
  assert.equal(await resolveNotionMediaSource(binding({ kind: "block", id: imageId }), scenario.repository, scenario.client), null);
  assert.deepEqual(scenario.reads.blocks, []);
});

test("source resolution prefers dedicated fresh media-owner qualification when available", async () => {
  const scenario = harness();
  let qualifications = 0;
  scenario.repository.resolvePublicPage = async () => { throw new Error("The generic source query must not run"); };
  scenario.repository.resolveMediaOwner = async owner => {
    qualifications++;
    assert.equal(owner, ownerId);
    return scenario.state.published ? scenario.state.record : null;
  };
  assert.equal((await resolveNotionMediaSource(binding(), scenario.repository, scenario.client))?.url, sourceUrl);
  scenario.state.published = false;
  assert.equal(await resolveNotionMediaSource(binding(), scenario.repository, scenario.client), null);
  assert.equal(qualifications, 2);
});

test("wrong, archived, and deleted owner responses cannot issue source URLs", async () => {
  for (const change of [{ id: id(40) }, { archived: true }, { in_trash: true }, { is_archived: true }]) {
    const scenario = harness();
    Object.assign(scenario.state.record.page, change);
    assert.equal(await resolveNotionMediaSource(binding(), scenario.repository, scenario.client), null);
  }
});

test("native cover resolution requires the current cover strategy and a current file", async () => {
  const scenario = harness();
  assert.deepEqual(await resolveNotionMediaSource(binding(), scenario.repository, scenario.client),
    { url: sourceUrl, sourceFingerprint: sourceFingerprint(sourceUrl, false) });
  scenario.state.record.source.cover = { strategy: "none" };
  assert.equal(await resolveNotionMediaSource(binding(), scenario.repository, scenario.client), null);
  scenario.state.record.source.cover = { strategy: "files-property", property: "Photo" };
  assert.equal(await resolveNotionMediaSource(binding(), scenario.repository, scenario.client), null);
  scenario.state.record.source.cover = { strategy: "native-page-cover" };
  scenario.state.record.page.cover = null;
  assert.equal(await resolveNotionMediaSource(binding(), scenario.repository, scenario.client), null);
});

test("files-property locators must match the exact current mapping and first file", async () => {
  const scenario = harness({ strategy: "files-property", property: "Photo" });
  scenario.state.record.page.properties.Photo = { id: "photo-property", type: "files", files: [
    { ...external(), name: "Fictional first image" }, { ...external("https://example.test/second.png"), name: "Fictional second image" },
  ] };
  const stored = binding({ kind: "property", name: "Photo" });
  assert.equal((await resolveNotionMediaSource(stored, scenario.repository, scenario.client))?.url, sourceUrl);
  scenario.state.record.source.cover.property = "Other";
  assert.equal(await resolveNotionMediaSource(stored, scenario.repository, scenario.client), null);
  scenario.state.record.source.cover = { strategy: "native-page-cover" };
  assert.equal(await resolveNotionMediaSource(stored, scenario.repository, scenario.client), null);
  scenario.state.record.source.cover = { strategy: "files-property", property: "Photo" };
  scenario.state.record.page.properties.Photo = { id: "photo-property", type: "files", files: [] };
  assert.equal(await resolveNotionMediaSource(stored, scenario.repository, scenario.client), null);
  scenario.state.record.page.properties.Photo = { id: "photo-property", type: "rich_text", rich_text: [] };
  assert.equal(await resolveNotionMediaSource(stored, scenario.repository, scenario.client), null);
});

test("explicit property ID mappings survive a display name change without guessing another property", async () => {
  const scenario = harness({ strategy: "files-property", property: "photo:id" });
  scenario.state.record.page.properties.Renamed = { id: "photo%3Aid", type: "files", files: [{ ...external(), name: "Fictional image" }] };
  assert.equal((await resolveNotionMediaSource(binding({ kind: "property", name: "photo:id" }), scenario.repository, scenario.client))?.url, sourceUrl);
  assert.equal(await resolveNotionMediaSource(binding({ kind: "property", name: "Renamed" }), scenario.repository, scenario.client), null);
});

test("fresh hosted signatures keep the source fingerprint while a replaced file changes it", async context => {
  const now = Date.parse("2026-01-01T12:00:00.000Z");
  context.mock.method(Date, "now", () => now);
  const scenario = harness();
  const oldUrl = signedUrl("fictional-old", "old");
  const newUrl = signedUrl("fictional-new", "new");
  const stored = { ...binding(), sourceFingerprint: sourceFingerprint(oldUrl, true) };
  scenario.state.record.page.cover = uploaded(new Date(now + 60_000).toISOString(), newUrl);
  const refreshed = await resolveNotionMediaSource(stored, scenario.repository, scenario.client);
  assert.equal(refreshed?.url, newUrl);
  assert.equal(refreshed?.sourceFingerprint, stored.sourceFingerprint);
  scenario.state.record.page.cover = uploaded(new Date(now + 60_000).toISOString(), "https://assets.example.test/replacement.png");
  const replaced = await resolveNotionMediaSource(stored, scenario.repository, scenario.client);
  assert.ok(replaced);
  assert.notEqual(replaced.sourceFingerprint, stored.sourceFingerprint);
  // Returning the fresh fingerprint lets the caller reject stale bindings;
  // this source locator resolver never decides to use an old Storage object.
});

test("external query changes represent a changed source rather than a refreshed hosted signature", async () => {
  const scenario = harness();
  const oldUrl = "https://assets.example.test/image.png?version=first";
  const newUrl = "https://assets.example.test/image.png?version=second";
  const stored = { ...binding(), sourceFingerprint: sourceFingerprint(oldUrl, false) };
  scenario.state.record.page.cover = external(newUrl);
  const resolved = await resolveNotionMediaSource(stored, scenario.repository, scenario.client);
  assert.equal(resolved?.url, newUrl);
  assert.notEqual(resolved?.sourceFingerprint, stored.sourceFingerprint);
});

test("hosted files need a parseable expiry more than five seconds ahead", async context => {
  const now = Date.parse("2026-01-01T12:00:00.000Z");
  context.mock.method(Date, "now", () => now);
  const scenario = harness();
  for (const expiry of ["invalid", new Date(now - 1).toISOString(), new Date(now + 5000).toISOString()]) {
    scenario.state.record.page.cover = uploaded(expiry);
    assert.equal(await resolveNotionMediaSource(binding(), scenario.repository, scenario.client), null);
  }
  scenario.state.record.page.cover = uploaded(new Date(now + 5001).toISOString());
  assert.equal((await resolveNotionMediaSource(binding(), scenario.repository, scenario.client))?.url, sourceUrl);
});

test("unsafe, non-HTTPS, and external Notion page URLs fail without any fallback", async () => {
  const scenario = harness();
  for (const url of ["javascript:alert(1)", "data:image/png,fictional", "file:///fictional.png", "http://example.test/image.png",
    "https://localhost/image.png", "https://127.0.0.1/image.png", "https://[::1]/image.png", "https://user:password@example.test/image.png",
  ]) {
    scenario.state.record.page.cover = external(url);
    assert.equal(await resolveNotionMediaSource(binding(), scenario.repository, scenario.client), null);
  }
  for (const hostname of ["app.notion.com", "workspace.notion.site", "NOTION.SO."]) {
    const url = new URL("https://example.test/fictional-page");
    url.hostname = hostname;
    scenario.state.record.page.cover = external(url.href);
    assert.equal(await resolveNotionMediaSource(binding(), scenario.repository, scenario.client), null);
  }
});

test("an SDK-hosted file may use a Notion file hostname with fresh expiry", async context => {
  const now = Date.parse("2026-01-01T12:00:00.000Z");
  context.mock.method(Date, "now", () => now);
  const scenario = harness();
  const url = new URL(sourceUrl);
  url.hostname = ["file", "notion", "so"].join(".");
  scenario.state.record.page.cover = uploaded(new Date(now + 60_000).toISOString(), url.href);
  assert.equal((await resolveNotionMediaSource(binding(), scenario.repository, scenario.client))?.url, url.href);
  url.protocol = "http:";
  scenario.state.record.page.cover = uploaded(new Date(now + 60_000).toISOString(), url.href);
  assert.equal(await resolveNotionMediaSource(binding(), scenario.repository, scenario.client), null);
});

test("image deletion, replacement type, wrong identity, inactive state, and movement revoke the locator", async () => {
  const scenario = harness();
  const stored = binding({ kind: "block", id: imageId });
  for (const replacement of [null, ancestor(2), { ...image(), id: id(40) }, { ...image(), archived: true }, { ...image(), in_trash: true },
    image({ type: "page_id", page_id: id(40) }), image({ type: "data_source_id", data_source_id: id(41), database_id: id(42) })]) {
    scenario.blocks.set(imageId, replacement);
    assert.equal(await resolveNotionMediaSource(stored, scenario.repository, scenario.client), null);
  }
});

test("nested images resolve only through active exact ancestors ending at their public owner", async () => {
  const scenario = harness();
  const stored = binding({ kind: "block", id: imageId });
  scenario.blocks.set(imageId, image({ type: "block_id", block_id: id(3) }));
  scenario.blocks.set(id(3), ancestor(3, { type: "block_id", block_id: id(4) }));
  scenario.blocks.set(id(4), ancestor(4));
  assert.equal((await resolveNotionMediaSource(stored, scenario.repository, scenario.client))?.url, sourceUrl);
  assert.deepEqual(scenario.reads.blocks, [imageId, id(3), id(4)]);
  for (const replacement of [null, ancestor(40), { ...ancestor(4), archived: true }, { ...ancestor(4), in_trash: true }, ancestor(4, { type: "page_id", page_id: id(40) })]) {
    scenario.blocks.set(id(4), replacement);
    assert.equal(await resolveNotionMediaSource(stored, scenario.repository, scenario.client), null);
  }
});

test("referenced synced ancestors are rejected while original inline synced blocks remain eligible", async () => {
  const scenario = harness();
  const stored = binding({ kind: "block", id: imageId });
  scenario.blocks.set(imageId, image({ type: "block_id", block_id: id(3) }));
  const synced: BlockObjectResponse = { ...ancestor(3), type: "synced_block", synced_block: { synced_from: { type: "block_id", block_id: id(40) } } };
  scenario.blocks.set(id(3), synced);
  assert.equal(await resolveNotionMediaSource(stored, scenario.repository, scenario.client), null);
  scenario.blocks.set(id(3), { ...synced, synced_block: { synced_from: null } });
  assert.equal((await resolveNotionMediaSource(stored, scenario.repository, scenario.client))?.url, sourceUrl);
});

test("cyclic and over-depth image ancestry fails closed with bounded block reads", async () => {
  const scenario = harness();
  const stored = binding({ kind: "block", id: imageId });
  scenario.blocks.set(imageId, image({ type: "block_id", block_id: id(3) }));
  scenario.blocks.set(id(3), ancestor(3, { type: "block_id", block_id: imageId }));
  assert.equal(await resolveNotionMediaSource(stored, scenario.repository, scenario.client), null);
  scenario.reads.blocks.length = 0;
  scenario.blocks.set(imageId, image({ type: "block_id", block_id: id(100) }));
  for (let index = 100; index <= 124; index++) {
    scenario.blocks.set(id(index), ancestor(index, index === 124 ? { type: "page_id", page_id: ownerId } : { type: "block_id", block_id: id(index + 1) }));
  }
  assert.equal(await resolveNotionMediaSource(stored, scenario.repository, scenario.client), null);
  assert.equal(scenario.reads.blocks.length, 25);
  scenario.reads.blocks.length = 0;
  scenario.blocks.set(id(123), ancestor(123));
  assert.equal((await resolveNotionMediaSource(stored, scenario.repository, scenario.client))?.url, sourceUrl);
  assert.equal(scenario.reads.blocks.length, 25);
});

test("upstream errors propagate instead of returning an old source or Storage fallback", async () => {
  const scenario = harness();
  const failure = new Error("Fictional upstream failure");
  scenario.client.getBlock = async () => { throw failure; };
  await assert.rejects(resolveNotionMediaSource(binding({ kind: "block", id: imageId }), scenario.repository, scenario.client), failure);
  scenario.repository.resolvePublicPage = async () => { throw failure; };
  await assert.rejects(resolveNotionMediaSource(binding(), scenario.repository, scenario.client), failure);
});
