import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import type { BlockObjectResponse } from "@notionhq/client";
import { createDemo, DEMO_PNG, demoId, demoParagraph } from "../scripts/notion-sync/demo.ts";
import { ContentServiceError } from "../contracts/repository.ts";
import { contentErrorResponse } from "../src/lib/content/http.ts";
import { mediaIdentity } from "../src/server/database/validation.ts";
import { hybridMediaResponse, mediaProvider, type HybridMediaPorts } from "../src/server/media/hybrid.ts";
import { sourceFingerprint, type MediaSourceProjection } from "../src/server/media/notion-source.ts";
import { resolveNotionMediaSource } from "../src/server/notion/media-source.ts";
import { createNotionRepository } from "../src/server/notion/repository.ts";
import type { NotionReadClient } from "../src/server/notion/types.ts";

const owner = demoId(1000), imageId = demoId(45000);
const hosted = (signature: string, file = "original.png") => {
  const url = new URL(`https://assets.example.test/${file}`);
  url.searchParams.set("X-Amz-Signature", signature);
  return url.href;
};
const jpg = Buffer.from([255, 216, 255, 224, 0, 2, 255, 217]);

function scenario(delivery: "notion" | "storage" = "notion") {
  const demo = createDemo(1);
  demo.config.sources = demo.config.sources.slice(0, 1);
  const image = { ...demoParagraph(imageId, owner, ""), type: "image", image: { type: "file", file: { url: hosted("original"), expiry_time: new Date(Date.now() + 600_000).toISOString() }, caption: [] } } as BlockObjectResponse;
  demo.blocks.set(owner, [image]);
  const client: NotionReadClient = {
    getPage: async id => structuredClone(demo.pages.get(id) ?? null),
    getDataSource: async id => structuredClone(demo.schemas.get(id)!),
    getBlock: async id => structuredClone([...demo.blocks.values()].flat().find(block => block.id === id) ?? null),
    listBlocks: async id => structuredClone(demo.blocks.get(id) ?? []),
    listPages: async id => structuredClone([...demo.pages.values()].filter(page => page.parent.type === "data_source_id" && page.parent.data_source_id === id)),
  };
  const repository = createNotionRepository({ client, config: demo.config });
  const bytes = delivery === "storage" ? jpg : DEMO_PNG;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const assetId = mediaIdentity(owner, `block:${imageId}`, sha256);
  const projection: MediaSourceProjection = {
    media: { assetId, ownerPageId: owner, objectKey: `sha256/${sha256}`, sha256, byteSize: bytes.length, mime: delivery === "storage" ? "image/jpeg" : "image/png", width: null, height: null },
    binding: { assetId, ownerPageId: owner, sha256, locator: { kind: "block", id: imageId }, delivery, sourceFingerprint: sourceFingerprint(hosted("original"), true) },
  };
  const state = { projection: structuredClone(projection) as MediaSourceProjection | null, dbReads: 0, resolutions: 0, storageInitializations: 0, storageReads: 0, bytes: Uint8Array.from(bytes) };
  const ports: HybridMediaPorts = {
    read: async id => { state.dbReads++; assert.equal(id, assetId); return structuredClone(state.projection); },
    resolve: async binding => { state.resolutions++; return resolveNotionMediaSource(binding, repository, client); },
    storage: () => {
      state.storageInitializations++;
      return { read: async media => { state.storageReads++; assert.deepEqual(media, projection.media); return state.bytes; }, put: async () => assert.fail("Website media must never write") };
    },
  };
  function signature(value: string, file?: string) {
    assert.equal(image.type, "image");
    image.image = { type: "file", file: { url: hosted(value, file), expiry_time: new Date(Date.now() + 600_000).toISOString() }, caption: [] };
  }
  return { demo, client, repository, projection, assetId, image, state, ports, signature };
}

function assertPrivate(response: Response) {
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
}

test("ordinary hybrid images redirect to refreshed source signatures without initializing Storage", async () => {
  const s = scenario();
  s.signature("fresh-one");
  const first = await hybridMediaResponse(s.assetId, s.ports);
  assert.equal(first.status, 302); assert.equal(first.headers.get("Location"), hosted("fresh-one")); assertPrivate(first);
  assert.equal(await first.text(), "");
  s.signature("fresh-two");
  const second = await hybridMediaResponse(s.assetId, s.ports);
  assert.equal(second.headers.get("Location"), hosted("fresh-two"));
  assert.equal(s.state.dbReads, 4); assert.equal(s.state.resolutions, 2);
  assert.equal(s.state.storageInitializations, 0); assert.equal(s.state.storageReads, 0);
});

test("converted images return hash-verified Storage bytes only after final database and live source checks", async () => {
  const s = scenario("storage");
  s.signature("fresh");
  const response = await hybridMediaResponse(s.assetId, s.ports);
  assert.equal(response.status, 200); assertPrivate(response);
  assert.equal(response.headers.get("Content-Type"), "image/jpeg");
  assert.equal(response.headers.get("Content-Length"), String(jpg.length));
  assert.equal(response.headers.get("Location"), null);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), jpg);
  assert.equal(s.state.storageInitializations, 1); assert.equal(s.state.storageReads, 1);
  assert.equal(s.state.resolutions, 2); assert.equal(s.state.dbReads, 3);
});

