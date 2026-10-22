import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SqlExecutor } from "../src/server/database/sql.ts";
import { CycleCloudSession, emptyUploadCost, parseUploadCost } from "../scripts/social-sync/cycle-cloud.ts";
import { config, hash, publicationKey, SocialSyncError } from "../scripts/social-sync/model.ts";
import { observation } from "../scripts/social-sync/bilibili.ts";
import { collectionKey } from "../scripts/social-sync/collection.ts";
import { collectionMemberShas } from "../scripts/social-sync/refresh.ts";
import { openStore } from "../scripts/social-sync/store.ts";
import { openCollectionStore } from "../scripts/social-sync/collection-store.ts";
import { executeAtRoot } from "../scripts/social-sync/execute-cli.ts";
import { exampleCollectionSnapshot } from "./helpers/social-collection-samples.ts";

const raw = "SOCIAL_DATABASE_URL=postgresql://nb_social_worker:example@localhost/example\nDATABASE_TLS=disable\n";
const scopeDigest = "a".repeat(64), checkScope = async () => {};
const target = (n = 1) => config({ version: 1, publications: [{ platform: "bilibili", accountId: "10001", workId: `example-session-${n}`,
  url: `https://www.bilibili.com/video/BV${String(n).padStart(10,"0")}/` }] })[0]!;
function publication(n = 1, at = new Date().toISOString()) {
  const t = target(n), row = observation(`<script>window.__INITIAL_STATE__=${JSON.stringify({ videoData: {
    bvid: t.publicationId, owner: { mid: 10001 }, title: "Example", stat: { like: 0 } } })};</script>`, t, at);
  return { key: publicationKey(row), sha256: hash(JSON.stringify(row)), observation: row };
}
function collection(at = new Date().toISOString()) {
  const snapshot = exampleCollectionSnapshot(at);
  return { key: collectionKey(snapshot.target), sha256: hash(JSON.stringify(snapshot)), snapshot };
}
const error = (code: string) => (e: unknown) => e instanceof SocialSyncError && e.code === code;
function harness(signal?: AbortSignal) {
  let connects = 0, closes = 0, failed = () => {}, ticks = 0;
  const queries: string[] = [];
  const behavior = { collectionVersion: 1, publicationVersion: 1, onIngest: async () => {},
    onConnect: async () => {}, closeFails: false, wrongReceipt: false };
  const sql: SqlExecutor = { query: async <T>(text: string, values?: unknown[]) => {
    queries.push(text);
    if (text.includes("current_user")) return { rows: [{ role: "nb_social_worker", login: "nb_social_worker", elevated: false,
      version: text.includes("collection_meta") ? behavior.collectionVersion : behavior.publicationVersion }] as T[] };
    assert(text.includes("social_sync.ingest")); await behavior.onIngest();
    return { rows: [{ key: values![0], sha256: behavior.wrongReceipt ? "0".repeat(64) : values![1] }] as T[] };
  } };
  const session = new CycleCloudSession(signal, { now: () => ++ticks, connect: async (_raw, onError) => {
    connects++; failed = onError; await behavior.onConnect();
    return { sql, close: async () => { closes++; if (behavior.closeFails) throw Error("private driver message"); } };
  } });
  return { session, behavior, queries, connects: () => connects, closes: () => closes, fatal: () => failed() };
}
async function fixture(t: { after: (f: () => Promise<void>) => void }, count = 1) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nb-cycle-cloud-"))); await chmod(root, 0o700);
  const pubs = (await openStore(root))!, cols = (await openCollectionStore(root))!, at = new Date().toISOString();
  t.after(async () => { pubs.close(); cols.close(); await rm(root, { recursive: true, force: true }); });
  const publications = Array.from({ length: count }, (_, i) => publication(i + 1, at)), col = collection(at);
  for (const p of publications) pubs.ingest(p.observation); cols.ingest(col.snapshot);
  const scope = { version: 1, reviewedAt: at, cadence: { bilibiliHours: 6, xiaohongshuHours: 24 },
    stateDirectories: { publications: root, collections: root }, publications: publications.map(p => ({ target: target(Number(p.observation.publicationId.slice(2))), kind: "video" })),
    collections: [{ target: col.snapshot.target, memberShas: collectionMemberShas(col.snapshot) }] };
  await writeFile(join(root, "refresh-config.json"), JSON.stringify(scope), { mode: 0o600 });
  await writeFile(join(root, "cloud.env"), raw, { mode: 0o600 });
  return { root, pubs, cols, publications, col, scope };
}

