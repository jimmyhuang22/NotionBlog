import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, chmod, symlink, writeFile, stat, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { config, count, publicationKey, SocialSyncError } from "../scripts/social-sync/model.ts";
import type { Observation } from "../scripts/social-sync/model.ts";
import { observation, pageState, collectVideo, MAX_PAGE_BYTES } from "../scripts/social-sync/bilibili.ts";
import { openStore, flushOutbox } from "../scripts/social-sync/store.ts";
import { collectTargets } from "../scripts/social-sync/worker.ts";
import { acquireLock } from "../scripts/notion-sync/state.ts";

const input = { version: 1, publications: [{ platform: "bilibili", workId: "example-work", accountId: "10001", url: "https://www.bilibili.com/video/BV0000000001/" }] };
const target = config(input)[0], time = "2026-01-02T03:04:05.000Z";
function state() {
  return { videoData: { bvid: target.publicationId, aid: 100, owner: { mid: 10001 }, title: 'Example } " title', desc: "Example description",
    pic: "http://i0.hdslb.com/bfs/archive/example.jpg", pubdate: 1700000000,
    stat: { aid: 100, view: 12, like: 0, reply: 2, share: 3, favorite: 4, coin: 5, danmaku: 6 },
    ugc_season: { id: 200, title: "Example collection", ep_count: 10, stat: { view: 99999, like: 99999 } } } };
}
function html(data: unknown = state()) { return `<html><script>window.__INITIAL_STATE__=${JSON.stringify(data)};(function(){window.unused=1;})()</script></html>`; }
function row(at = time): Observation { return observation(html(), target, at); }
async function directory(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "nb-social-test-"))); await chmod(dir, 0o700);
  t.after(() => rm(dir, { recursive: true, force: true })); return dir;
}
function error(code: string) { return (e: unknown) => e instanceof SocialSyncError && e.code === code; }

