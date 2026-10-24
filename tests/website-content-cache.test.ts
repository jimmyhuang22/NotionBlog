import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, chmod, stat, symlink, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { WebsiteRecord } from "../contracts/website-sync.ts";
import type { StoredMedia } from "../contracts/sync.ts";
import { preparePublicationDelta } from "../src/server/database/incremental-publication.ts";
import { canonicalJson } from "../src/server/database/website-validation.ts";
import { ContentCacheStore, ContentCacheError, openContentCache, type ContentCacheBaseline } from "../scripts/website-incremental-sync/content-cache.ts";
import { withContentCache } from "../scripts/website-incremental-sync/content-cache-ports.ts";
import { openIncrementalQueue } from "../scripts/website-incremental-sync/queue.ts";
import { runIncrementalCycle, type IncrementalPorts } from "../scripts/website-incremental-sync/executor.ts";
import { studyId } from "./helpers/study-runtime.ts";
import { cacheFixture, cacheProof } from "./helpers/content-cache.ts";

const error = (code: string) => (e: unknown) => e instanceof ContentCacheError && e.code === code;
function memory(t: TestContext, image = false) {
  const f = cacheFixture(image), db = new DatabaseSync(":memory:"), store = new ContentCacheStore(db, f.state.configDigest, f.sourceKeys);
  t.after(() => store.close()); return { ...f, db, store, init: () => store.initialize(f.baseline, cacheProof(f.baseline)) };
}
function delta(s: ReturnType<typeof cacheFixture>, records = [s.ordinary], media: StoredMedia[] = []) {
  return preparePublicationDelta({ expectedRevision: s.state.publicationRevision, configDigest: s.state.configDigest, upserts: records, media, withdrawals: [] });
}

test("complete baseline requires exact independent version, counts and content digest", t => {
  const s = memory(t), proof = cacheProof(s.baseline);
  for (const patch of [{ complete: false }, { readerVerified: false }, { records: 3 }, { media: 1 }, { contentDigest: "d".repeat(64) }, { policyEpoch: "1" }, { publicationRevision: `${randomUUID()}:9` }]) {
    assert.throws(() => s.store.initialize(s.baseline, { ...proof, ...patch } as unknown as typeof proof), error("CONTENT_CACHE_READER_UNVERIFIED"));
    assert.throws(() => s.store.assertState(s.state), error("CONTENT_CACHE_BASELINE_MISSING"));
  }
  s.init(); assert.deepEqual(s.store.readPublished({ sourceKey: "status", pageKey: studyId(20) }, s.state)!.record, s.ordinary);
  assert.throws(s.init, error("CONTENT_CACHE_ALREADY_INITIALIZED"));
});

test("invalid, duplicate, foreign or media-incomplete baselines cannot partly initialize", t => {
  const s = memory(t, true);
  for (const mutate of [(b: ContentCacheBaseline) => b.records.push(b.records[0]), (b: ContentCacheBaseline) => b.records[0].evidence.sourceKey = "foreign",
    (b: ContentCacheBaseline) => b.records[0].detail.document = null, (b: ContentCacheBaseline) => b.media = []]) {
    const b = structuredClone(s.baseline); mutate(b); assert.throws(() => s.store.initialize(b, cacheProof(b)));
    assert.throws(() => s.store.assertState(s.state), error("CONTENT_CACHE_BASELINE_MISSING"));
  }
  s.init();
});

test("qualified placement and known-page catalog never invent a new directory position", t => {
  const s = memory(t); s.init(); const ticket = { sourceKey: "status", pageKey: studyId(20) };
  assert.deepEqual(s.store.placement(ticket, s.state), { ordinal: 3 });
  assert.deepEqual(s.store.knownPages("notes", s.state).pageKeys, [studyId(2)]);
  assert.equal(s.store.readPublished({ ...ticket, pageKey: studyId(99) }, s.state), null);
  assert.throws(() => s.store.placement({ ...ticket, pageKey: studyId(99) }, s.state), error("CONTENT_CACHE_NEW_PLACEMENT_REQUIRED"));
  assert.deepEqual(s.store.placement({ ...ticket, pageKey: studyId(99) }, s.state, 5), { ordinal: 5 });
  for (const patch of [{ policyEpoch: "1" }, { publicationRevision: `${randomUUID()}:1` }]) assert.throws(() => s.store.knownPages("status", { ...s.state, ...patch }), error("CONTENT_CACHE_VERSION_CHANGED"));
  assert.throws(() => s.store.readPublished({ ...ticket, sourceKey: "notes" }, s.state), error("CONTENT_CACHE_SOURCE_MISMATCH"));
});

