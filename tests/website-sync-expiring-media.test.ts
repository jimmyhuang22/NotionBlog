import test from "node:test";
import assert from "node:assert/strict";
import { createDemo, demoId, DEMO_PNG } from "../scripts/notion-sync/demo.ts";
import { runWebsiteSync } from "../scripts/website-sync/worker.ts";
import type { NotionReadClient } from "../src/server/notion/types.ts";

const owner = demoId(1000);
const oldUrl = "https://assets.example.test/synthetic-cover.png?token=old";
const freshUrl = oldUrl.replace("=old", "=fresh");

function fixture(mode: "all" | "allowlist", locator: "cover" | "property", expiry: number) {
  const demo = createDemo(1), page = demo.pages.get(owner)!;
  const uploaded = (url: string, time: number) => ({ type: "file" as const, file: { url, expiry_time: new Date(time).toISOString() } });
  page.cover = uploaded(oldUrl, expiry);
  page.properties.Artwork = { id: "art", type: "files", files: [{ name: "Synthetic cover", ...uploaded(oldUrl, expiry) }] };
  const dataSourceId = demo.config.sources[0].dataSourceId;
  Object.assign(demo.schemas.get(dataSourceId)!.properties, { Artwork: { id: "art", name: "Artwork", type: "files", files: {} } });
  demo.blocks.set(owner, []);
  const config = { schemaVersion: 2, sources: [{ key: "games", kind: "game", enabled: true, dataSourceId, fields: { title: "Name" },
    cover: locator === "cover" ? { strategy: "native-page-cover" } : { strategy: "files-property", property: "Artwork" },
    publication: { mode, allowlistPageIds: mode === "allowlist" ? [owner] : [] } }] };
  let ownerReads = 0, bodyReads = 0;
  let change: "none" | "replacement" | "archive" | "moved" = "none";
  const client: NotionReadClient = {
    getPage: async id => {
      if (id !== owner) return null;
      ownerReads++;
      const current = structuredClone(page);
      if (mode === "allowlist" && ownerReads === 1) return current;
      const url = change === "replacement" ? freshUrl.replace("synthetic-cover.png", "different-file.png") : freshUrl;
      current.cover = uploaded(url, Date.now() + 3_600_000);
      current.properties.Artwork = { id: "art", type: "files", files: [{ name: "Synthetic cover", ...uploaded(url, Date.now() + 3_600_000) }] };
      if (change === "archive") current.archived = true;
      if (change === "moved") current.parent = { type: "data_source_id", data_source_id: demoId(9999), database_id: demoId(9998) };
      return current;
    },
    getDataSource: async id => structuredClone(demo.schemas.get(id)!),
    getBlock: async () => assert.fail("Cover refresh must not read body blocks"),
    listPages: async () => [structuredClone(page)],
    listBlocks: async () => { bodyReads++; return []; },
  };
  return { client, config, reads: () => ({ ownerReads, bodyReads }), change: (value: typeof change) => { change = value; } };
}

test("hybrid sync refreshes expired and near-expiry covers in whole-source and allowlist modes", async t => {
  for (const mode of ["all", "allowlist"] as const) for (const locator of ["cover", "property"] as const) {
    for (const offset of [-60_000, 30_000]) await t.test(`${mode} ${locator} ${offset < 0 ? "expired" : "near-expiry"}`, async () => {
      const s = fixture(mode, locator, Date.now() + offset);
      let downloads = 0;
      const report = await runWebsiteSync({ client: s.client, config: s.config, mode: "dry-run",
        mediaSources: { stage: async () => assert.fail("A dry run cannot stage media sources") },
        download: async url => { downloads++; assert.equal(url, freshUrl); return { bytes: DEMO_PNG, mime: "image/png" }; } });
      assert.equal(report.sourceRefreshes, 1);
      assert.equal(report.media, 1);
      assert.equal(downloads, 1);
      assert.equal(s.reads().bodyReads, 1, "Refreshing a locator must not traverse the body again");
      assert.equal(s.reads().ownerReads, mode === "all" ? 2 : 3, "Fresh owner checks bracket page processing");
    });
  }
});

test("hybrid locator refresh rejects replaced files and withdrawn owners before image reading", async t => {
  for (const reason of ["replacement", "archive", "moved"] as const) await t.test(reason, async () => {
    const s = fixture("all", "cover", Date.now() - 60_000); s.change(reason);
    let downloads = 0;
    await assert.rejects(runWebsiteSync({ client: s.client, config: s.config, mode: "dry-run",
      mediaSources: { stage: async () => assert.fail("A failed source cannot stage media") },
      download: async () => { downloads++; return { bytes: DEMO_PNG, mime: "image/png" }; } }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "CONTENT_UNAVAILABLE");
    assert.equal(downloads, 0);
  });
});
