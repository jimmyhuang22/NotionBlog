import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import type { BlockObjectResponse } from "@notionhq/client";
import type { WebsiteRecord, WebsiteWriter } from "../contracts/website-sync.ts";
import type { CollectionProgress } from "../src/server/notion/website-repository.ts";
import { createWebsiteNotionRepository } from "../src/server/notion/website-repository.ts";
import { parseWebsiteNotionConfig } from "../src/server/notion/website-config.ts";
import { createDemo, demoId, demoParagraph, DEMO_PNG } from "../scripts/notion-sync/demo.ts";
import { runWebsiteSync } from "../scripts/website-sync/worker.ts";
import type { NotionReadClient } from "../src/server/notion/types.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(count = 7) {
  const demo = createDemo(count);
  const config = parseWebsiteNotionConfig({ schemaVersion: 2, sources: [{ ...demo.config.sources[0], kind: "game" }] });
  const ids = Array.from({ length: count }, (_, n) => demoId(1000 + n));
  for (const [n, id] of ids.entries()) demo.blocks.set(id, [{ ...demoParagraph(demoId(50000 + n), id, ""), type: "image",
    image: { type: "external", external: { url: `https://images.example.test/${n}.png` }, caption: [] } } as BlockObjectResponse]);
  const client: NotionReadClient = {
    getPage: async id => structuredClone(demo.pages.get(id) ?? null),
    getDataSource: async id => structuredClone(demo.schemas.get(id)!),
    getBlock: async id => structuredClone([...demo.blocks.values()].flat().find(b => b.id === id) ?? null),
    listPages: async () => ids.map(id => structuredClone(demo.pages.get(id)!)),
    listBlocks: async id => structuredClone(demo.blocks.get(id) ?? []),
  };
  const staged: WebsiteRecord[] = []; let promoted = 0, failed = 0;
  const writer: WebsiteWriter = {
    begin: async (runId, configDigest) => ({ runId, configDigest, fence: "1", revision: "1", deniedPageIds: [] }),
    renew: async () => {}, stage: async (_lease, records) => { staged.push(...records); },
    promote: async () => { promoted++; }, fail: async () => { failed++; },
  };
  return { ids, client, config, writer, staged, outcomes: () => ({ promoted, failed }) };
}

