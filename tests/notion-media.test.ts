import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import type { BlockObjectResponse, PageObjectResponse } from "@notionhq/client";
import { createMediaSigner, resolveMediaUrl, safeMediaUrl } from "../src/server/notion/media.ts";
import type { NotionRepository, PublicNotionPage } from "../src/server/notion/repository.ts";
import type { NotionReadClient, NotionSource } from "../src/server/notion/types.ts";

// Fictional fixtures only. No request in this file can reach the network.
const id = (index: number) => index.toString(16).padStart(32, "0");
const ownerId = id(1);
const blockId = id(2);
const signingKey = "fictional-media-unit-test-signing-key";
const secondKey = "fictional-replacement-unit-test-key";
const sourceUrl = "https://assets.example.test/current-image.png";
const external = (url = sourceUrl): NonNullable<PageObjectResponse["cover"]> => ({ type: "external", external: { url } });
const uploaded = (expiryTime: string, url = sourceUrl): NonNullable<PageObjectResponse["cover"]> => ({ type: "file", file: { url, expiry_time: expiryTime } });

function page(): PageObjectResponse {
  return {
    object: "page", id: ownerId,
    parent: { type: "data_source_id", data_source_id: id(10), database_id: id(11) },
    properties: {}, icon: null, cover: external(),
    created_time: "2026-01-01T00:00:00.000Z", last_edited_time: "2026-01-01T00:00:00.000Z",
    in_trash: false, archived: false, is_archived: false, is_locked: false,
    url: "https://example.test/fictional-page", public_url: null,
    created_by: { object: "user", id: id(999) }, last_edited_by: { object: "user", id: id(999) },
  };
}

function source(cover: NotionSource["cover"] = { strategy: "native-page-cover" }): NotionSource {
  return {
    key: "fictional-status-source", kind: "status", dataSourceId: id(10), enabled: true, coursePageId: null,
    fields: { title: "Name" }, cover,
    publication: { mode: "allowlist", allowlistPageIds: [ownerId] },
  };
}

function imageBlock(parent: BlockObjectResponse["parent"] = { type: "page_id", page_id: ownerId }): BlockObjectResponse {
  return {
    object: "block", id: blockId, type: "image", image: { ...external(), caption: [] }, parent,
    has_children: false, archived: false, in_trash: false,
    created_time: "2026-01-01T00:00:00.000Z", last_edited_time: "2026-01-01T00:00:00.000Z",
    created_by: { object: "user", id: id(999) }, last_edited_by: { object: "user", id: id(999) },
  };
}

function ancestor(
  index: number,
  parent: BlockObjectResponse["parent"] = { type: "page_id", page_id: ownerId },
): BlockObjectResponse {
  return { ...imageBlock(parent), id: id(index), type: "toggle", toggle: { rich_text: [], color: "default" }, has_children: true } as BlockObjectResponse;
}

function harness(cover: NotionSource["cover"] = { strategy: "native-page-cover" }) {
  const record: PublicNotionPage = { page: page(), source: source(cover), course: null, ancestors: [] };
  const state = { published: true, record };
  const reads = { owners: [] as string[], blocks: [] as string[] };
  const blocks = new Map<string, BlockObjectResponse | null>([[blockId, imageBlock()]]);
  const repository = {
    async resolvePublicPage(pageId: string) {
      reads.owners.push(pageId);
      return state.published && pageId === ownerId ? state.record : null;
    },
  } as unknown as NotionRepository;
  const client: NotionReadClient = {
    async getPage() { throw new Error("Media authorization belongs to the repository"); },
    async getDataSource() { throw new Error("Media must not enumerate databases"); },
    async listBlocks() { throw new Error("Media must not download document bodies"); },
    async getBlock(requestedId) { reads.blocks.push(requestedId); return blocks.get(requestedId) ?? null; },
  };
  return { state, reads, blocks, repository, client };
}

async function asset(location: { blockId?: string; property?: string } = {}, url = sourceUrl) {
  const result = await createMediaSigner(signingKey).registerImage({ ownerPageId: ownerId, alt: "Fictional diagram", url, ...location });
  assert.ok(result);
  return result;
}

