import assert from "node:assert/strict";
import test from "node:test";
import { createDemo, demoId } from "../scripts/notion-sync/demo.ts";
import { prepareSinglePage, preparePublishedWithdrawal, createSinglePagePreparationPort, type PageWithdrawalOptions, type PublishedPage } from "../scripts/website-incremental-sync/source.ts";
import { parseWebsiteNotionConfig } from "../src/server/notion/website-config.ts";
import { configDigest } from "../src/server/database/website-validation.ts";
import type { NotionReadClient } from "../src/server/notion/types.ts";
import { WEBSITE_SCHEMA_DIGEST } from "../contracts/website-sync.ts";

async function fixture() {
  const demo = createDemo(3), owner = demoId(1000), config = parseWebsiteNotionConfig({ schemaVersion: 2, sources: [{ ...demo.config.sources[0] }] });
  const counts = { bodies: 0, pages: 0, schema: 0 };
  const client: NotionReadClient = {
    getPage: async id => { counts.pages++; return structuredClone(demo.pages.get(id) ?? null); },
    getDataSource: async id => { counts.schema++; return structuredClone(demo.schemas.get(id)!); },
    getBlock: async () => null,
    listBlocks: async id => { counts.bodies++; return structuredClone(demo.blocks.get(id) ?? []); },
    listPages: async () => assert.fail("Withdrawal must not enumerate source rows"),
  };
  const ticket = { operationId: "unused", sourceKey: "status", pageKey: owner, generation: 1, reasons: ["reconcile" as const] };
  const state = { publicationRevision: "revision-1", configDigest: configDigest(config), schemaDigest: WEBSITE_SCHEMA_DIGEST, policyEpoch: "epoch" };
  const prepareImage = async () => { assert.fail("No image operation is needed"); };
  const record = await prepareSinglePage({ client, config, ticket, signal: new AbortController().signal,
    expectedConfigDigest: state.configDigest, ordinal: 0, prepareImage });
  assert.equal(record.outcome, "ready"); if (record.outcome !== "ready") assert.fail();
  const published: PublishedPage = { record: record.record, media: record.media, ...state, readerVerified: true };
  counts.bodies = counts.pages = counts.schema = 0;
  const options: PageWithdrawalOptions = { client, config, ticket, state, published, signal: new AbortController().signal };
  return { demo, owner, counts, client, config, published, options, prepareImage };
}

test("a currently archived published page yields one confirmed withdrawal without body or media reads", async () => {
  const s = await fixture(); s.demo.pages.get(s.owner)!.is_archived = true;
  assert.deepEqual(await preparePublishedWithdrawal(s.options), { outcome: "confirmed", withdrawal: { id: s.owner, sourceKey: "status", reason: "archived" } });
  assert.deepEqual(s.counts, { bodies: 0, pages: 2, schema: 1 });
});

test("positive physical movement out of a direct source is confirmed, while a legacy database parent is ambiguous", async () => {
  const s = await fixture(); s.demo.pages.get(s.owner)!.parent = { type: "data_source_id", data_source_id: demoId(91), database_id: demoId(92) };
  assert.equal((await preparePublishedWithdrawal(s.options)).outcome, "confirmed");
  s.demo.pages.get(s.owner)!.parent = { type: "database_id", database_id: demoId(92) };
  assert.deepEqual(await preparePublishedWithdrawal(s.options), { outcome: "review", code: "SOURCE_SCOPE_UNKNOWN" });
  assert.equal(s.counts.bodies, 0);
});

test("an unavailable or still-active source page never becomes deletion evidence", async () => {
  const s = await fixture();
  assert.deepEqual(await preparePublishedWithdrawal(s.options), { outcome: "review", code: "SOURCE_SCOPE_UNKNOWN" });
  s.demo.pages.delete(s.owner);
  assert.deepEqual(await preparePublishedWithdrawal(s.options), { outcome: "review", code: "SOURCE_SCOPE_UNKNOWN" });
  assert.equal(s.counts.bodies, 0);
});

test("published source identity, version and reader verification are required before source reads", async () => {
  const s = await fixture(); s.demo.pages.get(s.owner)!.archived = true;
  for (const previous of [{ ...s.published, publicationRevision: "older" }, { ...s.published, readerVerified: false }]) {
    assert.equal((await preparePublishedWithdrawal({ ...s.options, published: previous as PublishedPage })).outcome, "retry");
  }
  const wrong = structuredClone(s.published); wrong.record.evidence.sourceKey = "another";
  assert.equal((await preparePublishedWithdrawal({ ...s.options, published: wrong })).outcome, "review");
  assert.deepEqual(s.counts, { bodies: 0, pages: 0, schema: 0 });
});

test("schema failure and central denial do not authorize an ordinary source withdrawal", async () => {
  const s = await fixture(); s.demo.pages.get(s.owner)!.archived = true;
  assert.deepEqual(await preparePublishedWithdrawal({ ...s.options, deniedPageIds: new Set([s.owner]) }), { outcome: "review", code: "POLICY_RECONCILIATION_REQUIRED" });
  const sourceId = s.config.sources[0].dataSourceId!; s.demo.schemas.get(sourceId)!.properties = {};
  assert.deepEqual(await preparePublishedWithdrawal(s.options), { outcome: "review", code: "SOURCE_SCHEMA_UNCONFIRMED" });
  assert.equal(s.counts.pages, 0);
});

test("restoration or movement during confirmation defers the withdrawal", async () => {
  const s = await fixture(); const page = s.demo.pages.get(s.owner)!; page.in_trash = true;
  const getPage = s.client.getPage; let reads = 0;
  s.client.getPage = async id => { if (++reads === 2) page.in_trash = false; return getPage(id); };
  assert.deepEqual(await preparePublishedWithdrawal(s.options), { outcome: "retry", code: "SOURCE_CHANGED_DURING_PREPARATION" });
  assert.equal(s.counts.bodies, 0);
});

test("learning withdrawal is routed to its dependency domain and cancellation stops before source reads", async () => {
  const s = await fixture(); s.config.sources[0].kind = "course";
  const options = { ...s.options, state: { ...s.options.state, configDigest: configDigest(s.config) } };
  assert.deepEqual(await preparePublishedWithdrawal(options), { outcome: "review", code: "DEPENDENCY_WITHDRAWAL_REQUIRED" });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(preparePublishedWithdrawal({ ...options, signal: controller.signal }), /CANCELLED/);
  assert.deepEqual(s.counts, { bodies: 0, pages: 0, schema: 0 });
});

test("the ordinary preparation port builds only a verified withdrawal and does not guess from a missing row", async () => {
  const s = await fixture(); s.demo.pages.get(s.owner)!.archived = true; let deltas = 0;
  const prepare = createSinglePagePreparationPort({ client: s.client, config: s.config, placement: async () => ({ ordinal: 0 }),
    prepareImage: s.prepareImage, readPublished: async () => s.published,
    prepareDelta: input => { deltas++; assert.deepEqual(input.upserts, []); assert.deepEqual(input.media, []);
      assert.deepEqual(input.withdrawals, [{ id: s.owner, sourceKey: "status", reason: "archived" }]);
      return { ...input, payloadDigest: "b".repeat(64) };
    } });
  assert.equal((await prepare(s.options.ticket, s.options.state, s.options.signal)).outcome, "prepared");
  assert.equal(s.counts.bodies, 0); s.demo.pages.delete(s.owner);
  assert.equal((await prepare(s.options.ticket, s.options.state, s.options.signal)).outcome, "review");
  assert.equal(deltas, 1);
});
