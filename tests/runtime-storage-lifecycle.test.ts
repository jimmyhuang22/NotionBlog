import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, realpath, writeFile, readFile, appendFile, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseEnv } from "node:util";
import { createRuntimeStorage } from "../scripts/website-incremental-sync/runtime-storage.ts";
import { createHostBudget, hostFail } from "../scripts/website-incremental-sync/host-budget.ts";
import { createHostResources } from "../scripts/website-incremental-sync/host-resources.ts";
import { runFullBaselineHost } from "../scripts/website-incremental-sync/full-baseline-host.ts";
import { runIncrementalHost } from "../scripts/website-incremental-sync/host.ts";
import { acquireLock } from "../scripts/notion-sync/state.ts";
import { hostFixture } from "./helpers/incremental-host.ts";
import { mediaIdentity } from "../src/server/database/validation.ts";
import type { StoredMedia } from "../contracts/sync.ts";

const env = { SYNC_DATABASE_URL: "postgresql://fiction:fixture@database.example.test/db", DATABASE_CA_CERT: "fixture-ca",
  STORAGE_URL: "https://storage.example.test/storage/v1", STORAGE_BUCKET: "fiction-media", STORAGE_API_KEY: "sb_publishable_fixture", STORAGE_WRITER_USER_ID: "fiction-writer" };
const jwt = (exp: number) => `e30.${Buffer.from(JSON.stringify({ exp, sub: env.STORAGE_WRITER_USER_ID, iss: "https://storage.example.test/auth/v1",
  role: "authenticated", app_metadata: { notionblog_storage_role: "writer" } })).toString("base64url")}.fixture`;
const bytes = Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]), sha = createHash("sha256").update(bytes).digest("hex");
const media: StoredMedia = { assetId: mediaIdentity("fiction-page", "cover", sha), ownerPageId: "fiction-page", objectKey: `sha256/${sha}`,
  sha256: sha, byteSize: bytes.length, mime: "image/png", width: null, height: null };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

test("static Storage preflight rejects insufficient whole-run windows before transport", async () => {
  const budget = createHostBudget({ durationMs: 10000 }), resources = createHostResources(); let requests = 0;
  try {
    for (const token of ["malformed", jwt(1), jwt(Date.now() / 1000 + 60)]) await assert.rejects(createRuntimeStorage({
      env: { ...env, STORAGE_WRITE_TOKEN: token }, budget, registerCleanup: resources.register,
      fetch: async () => { requests++; return new Response(null); },
    }), { message: "HOST_STORAGE_SESSION_WINDOW_INVALID" });
    const storage = await createRuntimeStorage({ env: { ...env, STORAGE_WRITE_TOKEN: jwt(Date.now() / 1000 + 3600) }, budget,
      registerCleanup: resources.register, fetch: async () => { requests++; return new Response(null); } });
    assert.equal(requests, 0); await storage.put(media, bytes); assert.equal(requests, 1);
  } finally { budget.close(); await resources.close(); }
});

test("partial or ambiguous renewal input fails before opening any private helper", async () => {
  const budget = createHostBudget(), resources = createHostResources();
  try {
    for (const extra of [ { SYNC_STORAGE_WRITER_ENV_FILE: "/missing/fiction.env" },
      { SYNC_STORAGE_REFRESH_MODULE: "" },
      { DATABASE_MEDIA_DIRECTORY: "/missing/local", SYNC_STORAGE_WRITER_ENV_FILE: "/missing/fiction.env",
        SYNC_STORAGE_REFRESH_MODULE: "/missing/helper.mjs", SYNC_STORAGE_REFRESH_SHA256: "0".repeat(64) } ]) {
      await assert.rejects(createRuntimeStorage({ env: { ...env, ...extra }, budget, registerCleanup: resources.register }), { message: "HOST_STORAGE_SESSION_INPUT_INVALID" });
    }
  } finally { budget.close(); await resources.close(); }
});