test("four-page collection overlaps downloads, preserves records/ordinals, and uploads shared bytes once", async () => {
  const f = fixture(); let active = 0, peak = 0, entered = 0, puts = 0;
  const gate = deferred();
  const progress: CollectionProgress[] = [];
  const result = await runWebsiteSync({ ...f, mode: "publish", collectionConcurrency: 4,
    onCollectionProgress: p => progress.push(p),
    download: async () => {
      active++; peak = Math.max(peak, active); entered++; if (entered === 4) gate.resolve();
      await gate.promise; await delay(entered === 4 ? 5 : 0); active--;
      return { bytes: DEMO_PNG, mime: "image/png" };
    }, storage: { read: async () => DEMO_PNG, put: async () => { puts++; await delay(5); } },
  });
  assert.equal(peak, 4); assert.equal(active, 0); assert.equal(puts, 1);
  assert.deepEqual(f.staged.map(r => r.detail.item.id), f.ids);
  assert.deepEqual(f.staged.map(r => r.evidence.ordinal), [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(result.media, 7); assert.equal(result.uniqueObjects, 1); assert.equal(result.mediaBytes, DEMO_PNG.length);
  assert.equal(progress.at(-1)?.phase, "complete"); assert.equal(progress.at(-1)?.recordsCompleted, 7);
  assert.deepEqual(f.outcomes(), { promoted: 1, failed: 0 });
});

test("concurrent unique objects cannot exceed the byte cap across an awaited PUT", async () => {
  const f = fixture(4); let puts = 0;
  await assert.rejects(runWebsiteSync({ ...f, mode: "publish", collectionConcurrency: 4, maxMediaBytes: DEMO_PNG.length + 1,
    download: async url => ({ bytes: Buffer.concat([DEMO_PNG, Buffer.from(new URL(url).pathname)]), mime: "image/png" }),
    storage: { read: async () => DEMO_PNG, put: async () => { puts++; await delay(10); } },
  }), /media limit/);
  assert.equal(puts, 0); assert.equal(f.staged.length, 0); assert.deepEqual(f.outcomes(), { promoted: 0, failed: 1 });
  // Each object alone fits; two distinct objects together do not.
  const g = fixture(4); puts = 0;
  await assert.rejects(runWebsiteSync({ ...g, mode: "publish", collectionConcurrency: 4, maxMediaBytes: DEMO_PNG.length + 6,
    download: async url => ({ bytes: Buffer.concat([DEMO_PNG, Buffer.from(new URL(url).pathname)]), mime: "image/png" }),
    storage: { read: async () => DEMO_PNG, put: async () => { puts++; await delay(10); } },
  }), /media limit/);
  assert.equal(puts, 1); assert.equal(g.staged.length, 0); assert.deepEqual(g.outcomes(), { promoted: 0, failed: 1 });
});

test("failed object commit drains started pages without retrying its PUT or publishing", async () => {
  const f = fixture(4); let puts = 0, active = 0;
  await assert.rejects(runWebsiteSync({ ...f, mode: "publish", collectionConcurrency: 4,
    download: async () => { active++; await delay(5); active--; return { bytes: DEMO_PNG, mime: "image/png" }; },
    storage: { read: async () => DEMO_PNG, put: async () => { puts++; await delay(10); throw new Error("PUT failed"); } },
  }), /PUT failed/);
  assert.equal(puts, 1); assert.equal(active, 0); assert.equal(f.staged.length, 0);
  assert.deepEqual(f.outcomes(), { promoted: 0, failed: 1 });
});

test("failed page stops new work and drains outstanding collection before returning", async () => {
  const f = fixture(8), error = new Error("source failed"), gate = deferred();
  let started = 0, active = 0; const progress: CollectionProgress[] = [];
  f.client.listBlocks = async id => {
    started++; active++;
    try { if (id === f.ids[0]) throw error; await gate.promise; return []; }
    finally { active--; }
  };
  const collecting = createWebsiteNotionRepository({ ...f, collectionConcurrency: 4, onCollectionProgress: p => progress.push(p) }).collectRecords();
  const rejected = assert.rejects(collecting, e => e === error);
  await delay(10); assert.equal(started, 4); assert.equal(active, 3);
  gate.resolve(); await rejected; assert.equal(active, 0); assert.equal(started, 4);
  assert.equal(progress.some(p => p.phase === "complete"), false);
});

test("cancellation while a PUT is in flight drains it and blocks queued commits", async () => {
  const f = fixture(4), abort = new AbortController(); let puts = 0;
  await assert.rejects(runWebsiteSync({ ...f, mode: "publish", collectionConcurrency: 4, signal: abort.signal,
    download: async () => ({ bytes: DEMO_PNG, mime: "image/png" }),
    storage: { read: async () => DEMO_PNG, put: async () => { puts++; abort.abort(new Error("stopped")); await delay(5); } },
  }), /stopped/);
  assert.equal(puts, 1); assert.equal(f.staged.length, 0); assert.deepEqual(f.outcomes(), { promoted: 0, failed: 1 });
});

test("bounded hybrid collection keeps ordinary Notion delivery and deduplicates transformed Storage objects", async () => {
  const f = fixture(4); let puts = 0;
  const deliveries: string[] = [];
  const result = await runWebsiteSync({ ...f, mode: "publish", collectionConcurrency: 4,
    mediaSources: { stage: async (_lease, bindings) => { deliveries.push(...bindings.map(b => b.delivery)); } },
    download: async url => ({ bytes: DEMO_PNG, mime: "image/png", transformed: Number(new URL(url).pathname.slice(1, -4)) % 2 === 1 ? true : undefined }),
    storage: { read: async () => DEMO_PNG, put: async () => { puts++; await delay(5); } },
  });
  assert.equal(puts, 1); assert.equal(result.uniqueObjects, 1);
  assert.deepEqual(deliveries.sort(), ["notion", "notion", "storage", "storage"]);
  assert.deepEqual(f.outcomes(), { promoted: 1, failed: 0 });
});
