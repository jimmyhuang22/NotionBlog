import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { BlockObjectResponse } from "@notionhq/client";
import { createDemo, demoId, demoParagraph, DEMO_PNG } from "../scripts/notion-sync/demo.ts";
import { runWebsiteSync, websitePolicy } from "../scripts/website-sync/worker.ts";
import { createWebsiteWriter } from "../src/server/database/website-writer.ts";
import { WEBSITE_SCHEMA_DIGEST } from "../contracts/website-sync.ts";
import type { NotionReadClient } from "../src/server/notion/types.ts";
import { createHash } from "node:crypto";
import { mediaIdentity } from "../src/server/database/website-validation.ts";
import { sourceFingerprint, type MediaSourceBinding } from "../src/server/media/notion-source.ts";
import { resolveNotionMediaSource } from "../src/server/notion/media-source.ts";
import { createWebsiteNotionRepository } from "../src/server/notion/website-repository.ts";
import { parseWebsiteNotionConfig } from "../src/server/notion/website-config.ts";
import { buildNotionDocument } from "../src/server/notion/blocks.ts";

const unavailable = (error: unknown) => error instanceof Error && "code" in error && error.code === "CONTENT_UNAVAILABLE";
function fixture() {
  const demo = createDemo(1), owner = demoId(1000);
  const config = { schemaVersion: 2, sources: [{ key: "games", kind: "game", enabled: true, dataSourceId: demo.config.sources[0].dataSourceId, fields: { title: "Name" }, cover: { strategy: "none" }, publication: { mode: "all", allowlistPageIds: [] } }] };
  const client: NotionReadClient = {
    getPage: async id => structuredClone(demo.pages.get(id) ?? null),
    getDataSource: async id => structuredClone(demo.schemas.get(id)!),
    getBlock: async id => structuredClone([...demo.blocks.values()].flat().find(b => b.id === id) ?? null),
    listPages: async id => structuredClone([...demo.pages.values()].filter(p => p.parent.type === "data_source_id" && p.parent.data_source_id === id)),
    listBlocks: async id => structuredClone(demo.blocks.get(id) ?? []),
  };
  demo.blocks.set(owner, [demoParagraph(demoId(50000), owner, "Complete public text")]);
  function brokenImage(nested: "root" | "toggle" | "list" | "columns") {
    const wrapper = demoId(50001), column = demoId(50002), imageId = demoId(50003);
    const image = { ...demoParagraph(imageId, owner, ""), type: "image", image: { type: "external", external: { url: "attachment:unavailable-image" }, caption: [] } } as unknown as BlockObjectResponse;
    if (nested === "root") { demo.blocks.set(owner, [image]); return; }
    const container = { ...demoParagraph(wrapper, owner, ""), has_children: true };
    if (nested === "toggle") demo.blocks.set(owner, [{ ...container, type: "toggle", toggle: { rich_text: [], color: "default" } } as unknown as BlockObjectResponse]);
    if (nested === "list") demo.blocks.set(owner, [{ ...container, type: "bulleted_list_item", bulleted_list_item: { rich_text: [], color: "default" } } as unknown as BlockObjectResponse]);
    if (nested === "columns") {
      demo.blocks.set(owner, [{ ...container, type: "column_list", column_list: {} } as unknown as BlockObjectResponse]);
      demo.blocks.set(wrapper, [{ ...demoParagraph(column, owner, ""), parent: { type: "block_id", block_id: wrapper }, type: "column", column: {}, has_children: true } as unknown as BlockObjectResponse]);
    }
    image.parent = { type: "block_id", block_id: nested === "columns" ? column : wrapper };
    demo.blocks.set(nested === "columns" ? column : wrapper, [image]);
  }
  return { demo, config, client, owner, brokenImage };
}
test("website repository enables stable external videos without downloading or changing the AST contract", async () => {
  const s = fixture();
  s.demo.blocks.set(s.owner, [{ ...demoParagraph(demoId(50100), s.owner, ""), type: "video", video: { type: "external", external: { url: "https://video.example.test/lesson" }, caption: [] } } as unknown as BlockObjectResponse]);
  const repository = createWebsiteNotionRepository({ client: s.client, config: parseWebsiteNotionConfig(s.config), timeZone: "UTC" });
  const detail = await repository.get("game", s.owner);
  assert.equal(detail?.document?.completeness, "complete");
  const block = detail?.document?.blocks[0];
  assert.equal(block?.type, "embed");
  if (block?.type !== "embed") assert.fail("Expected an existing embed DTO");
  assert.equal(block.url, "https://video.example.test/lesson");
  assert.equal(block.display, "link");
});

