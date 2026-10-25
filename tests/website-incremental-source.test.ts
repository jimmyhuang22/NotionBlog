import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BlockObjectResponse } from "@notionhq/client";
import { createDemo, demoId, demoParagraph, DEMO_PNG } from "../scripts/notion-sync/demo.ts";
import { createHeicConverter } from "../scripts/notion-sync/heic.ts";
import { createWebsiteImageDownloader } from "../scripts/website-sync/download.ts";
import { createIndependentMediaPort } from "../scripts/website-incremental-sync/independent-media.ts";
import { createHostBudget } from "../scripts/website-incremental-sync/host-budget.ts";
import { parseWebsiteNotionConfig } from "../src/server/notion/website-config.ts";
import { configDigest } from "../src/server/database/website-validation.ts";
import type { NotionReadClient } from "../src/server/notion/types.ts";
import { prepareSinglePage, createSinglePagePreparationPort, type PagePreparationOptions } from "../scripts/website-incremental-sync/source.ts";
import type { PreparedDelta, PublicationState } from "../scripts/website-incremental-sync/executor.ts";
import { runIncrementalCycle } from "../scripts/website-incremental-sync/executor.ts";
import { createIncrementalPublicationPort } from "../scripts/website-incremental-sync/publication-port.ts";
import { openIncrementalQueue } from "../scripts/website-incremental-sync/queue.ts";

function fixture() {
  const demo = createDemo(3), source = demo.config.sources[0], owner = demoId(1000);
  const config = parseWebsiteNotionConfig({ schemaVersion: 2, sources: [{ key: "status", kind: "status",
    dataSourceId: source.dataSourceId, enabled: true, fields: source.fields, cover: { strategy: "none" }, publication: { mode: "all", allowlistPageIds: [] } }] });
  demo.blocks.set(owner, [demoParagraph(demoId(57000), owner, "Only this page's current body")]);
  const bodyReads: string[] = [], pageReads: string[] = [];
  const client: NotionReadClient = {
    getPage: async id => { pageReads.push(id); return structuredClone(demo.pages.get(id) ?? null); },
    getDataSource: async id => structuredClone(demo.schemas.get(id)!),
    getBlock: async id => structuredClone([...demo.blocks.values()].flat().find(b => b.id === id) ?? null),
    listPages: async () => { assert.fail("Single-page preparation must not enumerate data source rows"); },
    listBlocks: async id => { bodyReads.push(id); return structuredClone(demo.blocks.get(id) ?? []); },
  };
  const options: PagePreparationOptions = { client, config, expectedConfigDigest: configDigest(config), ordinal: 7,
    ticket: { operationId: "operation", sourceKey: "status", pageKey: owner, generation: 1, reasons: ["content"] },
    signal: new AbortController().signal, prepareImage: async () => { assert.fail("No image in this page"); } };
  const image = { ...demoParagraph(demoId(57001), owner, ""), type: "image", image: { type: "external",
    external: { url: "https://images.example.test/example.png" }, caption: [] } } as unknown as BlockObjectResponse;
  return { demo, owner, bodyReads, pageReads, client, options, image };
}

test("single-page preparation keeps the existing AST/evidence and never reads unrelated bodies or source rows", async () => {
  const s = fixture(); const prepared = await prepareSinglePage(s.options);
  assert.equal(prepared.outcome, "ready"); if (prepared.outcome !== "ready") assert.fail();
  assert.equal(prepared.record.detail.item.id, s.owner); assert.equal(prepared.record.evidence.ordinal, 7);
  assert.equal(prepared.record.evidence.sourceKey, "status"); assert.ok(JSON.stringify(prepared.record.detail.document).includes("Only this page"));
  assert.deepEqual(s.bodyReads, [s.owner]); assert.deepEqual(s.pageReads, [s.owner, s.owner]);
  assert.deepEqual(prepared.media, []);
});

test("scope mismatch, denial and source-owner mismatch do not publish or fetch a body", async () => {
  const s = fixture();
  assert.equal((await prepareSinglePage({ ...s.options, expectedConfigDigest: "a".repeat(64) })).outcome, "review");
  assert.equal(s.pageReads.length, 0);
  assert.equal((await prepareSinglePage({ ...s.options, deniedPageIds: new Set([s.owner]) })).outcome, "review");
  s.demo.pages.get(s.owner)!.parent = { type: "data_source_id", data_source_id: demoId(57002), database_id: demoId(57003) };
  assert.equal((await prepareSinglePage(s.options)).outcome, "review"); assert.deepEqual(s.bodyReads, []);
});