test("learning rename and withdrawal rewrite only affected cached ordinary links", t => {
  const s = memory(t); s.init(); const href = s.checkpoint.entries[1].record.detail.item.href, next = { href: `/study/${studyId(1)}/notes/renamed`, title: "Renamed" };
  const result = s.store.incomingLinks([{ previous: href, current: next }], s.state);
  assert.equal(result.records.length, 1); assert.equal(result.records[0].detail.item.id, studyId(20));
  const blocks = result.records[0].detail.document!.blocks;
  assert.equal(blocks[0].type, "paragraph"); if (blocks[0].type === "paragraph") assert.deepEqual(blocks[0].text[0].link, { kind: "internal", href: next.href });
  assert.equal(blocks[1].type, "child-page"); if (blocks[1].type === "child-page") { assert.deepEqual(blocks[1].target, next); assert.equal(blocks[1].title, next.title); }
  assert.deepEqual(s.store.readPublished({ sourceKey: "status", pageKey: studyId(20) }, s.state)!.record, s.ordinary);
  const withdrawn = s.store.incomingLinks([{ previous: href, current: null }], s.state).records[0].detail.document!.blocks;
  if (withdrawn[0].type === "paragraph") assert.deepEqual(withdrawn[0].text[0].link, { kind: "unavailable" });
  if (withdrawn[1].type === "child-page") { assert.equal(withdrawn[1].target, null); assert.equal(withdrawn[1].title, "Unavailable page"); }
  const repaired = s.store.incomingLinks([{ previous: href, current: { href, title: s.checkpoint.entries[1].record.detail.item.title } }], s.state).records;
  assert.equal(repaired.length, 1); // The fixture has a stale outer title even before a rename.
  const repairedChild = repaired[0].detail.document!.blocks[1];
  if (repairedChild.type === "child-page") assert.equal(repairedChild.title, s.checkpoint.entries[1].record.detail.item.title);
  assert.throws(() => s.store.incomingLinks([{ previous: href, current: { href: "https://example.test/", title: "Other" } }], s.state), error("CONTENT_CACHE_LINK_CHANGES_INVALID"));
});

test("cached asset reuse checks owner and dimensions without any image transport", t => {
  const s = memory(t, true); s.init(); assert.deepEqual(s.store.assets([s.ordinary], s.state).media, s.baseline.media);
  const wrong = structuredClone(s.ordinary); wrong.detail.item.cover!.width = 41;
  assert.throws(() => s.store.assets([wrong], s.state), error("CONTENT_CACHE_MEDIA_MISMATCH"));
  wrong.detail.item.cover!.id = `a1.${"e".repeat(64)}`; wrong.detail.item.cover!.src = `/media/v2/${wrong.detail.item.cover!.id}`;
  assert.throws(() => s.store.assets([wrong], s.state), error("CONTENT_CACHE_MEDIA_PENDING"));
});

test("publication advances cached version only after exact reader proof and prunes removed media", t => {
  const s = memory(t, true); s.init(); const changed = structuredClone(s.ordinary); changed.detail.item.cover = null; changed.detail.document!.blocks = [];
  const prepared = delta(s, [changed]), id = randomUUID(); s.store.stage(id, prepared, s.state);
  const proof = { ...s.state, publicationRevision: `${id}:1`, operationId: id, payloadDigest: prepared.payloadDigest, readerVerified: true as const };
  assert.throws(() => s.store.install({ ...proof, readerVerified: false } as unknown as typeof proof), error("CONTENT_CACHE_READER_UNVERIFIED"));
  assert.throws(() => s.store.install({ ...proof, payloadDigest: "f".repeat(64) }), error("CONTENT_CACHE_OPERATION_CONFLICT"));
  assert.deepEqual(s.store.readPublished({ sourceKey: "status", pageKey: studyId(20) }, s.state)!.media, s.baseline.media);
  assert.equal(s.store.install(proof), "installed"); assert.equal(s.store.install(proof), "unchanged");
  const next = { ...s.state, publicationRevision: proof.publicationRevision };
  assert.deepEqual(s.store.readPublished({ sourceKey: "status", pageKey: studyId(20) }, next)!.media, []);
  assert.deepEqual(s.store.readPublished({ sourceKey: "status", pageKey: studyId(21) }, next)!.record, s.other);
  assert.throws(() => s.store.assertState(s.state), error("CONTENT_CACHE_VERSION_CHANGED"));
});

