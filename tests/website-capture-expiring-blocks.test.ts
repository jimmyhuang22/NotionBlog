import test from "node:test";
import assert from "node:assert/strict";
import type { BlockObjectResponse } from "@notionhq/client";
import { createDemo, demoId, demoParagraph, DEMO_PNG } from "../scripts/notion-sync/demo.ts";
import { runWebsiteSync } from "../scripts/website-sync/worker.ts";

test("captured collection refreshes expired block URLs outside its discovery memo", async t => {
  for (const change of ["same", "replacement", "archived", "moved", "expired"] as const) await t.test(change, async () => {
    const demo = createDemo(1), owner = demoId(1000);
    demo.pages.get(owner)!.cover = null;
    let lists = 0, downloads = 0, saved = 0, sealed = false;
    const image = (index: number, fresh: boolean): BlockObjectResponse => {
      const url = new URL(`https://assets.example.test/${fresh && change === "replacement" ? "changed" : index}.png`);
      url.searchParams.set("signature", fresh ? "fresh" : "old");
      const block = { ...demoParagraph(demoId(9100 + index), owner, ""), type: "image",
        image: { type: "file", file: { url: url.href, expiry_time: new Date(Date.now() + (fresh && change !== "expired" ? 600_000 : -60_000)).toISOString() }, caption: [] } } as BlockObjectResponse;
      if (fresh && change === "archived") block.archived = true;
      if (fresh && change === "moved") block.parent = { type: "page_id", page_id: demoId(9999) };
      return block;
    };
    const client = { ...demo.client,
      listBlocks: async (id: string) => { assert.equal(id, owner); lists++; return [image(0, lists > 1), image(1, lists > 1)]; },
      getBlock: async () => assert.fail("Refresh uses one fresh complete sibling listing"),
    };
    const run = () => runWebsiteSync({ client, config: { schemaVersion: 2, sources: [{ ...demo.config.sources[0], kind: "game" }] }, mode: "dry-run",
      captureCollection: { save: async () => { saved++; }, seal: async () => { sealed = true; } },
      mediaSources: { stage: async () => assert.fail("Dry run cannot stage") },
      download: async url => { assert.equal(new URL(url).searchParams.get("signature"), "fresh"); downloads++; return { bytes: DEMO_PNG, mime: "image/png" }; },
    });
    if (change === "same") {
      const report = await run(); assert.equal(report.sourceRefreshes, 2); assert.equal(downloads, 2); assert.equal(saved, 1); assert.equal(sealed, true);
    } else {
      await assert.rejects(run(), (error: unknown) => error instanceof Error && "code" in error && error.code === "CONTENT_UNAVAILABLE");
      assert.equal(downloads, 0); assert.equal(saved, 0); assert.equal(sealed, false);
    }
    assert.equal(lists, 2, "One cached body listing and one independent current sibling listing");
  });
});
