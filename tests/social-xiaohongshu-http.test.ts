import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hash, publicationKey, SocialSyncError, validateObservation } from "../scripts/social-sync/model.ts";
import { checkedNoteShareUrl, httpNoteObservation, httpNoteState, XHS_HTTP_PAGE_BYTES } from "../scripts/social-sync/xiaohongshu-http.ts";
import { HttpNoteSession } from "../scripts/social-sync/xiaohongshu-http-transport.ts";
import { readHttpNotePolicy, readHttpNoteScope, statePathsOverlap } from "../scripts/social-sync/xiaohongshu-http-config.ts";
import { prepareHttpNotes } from "../scripts/social-sync/prepare-xiaohongshu-http.ts";
import { refreshConfig } from "../scripts/social-sync/refresh.ts";
import { openStore } from "../scripts/social-sync/store.ts";
import { snapshotObservation } from "../scripts/social-sync/xiaohongshu.ts";
import { observation } from "../scripts/social-sync/bilibili.ts";
import { config } from "../scripts/social-sync/model.ts";
import { httpHtml, httpState, httpTarget, httpUrl } from "./helpers/social-xiaohongshu-http-samples.ts";
import { publicationCoverSource, sourceDigest } from "../scripts/social-media/sources.ts";

const at = "2026-01-02T00:00:00.000Z", error = (code: string) => (e: unknown) => e instanceof SocialSyncError && e.code === code;
async function directory(t: { after: (f: () => Promise<void>) => void }) { const d = await realpath(await mkdtemp(join(tmpdir(), "nb-http-"))); await chmod(d, 0o700); t.after(() => rm(d, { recursive: true, force: true })); return d; }
test("HTTP notes preserve identities, dates, nullable/rounded counts and truthful provenance without retaining content", () => {
  const row = httpNoteObservation(httpHtml(), httpTarget(), at); validateObservation(row);
  assert.equal(row.source, "public-note-page-ssr"); assert.equal(row.responseSha256, hash(httpHtml()));
  assert.equal(row.metrics.likes, null); assert.equal(row.metricDisplay.likes, "1.2万"); assert.equal(row.metrics.comments, 0); assert.equal(row.metrics.shares, null);
  assert.equal(row.publishedAt, new Date(1700000000000).toISOString()); assert.equal(row.updatedAt, null); assert.equal(row.websitePublicationApproved, false);
  assert.equal(row.description, null); assert.equal(row.observedAt, at); assert(!JSON.stringify(row).includes("Not retained"));
  for (const field of ["author", "note", "current"]) { const s = httpState(), n = s.note.noteDetailMap[httpTarget().publicationId]!.note;
    if (field === "author") n.user.userId = httpTarget(3).publicationId; if (field === "note") n.noteId = httpTarget(3).publicationId; if (field === "current") s.note.currentNoteId = httpTarget(3).publicationId;
    assert.throws(() => httpNoteObservation(`<script>window.__INITIAL_STATE__=${JSON.stringify(s)}</script>`, httpTarget(), at), error("IDENTITY_MISMATCH")); }
});
test("SSR parsing is inert, bounded, preserves quoted undefined, and rejects scripts instead of executing them", () => {
  const s = JSON.stringify(httpState()).replace('"lastUpdateTime":null', '"lastUpdateTime":undefined');
  assert.equal(httpNoteObservation(`<script>window.__INITIAL_STATE__=${s};globalThis.bad=1;</script>`, httpTarget(), at).title, "Example undefined } note");
  assert.throws(() => httpNoteState('<script>window.__INITIAL_STATE__={"note":(()=>{throw 1})()}</script>'), error("PAGE_STATE_INVALID"));
  assert.throws(() => httpNoteState(httpHtml() + httpHtml()), error("PAGE_STATE_MISSING"));
  assert.throws(() => httpNoteState("x".repeat(XHS_HTTP_PAGE_BYTES + 1)), error("PAGE_TOO_LARGE"));
  assert.throws(() => httpNoteState("login page"), error("PAGE_STATE_MISSING"));
});
test("HTTP validation reports fixed field categories without retaining failing values or changing valid projections",()=>{
  const cases:[string,(s:ReturnType<typeof httpState>)=>void][]=[
    ["NOTE_STATE",s=>{Object.assign(s,{note:null});}],
    ["CURRENT_ID",s=>{Object.assign(s.note,{currentNoteId:[]});}],
    ["DETAIL_MAP",s=>{Object.assign(s.note,{noteDetailMap:null});}],
    ["DETAIL_ENTRY",s=>{Object.assign(s.note.noteDetailMap,{[httpTarget().publicationId]:null});}],
    ["NOTE",s=>{Object.assign(s.note.noteDetailMap[httpTarget().publicationId]!,{note:null});}],
    ["AUTHOR",s=>{Object.assign(s.note.noteDetailMap[httpTarget().publicationId]!.note,{user:null});}],
    ["COUNTERS",s=>{Object.assign(s.note.noteDetailMap[httpTarget().publicationId]!.note,{interactInfo:[]});}],
    ["TITLE",s=>{s.note.noteDetailMap[httpTarget().publicationId]!.note.title=" ";}],
    ["COVER",s=>{Object.assign(s.note.noteDetailMap[httpTarget().publicationId]!.note,{imageList:["private-marker"]});}],
    ["COVER",s=>{Object.assign(s.note.noteDetailMap[httpTarget().publicationId]!.note,{imageList:[{urlDefault:"https://example.com/private-marker"}]});}],
    ["PUBLISHED_TIME",s=>{s.note.noteDetailMap[httpTarget().publicationId]!.note.time=0;}],
    ["UPDATED_TIME",s=>{Object.assign(s.note.noteDetailMap[httpTarget().publicationId]!.note,{lastUpdateTime:"private-marker"});}],
    ...Object.entries({LIKES:"likedCount",COMMENTS:"commentCount",SHARES:"shareCount",COLLECTIONS:"collectedCount"}).map(([field,key])=>
      [field,(s:ReturnType<typeof httpState>)=>{Object.assign(s.note.noteDetailMap[httpTarget().publicationId]!.note.interactInfo,{[key]:"private-marker"});}] as [string,(s:ReturnType<typeof httpState>)=>void]),
  ];
  for(const [field,change] of cases){const s=httpState();change(s);
    assert.throws(()=>httpNoteObservation(`<script>window.__INITIAL_STATE__=${JSON.stringify(s)}</script>`,httpTarget(),at),(e:unknown)=>{
      assert(e instanceof SocialSyncError);assert.equal(e.code,`NOTE_HTTP_${field}_INVALID`);assert.equal(e.message,e.code);assert(!JSON.stringify(e).includes("private-marker"));return true;
    });
  }
  const before=httpNoteObservation(httpHtml(),httpTarget(),at);assert.equal(before.source,"public-note-page-ssr");validateObservation(before);
});
test("HTTP observations remain compatible with social covers and counter refreshes preserve the image source digest",()=>{
  const html=httpHtml().replace('"imageList":[]','"imageList":[{"urlDefault":"https://sns-webpic-qc.xhscdn.com/example.webp"}]');
  const first=publicationCoverSource(httpNoteObservation(html,httpTarget(),at));
  const second=publicationCoverSource(httpNoteObservation(html.replace('"likedCount":"1.2万"','"likedCount":"5"'),httpTarget(),"2026-01-03T00:00:00.000Z"));
  assert.equal(first.key,second.key);assert.equal(sourceDigest(first),sourceDigest(second));assert.equal(first.url,"https://sns-webpic-qc.xhscdn.com/example.webp");
});
test("only the approved note's public share locator is accepted; destinations, credentials and duplicate parameters fail", () => {
  assert.equal(checkedNoteShareUrl(httpUrl(), httpTarget()), httpUrl());
  for (const u of ["invalid", httpTarget().url, httpUrl(3), httpUrl().replace("https:", "http:"), httpUrl().replace("www.", "user@www."),
    httpUrl().replace(".com/", ".com:444/"), httpUrl() + "#tracking", httpUrl() + "&cookie=example", httpUrl() + "&xsec_token=example_public_locator", "https://example.com/"]) assert.throws(() => checkedNoteShareUrl(u, httpTarget()), error("XHS_HTTP_LINK_INVALID"));
  assert(statePathsOverlap("/example/source", "/example/source/sub")); assert(!statePathsOverlap("/example/source", "/example/..hidden"));
});
function session(mode = "ok", html = httpHtml()) {
  let starts = 0;
  const body = Buffer.from(html).toString("base64");
  const source = `const r=require('node:readline').createInterface({input:process.stdin});r.on('line',s=>{const q=JSON.parse(s);${mode === "hang" ? "return;" : `process.stdout.write(JSON.stringify({id:${mode === "wrong-id" ? "q.id+1" : "q.id"},status:${mode === "blocked" ? "429" : "200"},code:${mode === "blocked" ? "'SOURCE_RATE_LIMITED'" : "null"},bodyBase64:${mode === "blocked" ? "null" : JSON.stringify(body)},responseBytes:${mode === "blocked" ? "0" : Buffer.byteLength(html)},elapsedMs:1,retryAfter:null,serverDate:null,cpuMs:q.id,peakRssBytes:100})+'\\n');`}});`;
  const http = new HttpNoteSession(process.execPath, { spawn: (exe, args, options) => {
    starts++; assert.equal(exe, process.execPath); assert.deepEqual(args.slice(0, 2), ["-I", "-B"]); assert.equal(args.length, 3); assert(!JSON.stringify(args).includes("xsec_token"));
    assert.deepEqual(Object.keys(options.env).sort(), ["LC_ALL", "NODE_ENV"]); return spawn(process.execPath, ["-e", source], options);
  } });
  return { http, starts: () => starts };
}
test("one owned interpreter serves multiple sequential notes, then exits; disabled/unused close never starts it", async () => {
  const f = session(); await f.http.collect(httpTarget(), httpUrl()); await f.http.collect(httpTarget(), httpUrl()); await f.http.close(); await f.http.close();
  assert.equal(f.starts(), 1); assert.equal(f.http.cost.requests, 2); assert.equal(f.http.cost.bytes, 2 * Buffer.byteLength(httpHtml()));
  const unused = session(); await unused.http.close(); assert.equal(unused.starts(), 0);
});
test("a field diagnostic survives transport, stops the session and is not retried",async()=>{
  const s=httpState();s.note.noteDetailMap[httpTarget().publicationId]!.note.title="";
  const f=session("ok",`<script>window.__INITIAL_STATE__=${JSON.stringify(s)}</script>`);
  await assert.rejects(f.http.collect(httpTarget(),httpUrl()),error("NOTE_HTTP_TITLE_INVALID"));
  await assert.rejects(f.http.collect(httpTarget(),httpUrl()),error("XHS_HTTP_SESSION_UNAVAILABLE"));await f.http.close();assert.equal(f.http.cost.requests,1);
});
test("rate limit, malformed reply and cancellation stop this session without retries or credential text", async () => {
  for (const [mode, code] of [["blocked", "SOURCE_RATE_LIMITED"], ["wrong-id", "XHS_HTTP_FRAME_INVALID"]]) {
    const f = session(mode); await assert.rejects(f.http.collect(httpTarget(), httpUrl()), error(code));
    await assert.rejects(f.http.collect(httpTarget(), httpUrl()), error("XHS_HTTP_SESSION_UNAVAILABLE")); await f.http.close(); assert.equal(f.starts(), 1);
  }
  const f = session("hang"), controller = new AbortController(), pending = f.http.collect(httpTarget(), httpUrl(), controller.signal);
  controller.abort(); await assert.rejects(pending, error("CANCELLED")); await f.http.close();
  const broken = new HttpNoteSession(process.execPath, { spawn: () => { throw Error("private URL"); } });
  await assert.rejects(broken.collect(httpTarget(), httpUrl()), error("XHS_HTTP_TRANSPORT_FAILED")); await broken.close();
});
test("preparation copies exact XHS history and ACK states to a new store while preserving the shared Bilibili store", async t => {
  const parent = await directory(t), root = join(parent, "runtime"), source = join(parent, "old-source"), out = join(parent, "candidate"), store = (await openStore(source))!;
  await writeFile(join(parent, "example-python"), "", { mode: 0o700 }); await import("../scripts/notion-sync/state.ts").then(m => m.privateDirectory(root));
  const target = httpTarget(), s = httpState().note.noteDetailMap[target.publicationId]!.note;
  const old = snapshotObservation({ version: 1, source: "browser-note-state", observedAt: at, pageUrl: target.url, note: { noteId: s.noteId, userId: s.user.userId, type: s.type, title: s.title,
    time: s.time, lastUpdateTime: null, coverUrl: null, interactInfo: s.interactInfo } }, target, at);
  store.ingest(old); store.acknowledge(publicationKey(old), hash(JSON.stringify(old))); store.recordAttempt(target, at, "OK");
  const bili = config({ version: 1, publications: [{ platform: "bilibili", accountId: "10001", workId: "example-video", url: "https://www.bilibili.com/video/BV0000000001/" }] })[0]!;
  store.ingest(observation(`<script>window.__INITIAL_STATE__={"videoData":{"bvid":"${bili.publicationId}","owner":{"mid":10001},"title":"Example","stat":{}}}</script>`, bili, at)); store.close();
  const base = refreshConfig({ version: 1, reviewedAt: at, cadence: { bilibiliHours: 6, xiaohongshuHours: 24 }, stateDirectories: { publications: source, collections: source },
    publications: [{ target, kind: "image-note" }, { target: bili, kind: "video" }], collections: [] });
  await writeFile(join(root, "refresh-config.json"), JSON.stringify(base), { mode: 0o600 });
  await writeFile(join(root, "browser-links.json"), JSON.stringify({ version: 1, links: [{ publicationId: target.publicationId, url: httpUrl() }] }), { mode: 0o600 });
  const before = hash((await readFile(join(source, "social.sqlite"))).toString("base64"));
  const prepared = await prepareHttpNotes(root, out, join(parent, "example-python")); assert.equal(prepared.targets, 1); assert.equal(prepared.counts.samples, 1);
  const policy = JSON.parse(await readFile(join(out, "xiaohongshu-http.json"), "utf8")); assert.equal(policy.enabled, false);
  await writeFile(join(root, "xiaohongshu-http.json"), JSON.stringify({ ...policy, enabled: true }), { mode: 0o600 });
  const derived = await readHttpNoteScope(root); assert.equal(derived.scope.publications.length, 1); assert.equal(derived.scope.collections.length, 0);
  const copied = (await openStore(policy.stateDirectory))!; assert.deepEqual(copied.latest(target), old); assert.equal(copied.status().pending, 0);
  copied.ingest(httpNoteObservation(httpHtml(), target, "2026-01-03T00:00:00.000Z")); copied.close();
  assert.equal(hash((await readFile(join(source, "social.sqlite"))).toString("base64")), before); assert.equal((await stat(join(out, "prepared.json"))).mode & 0o077, 0);
  await assert.rejects(prepareHttpNotes(root, out, join(parent, "example-python")), error("REFRESH_PACKAGE_EXISTS"));
  await writeFile(join(root, "browser-links.json"), "{}", { mode: 0o600 }); await assert.rejects(readHttpNoteScope(root), error("XHS_HTTP_LINKS_CHANGED"));
  assert.equal((await readHttpNotePolicy(root))!.enabled, true);
});
