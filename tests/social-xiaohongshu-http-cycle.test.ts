import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { hash, publicationKey, SocialSyncError } from "../scripts/social-sync/model.ts";
import { openStore } from "../scripts/social-sync/store.ts";
import { refreshConfig } from "../scripts/social-sync/refresh.ts";
import { inspectRefresh } from "../scripts/social-sync/refresh-state.ts";
import { executeRefresh } from "../scripts/social-sync/refresh-executor.ts";
import type { RefreshPorts } from "../scripts/social-sync/refresh-executor.ts";
import { runHttpNoteCycle, parseHttpHealth } from "../scripts/social-sync/xiaohongshu-http-cycle.ts";
import type { HttpCyclePorts, HttpHealth } from "../scripts/social-sync/xiaohongshu-http-cycle.ts";
import { httpNoteObservation } from "../scripts/social-sync/xiaohongshu-http.ts";
import { httpHtml, httpTarget } from "./helpers/social-xiaohongshu-http-samples.ts";
import { CycleCloudSession } from "../scripts/social-sync/cycle-cloud.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";
import { handleBrowserMessage } from "../scripts/social-sync/browser-bridge.ts";
import { executeAtRoot } from "../scripts/social-sync/execute-cli.ts";

const at = "2026-01-02T00:00:00.000Z", now = "2026-01-03T00:00:00.000Z";
const raw = "SOCIAL_DATABASE_URL=postgresql://nb_social_worker:example@localhost/example\nDATABASE_TLS=disable\n";
async function fixture(t: { after: (f: () => Promise<void>) => void }, count = 10) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nb-http-cycle-"))); await chmod(root, 0o700);
  const store = (await openStore(root))!; t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const targets = Array.from({ length: count }, (_, i) => httpTarget(i + 2));
  for (const target of targets) { const row = httpNoteObservation(httpHtml(Number(target.publicationId)), target, at); store.ingest(row); store.acknowledge(publicationKey(row), hash(JSON.stringify(row))); }
  const scope = refreshConfig({ version: 1, reviewedAt: at, cadence: { bilibiliHours: 6, xiaohongshuHours: 24 },
    stateDirectories: { publications: root, collections: root }, publications: targets.map(target => ({ target, kind: "image-note" })), collections: [] });
  let calls = 0, closes = 0, connections = 0, version = 1;
  const faults = { capture: null as string | null, upload: false, close: false };
  const sql: SqlExecutor = { query: async <T>(text: string, values?: unknown[]) => {
    if (text.includes("current_user")) return { rows: [{ role: "nb_social_worker", login: "nb_social_worker", elevated: false, version: 1, http_note_version: version }] as T[] };
    if (faults.upload) throw Error("private credential diagnostic"); return { rows: [{ key: values![0], sha256: values![1] }] as T[] };
  } };
  const cloud = () => new CycleCloudSession(undefined, { connect: async () => { connections++; return { sql, close: async () => { closes++; } }; } }, { httpNotes: true });
  let session = cloud();
  const receipt = async (p: { key: string; sha256: string }) => p;
  const refreshPorts: RefreshPorts = { publications: store, collections: null, checkScope: async () => {}, saveReview: async () => {}, progress: async () => {},
    sendPublication: p => session.sendPublication(raw, hash(JSON.stringify(scope)), p, undefined, async () => {}), sendCollection: receipt };
  const saved: HttpHealth[] = [], cycles: unknown[] = [];
  const ports: HttpCyclePorts = {
    inspect: () => inspectRefresh(root, "xiaohongshu", now, async () => scope),
    prepare: digest => session.preparePublications(raw, digest),
    execute: (keys, _digest, observe) => executeRefresh(scope, refreshPorts, { platform: "xiaohongshu", limit: 5, keys, now: () => now, spacingMs: 0, observe,
      collectHttpNote: async target => { calls++; if (faults.capture) throw new SocialSyncError(faults.capture); return httpNoteObservation(httpHtml(Number(target.publicationId)), target, now); } }),
    saveHealth: async h => { parseHttpHealth(h); saved.push(structuredClone(h)); }, saveCycle: async c => { cycles.push(structuredClone(c)); },
    finish: async () => { await session.close(); if (faults.close) throw new SocialSyncError("XHS_HTTP_CLOSE_FAILED"); },
    cost: () => ({ starts: calls ? 1 : 0, requests: calls, bytes: 0, cpuMs: 0, peakRssBytes: 0 }), uploadCost: () => ({ ...session.cost }), now: () => now,
  };
  return { root, store, scope, session:()=>session, ports, faults, saved, cycles, calls: () => calls, connections: () => connections, closes: () => closes,
    setVersion: (v: number) => { version = v; }, resetSession: () => { session = cloud(); } };
}
test("two HTTP batches reuse one worker connection and handshake, and preserve the 24-hour due rule", async t => {
  const f = await fixture(t), h = await runHttpNoteCycle("run", null, false, f.ports);
  assert.equal(h.state, "complete"); assert.equal(h.cycle!.uploaded, 10); assert.equal(h.cycle!.remaining, 0); assert.equal(f.calls(), 10);
  assert.equal(f.connections(), 1); assert.equal(f.closes(), 1); assert.equal(h.uploadCost!.publicationHandshakes, 1);
  assert.equal(h.lastCollectedAt, now); assert.equal(h.lastUploadedAt, now); assert.equal(f.store.status().pending, 0);
  f.resetSession(); const idle = await runHttpNoteCycle("run", h, false, f.ports); assert.equal(idle.state, "idle"); assert.equal(f.calls(), 10); assert.equal(f.connections(), 1);
});
test("first source failure records stage and reason, retains old numbers, and ordinary checks never retry it", async t => {
  const f = await fixture(t); f.faults.capture = "SOURCE_RATE_LIMITED";
  const first = await runHttpNoteCycle("run", null, false, f.ports); assert.equal(f.calls(), 1); assert.equal(first.cycle!.remaining, 10);
  assert.equal(first.recovery.stage, "capture"); assert.equal(first.recovery.code, "SOURCE_RATE_LIMITED"); assert(first.recovery.manualRequired); assert.equal(f.store.status().samples, 10);
  f.faults.capture = null; f.resetSession(); const blocked = await runHttpNoteCycle("run", first, false, f.ports);
  assert.deepEqual(blocked.recovery, first.recovery); assert.equal(f.calls(), 1); assert.equal(f.connections(), 1);
  f.resetSession(); const resumed = await runHttpNoteCycle("resume", blocked, false, f.ports); assert.equal(resumed.cycle!.uploaded, 10); assert(!resumed.recovery.manualRequired);
});
test("an unknown upload result stays pending and explicit resume reuses it without a new source read", async t => {
  const f = await fixture(t, 1); f.faults.upload = true;
  const first = await runHttpNoteCycle("run", null, false, f.ports); assert.equal(first.recovery.stage, "upload"); assert.equal(first.lastUploadedAt, null);
  assert.equal(first.lastCollectedAt, now); assert.equal(f.store.status().pending, 1);
  f.faults.upload = false; f.resetSession(); const next = await runHttpNoteCycle("resume", first, false, f.ports);
  assert.equal(f.calls(), 1); assert.equal(next.cycle!.uploaded, 1); assert.equal(f.store.status().samples, 2); assert.equal(f.store.status().pending, 0);
});
test("field validation diagnostics persist through the source attempt and health without clearing a pause or overwriting the last good sample",async t=>{
  const f=await fixture(t,1);f.faults.capture="NOTE_HTTP_COVER_INVALID";
  const first=await runHttpNoteCycle("run",null,false,f.ports);
  assert.equal(first.recovery.code,"NOTE_HTTP_COVER_INVALID");assert.equal(first.recovery.stage,"capture");assert(first.recovery.manualRequired);
  assert.equal(f.store.status().latestAttempts[0]!.code,"NOTE_HTTP_COVER_INVALID");assert.equal(f.store.latest(httpTarget())!.observedAt,at);
  assert.equal(f.store.status().pending,0);assert.equal(f.store.status().samples,1);
  f.faults.capture=null;f.resetSession();const next=await runHttpNoteCycle("run",first,false,f.ports);
  assert.deepEqual(next.recovery,first.recovery);assert.equal(f.calls(),1);assert.equal(f.connections(),1);
});
test("missing cloud capability, inherited legacy pause, cancellation and close failures all fail closed", async t => {
  const f = await fixture(t, 1); f.setVersion(0);
  const preflight = await runHttpNoteCycle("run", null, false, f.ports); assert.equal(preflight.recovery.code, "XHS_HTTP_PROTOCOL_REQUIRED"); assert.equal(preflight.recovery.stage, "preflight");
  assert.equal(f.calls(), 0); assert.equal(f.store.status().samples, 1); f.resetSession();
  const legacy = await runHttpNoteCycle("run", null, true, f.ports); assert.equal(legacy.recovery.code, "XHS_MANUAL_RESUME_REQUIRED"); assert.equal(f.connections(), 1);
  f.setVersion(1); f.resetSession(); const cancelled = await runHttpNoteCycle("resume", legacy, true, f.ports, AbortSignal.abort());
  assert.equal(cancelled.state, "cancelled"); assert.equal(f.calls(), 0);
  f.resetSession(); f.faults.close = true; const closed = await runHttpNoteCycle("resume", cancelled, false, f.ports);
  assert.equal(closed.recovery.stage, "close"); assert.equal(closed.recovery.code, "XHS_HTTP_CLOSE_FAILED");
});
test("lock contention preserves an existing pause; disabled CLI performs no source, health or cloud work", async t => {
  const f = await fixture(t, 1), legacy = await runHttpNoteCycle("run", null, true, f.ports);
  legacy.cost={starts:1,requests:1,bytes:123,cpuMs:2,peakRssBytes:456};
  legacy.uploadCost={connectionAttempts:1,connections:1,connectMs:1,handshakeAttempts:1,publicationHandshakes:1,collectionHandshakes:0,handshakeMs:1,ingestAttempts:1,receipts:1,ingestMs:1,closeMs:1};
  f.ports.inspect = async () => { throw Object.assign(Error("private lock"), { code: "BUSY" }); };
  const busy = await runHttpNoteCycle("resume", legacy, true, f.ports); assert.equal(busy.state, "deferred"); assert.deepEqual(busy.recovery, legacy.recovery);
  assert.deepEqual(busy.cost,legacy.cost);assert.deepEqual(busy.uploadCost,legacy.uploadCost);
  const cli = fileURLToPath(new URL("../scripts/social-sync/http-cycle-cli.ts", import.meta.url));
  const result = spawnSync(process.execPath, [cli, "run", f.root], { encoding: "utf8" }); assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), { state: "disabled", executed: false });
});
test("HTTP routing gates legacy XHS jobs while malformed XHS configuration leaves Bilibili settings enabled", async t => {
  const f = await fixture(t, 1), origin = "chrome-extension://" + "a".repeat(32) + "/";
  await writeFile(join(f.root, "bridge-config.json"), JSON.stringify({ version: 1, origin, enabled: true }), { mode: 0o600 });
  await writeFile(join(f.root, "xiaohongshu-http.json"), JSON.stringify({ version: 1, enabled: true, baseScopeDigest: "a".repeat(64), linksDigest: "b".repeat(64), stateDirectory: join(f.root, "separate"), pythonExecutable: process.execPath }), { mode: 0o600 });
  const settings = await handleBrowserMessage(f.root, origin, { op: "settings" }) as Record<string,unknown>; assert.equal(settings.enabled, true); assert.equal(settings.xiaohongshuEnabled, false);
  const managed = await handleBrowserMessage(f.root, origin, { op: "start", manual: true }) as Record<string,unknown>; assert.equal(managed.status, "http-managed");
  await writeFile(join(f.root, "xiaohongshu-http.json"), "{}", { mode: 0o600 });
  const broken = await handleBrowserMessage(f.root, origin, { op: "settings" }) as Record<string,unknown>; assert.equal(broken.enabled, true); assert.equal(broken.xiaohongshuEnabled, false);
  await assert.rejects(handleBrowserMessage(f.root, origin, { op: "start" }), { code: "XHS_HTTP_CONFIG_INVALID" });
});
test("the real root executor ignores legacy browser files in HTTP mode and sends through the prepared HTTP session", async t => {
  const f=await fixture(t,1);
  await writeFile(join(f.root,"cloud.env"),raw,{mode:0o600});
  await writeFile(join(f.root,"xiaohongshu-snapshot.json"),"must not read stale browser input",{mode:0o600});
  const digest=hash(JSON.stringify(f.scope));let captures=0;
  await assert.rejects(executeAtRoot(f.root,{platform:"xiaohongshu",limit:1,scopeProvider:async()=>f.scope,cloudSession:f.session(),
    collectHttpNote:async target=>{captures++;return httpNoteObservation(httpHtml(),target);}}),{code:"XHS_HTTP_PROTOCOL_REQUIRED"});
  assert.equal(captures,0);await f.session().preparePublications(raw,digest);
  const report=await executeAtRoot(f.root,{platform:"xiaohongshu",limit:1,scopeProvider:async()=>f.scope,cloudSession:f.session(),scopeDigest:digest,
    collectHttpNote:async target=>{captures++;return httpNoteObservation(httpHtml(),target);}});
  assert("entries" in report);assert.equal(report.uploaded,1);assert.equal(captures,1);assert.equal(f.store.status().pending,0);await f.session().close();
  assert.equal(f.connections(),1);assert.equal(f.session().cost.publicationHandshakes,1);
});
test("health parsing picks only safe aggregate fields and refuses corrupt cost counters",async t=>{
  const f=await fixture(t,1),h=await runHttpNoteCycle("run",null,true,f.ports);
  const extended={...h,privateDetail:"do not echo",recovery:{...h.recovery,url:"do not echo"},cycle:{startedAt:now,finishedAt:now,uploaded:0,remaining:1,keys:["do not echo"]},cost:{starts:0,requests:0,bytes:0,cpuMs:0,peakRssBytes:0,url:"do not echo"}};
  assert(!JSON.stringify(parseHttpHealth(extended)).includes("do not echo"));
  assert.throws(()=>parseHttpHealth({...extended,cost:{...extended.cost,requests:161}}),{code:"XHS_HTTP_HEALTH_INVALID"});
});
