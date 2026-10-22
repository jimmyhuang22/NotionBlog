import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { config, hash, noteCount, noteUrl, SocialSyncError, validateObservation } from "../scripts/social-sync/model.ts";
import type { Observation } from "../scripts/social-sync/model.ts";
import { browserCaptureScript, MAX_SNAPSHOT_AGE_MS, MAX_SNAPSHOT_BYTES, snapshotBatch, snapshotObservation } from "../scripts/social-sync/xiaohongshu.ts";
import { observation } from "../scripts/social-sync/bilibili.ts";
import { openStore } from "../scripts/social-sync/store.ts";
import { collectTargets } from "../scripts/social-sync/worker.ts";

const input = { version: 1, publications: [{ platform: "xiaohongshu", workId: "example-work", accountId: "000000000000000000000001", url: "https://www.xiaohongshu.com/explore/000000000000000000000002" }] };
const target = config(input)[0], at = "2026-01-02T03:04:05.000Z";
const cli = fileURLToPath(new URL("../scripts/social-sync/cli.ts", import.meta.url));
function snapshot(observedAt = at) {
  return { version: 1, source: "browser-note-state", observedAt, pageUrl: target.url,
    note: { noteId: target.publicationId, userId: target.accountId, type: "normal", title: "虚构测试笔记 🧪", time: 1700000000000,
      lastUpdateTime: 1700001000000, coverUrl: "http://sns-webpic-qc.xhscdn.com/example.webp",
      interactInfo: { likedCount: "0", commentCount: "2", shareCount: "3", collectedCount: "4" } } };
}
const error = (code: string) => (e: unknown) => e instanceof SocialSyncError && e.code === code;
async function directory(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "nb-xhs-test-"))); await chmod(dir, 0o700);
  t.after(() => rm(dir, { recursive: true, force: true })); return dir;
}
function batch(...snapshots: unknown[]) { return JSON.stringify({ version: 1, snapshots }); }