test("both runtime consumers can preflight and rotate a persisted private writer session", async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "fiction-runtime-storage-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "writer.env"), helper = join(dir, "refresh.mjs");
  const code = `import {readFile,appendFile} from "node:fs/promises";
import {parseEnv} from "node:util";
export async function refreshWriterSession(path) {
 const before=parseEnv(await readFile(path,"utf8"));
 await appendFile(path, 'STORAGE_WRITE_TOKEN="${jwt(Date.now() / 1000 + 3600)}"\\nREFRESH_MARKER='+String(Number(before.REFRESH_MARKER??0)+1)+'\\n');
 return {serverValidated:true};
}\n`;
  await writeFile(path, Object.entries({ ...env, STORAGE_WRITE_TOKEN: jwt(1) }).map(([k,v]) => `${k}=${JSON.stringify(v)}\n`).join(""), { mode: 0o600 });
  await writeFile(helper, code, { mode: 0o600 });
  const controller = new AbortController(), budget = createHostBudget({ durationMs: 10000, signal: controller.signal }), resources = createHostResources(); let requests = 0;
  const settings = { ...env, SYNC_STORAGE_WRITER_ENV_FILE: path, SYNC_STORAGE_REFRESH_MODULE: helper,
    SYNC_STORAGE_REFRESH_SHA256: createHash("sha256").update(code).digest("hex") };
  try {
    const storage = await resources.open(() => createRuntimeStorage({ env: settings, budget, registerCleanup: resources.register, fetch: async (_url, init) => {
      requests++; const current = parseEnv(await readFile(path, "utf8"));
      assert.equal((init?.headers as Record<string,string>).Authorization, `Bearer ${current.STORAGE_WRITE_TOKEN}`);
      assert.ok(init?.signal); assert.equal(init?.signal?.aborted, false); return new Response(null, { status: 200 });
    } }));
    assert.equal(parseEnv(await readFile(path, "utf8")).REFRESH_MARKER, "1"); assert.equal(requests, 0);
    await appendFile(path, `STORAGE_WRITE_TOKEN="${jwt(1)}"\n`);
    await Promise.all(Array.from({ length: 16 }, () => storage.put(media, bytes)));
    assert.equal(parseEnv(await readFile(path, "utf8")).REFRESH_MARKER, "2"); assert.equal(requests, 16);
    controller.abort(); await assert.rejects(storage.put(media, bytes)); assert.equal(requests, 16);
  } finally { budget.close(); await resources.close(); }
});

test("all resource closers run despite failure and closed allocation cannot restart", async () => {
  const resources = createHostResources(), called: number[] = [];
  resources.register(() => { called.push(1); });
  resources.register(() => { called.push(2); throw Error("fixture-private-error"); });
  const closing = resources.close(); assert.equal(resources.close(), closing);
  await assert.rejects(closing, { message: "HOST_RESOURCE_CLOSE_FAILED" }); assert.deepEqual(called, [2, 1]);
  assert.throws(() => resources.open(async () => 1), { message: "HOST_RESOURCE_CLOSED" });
  assert.throws(() => resources.register(() => {}), { message: "HOST_RESOURCE_CLOSED" });
});

for (const kind of ["full", "incremental"] as const) test(`${kind} cancellation keeps the canonical lock through late allocation and cleanup`, async t => {
  const f = await hostFixture(); t.after(() => f.close());
  if (kind === "incremental") assert.equal((await runIncrementalHost(f.options, f.deps)).outcome, "initialized");
  const entered = deferred(), allocated = deferred(), cleaning = deferred(), cleaned = deferred(), controller = new AbortController();
  const sources = async (input: { registerCleanup: (close: () => Promise<void>) => void }) => {
    entered.resolve(); await allocated.promise;
    input.registerCleanup(async () => { cleaning.resolve(); await cleaned.promise; });
    hostFail("HOST_CANCELLED");
  };
  const before = { ...f.counts };
  const running = kind === "full" ? runFullBaselineHost({ command: "publish", config: f.config, lockDirectory: f.options.lockDirectory,
    artifactDirectory: join(f.root, "first-full"), database: f.options.database, signal: controller.signal, durationMs: 10000 },
    { database: f.deps.database, sources }) : runIncrementalHost({ ...f.options, command: "run", signal: controller.signal }, { ...f.deps, sources });
  try {
    await entered.promise; controller.abort(); await Promise.resolve();
    await access(join(f.options.lockDirectory, "worker.lock"));
    await assert.rejects(acquireLock(f.options.lockDirectory, randomUUID()), { code: "BUSY" });
    allocated.resolve(); await cleaning.promise;
    await access(join(f.options.lockDirectory, "worker.lock"));
    assert.ok(f.counts.closed < f.counts.pools);
    cleaned.resolve(); const report = await running;
    assert.equal(report.outcome, "cancelled"); assert.equal(f.counts.sourceCalls, before.sourceCalls);
    assert.equal(f.counts.closed, f.counts.pools); await assert.rejects(access(join(f.options.lockDirectory, "worker.lock")));
  } finally { allocated.resolve(); cleaned.resolve(); await running; }
});