test("ancestor withdrawal removes cached descendants but preserves ordinary content", t => {
  const s = memory(t); s.init(); const id = randomUUID(), extra = s.store.incomingLinks([{ previous: s.checkpoint.entries[1].record.detail.item.href, current: null }], s.state);
  const prepared = preparePublicationDelta({ expectedRevision: s.state.publicationRevision, configDigest: s.state.configDigest,
    upserts: extra.records, media: [], withdrawals: [{ id: studyId(1), sourceKey: "courses", reason: "archived" }] });
  s.store.stage(id, prepared, s.state); const next = { ...s.state, publicationRevision: `${id}:1` };
  s.store.install({ ...next, operationId: id, payloadDigest: prepared.payloadDigest, readerVerified: true });
  assert.deepEqual(s.store.knownPages("notes", next).pageKeys, []); assert.deepEqual(s.store.knownPages("courses", next).pageKeys, []);
  assert.deepEqual(s.store.readPublished({ sourceKey: "status", pageKey: studyId(21) }, next)!.record, s.other);
});

test("cache corruption and conflicting operation identities do not return qualified bodies", t => {
  const s = memory(t); s.init(); const id = randomUUID(), prepared = delta(s); s.store.stage(id, prepared, s.state); s.store.stage(id, prepared, s.state);
  const changed = structuredClone(s.ordinary); changed.detail.item.title = "Different";
  assert.throws(() => s.store.stage(id, delta(s, [changed]), s.state), error("CONTENT_CACHE_OPERATION_CONFLICT"));
  s.db.prepare("UPDATE records SET digest=? WHERE id=?").run("f".repeat(64), studyId(20));
  assert.throws(() => s.store.readPublished({ sourceKey: "status", pageKey: studyId(20) }, s.state), error("CONTENT_CACHE_CORRUPT"));
});