test("mixed social configuration can bind two platforms to one work without leaking query tokens", () => {
  const bili = { platform: "bilibili", workId: target.workId, accountId: "10001", url: "https://www.bilibili.com/video/BV0000000001/" };
  const targets = config({ ...input, publications: [{ ...input.publications[0], url: target.url + "?xsec_token=example#tracking" }, bili] });
  assert.equal(targets.length, 2); assert.equal(targets[0].url, target.url); assert.equal(targets[0].workId, targets[1].workId);
  for (const url of [target.url.replace("www.xiaohongshu", "evil.xiaohongshu"), target.url.replace("https:", "http:"),
    target.url.replace("www.", "user@www."), target.url.replace(".com/", ".com:444/"), "https://xhslink.com/example", target.url.replace("explore", "discovery/item")]) {
    assert.throws(() => noteUrl(url), error("INVALID_URL"));
  }
  assert.throws(() => config({ ...input, publications: [{ ...input.publications[0], accountId: "10001" }] }), error("INVALID_IDENTITY"));
});
test("Xiaohongshu rounded counters stay unknown while display text and exact zero survive", () => {
  for (const display of ["1.2万", "10万+", "2k", "999+"]) assert.deepEqual(noteCount(display), { exact: null, display });
  assert.deepEqual(noteCount("0"), { exact: 0, display: "0" }); assert.deepEqual(noteCount(null), { exact: null, display: null });
  for (const bad of [-1, 1.5, true, "1.5", "private data", "9007199254740992"]) assert.throws(() => noteCount(bad), error("INVALID_COUNT"));
  const s = snapshot(); s.note.interactInfo.likedCount = "1.2万";
  const row = snapshotObservation(s, target, at); assert.equal(row.metrics.likes, null); assert.equal(row.metricDisplay.likes, "1.2万");
});
test("note observation preserves type, publication/update times and individual scope with unsupported counters null", () => {
  const row = snapshotObservation(snapshot(), target, at);
  assert.equal(row.kind, "image-note"); assert.equal(row.metricsScope, "individual-note");
  assert.equal(row.metrics.likes, 0); assert.equal(row.metrics.comments, 2); assert.equal(row.metrics.shares, 3);
  assert.equal(row.publishedAt, new Date(1700000000000).toISOString()); assert.equal(row.updatedAt, new Date(1700001000000).toISOString());
  assert.equal(row.metrics.views, null); assert.equal(row.metrics.coins, null); assert.equal(row.metrics.danmaku, null);
  assert.equal(row.description, null); assert.equal(row.collection, null); assert.equal(row.websitePublicationApproved, false);
  const s = snapshot(); s.note.type = "video"; assert.equal(snapshotObservation(s, target, at).kind, "video");
  s.note.type = "live"; assert.throws(() => snapshotObservation(s, target, at), error("NOTE_TYPE_UNSUPPORTED"));
});
test("note identity binds the current URL, requested note and author instead of accepting a different entry", () => {
  for (const change of ["page", "note", "author"] as const) {
    const s = snapshot(), other = "000000000000000000000003";
    if (change === "page") s.pageUrl = target.url.replace(target.publicationId, other);
    if (change === "note") s.note.noteId = other;
    if (change === "author") s.note.userId = other;
    assert.throws(() => snapshotObservation(s, target, at), error("IDENTITY_MISMATCH"));
  }
  assert.throws(() => snapshotObservation(snapshot(), { ...target, publicationId: "000000000000000000000003" }, at), error("IDENTITY_MISMATCH"));
});
test("snapshot import rejects stale/future observations and never rewrites their captured time", () => {
  const s = snapshot(), row = snapshotObservation(s, target, at); assert.equal(row.observedAt, at);
  const later = new Date(Date.parse(at) + MAX_SNAPSHOT_AGE_MS + 1).toISOString();
  assert.throws(() => snapshotObservation(s, target, later), error("SNAPSHOT_EXPIRED"));
  assert.throws(() => snapshotObservation(s, target, new Date(Date.parse(at) - 30001).toISOString()), error("SNAPSHOT_EXPIRED"));
  const missing = snapshot() as unknown as Record<string, unknown>; delete missing.observedAt;
  assert.throws(() => snapshotObservation(missing, target, at), error("SNAPSHOT_INVALID"));
});
test("unknown dates/covers stay null, invalid times and foreign cover hosts fail", () => {
  const s = snapshot() as unknown as { note: Record<string, unknown> };
  s.note.time = null; s.note.lastUpdateTime = null; s.note.coverUrl = null;
  const row = snapshotObservation(s, target, at); assert.equal(row.publishedAt, null); assert.equal(row.updatedAt, null); assert.equal(row.coverUrl, null);
  s.note.time = 0; assert.throws(() => snapshotObservation(s, target, at), error("INVALID_TIME"));
  s.note.time = null; s.note.coverUrl = "https://evil.example/image.webp";
  assert.throws(() => snapshotObservation(s, target, at), error("INVALID_DATA"));
});
test("full state, comments and authentication fields cannot cross the snapshot boundary", () => {
  assert.throws(() => snapshotObservation({ ...snapshot(), cookies: "example" }, target, at), error("SNAPSHOT_INVALID"));
  const s = snapshot(); Object.assign(s.note, { comments: [{ content: "must not persist" }] });
  assert.throws(() => snapshotObservation(s, target, at), error("SNAPSHOT_INVALID"));
  const alias = snapshot(); Object.assign(alias.note.interactInfo, { sharedCount: "999" });
  assert.throws(() => snapshotObservation(alias, target, at), error("SNAPSHOT_INVALID"));
});
test("bounded raw/base64 batches have identical payload hashes and reject duplicates or unconfigured notes", () => {
  const s = snapshot(), encoded = Buffer.from(JSON.stringify(s)).toString("base64");
  const raw = snapshotBatch(batch(s), [target], at), bridged = snapshotBatch(batch(encoded), [target], at);
  assert.deepEqual(raw, bridged); assert.equal(raw[0].responseSha256, hash(JSON.stringify(s)));
  assert.throws(() => snapshotBatch(batch(s, encoded), [target], at), error("DUPLICATE_PUBLICATION"));
  assert.throws(() => snapshotBatch(batch(s), [], at), error("UNCONFIGURED_PUBLICATION"));
  assert.throws(() => snapshotBatch("x".repeat(MAX_SNAPSHOT_BYTES + 1), [target], at), error("SNAPSHOT_TOO_LARGE"));
  for (const bad of ["{", batch("not base64!"), batch("/w=="), batch(Buffer.from("{};globalThis.bad=1").toString("base64"))]) {
    assert.throws(() => snapshotBatch(bad, [target], at), error("SNAPSHOT_INVALID"));
  }
});
test("our browser snippet reads only the exact note, supports Vue refs and never touches cookies/comments", () => {
  const s = snapshot(), note = { ...s.note, user: { userId: s.note.userId }, imageList: [{ urlDefault: s.note.coverUrl }] };
  Object.defineProperty(note, "comments", { get() { throw new Error("comment access forbidden"); } });
  const document = Object.defineProperty({}, "cookie", { get() { throw new Error("cookie access forbidden"); } });
  const location = { protocol: "https:", hostname: "www.xiaohongshu.com", pathname: new URL(target.url).pathname };
  const state = { currentNoteId: { __v_isRef: true, value: target.publicationId }, noteDetailMap: { [target.publicationId]: { note } } };
  const source = browserCaptureScript([target]);
  const result = runInNewContext(source, { window: { __INITIAL_STATE__: { note: state } }, document, location, TextEncoder, btoa });
  const data = JSON.parse(Buffer.from(result.slice("SOCIAL_SYNC_SNAPSHOT ".length), "base64").toString("utf8"));
  assert.deepEqual(data.note, s.note); assert.equal(Object.keys(data).length, 5); assert.equal(data.pageUrl, target.url);
  const plain = runInNewContext(source, { window: { __INITIAL_STATE__: { note: { ...state, currentNoteId: target.publicationId } } }, location, TextEncoder, btoa });
  assert.equal(JSON.parse(Buffer.from(plain.slice("SOCIAL_SYNC_SNAPSHOT ".length), "base64").toString("utf8")).note.noteId, target.publicationId);
  assert.throws(() => runInNewContext(source, { window: {}, location: { ...location, hostname: "evil.example" }, TextEncoder, btoa }), /UNCONFIGURED_PUBLICATION/);
  state.currentNoteId.value = "000000000000000000000003";
  assert.throws(() => runInNewContext(source, { window: { __INITIAL_STATE__: { note: state } }, location, TextEncoder, btoa }), /IDENTITY_MISMATCH/);
  state.currentNoteId.value = target.publicationId; delete (state.noteDetailMap as Record<string, unknown>)[target.publicationId];
  assert.throws(() => runInNewContext(source, { window: { __INITIAL_STATE__: { note: state } }, location, TextEncoder, btoa }), /NOTE_STATE_MISSING/);
});
test("v2 persistence rejects fabricated exact counters, foreign scope and public approval", () => {
  const row = snapshotObservation(snapshot(), target, at); validateObservation(row);
  for (const changed of [{ ...row, metrics: { ...row.metrics, views: 10 } }, { ...row, metrics: { ...row.metrics, likes: 9 } },
    { ...row, metricDisplay: { ...row.metricDisplay, likes: "1.2万" } }, { ...row, websitePublicationApproved: true },
    { ...row, description: "unrequested note text" }]) assert.throws(() => validateObservation(changed as unknown as Observation));
});
test("existing v1 Bilibili payloads survive reopening with v2 notes and share only the work binding", async t => {
  const dir = await directory(t); let store = (await openStore(dir))!; t.after(async () => store.close());
  const bili = config({ version: 1, publications: [{ platform: "bilibili", workId: target.workId, accountId: "10001", url: "https://www.bilibili.com/video/BV0000000001/" }] })[0];
  const old = observation('<script>window.__INITIAL_STATE__={"videoData":{"bvid":"BV0000000001","owner":{"mid":10001},"title":"Example video","stat":{"like":0}}}</script>', bili, at);
  const original = JSON.stringify(old); store.ingest(old); store.ingest(snapshotObservation(snapshot(), target, at));
  store.close(); store = (await openStore(dir, true))!;
  assert.equal(JSON.stringify(store.latest(bili)), original); assert.equal(store.status().works, 1); assert.equal(store.status().publications, 2);
  assert.equal(store.pending().length, 2); assert.deepEqual(store.pending().map(x => x.observation.version).sort(), [1, 2]);
});
test("a late conflict rolls back the entire note batch including an earlier new publication", async t => {
  const store = (await openStore(await directory(t)))!; t.after(async () => store.close());
  const row = snapshotObservation(snapshot(), target, at); store.ingest(row);
  const another = { ...row, publicationId: "000000000000000000000003", originalUrl: target.url.replace(target.publicationId, "000000000000000000000003") };
  const conflict = { ...row, title: "Changed title at identical time" };
  assert.throws(() => store.ingestBatch([another, conflict]), error("OBSERVATION_CONFLICT"));
  assert.equal(store.status().publications, 1); assert.equal(store.status().samples, 1); assert.equal(store.pending().length, 1);
});
test("Xiaohongshu cannot silently fall through to HTTP or to a collector for another platform", async t => {
  const store = (await openStore(await directory(t)))!; t.after(async () => store.close());
  const result = await collectTargets([target], store); assert.equal(result.failed, 1);
  assert.equal(store.status().latestAttempts[0].code, "BROWSER_SNAPSHOT_REQUIRED"); assert.equal(store.status().samples, 0);
  const row = snapshotObservation(snapshot(), target, at);
  const incorrect = { ...row, platform: "bilibili" } as unknown as Observation;
  assert.equal((await collectTargets([target], store, { collect: async () => incorrect })).failed, 1); assert.equal(store.status().samples, 0);
});
test("actual CLI generates a private snippet, imports once, deduplicates and keeps exports unacknowledged", async t => {
  const dir = await directory(t), s = snapshot(new Date().toISOString());
  await writeFile(join(dir, "config.json"), JSON.stringify(input), { mode: 0o600 });
  const call = (command: string) => JSON.parse(execFileSync(process.execPath, [cli, command, dir], { encoding: "utf8" }));
  assert.equal(call("capture-script").captured, 0); assert.equal(call("status").initialized, false);
  assert.equal((await stat(join(dir, "browser-capture.json"))).mode & 0o077, 0);
  assert.equal(JSON.parse(await readFile(join(dir, "browser-capture.json"), "utf8")).script, browserCaptureScript([target]));
  await writeFile(join(dir, "xiaohongshu-snapshot.json"), batch(s), { mode: 0o600 });
  assert.equal(call("import-xhs").inserted, 1); assert.equal(call("import-xhs").duplicate, 1);
  assert.equal(call("status").samples, 1); assert.equal(call("export").acknowledged, 0);
  const exported = JSON.parse(await readFile(join(dir, "pending.json"), "utf8"));
  assert.equal(exported.items[0].observation.kind, "image-note"); assert.equal(exported.items[0].observation.metrics.comments, 2);
  assert.equal(call("status").pending, 1);
});
test("CLI rejects a corrupt later snapshot before creating a database and sanitizes its failure", async t => {
  const dir = await directory(t), s = snapshot(new Date().toISOString());
  await writeFile(join(dir, "config.json"), JSON.stringify(input), { mode: 0o600 });
  await writeFile(join(dir, "xiaohongshu-snapshot.json"), batch(s, { ...s, cookies: "private auth detail" }), { mode: 0o600 });
  const result = spawnSync(process.execPath, [cli, "import-xhs", dir], { encoding: "utf8" });
  assert.equal(result.status, 1); assert.equal(result.stdout, ""); assert.deepEqual(JSON.parse(result.stderr), { code: "SNAPSHOT_INVALID" });
  await assert.rejects(stat(join(dir, "social.sqlite")), { code: "ENOENT" });
});
test("CLI browser input refuses permissive files and symbolic links", async t => {
  const dir = await directory(t), s = snapshot(new Date().toISOString()), path = join(dir, "xiaohongshu-snapshot.json");
  await writeFile(join(dir, "config.json"), JSON.stringify(input), { mode: 0o600 });
  await writeFile(path, batch(s), { mode: 0o644 });
  assert.equal(spawnSync(process.execPath, [cli, "import-xhs", dir]).status, 1);
  await rm(path); await writeFile(join(dir, "actual.json"), batch(s), { mode: 0o600 }); await symlink(join(dir, "actual.json"), path);
  assert.equal(spawnSync(process.execPath, [cli, "import-xhs", dir]).status, 1);
  await assert.rejects(stat(join(dir, "social.sqlite")), { code: "ENOENT" });
});