test("an archived or unavailable source is not guessed to be a confirmed deletion", async () => {
  const s = fixture(); s.demo.pages.get(s.owner)!.archived = true;
  assert.deepEqual(await prepareSinglePage(s.options), { outcome: "review", code: "SOURCE_SCOPE_UNKNOWN" });
  s.demo.pages.delete(s.owner);
  assert.deepEqual(await prepareSinglePage(s.options), { outcome: "review", code: "SOURCE_SCOPE_UNKNOWN" });
  assert.deepEqual(s.bodyReads, []);
});

test("a verified independent image descriptor is reused through the existing media route", async () => {
  const s = fixture(); s.demo.blocks.set(s.owner, [s.image]); let images = 0;
  const media = { assetId: `a1.${"d".repeat(64)}`, ownerPageId: s.owner, objectKey: `sha256/${"d".repeat(64)}`, sha256: "d".repeat(64),
    byteSize: 200, mime: "image/png" as const, width: 100, height: 50 };
  const prepared = await prepareSinglePage({ ...s.options, prepareImage: async input => {
    images++; assert.equal(input.ownerPageId, s.owner);
    return { verified: true, media, image: { id: media.assetId, src: `/media/v2/${media.assetId}`, alt: input.alt, width: 100, height: 50 } };
  } });
  assert.equal(prepared.outcome, "ready"); if (prepared.outcome !== "ready") assert.fail();
  assert.deepEqual(prepared.media, [media]); assert.equal(images, 1);
  assert.ok(JSON.stringify(prepared.record).includes(`/media/v2/${media.assetId}`));
  assert.ok(!JSON.stringify(prepared.record).includes("images.example.test"));
});

test("pending media and edits during body preparation keep the new page unready", async () => {
  const s = fixture(); s.demo.blocks.set(s.owner, [s.image]);
  assert.deepEqual(await prepareSinglePage({ ...s.options, prepareImage: async () => null }), { outcome: "pending", code: "MEDIA_PENDING" });
  s.demo.blocks.set(s.owner, [demoParagraph(demoId(57000), s.owner, "Changed while reading")]);
  s.client.listBlocks = async id => {
    s.demo.pages.get(s.owner)!.last_edited_time = "2026-01-03T00:00:00.000Z";
    return structuredClone(s.demo.blocks.get(id) ?? []);
  };
  assert.deepEqual(await prepareSinglePage(s.options), { outcome: "pending", code: "SOURCE_CHANGED_DURING_PREPARATION" });
});

test("single-page preparation reuses full-worker traversal protections and preserves supported partial blocks", async () => {
  const s = fixture();
  s.demo.blocks.set(s.owner, [{ ...s.image, image: { type: "external", external: { url: "attachment:missing" }, caption: [] } } as BlockObjectResponse]);
  await assert.rejects(prepareSinglePage(s.options), e => (e as { code?: string }).code === "CONTENT_UNAVAILABLE");
  s.demo.blocks.set(s.owner, [{ ...demoParagraph(demoId(57004), s.owner, ""), type: "video",
    video: { type: "external", external: { url: "https://example.test/video" }, caption: [] } } as unknown as BlockObjectResponse]);
  const external = await prepareSinglePage(s.options); assert.equal(external.outcome, "ready");
  if (external.outcome !== "ready") assert.fail();
  assert.equal(external.record.detail.document?.completeness, "complete");
  assert.equal(external.record.detail.document?.blocks[0].type, "embed");
  s.demo.blocks.set(s.owner, [{ ...demoParagraph(demoId(57004), s.owner, ""), type: "video",
    video: { type: "file", file: { url: "https://private.example.test/video", expiry_time: "2026-01-02T00:00:00.000Z" }, caption: [] } } as unknown as BlockObjectResponse]);
  const prepared = await prepareSinglePage(s.options); assert.equal(prepared.outcome, "ready");
  if (prepared.outcome !== "ready") assert.fail(); assert.equal(prepared.record.detail.document?.completeness, "partial");
});

test("content port supplies exactly one prepared page to the separately owned delta builder", async () => {
  const s = fixture(); let builders = 0;
  const state: PublicationState = { publicationRevision: "revision-1", configDigest: s.options.expectedConfigDigest, schemaDigest: "c".repeat(64), policyEpoch: "1" };
  const prepare = createSinglePagePreparationPort({ client: s.client, config: s.options.config, prepareImage: s.options.prepareImage,
    placement: async () => ({ ordinal: 7 }), readPublished: async () => null,
    prepareDelta: input => { builders++; assert.equal(input.upserts.length, 1); assert.equal(input.upserts[0].detail.item.id, s.owner);
      assert.deepEqual(input.withdrawals, []); return { ...input, payloadDigest: "b".repeat(64) }; },
  });
  const result = await prepare(s.options.ticket, state, s.options.signal);
  assert.equal(result.outcome, "prepared"); assert.equal(builders, 1); assert.deepEqual(s.bodyReads, [s.owner]);
});

