import test from "node:test";
import assert from "node:assert/strict";
import type { BlockObjectResponse } from "@notionhq/client";
import type { CollectedPage } from "../scripts/website-sync/collection-capture.ts";
import { createDemo, demoId, demoParagraph, DEMO_PNG } from "../scripts/notion-sync/demo.ts";
import { runWebsiteSync } from "../scripts/website-sync/worker.ts";

test("resumed expired images share owner checks while retaining live locators and final revocation checks", async t => {
  for (const revoke of [false, true]) await t.test(revoke ? "revoked during reuse" : "unchanged forty-image page", async () => {
    const demo = createDemo(1), owner = demoId(1000), count = 40;
    demo.pages.get(owner)!.cover = null;
    let resuming = false, downloads = 0, pages = 0, schemas = 0, blocks = 0;
    const image = (n: number, fresh: boolean): BlockObjectResponse => ({
      ...demoParagraph(demoId(9100 + n), owner, ""), type: "image",
      image: { type: "file", file: { url: `https://assets.example.test/${n}.png?version=${fresh ? "fresh" : "old"}`,
        expiry_time: new Date(Date.now() + (fresh ? 600_000 : -60_000)).toISOString() }, caption: [] },
    } as BlockObjectResponse);
    const client = { ...demo.client,
      getPage: async (id: string) => { pages++; return structuredClone(demo.pages.get(id) ?? null); },
      getDataSource: async (id: string) => { schemas++; return structuredClone(demo.schemas.get(id)!); },
      listBlocks: async () => Array.from({ length: count }, (_, n) => image(n, !resuming)),
      getBlock: async (id: string) => { blocks++; const n = Array.from({ length: count }, (_, n) => n).find(n => demoId(9100 + n) === id);
        assert.notEqual(n, undefined); return image(n!, true); },
    };
    const config = { schemaVersion: 2, sources: [{ ...demo.config.sources[0], kind: "game" }] };
    const captured: CollectedPage[] = [];
    const download = async (url: string) => {
      assert.equal(new URL(url).searchParams.get("version"), "fresh"); downloads++;
      if (resuming && revoke && downloads === count) demo.pages.get(owner)!.archived = true;
      return { bytes: DEMO_PNG, mime: "image/png" as const };
    };
    await runWebsiteSync({ client, config, mode: "dry-run", download, mediaSources: { stage: async () => assert.fail() },
      captureCollection: { save: async page => { captured.push(page); }, seal: async () => {} } });
    assert.equal(captured.length, 1);
    resuming = true; pages = schemas = blocks = downloads = 0;
    let saved = 0, sealed = false;
    const run = () => runWebsiteSync({ client, config, mode: "publish", download, mediaSources: { stage: async () => { assert.equal(revoke, false); } },
      storage: { put: async () => assert.fail("Reused ordinary images require no upload"), read: async () => assert.fail() },
      writer: { begin: async (runId, configDigest) => ({ runId, configDigest, fence: "1", revision: "1", deniedPageIds: [] }),
        renew: async () => {}, stage: async () => { assert.equal(revoke, false); }, promote: async () => { assert.equal(revoke, false); }, fail: async () => {} },
      resumeCollection: { pages: captured, bind: async () => () => {} },
      captureCollection: { save: async () => { saved++; }, seal: async () => { sealed = true; } } });
    if (revoke) { await assert.rejects(run(), { code: "CONTENT_UNAVAILABLE" }); assert.equal(saved, 0); assert.equal(sealed, false); }
    else { const report = await run(); assert.equal(report.resume?.reusedPages, 1); assert.equal(report.resume?.recollectedPages, 0); assert.equal(saved, 1); assert.equal(sealed, true); }
    assert.equal(downloads, count); assert.equal(blocks, count, "Each expired locator still gets a current read");
    assert.ok(pages < 10 && schemas < 10, `Owner checks must not grow with image count: ${pages} pages, ${schemas} schemas`);
    t.diagnostic(`reuse=${!revoke}: page reads=${pages}, schema reads=${schemas}, locator reads=${blocks}`);
  });
});