test("private cache survives reopening and rejects different scope and unsafe files", async t => {
  const s = cacheFixture(), directory = await realpath(await mkdtemp(join(tmpdir(), "content-cache-private-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let store = await openContentCache(directory, s.state.configDigest, s.sourceKeys); store.initialize(s.baseline, cacheProof(s.baseline));
  const id = randomUUID(), prepared = delta(s); store.stage(id, prepared, s.state); store.close();
  store = await openContentCache(directory, s.state.configDigest, s.sourceKeys); assert.equal(store.ownsOperation(id, prepared.payloadDigest), true); store.close();
  await assert.rejects(openContentCache(directory, "d".repeat(64), s.sourceKeys), error("CONTENT_CACHE_SCOPE_MISMATCH"));
  await assert.rejects(openContentCache(directory, s.state.configDigest, ["status"]), error("CONTENT_CACHE_SCOPE_MISMATCH"));
  assert.equal((await stat(join(directory, "content.sqlite"))).mode & 0o777, 0o600);
  await chmod(join(directory, "content.sqlite"), 0o644);
  await assert.rejects(openContentCache(directory, s.state.configDigest, s.sourceKeys), error("CONTENT_CACHE_PRIVATE_STATE_INVALID"));
  await chmod(join(directory, "content.sqlite"), 0o600); await link(join(directory, "content.sqlite"), join(directory, "other.sqlite"));
  await assert.rejects(openContentCache(directory, s.state.configDigest, s.sourceKeys), error("CONTENT_CACHE_PRIVATE_STATE_INVALID"));
  await rm(join(directory, "other.sqlite")); await symlink(join(directory, "content.sqlite"), join(directory, "content.sqlite-wal"));
  await assert.rejects(openContentCache(directory, s.state.configDigest, s.sourceKeys), error("CONTENT_CACHE_PRIVATE_STATE_INVALID"));
});

test("cancelled staged cache is retired from the durable queue proof before another preparation", async t => {
  const s = memory(t); s.init(); const directory = await realpath(await mkdtemp(join(tmpdir(), "cache-cancel-"))), queue = await openIncrementalQueue(directory, { digest: s.state.configDigest, sourceKeys: s.sourceKeys });
  t.after(async () => { queue.close(); await rm(directory, { recursive: true, force: true }); });
  queue.enqueue([{ eventId: "one", sourceKey: "status", pageKey: studyId(20), reason: "content", observedAt: 1 }]);
  const controller = new AbortController(), prepared = delta(s); let retired = 0;
  const base: IncrementalPorts<typeof prepared> & Required<Pick<IncrementalPorts<typeof prepared>, "finalize" | "retire">> = {
    state: async () => s.state, prepare: async () => ({ outcome: "prepared", delta: prepared }), submit: async () => assert.fail("Cancelled cache cannot send"),
    lookup: async () => assert.fail(), verify: async () => assert.fail(), finalize: async () => assert.fail(), retire: async () => { retired++; },
  };
  const ports = withContentCache({ store: s.store, ports: base, queue, readVerifiedState: async () => assert.fail() }), original = s.store.stage.bind(s.store);
  s.store.stage = (...args) => { original(...args); controller.abort(); };
  const result = await runIncrementalCycle({ queue, schemaDigest: s.state.schemaDigest, signal: controller.signal }, ports);
  assert.equal(result.cancelled, true); const [proof] = queue.pendingRetirements(); assert.equal(proof.disposition, "never_submitted");
  await ports.retire!(proof, new AbortController().signal); await ports.retire!(proof, new AbortController().signal); assert.equal(retired, 2);
  assert.equal(s.store.ownsOperation(proof.ticket.operationId, prepared.payloadDigest), false);
  await assert.rejects(ports.retire!({ ...proof, ticket: { ...proof.ticket, generation: proof.ticket.generation + 1 } }, new AbortController().signal), error("CONTENT_CACHE_TERMINAL_UNCONFIRMED"));
});

test("incoming-link cache refuses a dependency batch exceeding SQL limits before emitting partial results", t => {
  const s = memory(t), b = structuredClone(s.baseline);
  for (let n = 0; n < 100; n++) { const r = structuredClone(s.ordinary); const id = studyId(100 + n); Object.assign(r.detail.item, { id, slug: id, href: `/status#${id}` }); b.records.push(r); }
  s.store.initialize(b, cacheProof(b));
  assert.throws(() => s.store.incomingLinks([{ previous: s.checkpoint.entries[1].record.detail.item.href, current: null }], s.state), error("CONTENT_CACHE_BUDGET_REACHED"));
  assert.equal(canonicalJson(s.store.readPublished({ sourceKey: "status", pageKey: studyId(20) }, s.state)!.record), canonicalJson(s.ordinary));
});

test("writer receipt alone and a different independent-reader version cannot finalize the cache", async t => {
  const s = memory(t); s.init(); const prepared = delta(s), id = randomUUID(); s.store.stage(id, prepared, s.state);
  const receipt = { operationId: id, payloadDigest: prepared.payloadDigest, publicationRevision: `${id}:1`, committed: true as const };
  let readerChecks = 0, finalized = 0, independentlyVerified = false, currentVersion = s.state.publicationRevision;
  const base: IncrementalPorts<typeof prepared> & Required<Pick<IncrementalPorts<typeof prepared>, "finalize" | "retire">> = {
    state: async () => s.state, prepare: async () => assert.fail(), submit: async () => assert.fail(), lookup: async () => receipt,
    verify: async () => independentlyVerified, finalize: async () => { finalized++; }, retire: async () => assert.fail(),
  };
  const ports = withContentCache({ store: s.store, ports: base, queue: { assertPreparing: () => assert.fail(), attemptClosure: () => null },
    readVerifiedState: async () => { readerChecks++; return { ...s.state, publicationRevision: currentVersion }; } });
  const signal = new AbortController().signal;
  assert.equal(await ports.verify(receipt, signal), false); assert.equal(readerChecks, 0);
  independentlyVerified = true; assert.equal(await ports.verify(receipt, signal), false);
  await assert.rejects(ports.finalize!(receipt, signal), error("CONTENT_CACHE_READER_UNVERIFIED")); assert.equal(finalized, 0); s.store.assertState(s.state);
  currentVersion = receipt.publicationRevision; assert.equal(await ports.verify(receipt, signal), true);
  await ports.finalize!(receipt, signal); assert.equal(finalized, 1); s.store.assertState({ ...s.state, publicationRevision: currentVersion });
});

test("unknown submitted cache cannot be retired using a forged never-sent proof", async t => {
  const s = memory(t); s.init(); const directory = await realpath(await mkdtemp(join(tmpdir(), "cache-unknown-"))), queue = await openIncrementalQueue(directory, { digest: s.state.configDigest, sourceKeys: s.sourceKeys });
  t.after(async () => { queue.close(); await rm(directory, { recursive: true, force: true }); });
  queue.enqueue([{ eventId: "one", sourceKey: "status", pageKey: studyId(20), reason: "content", observedAt: 1 }]);
  const [ticket] = queue.claim(), prepared = delta(s); s.store.stage(ticket.operationId, prepared, s.state); queue.markSubmitting(ticket, prepared);
  const base: IncrementalPorts<typeof prepared> & Required<Pick<IncrementalPorts<typeof prepared>, "finalize" | "retire">> = {
    state: async () => s.state, prepare: async () => assert.fail(), submit: async () => assert.fail(), lookup: async () => null,
    verify: async () => false, finalize: async () => assert.fail(), retire: async () => assert.fail("Unknown operation cannot retire any domain"),
  };
  const ports = withContentCache({ store: s.store, ports: base, queue, readVerifiedState: async () => assert.fail() });
  await assert.rejects(ports.retire!({ ticket, disposition: "never_submitted", payloadDigest: null }, new AbortController().signal), error("CONTENT_CACHE_TERMINAL_UNCONFIRMED"));
  assert.equal(s.store.ownsOperation(ticket.operationId, prepared.payloadDigest), true); assert.equal(queue.status().awaiting_verification, 1);
});