test("v2 dry-run rejects dropped image blocks at every supported nesting level", async t => {
  for (const nesting of ["root", "toggle", "list", "columns"] as const) await t.test(nesting, async () => {
    const s = fixture(); s.brokenImage(nesting);
    await assert.rejects(runWebsiteSync({ client: s.client, config: s.config, mode: "dry-run", download: async () => { assert.fail("Invalid URL must not be downloaded"); } }), unavailable);
  });
});
test("a missing-image publish fails its lease and preserves the prior complete database batch", async () => {
  const s = fixture(), db = await PGlite.create();
  try {
    await db.exec(await readFile(new URL("../database/website-migrations/001_website.sql", import.meta.url), "utf8"));
    await db.query("UPDATE nb_v2.state SET schema_digest=$1", [WEBSITE_SCHEMA_DIGEST]);
    const policy = await websitePolicy(s.client, s.config, 600);
    await db.query("SELECT nb_v2_api.configure_policy($1,$2,$3::jsonb,$4::jsonb)", [policy.configDigest, policy.freshnessSeconds, JSON.stringify(policy.sources), JSON.stringify(policy.permits)]);
    const writer = createWebsiteWriter(db), options = { client: s.client, config: s.config, mode: "publish" as const, writer, storage: { read: async () => new Uint8Array(), put: async () => assert.fail("No objects expected") } };
    // A supported partial representation remains permissible: unavailable internal links
    // and unsupported non-image block types do not mean an image download was skipped.
    s.demo.blocks.get(s.owner)!.push({ ...demoParagraph(demoId(50004), s.owner, ""), type: "video", video: { type: "file", file: { url: "https://private.example.test/video", expiry_time: "2026-01-02T00:00:00.000Z" }, caption: [] } } as unknown as BlockObjectResponse);
    assert.equal((await runWebsiteSync(options)).partialDocuments, 1);
    const before = (await db.query<{ current_run: string }>("SELECT current_run FROM nb_v2.state")).rows[0].current_run;
    s.brokenImage("toggle");
    for (const indexed of [false, true]) {
      await assert.rejects(runWebsiteSync({ ...options, ...(indexed ? { mediaSources: { stage: async () => assert.fail("Invalid body must not stage source bindings") } } : {}) }), unavailable);
      const state = (await db.query<{ current_run: string; lease_run: string | null }>("SELECT current_run,lease_run FROM nb_v2.state")).rows[0];
      assert.equal(state.current_run, before); assert.equal(state.lease_run, null);
      assert.equal((await db.query<{ status: string }>("SELECT status FROM nb_v2.runs ORDER BY started_at DESC LIMIT 1")).rows[0].status, "failed");
    }
    assert.equal((await db.query<{ n: number }>("SELECT count(*)::int n FROM nb_v2.records WHERE run_id=$1", [before])).rows[0].n, 1);
  } finally { await db.close(); }
});
test("v2 encodes image path spaces consistently for sync and the live hybrid resolver", async () => {
  const s = fixture(); s.brokenImage("root");
  const block = s.demo.blocks.get(s.owner)![0]; assert.equal(block.type, "image");
  if (block.type !== "image") assert.fail();
  const rawUrl = "https://assets.example.test/Film Poster.jpg?edition=extended cut", canonical = "https://assets.example.test/Film%20Poster.jpg?edition=extended%20cut";
  block.image = { type: "external", external: { url: rawUrl }, caption: [] };
  let calls = 0;
  const report = await runWebsiteSync({ client: s.client, config: s.config, mode: "dry-run", download: async url => { calls++; assert.equal(url, canonical); return { bytes: DEMO_PNG, mime: "image/png" }; } });
  assert.equal(calls, 1); assert.equal(report.media, 1); assert.equal(report.partialDocuments, 0);
  const hash = createHash("sha256").update(DEMO_PNG).digest("hex");
  const binding: MediaSourceBinding = { assetId: mediaIdentity(s.owner, block.id, hash), ownerPageId: s.owner, sha256: hash, locator: { kind: "block", id: block.id }, delivery: "notion", sourceFingerprint: sourceFingerprint(canonical, false) };
  const live = createWebsiteNotionRepository({ client: s.client, config: parseWebsiteNotionConfig(s.config) });
  assert.deepEqual(await resolveNotionMediaSource(binding, live, s.client), { url: canonical, sourceFingerprint: binding.sourceFingerprint });
  assert.equal(block.image.external.url, rawUrl, "Source page stays unchanged");
  const legacy = await buildNotionDocument(s.owner, s.client, { resolvePageLink: async () => null, registerImage: async () => { assert.fail("v1 keeps its original strict URL behavior"); } });
  assert.equal(legacy.blocks[0].type, "unsupported");
  for (const url of [" https://assets.example.test/image.png", "https://assets.example.test/image.png ", "https://assets.example.test/line\nbreak.png", "https://user:pass@assets.example.test/image.png", "https://assets.example.test/unsafe\\path.png", "https://assets.example.test:bad/image.png"]) {
    block.image.external.url = url;
    await assert.rejects(runWebsiteSync({ client: s.client, config: s.config, mode: "dry-run", download: async () => { assert.fail("Unsafe input must not reach download"); } }), unavailable);
  }
});
