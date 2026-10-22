import test from "node:test";
import assert from "node:assert/strict";
import type { BlockObjectResponse } from "@notionhq/client";
import { createDemo, demoId, demoParagraph, DEMO_PNG } from "../scripts/notion-sync/demo.ts";
import { runWebsiteSync } from "../scripts/website-sync/worker.ts";
import { createMediaRefreshScope } from "../scripts/website-sync/media-refresh-scope.ts";
import { createWebsiteNotionRepository } from "../src/server/notion/website-repository.ts";
import { parseWebsiteNotionConfig } from "../src/server/notion/website-config.ts";
import type { NotionReadClient } from "../src/server/notion/types.ts";

function fixture(count = 40) {
  const demo = createDemo(2), owner = demoId(1000), second = demoId(1001);
  const config = parseWebsiteNotionConfig({ schemaVersion: 2, sources: [{ ...demo.config.sources[0], kind: "game" }] });
  const images = Array.from({ length: count }, (_, n) => ({ ...demoParagraph(demoId(9000 + n), owner, ""), type: "image",
    image: { type: "file", file: { url: `https://assets.example.test/${n}.png?token=old`, expiry_time: new Date(0).toISOString() }, caption: [] } } as BlockObjectResponse));
  let pageReads = 0, schemaReads = 0, blockReads = 0, listings = 0;
  let mutation: "none" | "replacement" | "missing" | "moved" | "duplicate" = "none";
  const client: NotionReadClient = {
    getPage: async id => { pageReads++; return structuredClone(demo.pages.get(id) ?? null); },
    getDataSource: async id => { schemaReads++; return structuredClone(demo.schemas.get(id)!); },
    listPages: async () => [structuredClone(demo.pages.get(owner)!)],
    getBlock: async () => { blockReads++; assert.fail("Direct image siblings need no individual block fetch"); },
    listBlocks: async id => {
      assert.equal(id, owner); listings++;
      const rows = structuredClone(images);
      if (listings > 1) for (const row of rows) if (row.type === "image" && row.image.type === "file") {
        row.image.file = { url: row.image.file.url.replace("token=old", "token=fresh"), expiry_time: new Date(Date.now() + 3_600_000).toISOString() };
      }
      if (listings > 1) {
        if (mutation === "missing") rows.shift();
        if (mutation === "duplicate") rows.push(rows[0]);
        if (mutation === "moved") rows[0].parent = { type: "page_id", page_id: second };
        if (mutation === "replacement" && rows[0].type === "image" && rows[0].image.type === "file") rows[0].image.file.url = rows[0].image.file.url.replace("/0.png", "/replacement.png");
      }
      return rows;
    },
  };
  return { client, config, owner, second, demo, mutate: (value: typeof mutation) => { mutation = value; },
    counts: () => ({ pageReads, schemaReads, blockReads, listings }) };
}

test("forty expired sibling images use one refresh listing and two fresh owner checks", async () => {
  const f = fixture(); let downloads = 0;
  const report = await runWebsiteSync({ client: f.client, config: f.config, mode: "dry-run", mediaSources: { stage: async () => assert.fail() },
    download: async url => { assert.match(url, /token=fresh/); downloads++; return { bytes: DEMO_PNG, mime: "image/png" }; } });
  assert.equal(downloads, 40); assert.equal(report.sourceRefreshes, 40); assert.equal(report.media, 40);
  assert.deepEqual(f.counts(), { pageReads: 2, schemaReads: 3, blockReads: 0, listings: 2 });
});

test("fresh sibling membership and fingerprints reject missing, moved, duplicate and replaced images", async t => {
  for (const value of ["missing", "moved", "duplicate", "replacement"] as const) await t.test(value, async () => {
    const f = fixture(); f.mutate(value); let downloads = 0;
    await assert.rejects(runWebsiteSync({ client: f.client, config: f.config, mode: "dry-run", mediaSources: { stage: async () => assert.fail() },
      download: async () => { downloads++; return { bytes: DEMO_PNG, mime: "image/png" }; } }), { code: "CONTENT_UNAVAILABLE" });
    assert.equal(downloads, 0);
  });
});