test("an independently verified unchanged projection ignores JSON object key order and does not build a delta", async () => {
  const s = fixture(), baseline = await prepareSinglePage(s.options);
  if (baseline.outcome !== "ready") assert.fail();
  const state: PublicationState = { publicationRevision: "revision-1", configDigest: s.options.expectedConfigDigest, schemaDigest: "c".repeat(64), policyEpoch: "1" };
  const prepare = createSinglePagePreparationPort({ client: s.client, config: s.options.config, prepareImage: s.options.prepareImage,
    placement: async () => ({ ordinal: 7 }),
    readPublished: async () => ({ ...state, readerVerified: true, record: Object.fromEntries(Object.entries(baseline.record).reverse()) as typeof baseline.record, media: [] }),
    prepareDelta: () => { assert.fail("Unchanged data must not enter the publisher"); },
  });
  assert.deepEqual(await prepare(s.options.ticket, state, s.options.signal), { outcome: "unchanged" });
});

test("stale published projection or pending asset stops before delta construction", async () => {
  const s = fixture(), baseline = await prepareSinglePage(s.options);
  if (baseline.outcome !== "ready") assert.fail();
  const state: PublicationState = { publicationRevision: "revision-1", configDigest: s.options.expectedConfigDigest, schemaDigest: "c".repeat(64), policyEpoch: "1" };
  const prepare = createSinglePagePreparationPort({ client: s.client, config: s.options.config, prepareImage: async () => null,
    placement: async () => ({ ordinal: 7 }),
    readPublished: async () => ({ ...state, publicationRevision: "older", readerVerified: true, record: baseline.record, media: [] }),
    prepareDelta: () => { assert.fail("Unready data must not enter the publisher"); },
  });
  assert.deepEqual(await prepare(s.options.ticket, state, s.options.signal), { outcome: "retry", code: "PUBLICATION_VERSION_CHANGED" });
  s.demo.blocks.set(s.owner, [s.image]);
  assert.deepEqual(await prepare(s.options.ticket, state, s.options.signal), { outcome: "retry", code: "MEDIA_PENDING" });
});

test("a queued hint flows through the real single-page converter and explicit publisher/reader ports", async t => {
  const s = fixture(), directory = await realpath(await mkdtemp(join(tmpdir(), "incremental-page-cycle-")));
  const queue = await openIncrementalQueue(directory, { digest: s.options.expectedConfigDigest, sourceKeys: ["status"] });
  t.after(async () => { queue.close(); await rm(directory, { recursive: true, force: true }); });
  queue.enqueue([{ eventId: "edit", sourceKey: "status", pageKey: s.owner, reason: "content", observedAt: 1000 }]);
  const state: PublicationState = { publicationRevision: "revision-1", configDigest: s.options.expectedConfigDigest, schemaDigest: "c".repeat(64), policyEpoch: "1" };
  const prepare = createSinglePagePreparationPort({ client: s.client, config: s.options.config, prepareImage: s.options.prepareImage,
    placement: async () => ({ ordinal: 7 }), readPublished: async () => null,
    prepareDelta: input => ({ ...input, payloadDigest: "b".repeat(64) }),
  });
  let submitted = 0, verified = 0;
  const publication = createIncrementalPublicationPort({ state: async () => state, lookup: async () => null,
    publish: async (operationId, delta: PreparedDelta) => {
      submitted++; assert.equal(queue.pendingVerifications()[0].ticket.operationId, operationId);
      return { operationId, payloadDigest: delta.payloadDigest, publicationRevision: "revision-2", committed: true };
    },
  }, async () => { verified++; return true; });
  const result = await runIncrementalCycle({ queue, schemaDigest: state.schemaDigest }, { ...publication, prepare });
  assert.equal(result.outcome, "updated"); assert.equal(submitted, 1); assert.equal(verified, 1);
  assert.deepEqual(s.bodyReads, [s.owner]); assert.equal(queue.status().done, 1);
});