test("an unused or already-cancelled cycle never creates a connection, and close is idempotent", async () => {
  const f = harness(); await f.session.close(); await f.session.close();
  assert.equal(f.connects(), 0); assert.equal(f.closes(), 0); assert.deepEqual(f.session.cost, emptyUploadCost());
  const controller = new AbortController(); controller.abort(); const cancelled = harness(controller.signal);
  await assert.rejects(cancelled.session.sendPublication(raw, scopeDigest, publication(), undefined, checkScope), error("CANCELLED"));
  await cancelled.session.close(); assert.equal(cancelled.connects(), 0);
});
test("video and collection protocols are both checked once on the same connection across batches", async t => {
  const f = await fixture(t, 21), h = harness(), keys = [...f.publications.map(p => p.key), f.col.key].sort();
  const options = { platform: "bilibili" as const, limit: 20, uploadOnly: true, cloudSession: h.session };
  const first = await executeAtRoot(f.root, { ...options, keys: keys.slice(0, 20) });
  const second = await executeAtRoot(f.root, { ...options, keys: keys.slice(20) });
  assert("uploaded" in first && "uploaded" in second); assert.equal(first.uploaded + second.uploaded, 22);
  assert.equal(h.connects(), 1); assert.equal(h.closes(), 0); assert.equal(h.session.closed, false);
  assert.equal(h.queries.filter(q => q.includes("current_user")).length, 2);
  assert.equal(h.session.cost.publicationHandshakes, 1); assert.equal(h.session.cost.collectionHandshakes, 1);
  assert.equal(h.session.cost.ingestAttempts, 22); assert.equal(h.session.cost.receipts, 22);
  assert.equal(f.pubs.status().pending, 0); assert.equal(f.cols.status().pending, 0);
  await assert.rejects(stat(join(f.root, "worker.lock")), { code: "ENOENT" });
  await h.session.close(); await h.session.close(); assert.equal(h.closes(), 1);
});
test("a failed protocol check stops ingest and never reconnects inside the cycle", async () => {
  const f = harness(); await f.session.sendPublication(raw, scopeDigest, publication(), undefined, checkScope);
  f.behavior.collectionVersion = 2;
  await assert.rejects(f.session.sendCollection(raw, scopeDigest, collection(), undefined, checkScope), error("CLOUD_HANDSHAKE_INVALID"));
  await assert.rejects(f.session.sendPublication(raw, scopeDigest, publication(), undefined, checkScope), error("CLOUD_SESSION_FAILED"));
  assert.equal(f.connects(), 1); assert.equal(f.session.cost.ingestAttempts, 1);
  assert.equal(f.session.cost.collectionHandshakes, 0); await f.session.close(); assert.equal(f.closes(), 1);
});
test("scope or credential changes between batches block the old session before a second ingest", async t => {
  for (const change of ["scope", "credentials"]) await t.test(change, async () => {
    const f = harness(); await f.session.sendPublication(raw, scopeDigest, publication(), undefined, checkScope);
    await assert.rejects(f.session.sendPublication(change === "credentials" ? raw.replace("example@", "changed@") : raw,
      change === "scope" ? "b".repeat(64) : scopeDigest, publication(), undefined, checkScope), error("CLOUD_SESSION_INPUT_CHANGED"));
    assert.equal(f.connects(), 1); assert.equal(f.session.cost.ingestAttempts, 1); await f.session.close();
  });
});
test("a scope change during connection setup is rechecked before ingest", async () => {
  const f = harness();
  await assert.rejects(f.session.sendPublication(raw, scopeDigest, publication(), undefined,
    async () => { throw new SocialSyncError("REFRESH_SCOPE_CHANGED"); }), error("REFRESH_SCOPE_CHANGED"));
  assert.equal(f.connects(), 1); assert.equal(f.session.cost.ingestAttempts, 0); await f.session.close();
});
test("batch cancellation after a committed receipt keeps either payload pending", async t => {
  for (const kind of ["publication", "collection"] as const) await t.test(kind, async st => {
    const f = await fixture(st), h = harness(), controller = new AbortController();
    h.behavior.onIngest = async () => { controller.abort(); };
    const report = await executeAtRoot(f.root, { platform: "bilibili", limit: 1, uploadOnly: true, cloudSession: h.session,
      keys: [kind === "publication" ? f.publications[0]!.key : f.col.key], signal: controller.signal });
    assert("uploaded" in report); assert.equal(report.uploaded, 0); assert.equal(report.cancelled, true);
    assert.equal(report.entries[0]!.code, "CANCELLED"); assert.equal(h.session.cost.receipts, 0);
    assert.equal(kind === "publication" ? f.pubs.status().pending : f.cols.status().pending, 1);
    await h.session.close(); assert.equal(h.closes(), 1);
  });
});
test("a lost response or mismatched receipt leaves pending and prevents another ingest", async t => {
  for (const mode of ["lost", "wrong"] as const) await t.test(mode, async st => {
    const f = await fixture(st), h = harness();
    if (mode === "lost") h.behavior.onIngest = async () => { throw Error("committed, private network detail"); };
    else h.behavior.wrongReceipt = true;
    const result = await executeAtRoot(f.root, { platform: "bilibili", limit: 1, uploadOnly: true, keys: [f.publications[0]!.key], cloudSession: h.session });
    assert("uploaded" in result); assert.equal(result.uploaded, 0); assert.equal(result.paused, true);
    assert.equal(f.pubs.status().pending, 1); assert.equal(h.session.cost.receipts, 0);
    assert.equal(result.entries[0]!.code, mode === "lost" ? "CLOUD_UPLOAD_FAILED" : "ACK_MISMATCH");
    await assert.rejects(h.session.sendPublication(raw, scopeDigest, publication(), undefined, checkScope), error("CLOUD_SESSION_FAILED"));
    assert.equal(h.session.cost.ingestAttempts, 1); await h.session.close();
  });
});
test("a checked-out client error between batches stops reuse instead of silently reconnecting", async () => {
  const f = harness(); await f.session.sendPublication(raw, scopeDigest, publication(), undefined, checkScope); f.fatal();
  await assert.rejects(f.session.sendCollection(raw, scopeDigest, collection(), undefined, checkScope), error("CLOUD_SESSION_FAILED"));
  assert.equal(f.connects(), 1); assert.equal(f.session.cost.ingestAttempts, 1); await f.session.close();
});
test("closing during an in-flight statement waits, rejects a late receipt and releases once", async () => {
  const f = harness(); let resolve!: () => void, entered!: () => void;
  const ready = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { resolve = r; });
  f.behavior.onIngest = async () => { entered(); await gate; };
  const sending = f.session.sendPublication(raw, scopeDigest, publication(), undefined, checkScope); await ready;
  await assert.rejects(f.session.sendCollection(raw, scopeDigest, collection(), undefined, checkScope), error("CLOUD_SESSION_BUSY"));
  const closing = f.session.close(); assert.equal(f.closes(), 0); resolve();
  await assert.rejects(sending, error("CLOUD_SESSION_CLOSED")); await closing; await f.session.close();
  assert.equal(f.closes(), 1); assert.equal(f.session.cost.receipts, 0);
});
test("failed connection setup does not retry and failed cleanup exposes only a safe code", async () => {
  const f = harness(); f.behavior.onConnect = async () => { throw Error("private password"); };
  await assert.rejects(f.session.sendPublication(raw, scopeDigest, publication(), undefined, checkScope), error("CLOUD_UNAVAILABLE"));
  await assert.rejects(f.session.sendPublication(raw, scopeDigest, publication(), undefined, checkScope), error("CLOUD_SESSION_FAILED"));
  assert.equal(f.session.cost.connectionAttempts, 1); assert.equal(f.session.cost.connections, 0); await f.session.close();
  const c = harness(); await c.session.sendPublication(raw, scopeDigest, publication(), undefined, checkScope); c.behavior.closeFails = true;
  await assert.rejects(c.session.close(), error("CLOUD_CLOSE_FAILED")); assert.equal(c.session.closed, true); assert.equal(c.closes(), 1);
});
test("upload metrics pick only bounded aggregate fields and reject impossible or corrupt counters", () => {
  assert.deepEqual(parseUploadCost({ ...emptyUploadCost(), secret: "private" }), emptyUploadCost());
  for (const patch of [{ connections: 1 }, { receipts: 1 }, { connectionAttempts: -1 }, { ingestAttempts: 1.5 },
    { connectMs: Infinity }, { handshakeAttempts: "2" }]) assert.throws(() => parseUploadCost({ ...emptyUploadCost(), ...patch }), error("BILIBILI_HEALTH_INVALID"));
});