test("owner revocation during downloads prevents any record staging or publication", async () => {
  const f = fixture(2); let failed = 0;
  await assert.rejects(runWebsiteSync({ client: f.client, config: f.config, mode: "publish",
    writer: { begin: async (runId, configDigest) => ({ runId, configDigest, fence: "1", revision: "1", deniedPageIds: [] }),
      renew: async () => {}, stage: async () => assert.fail("No partial records may stage"), promote: async () => assert.fail(), fail: async () => { failed++; } },
    storage: { put: async () => assert.fail(), read: async () => assert.fail() }, mediaSources: { stage: async () => assert.fail() },
    download: async () => { f.demo.pages.get(f.owner)!.archived = true; return { bytes: DEMO_PNG, mime: "image/png" }; } }), { code: "CONTENT_UNAVAILABLE" });
  assert.equal(failed, 1);
});

test("page scopes expire from request start, check completion, and isolate concurrent owners", async () => {
  const f = fixture(), repo = createWebsiteNotionRepository({ client: f.client, config: f.config });
  const first = (await repo.resolveMediaOwner!(f.owner))!, second = (await repo.resolveMediaOwner!(f.second))!;
  const reads: string[] = []; let time = 0;
  const scope = createMediaRefreshScope(async id => { reads.push(id); return structuredClone(id === f.owner ? first : second); }, () => {}, () => time);
  await Promise.all([scope.run(first, async () => {
    await scope.resolveMediaOwner(f.owner); await scope.resolveMediaOwner(f.owner);
    time = 30_000; await scope.resolveMediaOwner(f.owner);
    await assert.rejects(scope.resolveMediaOwner(f.second), { code: "CONTENT_UNAVAILABLE" });
  }), scope.run(second, async () => { await scope.resolveMediaOwner(f.second); })]);
  assert.equal(reads.filter(id => id === f.owner).length, 3);
  assert.equal(reads.filter(id => id === f.second).length, 2);
  await scope.resolveMediaOwner(f.owner); await scope.resolveMediaOwner(f.owner);
  assert.equal(reads.filter(id => id === f.owner).length, 5, "No owner evidence survives a page scope");
});

test("page moves or edit revisions changing before completion invalidate the result", async t => {
  for (const move of [false, true]) await t.test(move ? "move" : "edit", async () => {
    const f = fixture(), repo = createWebsiteNotionRepository({ client: f.client, config: f.config });
    const owner = (await repo.resolveMediaOwner!(f.owner))!; let calls = 0;
    const scope = createMediaRefreshScope(async () => {
      const fresh = structuredClone(owner);
      if (++calls > 1) {
        if (move) fresh.page.parent = { type: "page_id", page_id: f.second };
        else fresh.page.last_edited_time = "2026-10-02T00:00:00.000Z";
      }
      return fresh;
    }, () => {});
    await assert.rejects(scope.run(owner, async () => { await scope.resolveMediaOwner(f.owner); return "partial"; }), { code: "CONTENT_UNAVAILABLE" });
  });
});

test("a read that itself exhausts the thirty-second bound cannot supply reusable evidence", async () => {
  const f = fixture(), repo = createWebsiteNotionRepository({ client: f.client, config: f.config });
  const owner = (await repo.resolveMediaOwner!(f.owner))!; let time = 0;
  const slowOwner = createMediaRefreshScope(async () => { time += 30_000; return owner; }, () => {}, () => time);
  await assert.rejects(slowOwner.run(owner, () => slowOwner.resolveMediaOwner(f.owner)), { code: "CONTENT_UNAVAILABLE" });
  const scope = createMediaRefreshScope(async () => owner, () => {}, () => time);
  await assert.rejects(scope.run(owner, async () => {
    await scope.resolveMediaOwner(f.owner);
    const slow = { ...f.client, listBlocks: async () => { time += 30_000; return []; } };
    await scope.locatorClient(slow, demoId(9000), f.owner).getBlock(demoId(9000));
  }), { code: "CONTENT_UNAVAILABLE" });
});