function signPayload(value: unknown): string {
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  const signature = createHmac("sha256", signingKey).update(`notion-media-v1:${payload}`).digest("base64url");
  return `m1.${payload}.${signature}`;
}

test("media IDs sign only the source location, and changing keys invalidates old assets", async () => {
  const url = new URL(sourceUrl);
  url.searchParams.set("X-Amz-Signature", "fictional-upload-signature");
  const registered = await asset({ blockId }, url.href);
  assert.ok(registered.src.startsWith("/media/m1."));
  assert.equal(registered.width, null);
  assert.equal(registered.height, null);
  assert.ok(!JSON.stringify(registered).includes(url.href));
  assert.ok(!JSON.stringify(registered).includes("fictional-upload-signature"));
  assert.deepEqual(createMediaSigner(signingKey).decode(registered.id), { page: ownerId, block: blockId });
  assert.equal(createMediaSigner(secondKey).decode(registered.id), null);
  assert.throws(() => createMediaSigner(""), /configuration is missing/);
});

test("property locations contain a keyed opaque tag instead of a source mapping", async () => {
  const mapping = "Fictional personal cover field / photo:property";
  const registered = await asset({ property: mapping });
  const signer = createMediaSigner(signingKey);
  const expectedTag = createHmac("sha256", signingKey).update(`notion-media-property-v1:${mapping}`).digest("base64url");
  const decoded = signer.decode(registered.id);
  assert.deepEqual(decoded, { page: ownerId, property: expectedTag });
  assert.match(decoded!.property!, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(signer.propertyTag(mapping), expectedTag);
  assert.notEqual(createMediaSigner(secondKey).propertyTag(mapping), expectedTag);
  const plainPayload = Buffer.from(registered.id.split(".")[1]!, "base64url").toString("utf8");
  assert.ok(!plainPayload.includes(mapping));
  assert.ok(!plainPayload.includes("photo:property"));
  assert.ok(!JSON.stringify(registered).includes(mapping));
  // Legacy locators must not bring source mapping text back into public IDs.
  assert.equal(signer.decode(signPayload({ page: ownerId, property: mapping })), null);
});

test("tampering, malformed locations, and oversized identifiers fail before reading public pages", async () => {
  const registered = await asset({ blockId });
  const [version, payload, signature] = registered.id.split(".");
  const forgedPayload = Buffer.from(JSON.stringify({ page: id(40), block: blockId })).toString("base64url");
  const badSignature = `${signature![0] === "A" ? "B" : "A"}${signature!.slice(1)}`;
  const malformed = [
    `${version}.${forgedPayload}.${signature}`, `${version}.${payload}.${badSignature}`,
    `m2.${payload}.${signature}`, "m1.broken.short", "x".repeat(2049),
    signPayload(null), signPayload({ page: "invalid" }), signPayload({ page: ownerId, block: "invalid" }),
    signPayload({ page: ownerId, property: 2 }), signPayload({ page: ownerId, property: "x".repeat(257) }),
    signPayload({ page: ownerId, property: "" }), signPayload({ page: ownerId, property: "Photo" }),
    signPayload({ page: ownerId, property: "+".repeat(43) }),
    signPayload({ page: ownerId, block: blockId, property: createMediaSigner(signingKey).propertyTag("Photo") }),
  ];
  const scenario = harness();
  for (const invalid of malformed) {
    assert.equal(await resolveMediaUrl(invalid, scenario.repository, scenario.client, signingKey), null);
  }
  assert.deepEqual(scenario.reads, { owners: [], blocks: [] });
});

test("signer rejects ambiguous locations and unsafe URLs", async () => {
  const signer = createMediaSigner(signingKey);
  for (const location of [{ blockId, property: "Photo" }, { property: "" }, { property: "x".repeat(257) }]) {
    assert.equal(await signer.registerImage({ ownerPageId: ownerId, alt: "", url: sourceUrl, ...location }), null);
  }
  for (const url of ["javascript:alert(1)", "data:image/png,fictional", "file:///fictional", "http://localhost/picture", "http://127.0.0.1/picture", "http://[::1]/picture", "https://user:password@example.test/image", "http://2130706433/picture"]) {
    assert.equal(safeMediaUrl(url), null);
    assert.equal(await signer.registerImage({ ownerPageId: ownerId, alt: "", url }), null);
  }
  assert.equal(safeMediaUrl(sourceUrl), sourceUrl);
});

test("external Notion page locations cannot be registered or reached through old media assets", async () => {
  const signer = createMediaSigner(signingKey);
  const registered = await asset();
  const scenario = harness();
  for (const hostname of ["notion.so", "workspace.notion.site", "app.notion.com", "NOTION.SO."]) {
    const url = new URL("https://example.test/fictional-private-page");
    url.hostname = hostname;
    assert.equal(await signer.registerImage({ ownerPageId: ownerId, alt: "", url: url.href }), null);
    scenario.state.record.page.cover = external(url.href);
    assert.equal(await resolveMediaUrl(registered.id, scenario.repository, scenario.client, signingKey), null);
  }
});

test("SDK file media may use a Notion file host while its signed location refreshes", async (context) => {
  const now = Date.parse("2026-01-01T12:00:00.000Z");
  context.mock.method(Date, "now", () => now);
  const expiryTime = new Date(now + 60_000).toISOString();
  const url = new URL("https://example.test/fictional-upload.png");
  url.hostname = ["file", "notion", "so"].join(".");
  url.searchParams.set("X-Amz-Signature", "fictional-original-file-signature");
  const registered = await createMediaSigner(signingKey).registerImage({ ownerPageId: ownerId, alt: "", url: url.href, expiryTime });
  assert.ok(registered);
  assert.ok(!JSON.stringify(registered).includes(url.href));
  const scenario = harness();
  scenario.state.record.page.cover = uploaded(expiryTime, url.href);
  assert.equal(await resolveMediaUrl(registered.id, scenario.repository, scenario.client, signingKey), url.href);
  url.searchParams.set("X-Amz-Signature", "fictional-refreshed-file-signature");
  scenario.state.record.page.cover = uploaded(new Date(now + 120_000).toISOString(), url.href);
  assert.equal(await resolveMediaUrl(registered.id, scenario.repository, scenario.client, signingKey), url.href);
  // The current SDK type wins over the metadata used when the asset was issued.
  scenario.state.record.page.cover = external(url.href);
  assert.equal(await resolveMediaUrl(registered.id, scenario.repository, scenario.client, signingKey), null);
});

test("private owners and revoked publication block media before any image read", async () => {
  const registered = await asset({ blockId });
  const scenario = harness();
  scenario.state.published = false;
  assert.equal(await resolveMediaUrl(registered.id, scenario.repository, scenario.client, signingKey), null);
  assert.deepEqual(scenario.reads.blocks, []);
  scenario.state.published = true;
  assert.equal(await resolveMediaUrl(registered.id, scenario.repository, scenario.client, signingKey), sourceUrl);
  scenario.state.published = false;
  assert.equal(await resolveMediaUrl(registered.id, scenario.repository, scenario.client, signingKey), null);
  assert.equal(scenario.reads.owners.length, 3);
  assert.equal(scenario.reads.blocks.length, 1);
});

test("current native cover strategy and current file location govern an existing asset", async () => {
  const registered = await asset();
  const scenario = harness();
  assert.equal(await resolveMediaUrl(registered.id, scenario.repository, scenario.client, signingKey), sourceUrl);
  const replacement = "https://assets.example.test/replacement-image.png";
  scenario.state.record.page.cover = external(replacement);
  assert.equal(await resolveMediaUrl(registered.id, scenario.repository, scenario.client, signingKey), replacement);
  scenario.state.record.source.cover = { strategy: "none" };
  assert.equal(await resolveMediaUrl(registered.id, scenario.repository, scenario.client, signingKey), null);
  scenario.state.record.source.cover = { strategy: "native-page-cover" };
  scenario.state.record.page.cover = null;
  assert.equal(await resolveMediaUrl(registered.id, scenario.repository, scenario.client, signingKey), null);
  assert.deepEqual(scenario.reads.blocks, []);
});

test("files-property assets respect mapping changes, renamed properties, and deleted files", async () => {
  const propertyId = "photo:field";
  const registered = await asset({ property: propertyId });
  const scenario = harness({ strategy: "files-property", property: propertyId });
  scenario.state.record.page.properties = {
    "Renamed image": { id: encodeURIComponent(propertyId), type: "files", files: [{ ...external(), name: "image.png" }] },
  };
  const locator = createMediaSigner(signingKey).decode(registered.id);
  assert.equal(locator?.property, createMediaSigner(signingKey).propertyTag(propertyId));
  assert.notEqual(locator?.property, propertyId);
  assert.equal(await resolveMediaUrl(registered.id, scenario.repository, scenario.client, signingKey), sourceUrl);
  const wrongTagAsset = signPayload({ page: ownerId, property: createMediaSigner(signingKey).propertyTag("Other image") });
  assert.equal(await resolveMediaUrl(wrongTagAsset, scenario.repository, scenario.client, signingKey), null);
  scenario.state.record.source.cover = { strategy: "files-property", property: "Other image" };
  assert.equal(await resolveMediaUrl(registered.id, scenario.repository, scenario.client, signingKey), null);
  scenario.state.record.source.cover = { strategy: "native-page-cover" };
  assert.equal(await resolveMediaUrl(registered.id, scenario.repository, scenario.client, signingKey), null);
  scenario.state.record.source.cover = { strategy: "files-property", property: propertyId };
  scenario.state.record.page.properties = { "Renamed image": { id: encodeURIComponent(propertyId), type: "files", files: [] } };
  assert.equal(await resolveMediaUrl(registered.id, scenario.repository, scenario.client, signingKey), null);
  scenario.state.record.page.properties = { "Renamed image": { id: encodeURIComponent(propertyId), type: "rich_text", rich_text: [] } };
  assert.equal(await resolveMediaUrl(registered.id, scenario.repository, scenario.client, signingKey), null);
});

test("expired and nearly expired uploads are refused, while refreshed uploads use their latest URLs", async (context) => {
  const now = Date.parse("2026-01-01T12:00:00.000Z");
  context.mock.method(Date, "now", () => now);
  const registered = await asset();
  const scenario = harness();
  for (const expiryTime of ["invalid", new Date(now - 1).toISOString(), new Date(now + 5000).toISOString()]) {
    scenario.state.record.page.cover = uploaded(expiryTime);
    assert.equal(await resolveMediaUrl(registered.id, scenario.repository, scenario.client, signingKey), null);
  }
  const refreshedUrl = new URL("https://assets.example.test/refreshed-image.png");
  refreshedUrl.searchParams.set("X-Amz-Signature", "fictional-fresh-signature");
  scenario.state.record.page.cover = uploaded(new Date(now + 60_000).toISOString(), refreshedUrl.href);
  assert.equal(await resolveMediaUrl(registered.id, scenario.repository, scenario.client, signingKey), refreshedUrl.href);
  scenario.state.record.page.cover = external("javascript:alert(1)");
  assert.equal(await resolveMediaUrl(registered.id, scenario.repository, scenario.client, signingKey), null);
});

test("image deletion, changed type, archived state, and movement to another page revoke old assets", async () => {
  const registered = await asset({ blockId });
  const scenario = harness();
  const original = imageBlock();
  const replacements: (BlockObjectResponse | null)[] = [
    null, { ...ancestor(2), id: blockId }, { ...original, archived: true }, { ...original, in_trash: true },
    imageBlock({ type: "page_id", page_id: id(40) }), imageBlock({ type: "data_source_id", data_source_id: id(41), database_id: id(42) }),
  ];
  for (const replacement of replacements) {
    scenario.blocks.set(blockId, replacement);
    assert.equal(await resolveMediaUrl(registered.id, scenario.repository, scenario.client, signingKey), null);
  }
  scenario.blocks.set(blockId, original);
  assert.equal(await resolveMediaUrl(registered.id, scenario.repository, scenario.client, signingKey), sourceUrl);
});

test("nested image ancestry must remain active, identified, and inside the authorized page", async () => {
  const registered = await asset({ blockId });
  const scenario = harness();
  scenario.blocks.set(blockId, imageBlock({ type: "block_id", block_id: id(3) }));
  scenario.blocks.set(id(3), ancestor(3, { type: "block_id", block_id: id(4) }));
  scenario.blocks.set(id(4), ancestor(4));
  assert.equal(await resolveMediaUrl(registered.id, scenario.repository, scenario.client, signingKey), sourceUrl);
  assert.deepEqual(scenario.reads.blocks, [blockId, id(3), id(4)]);
  scenario.blocks.set(id(4), ancestor(4, { type: "page_id", page_id: id(40) }));
  assert.equal(await resolveMediaUrl(registered.id, scenario.repository, scenario.client, signingKey), null);
  scenario.blocks.set(id(4), { ...ancestor(4), archived: true });
  assert.equal(await resolveMediaUrl(registered.id, scenario.repository, scenario.client, signingKey), null);
  scenario.blocks.set(id(4), null);
  assert.equal(await resolveMediaUrl(registered.id, scenario.repository, scenario.client, signingKey), null);
});

test("a client response for a different image or ancestor cannot supply the requested asset", async () => {
  const registered = await asset({ blockId });
  const scenario = harness();
  scenario.blocks.set(blockId, { ...imageBlock(), id: id(30) });
  assert.equal(await resolveMediaUrl(registered.id, scenario.repository, scenario.client, signingKey), null);
  scenario.blocks.set(blockId, imageBlock({ type: "block_id", block_id: id(3) }));
  scenario.blocks.set(id(3), ancestor(30));
  assert.equal(await resolveMediaUrl(registered.id, scenario.repository, scenario.client, signingKey), null);
});

test("referenced synced ancestors revoke old media, while original inline sync remains eligible", async () => {
  const registered = await asset({ blockId });
  const scenario = harness();
  scenario.blocks.set(blockId, imageBlock({ type: "block_id", block_id: id(3) }));
  const synced: BlockObjectResponse = {
    ...ancestor(3), type: "synced_block", synced_block: { synced_from: { type: "block_id", block_id: id(40) } },
  };
  scenario.blocks.set(id(3), synced);
  assert.equal(await resolveMediaUrl(registered.id, scenario.repository, scenario.client, signingKey), null);
  scenario.blocks.set(id(3), { ...synced, synced_block: { synced_from: null } });
  assert.equal(await resolveMediaUrl(registered.id, scenario.repository, scenario.client, signingKey), sourceUrl);
});

test("cyclic or overly deep image ancestry cannot issue a redirect", async () => {
  const registered = await asset({ blockId });
  const scenario = harness();
  scenario.blocks.set(blockId, imageBlock({ type: "block_id", block_id: id(3) }));
  scenario.blocks.set(id(3), ancestor(3, { type: "block_id", block_id: id(4) }));
  scenario.blocks.set(id(4), ancestor(4, { type: "block_id", block_id: id(3) }));
  assert.equal(await resolveMediaUrl(registered.id, scenario.repository, scenario.client, signingKey), null);
  scenario.blocks.set(blockId, imageBlock({ type: "block_id", block_id: id(100) }));
  for (let index = 100; index <= 124; index++) {
    scenario.blocks.set(id(index), ancestor(index, index === 124 ? { type: "page_id", page_id: ownerId } : { type: "block_id", block_id: id(index + 1) }));
  }
  assert.equal(await resolveMediaUrl(registered.id, scenario.repository, scenario.client, signingKey), null);
});

test("upstream media reads fail through the normal error boundary", async () => {
  const registered = await asset({ blockId });
  const scenario = harness();
  scenario.client.getBlock = async () => { throw new Error("Upstream unavailable"); };
  await assert.rejects(resolveMediaUrl(registered.id, scenario.repository, scenario.client, signingKey), /Upstream unavailable/);
});