test("social config normalizes links and rejects foreign destinations, duplicate bindings and typos", () => {
  const q = structuredClone(input); q.publications[0].url += "?p=2&tracking=example";
  assert.deepEqual(config(q), [target]);
  for (const url of ["http://www.bilibili.com/video/BV0000000001/", "https://evil.example/video/BV0000000001/",
    "https://www.bilibili.com:444/video/BV0000000001/", "https://x@www.bilibili.com/video/BV0000000001/", "https://b23.tv/example"]) {
    assert.throws(() => config({ ...input, publications: [{ ...input.publications[0], url }] }), error("INVALID_URL"));
  }
  assert.throws(() => config({ ...input, publications: [...input.publications, ...input.publications] }), error("DUPLICATE_PUBLICATION"));
  assert.throws(() => config({ ...input, unexpected: true }), error("INVALID_CONFIG"));
  assert.throws(() => config({ ...input, publications: [{ ...input.publications[0], accountId: 10001 }] }), error("INVALID_CONFIG"));
});
test("social counters distinguish unknown and zero and reject rounded, negative or unsafe values", () => {
  assert.equal(count(undefined), null); assert.equal(count(null), null); assert.equal(count(0), 0); assert.equal(count("12"), 12);
  for (const value of [true, "1.2万", -1, 0.5, Number.MAX_SAFE_INTEGER + 1, ""]) assert.throws(() => count(value), error("INVALID_COUNT"));
});
test("Bilibili SSR parser reads inert JSON, verifies owner and keeps episode statistics separate", () => {
  const value = row(); assert.equal(value.title, 'Example } " title'); assert.equal(value.metrics.views, 12);
  assert.equal(value.metrics.likes, 0); assert.equal(value.metricsScope, "individual-video");
  assert.equal(value.collection?.episodeCount, 10); assert.equal(value.coverUrl?.startsWith("https:"), true);
  assert.equal(value.websitePublicationApproved, false); assert.equal((globalThis as Record<string, unknown>).unused, undefined);
});
test("Bilibili missing dates and counts stay null without fabricated fallbacks", () => {
  const s = state(); const v = s.videoData as Record<string, unknown>; delete v.pubdate;
  delete (v.stat as Record<string, unknown>).view;
  const value = observation(html(s), target, time); assert.equal(value.publishedAt, null); assert.equal(value.metrics.views, null);
});
test("Bilibili mismatched owner, video or stat scope fail instead of selecting another record", () => {
  const s = state(); s.videoData.owner.mid = 10002;
  assert.throws(() => observation(html(s), target, time), error("IDENTITY_MISMATCH"));
  s.videoData.owner.mid = 10001; s.videoData.bvid = "BV0000000002";
  assert.throws(() => observation(html(s), target, time), error("IDENTITY_MISMATCH"));
  s.videoData.bvid = target.publicationId; s.videoData.stat.aid = 101;
  assert.throws(() => observation(html(s), target, time), error("SCOPE_MISMATCH"));
});
test("Bilibili missing, executable, duplicate and oversized state cannot be evaluated", () => {
  assert.throws(() => pageState("<script>window.__INITIAL_STATE__=fetch('https://evil.example')</script>"), error("PAGE_STATE_INVALID"));
  assert.throws(() => pageState("<p>login</p>"), error("PAGE_STATE_MISSING"));
  assert.throws(() => pageState(html()+html()), error("PAGE_STATE_MISSING"));
  assert.throws(() => pageState("x".repeat(MAX_PAGE_BYTES+1)), error("PAGE_TOO_LARGE"));
});
test("Bilibili HTTP keeps redirects and blocked responses as explicit failures", async () => {
  for (const [status, code] of [[302,"SOURCE_REDIRECT"],[403,"SOURCE_BLOCKED"],[412,"SOURCE_BLOCKED"],[429,"RATE_LIMITED"],[503,"SOURCE_HTTP_ERROR"]] as const) {
    const request = (async () => new Response("", { status })) as typeof fetch;
    await assert.rejects(collectVideo(target, undefined, request), error(code));
  }
});
test("Bilibili HTTP validates destination before requests and bounds decoded body bytes", async () => {
  let calls = 0;
  const request = (async () => { calls++; return new Response(html(), { headers: { "content-type": "text/html" } }); }) as typeof fetch;
  await assert.rejects(collectVideo({ ...target, url: "https://127.0.0.1/" }, undefined, request), error("INVALID_URL")); assert.equal(calls, 0);
  assert.equal((await collectVideo(target, undefined, request)).metrics.likes, 0);
  const huge = (async () => new Response("x".repeat(MAX_PAGE_BYTES+1), { headers: { "content-type": "text/html" } })) as typeof fetch;
  await assert.rejects(collectVideo(target, undefined, huge), error("PAGE_TOO_LARGE"));
  const json = (async () => new Response("{}", { headers: { "content-type": "application/json" } })) as typeof fetch;
  await assert.rejects(collectVideo(target, undefined, json), error("PAGE_TYPE_INVALID"));
});
test("Bilibili cancellation and transport exceptions never disclose original errors", async () => {
  const abort = new AbortController(); abort.abort();
  await assert.rejects(collectVideo(target, abort.signal), error("CANCELLED"));
  const request = (async () => { throw new Error("private auth detail"); }) as typeof fetch;
  await assert.rejects(collectVideo(target, undefined, request), e => error("SOURCE_NETWORK_ERROR")(e) && !(e as Error).message.includes("auth"));
});
test("SQLite reopening preserves samples, zero, null and private file permissions", async t => {
  const dir = await directory(t); const store = (await openStore(dir))!;
  const first = row(); first.metrics.views = null; store.ingest(first); store.close();
  assert.equal((await stat(join(dir,"social.sqlite"))).mode & 0o077, 0);
  const reopened = (await openStore(dir, true))!;
  try { assert.equal(reopened.latest(target)?.metrics.views, null); assert.equal(reopened.latest(target)?.metrics.likes, 0); assert.equal(reopened.status().samples, 1); }
  finally { reopened.close(); }
});
test("SQLite deduplicates samples, rejects older data and rolls back timestamp conflicts", async t => {
  const store = (await openStore(await directory(t)))!; t.after(async () => store.close());
  assert.equal(store.ingest(row()), "inserted"); assert.equal(store.ingest(row()), "duplicate");
  const older = row("2026-01-01T00:00:00.000Z"); older.metrics.views = 9999; assert.equal(store.ingest(older), "older");
  const conflict = row(); conflict.metrics.views = 99; assert.throws(() => store.ingest(conflict), error("OBSERVATION_CONFLICT"));
  assert.equal(store.latest(target)?.metrics.views, 12); assert.equal(store.status().samples, 1); assert.equal(store.pending().length, 1);
});
test("SQLite keeps new statistical history while coalescing a publication's pending upload", async t => {
  const store = (await openStore(await directory(t)))!; t.after(async () => store.close());
  store.ingest(row()); const newer = row("2026-01-03T00:00:00.000Z"); newer.metrics.likes = 1;
  assert.equal(store.ingest(newer), "updated"); assert.equal(store.status().publications, 1); assert.equal(store.status().samples, 2);
  assert.equal(store.pending().length, 1); assert.equal(store.pending()[0].observation.metrics.likes, 1);
});
test("SQLite rejects changed work mappings and unsolicited fields before mutation", async t => {
  const store = (await openStore(await directory(t)))!; t.after(async () => store.close()); store.ingest(row());
  assert.throws(() => store.checkTargets([{ ...target, workId: "other-work" }]), error("WORK_BINDING_CONFLICT"));
  assert.throws(() => store.ingest({ ...row(), workId: "other-work" }), error("WORK_BINDING_CONFLICT"));
  assert.throws(() => store.ingest({ ...row(), secret: "not allowed" } as unknown as Observation), error("INVALID_DATA"));
  assert.equal(store.status().samples, 1);
});
test("failed upload and mismatched receipts remain pending until a verified retry", async t => {
  const store = (await openStore(await directory(t)))!; t.after(async () => store.close()); store.ingest(row());
  assert.equal((await flushOutbox(store, async () => { throw new Error("private failure"); })).failed, 1);
  assert.equal(store.status().failedUploads, 1);
  assert.equal((await flushOutbox(store, async item => ({ key: item.key, sha256: "wrong" }))).failed, 1);
  assert.equal(store.status().pending, 1);
  assert.equal((await flushOutbox(store, async item => ({ key: item.key, sha256: item.sha256 }))).acknowledged, 1);
  assert.equal(store.status().pending, 0);
});
test("an old in-flight receipt cannot acknowledge a newer queued sample", async t => {
  const store = (await openStore(await directory(t)))!; t.after(async () => store.close()); store.ingest(row());
  const result = await flushOutbox(store, async item => {
    store.ingest(row("2026-01-03T00:00:00.000Z")); return { key: item.key, sha256: item.sha256 };
  });
  assert.equal(result.superseded, 1); assert.equal(store.status().pending, 1);
});
test("source failure preserves prior successful data and a later run recovers", async t => {
  const store = (await openStore(await directory(t)))!; t.after(async () => store.close()); store.ingest(row());
  const failed = await collectTargets([target], store, { collect: async () => { throw new SocialSyncError("SOURCE_BLOCKED"); } });
  assert.equal(failed.failed, 1); assert.equal(store.latest(target)?.metrics.views, 12);
  assert.equal(store.status().latestAttempts[0].code, "SOURCE_BLOCKED");
  const recovered = await collectTargets([target], store, { collect: async () => row("2026-01-03T00:00:00.000Z") });
  assert.equal(recovered.updated, 1); assert.equal(store.status().latestAttempts[0].code, "OK");
});
test("a wrong adapter identity or cancelled run cannot silently become success", async t => {
  const store = (await openStore(await directory(t)))!; t.after(async () => store.close());
  const value = row(); value.accountId = "10002";
  assert.equal((await collectTargets([target], store, { collect: async () => value })).failed, 1); assert.equal(store.status().samples, 0);
  const abort = new AbortController(); abort.abort();
  assert.equal((await collectTargets([target], store, { signal: abort.signal })).cancelled, true);
});
test("SQLite refuses symlinks, permissive files and unknown databases", async t => {
  const dir = await directory(t), other = join(dir,"other"); await writeFile(other,"",{mode:0o600});
  await symlink(other,join(dir,"social.sqlite")); await assert.rejects(openStore(dir), error("PRIVATE_STATE_INVALID"));
  await rm(join(dir,"social.sqlite")); await writeFile(join(dir,"social.sqlite"),"",{mode:0o644});
  await assert.rejects(openStore(dir), error("PRIVATE_STATE_INVALID"));
  await chmod(join(dir,"social.sqlite"),0o600); await assert.rejects(openStore(dir,true), error("LOCAL_SCHEMA_UNSUPPORTED"));
});
test("the shared process lock cannot be stolen or removed by another owner", async t => {
  const dir = await directory(t), release = await acquireLock(dir,"example-run");
  await assert.rejects(acquireLock(dir,"other-run"), e => (e as {code:string}).code === "BUSY");
  await release(); const next = await acquireLock(dir,"next-run"); await next();
});
test("real CLI status and private export do not acknowledge queued data", async t => {
  const dir = await directory(t); const store = (await openStore(dir))!; store.ingest(row()); store.close();
  const cli = fileURLToPath(new URL("../scripts/social-sync/cli.ts",import.meta.url));
  const status = JSON.parse(execFileSync(process.execPath,[cli,"status",dir],{encoding:"utf8"}));
  assert.equal(status.publications,1); assert.equal(status.pending,1);
  const result = JSON.parse(execFileSync(process.execPath,[cli,"export",dir],{encoding:"utf8"}));
  assert.equal(result.exported,1); assert.equal(result.acknowledged,0);
  const exported = JSON.parse(await readFile(join(dir,"pending.json"),"utf8"));
  assert.equal(exported.items[0].key,publicationKey(target)); assert.equal(exported.items[0].observation.websitePublicationApproved,false);
  assert.equal((await stat(join(dir,"pending.json"))).mode & 0o077,0);
});