test("missing or failing Notion qualification never falls back to a stored derivative", async t => {
  for (const variant of ["unpublished", "archived", "deleted-block", "changed-file", "expired", "upstream"] as const) await t.test(variant, async () => {
    const s = scenario("storage");
    if (variant === "unpublished") s.demo.config.sources[0].enabled = false;
    if (variant === "archived") s.demo.pages.get(owner)!.archived = true;
    if (variant === "deleted-block") s.demo.blocks.set(owner, []);
    if (variant === "changed-file") s.signature("fresh", "replacement.png");
    if (variant === "expired" && s.image.type === "image") s.image.image = { type: "file", file: { url: hosted("expired"), expiry_time: new Date(Date.now() - 1000).toISOString() }, caption: [] };
    if (variant === "upstream") s.client.getBlock = async () => { throw new ContentServiceError("CONTENT_UNAVAILABLE", "Fictional provider failure"); };
    const response = await hybridMediaResponse(s.assetId, s.ports).catch(contentErrorResponse);
    assert.equal(response.status, variant === "upstream" ? 503 : 404);
    assert.equal(response.headers.get("Location"), null);
    assert.equal(s.state.storageInitializations, 0); assert.equal(s.state.storageReads, 0);
  });
});

test("database withdrawal or binding changes during source resolution suppress ordinary redirects", async t => {
  for (const variant of ["withdrawal", "binding"] as const) await t.test(variant, async () => {
    const s = scenario();
    const resolve = s.ports.resolve;
    s.ports.resolve = async binding => {
      const source = await resolve(binding);
      if (variant === "withdrawal") s.state.projection = null;
      else s.state.projection!.binding.sourceFingerprint = "f".repeat(64);
      return source;
    };
    const response = await hybridMediaResponse(s.assetId, s.ports);
    assert.equal(response.status, 404); assertPrivate(response);
    assert.equal(response.headers.get("Location"), null); assert.equal(await response.text(), "");
    assert.equal(s.state.storageInitializations, 0);
  });
});

test("withdrawal during a Storage read rechecks both source permission and the last database projection", async t => {
  for (const variant of ["database", "source", "final-database", "final-binding", "file"] as const) await t.test(variant, async () => {
    const s = scenario("storage");
    const storage = s.ports.storage;
    s.ports.storage = () => {
      const object = storage();
      return { ...object, read: async media => {
        const bytes = await object.read(media);
        if (variant === "database") s.state.projection = null;
        if (variant === "source") s.demo.pages.get(owner)!.archived = true;
        if (variant === "file") s.signature("fresh", "replacement.png");
        return bytes;
      } };
    };
    if (variant === "final-database" || variant === "final-binding") {
      const resolve = s.ports.resolve;
      s.ports.resolve = async binding => {
        const source = await resolve(binding);
        if (s.state.resolutions === 2) {
          if (variant === "final-database") s.state.projection = null;
          else s.state.projection!.binding.sourceFingerprint = "f".repeat(64);
        }
        return source;
      };
    }
    const response = await hybridMediaResponse(s.assetId, s.ports);
    assert.equal(response.status, 404); assert.equal(await response.text(), ""); assertPrivate(response);
    assert.equal(s.state.storageReads, 1);
  });
});

test("a valid projection belonging to another requested asset is denied before source or Storage access", async () => {
  const s = scenario("storage");
  const requested = `a1.${"d".repeat(64)}`;
  s.ports.read = async id => { s.state.dbReads++; assert.equal(id, requested); return structuredClone(s.projection); };
  const response = await hybridMediaResponse(requested, s.ports);
  assert.equal(response.status, 404); assertPrivate(response);
  assert.equal(s.state.dbReads, 1); assert.equal(s.state.resolutions, 0); assert.equal(s.state.storageInitializations, 0);
});

test("corrupt derivative bytes fail hash verification rather than redirecting to the original", async () => {
  const s = scenario("storage");
  s.state.bytes = Uint8Array.from(jpg); s.state.bytes[4] ^= 1;
  const response = await hybridMediaResponse(s.assetId, s.ports).catch(contentErrorResponse);
  assert.equal(response.status, 503); assert.equal(response.headers.get("Location"), null);
  assert.equal((await response.json()).error.message, "Media is temporarily unavailable.");
  assert.equal(s.state.dbReads, 1); assert.equal(s.state.resolutions, 1);
});

test("malformed public asset IDs are rejected before any database or source operation", async () => {
  const s = scenario();
  for (const id of ["", "m1.fixture", `a1.${"a".repeat(63)}`, `a1.${"A".repeat(64)}`, `${s.assetId}/private`]) {
    const response = await hybridMediaResponse(id, s.ports);
    assert.equal(response.status, 404); assertPrivate(response);
  }
  assert.equal(s.state.dbReads, 0); assert.equal(s.state.resolutions, 0); assert.equal(s.state.storageInitializations, 0);
  assert.equal(mediaProvider(undefined), "storage"); assert.equal(mediaProvider("storage"), "storage"); assert.equal(mediaProvider("notion"), "notion");
  assert.throws(() => mediaProvider("unknown"), error => error instanceof ContentServiceError && error.code === "MISCONFIGURED");
});