test("actual image adapters defer transient preparation, retain the five-failure cap and reject unsafe images", async t => {
  for (const mode of ["converter", "length", "exhaustion", "oversize", "type", "source"] as const) await t.test(mode, async t => {
    const s = fixture(), directory = await realpath(await mkdtemp(join(tmpdir(), "incremental-image-classification-")));
    const temporaryRoot = join(directory, "conversion"), executable = join(directory, "decoder");
    await mkdir(temporaryRoot, { mode: 0o700 });
    await writeFile(executable, "#!/bin/sh\nexit 75\n", { mode: 0o700 });
    const heic = Buffer.alloc(24); heic.writeUInt32BE(24); heic.write("ftypheic", 4); heic.write("mif1heic", 16);
    let now = 2000, ready = false, requests = 0, puts = 0, reads = 0, submitted = 0;
    const queue = await openIncrementalQueue(join(directory, "queue"), { digest: s.options.expectedConfigDigest, sourceKeys: ["status"] }, () => now);
    const budget = createHostBudget(), download = createWebsiteImageDownloader({
      maxBytes: mode === "oversize" ? DEMO_PNG.length - 1 : 1000,
      allowedHosts: mode === "source" ? ["other.example.test"] : undefined,
      resolve: async () => [{ address: "8.8.8.8", family: 4 }],
      convertHeic: createHeicConverter({ executable, temporaryRoot }),
      request: async () => {
        requests++;
        const conversion = mode === "converter";
        const bytes = conversion ? heic : DEMO_PNG;
        return { status: 200, headers: { "content-type": mode === "type" ? "image/svg+xml" : conversion ? "image/heic" : "image/png",
          "content-length": String(bytes.length + (!ready && ["length", "exhaustion"].includes(mode) ? 1 : 0)) },
        bytes: (async function* () { yield bytes; })(), cancel() {} };
      },
    }, { wait: async () => { assert.fail("These complete-body/converter failures must not add an immediate v2 retry"); } });
    t.after(async () => { download.close(); budget.close(); queue.close(); await rm(directory, { recursive: true, force: true }); });
    const storedBytes = mode === "converter" ? Buffer.from([255, 216, 255, 0]) : DEMO_PNG;
    const media = createIndependentMediaPort({ budget, download, cached: () => null,
      storage: { put: async (_media, bytes) => { assert.deepEqual(Buffer.from(bytes), storedBytes); puts++; },
        read: async () => { reads++; return storedBytes; } } });
    s.demo.blocks.set(s.owner, [s.image]);
    queue.enqueue([{ eventId: "image-edit", sourceKey: "status", pageKey: s.owner, reason: "content", observedAt: 1000 }]);
    const state: PublicationState = { publicationRevision: "revision-1", configDigest: s.options.expectedConfigDigest,
      schemaDigest: "c".repeat(64), policyEpoch: "1" };
    const prepare = createSinglePagePreparationPort({ client: s.client, config: s.options.config,
      prepareImage: (input, signal) => media.prepare(input, signal), placement: async () => ({ ordinal: 7 }), readPublished: async () => null,
      prepareDelta: input => ({ ...input, payloadDigest: "b".repeat(64) }) });
    const publication = createIncrementalPublicationPort({ state: async () => state, lookup: async () => null,
      publish: async (operationId, delta) => { submitted++; return { operationId, payloadDigest: delta.payloadDigest,
        publicationRevision: "revision-2", committed: true }; } }, async () => true);
    const run = () => runIncrementalCycle({ queue, schemaDigest: state.schemaDigest, maxTasks: 1, retryDelayMs: 1000 }, { ...publication, prepare });
    const first = await run();
    assert.equal(puts + reads + submitted, 0, "Failed images must not reach object storage or publication");
    assert.deepEqual(await readdir(temporaryRoot), []);
    if (["oversize", "type", "source"].includes(mode)) {
      assert.equal(first.review, 1); assert.equal(first.retried, 0); assert.equal(queue.status().needs_review, 1);
      assert.equal(requests, mode === "source" ? 0 : 1); return;
    }
    assert.equal(first.retried, 1); assert.equal(first.review, 0); assert.equal(requests, 1);
    now += 999; assert.equal((await run()).claimed, 0); assert.equal(requests, 1);
    now++;
    if (mode !== "exhaustion") {
      ready = true;
      if (mode === "converter") await writeFile(executable, '#!/bin/sh\numask 077\nprintf "\\377\\330\\377\\000" > "$2"\n');
      assert.equal((await run()).outcome, "updated"); assert.equal(queue.status().done, 1);
      assert.equal(requests, 2); assert.equal(puts, 1); assert.equal(reads, 1); assert.equal(submitted, 1);
    } else {
      for (let attempt = 2; attempt <= 5; attempt++) {
        if (attempt > 2) now += 1000 * 2 ** (attempt - 2);
        const result = await run(); assert.equal(result.claimed, 1);
        assert.equal(result.review, attempt === 5 ? 1 : 0);
      }
      assert.equal(requests, 5); assert.equal(queue.status().needs_review, 1); assert.equal(puts + reads + submitted, 0);
      now += 86_400_000; assert.equal((await run()).claimed, 0); assert.equal(requests, 5);
    }
  });
});
