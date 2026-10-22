import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, realpath, mkdir, writeFile, readFile, readdir, chmod, rm, copyFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
const adapter = new URL("../scripts/website-sync/run-private.mjs", import.meta.url).pathname;
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "website-runtime-"))); await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  // Hosted toolcache binaries need not satisfy a private release's permissions.
  const nodePath = join(root, "node");
  await copyFile(await realpath(process.execPath), nodePath, constants.COPYFILE_FICLONE); await chmod(nodePath, 0o700);
  const project = join(root, "release"), inputs = join(root, "inputs"), state = join(inputs, "state"), cache = join(root, "image-cache");
  for (const dir of [project, inputs, state, cache]) await mkdir(dir, { mode: 0o700 });
  await mkdir(join(inputs, "bin"), { mode: 0o700 });
  await writeFile(join(inputs, "notion-readonly.env"), 'NOTION_TOKEN="fake"\n', { mode: 0o600 });
  await writeFile(join(inputs, "supabase-worker.env"), 'SYNC_DATABASE_URL="fixture-only"\nSTORAGE_URL="fixture-only"\nSTORAGE_API_KEY="fixture-only"\nSTORAGE_BUCKET="fixture-only"\nSYNC_MEDIA_PROVIDER="storage"\nNODE_OPTIONS="fixture-must-not-be-forwarded"\n', { mode: 0o600 });
  const readerEnv = join(inputs, "reader.env"); await writeFile(readerEnv, 'DATABASE_READER_URL="fixture-only"\n', { mode: 0o600 });
  const source = "{}", sourcesFile = join(inputs, "website-sources.json"); await writeFile(sourcesFile, source, { mode: 0o600 });
  const refresh = "throw new Error('Offline and stub-child tests must not refresh');", converter = "fixture-converter";
  await writeFile(join(inputs, "refresh-writer-session.mjs"), refresh, { mode: 0o600 }); await writeFile(join(inputs, "bin/heic-to-jpeg"), converter, { mode: 0o700 });
  const script = `import {writeFileSync} from 'node:fs';import {join} from 'node:path';const mode=process.argv[process.argv.indexOf('--mode')+1];writeFileSync(join(process.env.WEBSITE_OUTPUT_DIR,'receipt-private.json'),JSON.stringify({runId:process.env.WEBSITE_RUN_ID,mode,published:false,readerVerified:false,promoteRequested:false,outcome:mode}),{mode:384});console.log(JSON.stringify({child:true,mode,cache:!!process.env.SYNC_IMAGE_CACHE_DIRECTORY,source:!!process.env.WEBSITE_SOURCE_SHA256,inherited:!!process.env.HOST_SECRET_EXAMPLE,nodeOptions:!!process.env.NODE_OPTIONS}));`;
  const files: string[] = ["scripts/website-sync/run.ts", "scripts/website-sync/run-private.mjs", "scripts/website-sync/release.mjs", "scripts/website-sync/runtime-reader.ts", "scripts/website-sync/download.ts", "scripts/website-sync/image-cache.ts", "package-lock.json", "database/website-protocol.json", "database/website-media-protocol.json", "src/server/database/publication.ts", "database/publication-protocol.json", "src/app/[slug]/page.tsx", "src/app/[...segments]/page.tsx"];
  for (const path of files) { await mkdir(dirname(join(project, path)), { recursive: true }); await writeFile(join(project, path), path.endsWith("/run.ts") ? script : "fixture", { mode: 0o644 }); }
  const manifest = join(root, "manifest-private.json");
  const saveManifest = async () => writeFile(manifest, JSON.stringify({ format: "website-v2-release-1", commit: "a".repeat(40), nodePath, nodeVersion: process.versions.node,
    nodeSha256: hash(await readFile(nodePath)), files: await Promise.all(files.map(async path => ({ path, sha256: hash(await readFile(join(project, path))) }))) }), { mode: 0o600 });
  await saveManifest();
  const configFile = join(root, "runtime-private.json"), config = { format: "website-v2-runtime-1", project, manifest, privateRoot: inputs, stateDir: state, sourcesFile, sourceSha256: hash(source),
    cacheDirectory: cache, readerEnv, refreshSha256: hash(refresh), converterSha256: hash(converter), timeoutSeconds: 1, maxMediaBytes: 1024 };
  const saveConfig = async () => writeFile(configFile, JSON.stringify(config), { mode: 0o600 }); await saveConfig();
  return { root, project, inputs, state, cache, nodePath, config, configFile, files, saveConfig, saveManifest, args: [nodePath, adapter, "--config", configFile] };
}
async function invoke(args: string[]) {
  return new Promise<{ code: number | null; out: string; err: string }>((done, reject) => {
    const child = spawn(args[0], args.slice(1), { env: { ...process.env, HOST_SECRET_EXAMPLE: "fixture-only" }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = ""; child.stdout.on("data", x => { out += x; }); child.stderr.on("data", x => { err += x; });
    child.once("error", reject); child.once("close", code => done({ code, out, err }));
  });
}
async function clean(f: Awaited<ReturnType<typeof fixture>>) {
  assert.equal((await readdir(f.inputs)).some(n => n === "manual-run.lock" || n.startsWith(".website-runtime-env-")), false);
  assert.equal((await readdir(f.state)).includes("worker.lock"), false);
}
test("v2 offline check accepts Next.js dynamic route releases without locks, sessions, cache writes or child startup", async t => {
  const f = await fixture(t), result = await invoke([...f.args, "--mode", "publish", "--check"]);
  assert.equal(result.code, 0, result.err); const value = JSON.parse(result.out);
  assert.equal(value.offlineCheck, true); assert.equal(value.networkChecked, false); assert.equal(value.sessionRefreshed, false); assert.equal(value.workerStarted, false);
  assert.equal(value.publicationMode, "qualified"); assert.equal(value.mediaProvider, "notion");
  await clean(f); assert.deepEqual(await readdir(f.cache), []); assert.deepEqual(await readdir(f.state), []);
});
test("v2 child defaults to dry-run, receives explicit cache/source settings, and inherits no shell or input Node options", async t => {
  const f = await fixture(t), result = await invoke(f.args); assert.equal(result.code, 0, result.err);
  const child = JSON.parse(result.out.split("\n")[0]); assert.deepEqual(child, { child: true, mode: "dry-run", cache: true, source: true, inherited: false, nodeOptions: false }); await clean(f);
  const files = await readdir(join(f.state, "website-v2")); assert.ok(files.includes("latest-run-private.json")); assert.equal(files.includes("last-success-private.json"), false);
});
test("v2 host validates explicit request pacing and forwards only the bound runtime value", async t => {
  const f = await fixture(t), childPath = join(f.project, "scripts/website-sync/run.ts");
  await writeFile(childPath, (await readFile(childPath, "utf8")).replace("child:true,", "child:true,intervalMs:process.env.WEBSITE_NOTION_INTERVAL_MS,"));
  await f.saveManifest();
  Object.assign(f.config, { notionIntervalMs: 400 }); await f.saveConfig();
  const result = await invoke(f.args); assert.equal(result.code, 0, result.err);
  assert.equal(JSON.parse(result.out.split("\n")[0]).intervalMs, "400"); await clean(f);
  for (const value of [0, 349, 5001, 400.5, "400"]) {
    Object.assign(f.config, { notionIntervalMs: value }); await f.saveConfig();
    const invalid = await invoke([...f.args, "--check"]); assert.equal(invalid.code, 1); assert.equal(invalid.out.includes('"child"'), false); await clean(f);
  }
});
test("v2 host binds bounded collection concurrency and rejects invalid values before startup", async t => {
  const f = await fixture(t), childPath = join(f.project, "scripts/website-sync/run.ts");
  await writeFile(childPath, (await readFile(childPath, "utf8")).replace("child:true,", "child:true,concurrency:process.env.WEBSITE_COLLECTION_CONCURRENCY,"));
  await f.saveManifest();
  assert.equal(JSON.parse((await invoke(f.args)).out.split("\n")[0]).concurrency, "1");
  Object.assign(f.config, { collectionConcurrency: 4 }); await f.saveConfig();
  const result = await invoke(f.args); assert.equal(result.code, 0, result.err);
  assert.equal(JSON.parse(result.out.split("\n")[0]).concurrency, "4"); await clean(f);
  for (const value of [0, 5, 1.5, "4"]) {
    Object.assign(f.config, { collectionConcurrency: value }); await f.saveConfig();
    assert.equal((await invoke([...f.args, "--check"])).code, 1); await clean(f);
  }
});
test("v2 host binds capture opt-in and rejects non-boolean capture settings", async t => {
  const f = await fixture(t);
  await writeFile(join(f.project, "scripts/website-sync/run.ts"), "console.log(JSON.stringify({capture:process.env.WEBSITE_CAPTURE_COLLECTION}));");
  await f.saveManifest();
  const initial = await invoke(f.args);
  assert.equal(JSON.parse(initial.out.split("\n")[0]).capture, "false"); await clean(f);
  Object.assign(f.config, { captureCollection: true }); await f.saveConfig();
  const enabled = await invoke(f.args);
  assert.equal(JSON.parse(enabled.out.split("\n")[0]).capture, "true"); await clean(f);
  Object.assign(f.config, { captureCollection: "true" }); await f.saveConfig();
  assert.equal((await invoke([...f.args, "--check"])).code, 1); await clean(f);
});
test("persistent host mode requires stored originals, an extension release and a matching child receipt", async t => {
  const f = await fixture(t), path = join(f.inputs, "supabase-worker.env"), original = await readFile(path, "utf8");
  await writeFile(path, original + 'SYNC_PUBLICATION_MODE="published"\nSYNC_MEDIA_PROVIDER="notion"\n', { mode: 0o600 });
  assert.equal((await invoke([...f.args, "--check"])).code, 1); await clean(f);
  await writeFile(path, original + 'SYNC_PUBLICATION_MODE="invalid"\nSYNC_MEDIA_PROVIDER="storage"\n', { mode: 0o600 });
  assert.equal((await invoke([...f.args, "--check"])).code, 1); await clean(f);
  await writeFile(path, original + 'SYNC_PUBLICATION_MODE="published"\nSYNC_MEDIA_PROVIDER="storage"\n', { mode: 0o600 });
  const offline = await invoke([...f.args, "--check"]); assert.equal(offline.code, 0, offline.err);
  assert.equal(JSON.parse(offline.out).publicationMode, "published"); assert.equal(JSON.parse(offline.out).workerStarted, false);
  // An older child that ignores the new env flag cannot supply a success receipt.
  const ignored = await invoke(f.args); assert.equal(ignored.code, 1);
  assert.equal(JSON.parse(ignored.out.trim().split("\n").at(-1)!).requiresReceiptCheck, true); await clean(f);
  await writeFile(join(f.project, "scripts/website-sync/run.ts"), `import {writeFileSync} from 'node:fs';import {join} from 'node:path';
const e=process.env;writeFileSync(join(e.WEBSITE_OUTPUT_DIR,'receipt-private.json'),JSON.stringify({runId:e.WEBSITE_RUN_ID,mode:'dry-run',publicationMode:e.SYNC_PUBLICATION_MODE,mediaProvider:e.SYNC_MEDIA_PROVIDER,published:false,readerVerified:false,outcome:'dry-run'}),{mode:384});
console.log(JSON.stringify({publication:e.SYNC_PUBLICATION_MODE,media:e.SYNC_MEDIA_PROVIDER}));`);
  await f.saveManifest(); const ready = await invoke(f.args); assert.equal(ready.code, 0, ready.err);
  assert.deepEqual(JSON.parse(ready.out.split("\n")[0]), { publication: "published", media: "storage" }); await clean(f);
  const module = "src/server/database/publication.ts"; f.files.splice(f.files.indexOf(module), 1);
  await rm(join(f.project, module)); await f.saveManifest();
  assert.equal((await invoke([...f.args, "--check"])).code, 1); await clean(f);
});
test("v2 refuses altered sources, altered release code and a development checkout before child startup", async t => {
  const f = await fixture(t);
  await writeFile(f.config.sourcesFile, "[]"); assert.equal((await invoke([...f.args, "--check"])).code, 1); await writeFile(f.config.sourcesFile, "{}");
  await writeFile(join(f.project, "scripts/website-sync/run.ts"), "changed"); assert.equal((await invoke([...f.args, "--check"])).code, 1); await f.saveManifest();
  await writeFile(join(f.project, "unlisted.mjs"), "extra"); assert.equal((await invoke([...f.args, "--check"])).code, 1); await rm(join(f.project, "unlisted.mjs"));
  await writeFile(join(f.project, ".git"), "development marker"); const checkout = await invoke([...f.args, "--check"]); assert.equal(checkout.code, 1); assert.match(checkout.err, /RELEASE_INVALID/); await clean(f);
});
for (const name of ["manual", "worker", "session"]) test(`v2 refuses an existing ${name} lock without deleting it`, async t => {
  const f = await fixture(t), path = name === "manual" ? join(f.inputs, "manual-run.lock") : name === "worker" ? join(f.state, "worker.lock") : join(f.inputs, "writer-session.lock");
  await writeFile(path, "existing owner", { mode: 0o600 }); const result = await invoke([...f.args, "--mode", "publish"]);
  assert.equal(result.code, 75); assert.equal(await readFile(path, "utf8"), "existing owner"); assert.equal(result.out.includes('"child"'), false);
});
test("v2 rejects a separate business-lock namespace, permissive private files, and unsafe budgets", async t => {
  const f = await fixture(t); await chmod(f.nodePath, 0o720); assert.equal((await invoke([...f.args, "--check"])).code, 1); await chmod(f.nodePath, 0o700);
  await chmod(f.config.sourcesFile, 0o644); assert.equal((await invoke([...f.args, "--check"])).code, 1); await chmod(f.config.sourcesFile, 0o600);
  f.config.stateDir = f.cache; await f.saveConfig(); assert.equal((await invoke([...f.args, "--check"])).code, 1);
  f.config.stateDir = f.state; f.config.timeoutSeconds = 7200; await f.saveConfig(); assert.equal((await invoke([...f.args, "--check"])).code, 0);
  f.config.timeoutSeconds = 7201; await f.saveConfig(); assert.equal((await invoke([...f.args, "--check"])).code, 1); await clean(f);
});
test("v2 cancellation reaches child cleanup and releases only the host's own locks", async t => {
  const f = await fixture(t); f.config.timeoutSeconds = 30; await f.saveConfig();
  await writeFile(join(f.project, "scripts/website-sync/run.ts"), "const timer=setInterval(()=>{},1000);process.on('SIGTERM',()=>{clearInterval(timer);process.exitCode=23;});console.log('READY');"); await f.saveManifest();
  const child = spawn(f.args[0], f.args.slice(1), { detached: true, stdio: ["ignore", "pipe", "pipe"] }); let err = "";
  child.stderr.on("data", data => { err += data; });
  const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, reject) => { child.once("error", reject); child.once("close", (code, signal) => done({ code, signal })); });
  const terminate = () => { if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } } };
  t.after(async () => { terminate(); await ended.catch(() => {}); });
  await new Promise<void>((done, reject) => { const timer = setTimeout(() => { terminate(); reject(new Error("Child never started")); }, 5000);
    child.stdout.on("data", data => { if (data.toString().includes("READY")) { clearTimeout(timer); done(); } });
    ended.then(result => { clearTimeout(timer); reject(new Error(`Host exited before child startup: ${result.code}; ${err}`)); }, error => { clearTimeout(timer); reject(error); }); });
  child.kill("SIGTERM"); assert.deepEqual(await ended, { code: 23, signal: null }, err); await clean(f);
});
