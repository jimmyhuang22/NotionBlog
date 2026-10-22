import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { SYNC_SCHEMA_DIGEST, type StoredMedia } from "../contracts/sync.ts";
import { WEBSITE_SCHEMA_DIGEST } from "../contracts/website-sync.ts";
import { generateAndRegisterThumbnails, type ThumbnailBatchOptions } from "../scripts/media-thumbnails/batch.ts";
import { createVerifiedThumbnailCache } from "../scripts/media-thumbnails/cache.ts";
import { generateThumbnails, thumbnailEncodingRecipe } from "../scripts/media-thumbnails/encode.ts";
import { createThumbnailOriginalMirror } from "../scripts/media-thumbnails/original-mirror.ts";
import { initializeThumbnailBudgetLedger, openThumbnailBudgetAttempt, thumbnailPlanDigest } from "../scripts/media-thumbnails/budget.ts";
import { THUMBNAIL_CAPABILITY, readThumbnail, type ThumbnailWidth } from "../src/server/database/thumbnail-index.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";
import type { ObjectStorage } from "../src/server/database/storage.ts";
import { createSupabaseStorage, verifyMediaBytes } from "../src/server/database/storage.ts";
import { mediaIdentity } from "../src/server/database/validation.ts";
import { locatorIdentity, sourceFingerprint, type MediaSourceBinding, type MediaSourceVersion } from "../src/server/media/notion-source.ts";

const RUN = "00000000-0000-4000-8000-000000000001";
const NEXT_RUN = "00000000-0000-4000-8000-000000000002";
const OWNER = "00000000000000000000000000000010";
const BLOCK = "00000000000000000000000000000020";
const SOURCE_URL = "https://images.example.test/synthetic.png";
const controlled = (error: unknown) => error instanceof Error && "code" in error && error.code === "CONTENT_UNAVAILABLE" && !error.message.includes(SOURCE_URL);

test("selected caps use local originals for both delivery types and resume without rereading originals",async t=>{
  for(const delivery of ["notion","storage"] as const)await t.test(delivery,async()=>{
    const f=await fixture({delivery});
    const root=await realpath(await mkdtemp(join(tmpdir(),"nb-batch-mirror-")));
    try {
      await writeFile(join(root,f.state.parent.sha256),f.bytes,{mode:0o600});
      const read=await createThumbnailOriginalMirror(root);let localReads=0;
      f.state.objects.delete(f.state.parent.objectKey);
      const widthCap=delivery==="notion"?400:800;
      const options:ThumbnailBatchOptions={...f.options,widths:{format:"notionblog-thumbnail-widths-v1",
        version:f.options.version,runId:RUN,assets:[{assetId:f.assetId,widthCaps:[widthCap]}]},
        readOriginal:async(media,signal)=>{localReads++;return read(media,signal);}};
      const first=await generateAndRegisterThumbnails(options);
      assert.equal(first.registered,1);assert.deepEqual([...f.state.mappings.keys()],[widthCap]);
      assert.equal(f.state.downloads,0);assert.equal(localReads,1);assert.equal(f.state.puts,1);
      await rm(join(root,f.state.parent.sha256));
      const second=await generateAndRegisterThumbnails(options);
      assert.equal(second.alreadyPresent,1);assert.equal(second.registered,0);assert.equal(second.uploadAttemptBytes,0);
      assert.equal(localReads,1);assert.equal(f.state.downloads,0);assert.equal(f.state.puts,1);
    } finally {await rm(root,{recursive:true,force:true});}
  });
});

test("failed local original reads remain charged with no network fallback or writes",async()=>{
  const f=await fixture();const allocation=await executionAllocation(f.options);
  const budget=await openThumbnailBudgetAttempt(allocation.file,allocation.plan);
  try {
    const report=generateAndRegisterThumbnails({...f.options,budget,readOriginal:async()=>{
      assert.equal(budget.snapshot().totalOriginalBytes,f.bytes.length);
      throw new Error("Synthetic mirror unavailable");
    }});
    await assert.rejects(report,controlled);
    assert.equal(f.state.downloads,0);assert.equal(f.state.puts,0);assert.equal(f.state.writes,0);
    assert.equal(budget.snapshot().totalOriginalBytes,f.bytes.length);
  } finally {await budget.close();await allocation.cleanup();}
});

test("local bytes cannot authorize a withdrawn or changed source and unused caps are never queried",async t=>{
  for(const mode of ["withdrawn","fingerprint","corrupt","unused-cap"] as const)await t.test(mode,async()=>{
    const f=await fixture();
    const query=f.options.db.query.bind(f.options.db);
    f.options.db={query:async<T>(text:string,parameters?:unknown[])=>{
      assert.equal(parameters?.[2],800,"only the requested projection is read");return query<T>(text,parameters);
    }};
    f.options.widths={format:"notionblog-thumbnail-widths-v1",version:f.options.version,runId:RUN,
      assets:[{assetId:f.assetId,widthCaps:[800]}]};
    f.options.readOriginal=async()=>{
      if(mode==="withdrawn")f.state.eligible=false;
      if(mode==="fingerprint")f.state.liveFingerprint="c".repeat(64);
      return mode==="corrupt"?new Uint8Array(f.bytes.length):f.bytes;
    };
    if(mode==="unused-cap")assert.equal((await generateAndRegisterThumbnails(f.options)).registered,1);
    else {await assert.rejects(generateAndRegisterThumbnails(f.options),controlled);assert.equal(f.state.puts,0);assert.equal(f.state.writes,0);}
    assert.equal(f.state.downloads,0);
  });
});

async function fixture(settings: { version?: MediaSourceVersion; delivery?: "notion" | "storage"; animated?: boolean; seed?: number;
  bytes?: Buffer; mime?: StoredMedia["mime"] } = {}) {
  const version = settings.version ?? "v1";
  const animated = settings.animated ?? false;
  const seed = settings.seed ?? 0;
  const url = seed ? `${SOURCE_URL}?sample=${seed}` : SOURCE_URL;
  const raw = Buffer.alloc(32 * 16 * 4);
  for (let index = 0; index < raw.length; index += 4) {
    raw[index] = (index + seed) % 251; raw[index + 1] = 70; raw[index + 2] = 170; raw[index + 3] = 255;
  }
  const pipeline = sharp(raw, { raw: { width: 32, height: 16, channels: 4, ...(animated ? { pageHeight: 8 } : {}) } });
  const bytes = settings.bytes ?? (animated ? await pipeline.gif({ delay: [100, 100] }).toBuffer() : await pipeline.png().toBuffer());
  const hash = createHash("sha256").update(bytes).digest("hex");
  const locator = { kind: "block" as const, id: BLOCK };
  const assetId = mediaIdentity(OWNER, locatorIdentity(locator, version), hash);
  const parent: StoredMedia = { assetId, ownerPageId: OWNER, objectKey: `sha256/${hash}`, sha256: hash, byteSize: bytes.length, mime: settings.mime ?? (animated ? "image/gif" : "image/png"), width: null, height: null };
  const binding: MediaSourceBinding = { assetId, ownerPageId: OWNER, sha256: hash, locator, delivery: settings.delivery ?? "notion", sourceFingerprint: sourceFingerprint(url, false) };
  const state = {
    runId: RUN,
    parent,
    binding,
    eligible: true,
    liveUrl: url,
    liveFingerprint: binding.sourceFingerprint,
    mappings: new Map<ThumbnailWidth, StoredMedia>(),
    objects: new Map<string, Uint8Array>(),
    reads: 0,
    writes: 0,
    puts: 0,
    storageReads: 0,
    downloads: 0,
    resolves: 0,
    onRead: undefined as (() => void | Promise<void>) | undefined,
    onDownload: undefined as (() => void | Promise<void>) | undefined,
    onResolve: undefined as (() => void | Promise<void>) | undefined,
    onPut: undefined as (() => void | Promise<void>) | undefined,
    onRegister: undefined as (() => void | Promise<void>) | undefined,
    onStorageRead: undefined as (() => void | Promise<void>) | undefined,
    downloadedBytes: bytes as Uint8Array,
  };
  if (binding.delivery === "storage") state.objects.set(parent.objectKey, Uint8Array.from(bytes));
  const db: SqlExecutor = {
    async query<T>(sql: string, values?: unknown[]) {
      assert.ok(sql.includes("nb_thumbnail_api.read_media("), "reader cannot perform writes");
      state.reads++; await state.onRead?.();
      assert.equal(values?.[0], version); assert.equal(values?.[1], assetId);
      const widthCap = values?.[2] as ThumbnailWidth;
      const result = state.eligible ? {
        thumbnailCapability: THUMBNAIL_CAPABILITY,
        schemaDigest: version === "v1" ? SYNC_SCHEMA_DIGEST : WEBSITE_SCHEMA_DIGEST,
        version,
        runId: state.runId,
        source: { media: structuredClone(state.parent), binding: structuredClone(state.binding) },
        thumbnail: structuredClone(state.mappings.get(widthCap) ?? null),
      } : null;
      return { rows: [{ result } as T] };
    },
  };
  const registrationDb: SqlExecutor = {
    async query<T>(sql: string, values?: unknown[]) {
      assert.ok(sql.includes("nb_thumbnail_api.register_media("), "writer cannot read published projections");
      state.writes++;
      if (values?.[0] !== version || values?.[1] !== state.runId || values?.[2] !== assetId ||
          values?.[3] !== state.parent.sha256 || values?.[4] !== state.binding.sourceFingerprint || !state.eligible) {
        throw new Error("Synthetic registration race");
      }
      const widthCap = values?.[5] as ThumbnailWidth;
      const thumbnail = JSON.parse(values?.[6] as string) as StoredMedia;
      const prior = state.mappings.get(widthCap);
      if (prior && JSON.stringify(prior) !== JSON.stringify(thumbnail)) throw new Error("Synthetic immutable conflict");
      state.mappings.set(widthCap, thumbnail);
      await state.onRegister?.();
      return { rows: [{ result: null } as T] };
    },
  };
  const storage: ObjectStorage = {
    async read(media) {
      state.storageReads++;
      const data = state.objects.get(media.objectKey);
      if (!data) throw new Error("Synthetic missing object");
      verifyMediaBytes(media, data);
      await state.onStorageRead?.();
      return Uint8Array.from(data);
    },
    async put(media, data) {
      state.puts++;
      verifyMediaBytes(media, data);
      const prior = state.objects.get(media.objectKey);
      if (prior) verifyMediaBytes(media, prior);
      else state.objects.set(media.objectKey, Uint8Array.from(data));
      await state.onPut?.();
    },
  };
  const options: ThumbnailBatchOptions = {
    version, runId: RUN, assetIds: [assetId], db, registrationDb, storage,
    resolve: async candidate => {
      state.resolves++;
      assert.equal(candidate.assetId, assetId);
      await state.onResolve?.();
      return state.eligible ? { url: state.liveUrl, sourceFingerprint: state.liveFingerprint } : null;
    },
    download: async url => {
      state.downloads++;
      assert.equal(url, state.liveUrl);
      await state.onDownload?.();
      return { bytes: Uint8Array.from(state.downloadedBytes), mime: state.parent.mime };
    },
  };
  return { state, options, bytes, assetId };
}

test("v1/v2 batches register both profiles with reader/writer separation and resume without original downloads", async t => {
  for (const version of ["v1", "v2"] as const) await t.test(version, async () => {
    const { state, options, bytes } = await fixture({ version });
    const progress: unknown[] = [];
    const report = await generateAndRegisterThumbnails({ ...options, onProgress: current => { progress.push(current); } });
    assert.equal(report.processed, 1); assert.equal(report.registered, 2); assert.equal(report.alreadyPresent, 0); assert.equal(report.skipped, 0);
    assert.equal(state.downloads, 1); assert.equal(state.writes, 2); assert.equal(state.puts, 1, "identical tiny outputs share one immutable object");
    assert.equal(state.mappings.size, 2);
    const four = state.mappings.get(400)!, eight = state.mappings.get(800)!;
    assert.equal(four.sha256, eight.sha256); assert.notEqual(four.assetId, eight.assetId);
    assert.equal(report.thumbnailBytes, four.byteSize + eight.byteSize);
    assert.equal(report.uploadAttemptBytes, four.byteSize);
    assert.equal(state.objects.has(state.parent.objectKey), false, "ordinary originals are not uploaded");
    assert.equal(createHash("sha256").update(bytes).digest("hex"), state.parent.sha256);
    assert.deepEqual(progress, [report]);
    const beforeDownloads = state.downloads, beforePuts = state.puts;
    const resumed = await generateAndRegisterThumbnails(options);
    assert.deepEqual(resumed, { processed: 1, registered: 0, alreadyPresent: 2, skipped: 0, notSmaller: 0, thumbnailBytes: four.byteSize + eight.byteSize, uploadAttemptBytes: 0 });
    assert.equal(state.downloads, beforeDownloads); assert.equal(state.puts, beforePuts);
    assert.ok(state.storageReads >= 3);
    assert.deepEqual(Object.keys(report).sort(), ["alreadyPresent", "processed", "registered", "skipped", "notSmaller", "thumbnailBytes", "uploadAttemptBytes"].sort());
  });
});

test("new v1/v2 runs re-register verified previews with no original download or upload body", async t => {
  for (const version of ["v1", "v2"] as const) await t.test(version, async () => {
    const {state, options} = await fixture({version});
    const cache = createVerifiedThumbnailCache(thumbnailEncodingRecipe());
    await generateAndRegisterThumbnails({...options, cache});
    const before = {downloads:state.downloads, puts:state.puts, writes:state.writes, objects:state.objects.size};
    state.runId = NEXT_RUN; state.mappings.clear();
    const restored = createVerifiedThumbnailCache(thumbnailEncodingRecipe(), JSON.parse(JSON.stringify(cache.snapshot())));
    const report = await generateAndRegisterThumbnails({...options, runId:NEXT_RUN, cache:restored, maxBytes:1});
    assert.equal(report.registered, 2); assert.equal(report.alreadyPresent, 0); assert.equal(report.uploadAttemptBytes, 0);
    assert.equal(state.downloads, before.downloads); assert.equal(state.puts, before.puts);
    assert.equal(state.objects.size, before.objects); assert.equal(state.writes, before.writes + 2);
    const retry = await generateAndRegisterThumbnails({...options, runId:NEXT_RUN, cache:restored});
    assert.equal(retry.registered, 0); assert.equal(retry.alreadyPresent, 2); assert.equal(retry.uploadAttemptBytes, 0);
    assert.equal(state.downloads, before.downloads); assert.equal(state.puts, before.puts);
  });
});

test("a zero image budget reuses a cached cap in a new run and rejects a missing cap before original I/O", async () => {
  const f = await fixture({version:"v2"}), cache = createVerifiedThumbnailCache(thumbnailEncodingRecipe());
  const widths = {format:"notionblog-thumbnail-widths-v1" as const,version:f.options.version,runId:RUN,
    assets:[{assetId:f.assetId,widthCaps:[400 as const]}]};
  await generateAndRegisterThumbnails({...f.options,widths,cache});
  const before = {downloads:f.state.downloads,puts:f.state.puts,writes:f.state.writes};
  f.state.runId=NEXT_RUN;f.state.mappings.clear();let localReads=0;
  const options:ThumbnailBatchOptions={...f.options,runId:NEXT_RUN,cache,
    widths:{...widths,runId:NEXT_RUN},readOriginal:async()=>{localReads++;return f.bytes;}};
  const allocation=await executionAllocation(options,{maxOriginalBytes:0,maxUploadRequests:0,maxUploadBodyBytes:0,
    maxTotalOriginalBytes:0,maxTotalUploadRequests:0,maxTotalUploadBodyBytes:0});
  let guard=await openThumbnailBudgetAttempt(allocation.file,allocation.plan);
  try {
    const report=await generateAndRegisterThumbnails({...options,budget:guard});
    assert.equal(report.registered,1);assert.equal(report.uploadAttemptBytes,0);
    assert.equal(f.state.writes,before.writes+1);
    assert.equal(guard.snapshot().totalOriginalBytes,0);assert.equal(guard.snapshot().totalUploadRequests,0);
    assert.equal(guard.snapshot().totalUploadBodyBytes,0);
    await guard.close();guard=await openThumbnailBudgetAttempt(allocation.file,allocation.plan);
    const missing={...options,widths:{...widths,runId:NEXT_RUN,assets:[{assetId:f.assetId,widthCaps:[800 as const]}]}};
    await assert.rejects(generateAndRegisterThumbnails({...missing,budget:guard}),controlled);
    assert.equal(f.state.downloads,before.downloads);assert.equal(localReads,0);assert.equal(f.state.puts,before.puts);
    assert.equal(f.state.writes,before.writes+1);assert.equal(guard.snapshot().totalOriginalBytes,0);
    assert.equal(guard.snapshot().totalUploadRequests,0);assert.equal(guard.snapshot().totalUploadBodyBytes,0);
    assert.equal(guard.snapshot().attemptCount,2,"failed reuse retains its attempt instead of refunding it");
  } finally {await guard.close();await allocation.cleanup();}
});

test("only changed parent/source identities and encoder recipes miss the reusable candidates", async t => {
  for (const mode of ["parent", "fingerprint", "recipe"] as const) await t.test(mode, async () => {
    const first = await fixture({seed:1});
    const cache = createVerifiedThumbnailCache(thumbnailEncodingRecipe());
    await generateAndRegisterThumbnails({...first.options, cache});
    const current = mode === "parent" ? await fixture({seed:2}) : first;
    current.state.runId = NEXT_RUN; current.state.mappings.clear();
    if (mode === "fingerprint") {
      current.state.binding.sourceFingerprint = sourceFingerprint(`${SOURCE_URL}?new-source=1`, false);
      current.state.liveFingerprint = current.state.binding.sourceFingerprint;
    }
    const snapshot = JSON.parse(JSON.stringify(cache.snapshot()));
    if (mode === "recipe") snapshot.recipe = "webp-older-recipe";
    const restored = createVerifiedThumbnailCache(thumbnailEncodingRecipe(), snapshot);
    const downloads = current.state.downloads, puts = current.state.puts;
    const report = await generateAndRegisterThumbnails({...current.options, runId:NEXT_RUN, cache:restored});
    assert.equal(report.registered, 2); assert.ok(report.uploadAttemptBytes > 0);
    assert.equal(current.state.downloads, downloads + 1); assert.ok(current.state.puts > puts);
  });
});

test("cached previews still refuse revoked, changed, missing, corrupt or denied sources/objects", async t => {
  for (const mode of ["withdrawn", "stale-plan", "live", "read-run", "read-withdrawal", "missing", "bad-bytes", "permission"] as const) await t.test(mode, async () => {
    const {state, options} = await fixture();
    const cache = createVerifiedThumbnailCache(thumbnailEncodingRecipe());
    await generateAndRegisterThumbnails({...options, cache});
    const thumbnail = state.mappings.get(400)!;
    const before = {downloads:state.downloads, puts:state.puts, writes:state.writes};
    state.runId = NEXT_RUN; state.mappings.clear();
    if (mode === "withdrawn") state.eligible = false;
    if (mode === "live") state.liveFingerprint = "b".repeat(64);
    if (mode === "read-run") state.onStorageRead = () => {state.runId = RUN;};
    if (mode === "read-withdrawal") state.onStorageRead = () => {state.eligible = false;};
    if (mode === "missing") state.objects.delete(thumbnail.objectKey);
    if (mode === "bad-bytes") state.objects.set(thumbnail.objectKey, new Uint8Array(thumbnail.byteSize));
    if (mode === "permission") options.storage = {put:options.storage.put, read:async () => {throw new Error(`Private denied ${SOURCE_URL}`);}};
    await assert.rejects(generateAndRegisterThumbnails({...options, cache, runId:mode === "stale-plan" ? RUN : NEXT_RUN}), controlled);
    assert.equal(state.puts, before.puts); assert.equal(state.downloads, before.downloads); assert.equal(state.writes, before.writes);
  });
});

test("legacy mappings without encoder provenance are verified but do not seed reusable candidates", async () => {
  const {state, options} = await fixture();
  await generateAndRegisterThumbnails(options);
  const cache = createVerifiedThumbnailCache(thumbnailEncodingRecipe());
  const report = await generateAndRegisterThumbnails({...options, cache});
  assert.equal(report.alreadyPresent, 2);
  state.runId = NEXT_RUN; state.mappings.clear();
  const downloads = state.downloads;
  const next = await generateAndRegisterThumbnails({...options, runId:NEXT_RUN, cache});
  assert.equal(next.registered, 2); assert.equal(state.downloads, downloads + 1); assert.ok(next.uploadAttemptBytes > 0);
});

test("converted parents read Storage after live source validation and never download the source original", async () => {
  const { state, options } = await fixture({ delivery: "storage" });
  const report = await generateAndRegisterThumbnails(options);
  assert.equal(report.registered, 2); assert.equal(state.downloads, 0); assert.ok(state.storageReads >= 2);
});

test("stale run, withdrawal and source changes before upload prevent registration", async t => {
  for (const mode of ["wrong-run", "resolve-race", "download-run", "download-binding", "download-live", "withdrawal"] as const) await t.test(mode, async () => {
    const { state, options } = await fixture();
    if (mode === "wrong-run") state.runId = NEXT_RUN;
    if (mode === "resolve-race") state.onResolve = () => { state.runId = NEXT_RUN; };
    state.onDownload = () => {
      if (mode === "download-run") state.runId = NEXT_RUN;
      if (mode === "download-binding") state.binding.sourceFingerprint = "b".repeat(64);
      if (mode === "download-live") state.liveFingerprint = "b".repeat(64);
      if (mode === "withdrawal") state.eligible = false;
    };
    await assert.rejects(generateAndRegisterThumbnails(options), controlled);
    assert.equal(state.puts, 0); assert.equal(state.writes, 0);
    if (mode === "wrong-run" || mode === "resolve-race") assert.equal(state.downloads, 0);
  });
});

test("publication, live source and permission changes after object upload reject before registration", async t => {
  for (const mode of ["run", "live", "withdrawal"] as const) await t.test(mode, async () => {
    const { state, options } = await fixture();
    state.onPut = () => {
      if (mode === "run") state.runId = NEXT_RUN;
      if (mode === "live") state.liveFingerprint = "b".repeat(64);
      if (mode === "withdrawal") state.eligible = false;
    };
    await assert.rejects(generateAndRegisterThumbnails(options), controlled);
    assert.equal(state.puts, 1); assert.equal(state.writes, 0); assert.equal(state.mappings.size, 0);
  });
});

test("source change after registration rejects instead of reporting a complete batch", async () => {
  const { state, options } = await fixture();
  state.onRegister = () => { state.liveFingerprint = "b".repeat(64); };
  await assert.rejects(generateAndRegisterThumbnails(options), controlled);
  assert.equal(state.writes, 1); assert.equal(state.mappings.size, 1);
});

test("partial registration resumes from the verified mapping without reuploading identical objects", async () => {
  const { state, options } = await fixture();
  state.onRegister = () => { state.liveFingerprint = "b".repeat(64); };
  await assert.rejects(generateAndRegisterThumbnails(options), controlled);
  assert.equal(state.mappings.size, 1);
  state.onRegister = undefined;
  state.liveFingerprint = state.binding.sourceFingerprint;
  const puts = state.puts;
  const report = await generateAndRegisterThumbnails(options);
  assert.equal(report.processed, 1); assert.equal(report.alreadyPresent, 1); assert.equal(report.registered, 1);
  assert.equal(report.uploadAttemptBytes, 0); assert.equal(state.puts, puts); assert.equal(state.mappings.size, 2);
});

test("successful upload responses with bad readback bytes never register a thumbnail", async () => {
  const { state, options } = await fixture();
  state.onPut = () => {
    for (const [key, value] of state.objects) state.objects.set(key, new Uint8Array(value.byteLength));
  };
  await assert.rejects(generateAndRegisterThumbnails(options), controlled);
  assert.equal(state.puts, 1); assert.equal(state.writes, 0); assert.equal(state.mappings.size, 0);
});

test("original hash, MIME and budget mismatch never uploads a derivative", async t => {
  for (const mode of ["sha", "mime", "budget"] as const) await t.test(mode, async () => {
    const { state, options } = await fixture();
    if (mode === "sha") { state.downloadedBytes = Uint8Array.from(state.downloadedBytes); state.downloadedBytes[state.downloadedBytes.length - 1] ^= 1; }
    if (mode === "mime") options.download = async () => ({ bytes: state.downloadedBytes, mime: "image/jpeg" });
    if (mode === "budget") options.maxBytes = state.parent.byteSize - 1;
    await assert.rejects(generateAndRegisterThumbnails(options), controlled);
    assert.equal(state.puts, 0); assert.equal(state.writes, 0);
    if (mode === "budget") assert.equal(state.downloads, 0);
  });
});

test("the total original budget carries across assets and stops before another download", async () => {
  const first = await fixture({ seed: 1 }), second = await fixture({ seed: 2 });
  const fixtures = [first, second];
  const forAsset = (id: unknown) => fixtures.find(value => value.assetId === id)!;
  const progress: unknown[] = [];
  const db: SqlExecutor = { query: <T>(sql: string, values?: unknown[]) => forAsset(values?.[1]).options.db.query<T>(sql, values) };
  const registrationDb: SqlExecutor = { query: <T>(sql: string, values?: unknown[]) => forAsset(values?.[2]).options.registrationDb.query<T>(sql, values) };
  const options: ThumbnailBatchOptions = {
    ...first.options,
    db,
    registrationDb,
    assetIds: fixtures.map(value => value.assetId),
    maxBytes: first.bytes.byteLength + second.bytes.byteLength - 1,
    resolve: binding => forAsset(binding.assetId).options.resolve(binding),
    download: url => fixtures.find(value => value.state.liveUrl === url)!.options.download!(url),
    onProgress: value => { progress.push(value); },
  };
  await assert.rejects(generateAndRegisterThumbnails(options), controlled);
  assert.equal(first.state.downloads, 1); assert.equal(second.state.downloads, 0);
  assert.equal(first.state.mappings.size, 2); assert.equal(second.state.mappings.size, 0);
  assert.equal(progress.length, 1);
});

test("unsupported animation preserves the original and records an explicit skip", async () => {
  const { state, options } = await fixture({ animated: true });
  assert.equal((await sharp(state.downloadedBytes, { animated: true }).metadata()).pages, 2);
  const report = await generateAndRegisterThumbnails(options);
  assert.deepEqual(report, { processed: 1, registered: 0, alreadyPresent: 0, skipped: 1, notSmaller: 0, thumbnailBytes: 0, uploadAttemptBytes: 0 });
  assert.equal(state.puts, 0); assert.equal(state.writes, 0); assert.equal(state.mappings.size, 0);
});

test("existing mappings with missing or changed bytes fail instead of silently regenerating", async t => {
  for (const mode of ["missing", "bad-bytes", "permission"] as const) await t.test(mode, async () => {
    const { state, options } = await fixture();
    await generateAndRegisterThumbnails(options);
    const mapped = state.mappings.get(400)!;
    if (mode === "missing") state.objects.delete(mapped.objectKey);
    if (mode === "bad-bytes") state.objects.set(mapped.objectKey, new Uint8Array(mapped.byteSize));
    if (mode === "permission") options.storage = { put: options.storage.put, read: async () => { throw new Error(`Private denied ${SOURCE_URL}`); } };
    const puts = state.puts, writes = state.writes, downloads = state.downloads;
    await assert.rejects(generateAndRegisterThumbnails(options), controlled);
    assert.equal(state.puts, puts); assert.equal(state.writes, writes); assert.equal(state.downloads, downloads);
  });
});

test("unsafe live URLs reject even when the resolver is injected", async () => {
  for (const url of ["http://images.example.test/a", "https://localhost/a", "https://user:pass@images.example.test/a", "https://images.example.test:444/a", "https://images.example.test/a#fragment", "https://images.example.test./a"]) {
    const { state, options } = await fixture();
    state.liveUrl = url;
    await assert.rejects(generateAndRegisterThumbnails(options), controlled);
    assert.equal(state.puts, 0); assert.equal(state.downloads, 0);
  }
});

test("empty, duplicate, malformed and oversized selections or elevated budgets reject before I/O", async () => {
  const { state, options, assetId } = await fixture();
  const sparse = Array<string>(2); sparse[0] = assetId;
  for (const assetIds of [[], [assetId, assetId], ["invalid"], sparse, Array(20_001).fill(assetId)]) {
    await assert.rejects(generateAndRegisterThumbnails({ ...options, assetIds }), error => error instanceof Error && "code" in error && error.code === "MISCONFIGURED");
  }
  for (const maxBytes of [0, 1024 * 1024 * 1024 + 1, Number.NaN]) {
    await assert.rejects(generateAndRegisterThumbnails({ ...options, maxBytes }), error => error instanceof Error && "code" in error && error.code === "MISCONFIGURED");
  }
  assert.equal(state.reads, 0); assert.equal(state.puts, 0);
});

async function executionAllocation(options: ThumbnailBatchOptions, tightened: Record<string, number> = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "thumbnail-batch-budget-")));
  const plan = {version: options.version, runId: options.runId, assetIds: options.assetIds};
  const file = join(directory, "allocation.json");
  await writeFile(file, JSON.stringify({format:"notionblog-thumbnail-execution-budget-v1",
    budgetId:"00000000-0000-4000-8000-000000000099",version:plan.version,runId:plan.runId,
    planSHA256:[thumbnailPlanDigest(plan)],limits:{maxParents:3,maxOriginalBytes:64*1024**2,
      maxUploadRequests:6,maxUploadBodyBytes:2*1024**2,maxDurationSeconds:60,
      maxTotalParentAttempts:9,maxTotalOriginalBytes:128*1024**2,maxTotalUploadRequests:18,
      maxTotalUploadBodyBytes:6*1024**2,maxTotalReservedDurationSeconds:180,...tightened}}),{mode:0o600});
  await initializeThumbnailBudgetLedger(file);
  return {file,plan,cleanup:()=>rm(directory,{recursive:true,force:true})};
}

async function compressedJpegFixture(quality: number) {
  const raw = Buffer.alloc(800 * 500 * 3);
  let seed = 14309;
  for (let index = 0; index < raw.length; index++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    raw[index] = seed >>> 24;
  }
  const bytes = await sharp(raw, { raw: { width: 800, height: 500, channels: 3 } }).jpeg({ quality, mozjpeg: true }).toBuffer();
  return fixture({ bytes, mime: "image/jpeg" });
}

test("each width cap independently requires smaller bytes before upload, budget charge and registration", async () => {
  const f = await compressedJpegFixture(30);
  const encoded = await generateThumbnails(f.bytes);
  const four = encoded.find(output => output.widthCap === 400)!;
  const eight = encoded.find(output => output.widthCap === 800)!;
  assert.ok(four.byteSize < f.bytes.length);
  assert.ok(eight.byteSize > f.bytes.length);
  const allocation = await executionAllocation(f.options, { maxUploadRequests: 1, maxTotalUploadRequests: 1 });
  const budget = await openThumbnailBudgetAttempt(allocation.file, allocation.plan);
  try {
    const report = await generateAndRegisterThumbnails({ ...f.options, budget });
    assert.equal(report.processed, 1); assert.equal(report.registered, 1);
    assert.equal(report.notSmaller, 1); assert.equal(report.skipped, 0);
    assert.equal(report.thumbnailBytes, four.byteSize); assert.equal(report.uploadAttemptBytes, four.byteSize);
    assert.equal(f.state.puts, 1); assert.equal(f.state.writes, 1);
    assert.equal(f.state.mappings.get(400)?.sha256, four.sha256);
    assert.equal(f.state.mappings.has(800), false);
    const fallback = await readThumbnail(f.options.db, f.options.version, f.assetId, 800);
    assert.equal(fallback?.thumbnail, null); assert.deepEqual(fallback?.source.media, f.state.parent);
    assert.equal(budget.snapshot().totalUploadRequests, 1);
    assert.equal(budget.snapshot().totalUploadBodyBytes, four.byteSize);
  } finally { await budget.close(); await allocation.cleanup(); }
});

test("equal or larger fresh outputs retain both original fallbacks without upload or upload allocation", async t => {
  for (const mode of ["larger", "equal"] as const) await t.test(mode, async () => {
    const f = mode === "larger" ? await compressedJpegFixture(10) : await fixture({
      bytes: await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 30, b: 80 } } }).webp({ lossless: true }).toBuffer(),
      mime: "image/webp",
    });
    const encoded = await generateThumbnails(f.bytes);
    assert.equal(encoded.length, 2);
    for (const output of encoded) {
      if (mode === "equal") assert.equal(output.byteSize, f.bytes.length);
      else assert.ok(output.byteSize > f.bytes.length);
    }
    // Any upload reservation would exceed this deliberately tiny body budget.
    const allocation = await executionAllocation(f.options, { maxUploadBodyBytes: 1, maxTotalUploadBodyBytes: 1 });
    const budget = await openThumbnailBudgetAttempt(allocation.file, allocation.plan);
    try {
      const report = await generateAndRegisterThumbnails({ ...f.options, budget });
      assert.deepEqual(report, { processed: 1, registered: 0, alreadyPresent: 0, skipped: 0, notSmaller: 2, thumbnailBytes: 0, uploadAttemptBytes: 0 });
      assert.equal(f.state.downloads, 1); assert.equal(f.state.puts, 0); assert.equal(f.state.writes, 0);
      assert.equal(f.state.mappings.size, 0); assert.equal(f.state.objects.size, 0);
      assert.equal(budget.snapshot().totalOriginalBytes, f.bytes.length);
      assert.equal(budget.snapshot().totalUploadRequests, 0); assert.equal(budget.snapshot().totalUploadBodyBytes, 0);
      for (const widthCap of [400, 800] as const) {
        const fallback = await readThumbnail(f.options.db, f.options.version, f.assetId, widthCap);
        assert.equal(fallback?.thumbnail, null); assert.deepEqual(fallback?.source.media, f.state.parent);
      }
    } finally { await budget.close(); await allocation.cleanup(); }
  });
});

test("rejected larger cache descriptors trigger fresh verification and never overwrite immutable cache entries", async () => {
  const f = await fixture();
  const cache = createVerifiedThumbnailCache(thumbnailEncodingRecipe());
  const raw = Buffer.alloc(32 * 16 * 3);
  let seed = 14309;
  for (let index = 0; index < raw.length; index++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    raw[index] = seed >>> 24;
  }
  const oldBytes = await sharp(raw, { raw: { width: 32, height: 16, channels: 3 } }).webp({ lossless: true }).toBuffer();
  assert.ok(oldBytes.length > f.bytes.length);
  const oldHash = createHash("sha256").update(oldBytes).digest("hex");
  for (const widthCap of [400, 800] as const) {
    const source = { media: f.state.parent, binding: f.state.binding };
    const candidate: StoredMedia = { assetId: mediaIdentity(OWNER, `thumbnail:${widthCap}:${f.assetId}`, oldHash),
      ownerPageId: OWNER, objectKey: `sha256/${oldHash}`, sha256: oldHash,
      byteSize: oldBytes.length, mime: "image/webp", width: 32, height: 16 };
    cache.record({ version: f.options.version, runId: RUN, source, thumbnail: candidate }, widthCap, candidate);
  }
  const oldSnapshot = cache.snapshot();
  const report = await generateAndRegisterThumbnails({ ...f.options, cache });
  assert.equal(f.state.downloads, 1); assert.equal(report.registered, 2); assert.equal(report.notSmaller, 0);
  assert.equal(f.state.objects.has(`sha256/${oldHash}`), false, "ignored cache locations are never read or reused");
  assert.deepEqual(cache.snapshot(), oldSnapshot, "immutable cache entries remain intact");
  assert.ok(report.uploadAttemptBytes > 0);
});

test("an equal-size cached preview cannot authorize a skip when the current original fails verification", async () => {
  const f = await fixture({
    bytes: await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 30, b: 80 } } }).webp({ lossless: true }).toBuffer(),
    mime: "image/webp",
  });
  const cache = createVerifiedThumbnailCache(thumbnailEncodingRecipe());
  for (const output of await generateThumbnails(f.bytes)) {
    assert.equal(output.byteSize, f.bytes.length);
    const thumbnail: StoredMedia = { assetId: mediaIdentity(OWNER, `thumbnail:${output.widthCap}:${f.assetId}`, output.sha256),
      ownerPageId: OWNER, objectKey: `sha256/${output.sha256}`, sha256: output.sha256, byteSize: output.byteSize,
      mime: output.mime, width: output.width, height: output.height };
    cache.record({ version: f.options.version, runId: RUN, source: { media: f.state.parent, binding: f.state.binding }, thumbnail }, output.widthCap, thumbnail);
  }
  f.state.downloadedBytes = Uint8Array.from(f.bytes);
  f.state.downloadedBytes[f.state.downloadedBytes.length - 1] ^= 1;
  await assert.rejects(generateAndRegisterThumbnails({ ...f.options, cache }), controlled);
  assert.equal(f.state.downloads, 1); assert.equal(f.state.storageReads, 0);
  assert.equal(f.state.puts, 0); assert.equal(f.state.writes, 0);
  f.state.downloadedBytes = f.bytes;
  const report = await generateAndRegisterThumbnails({ ...f.options, cache });
  assert.equal(report.notSmaller, 2); assert.equal(report.registered, 0);
  assert.equal(f.state.downloads, 2); assert.equal(f.state.storageReads, 0);
});

test("already registered equal-size previews remain verified and are not removed by the new rule", async () => {
  const f = await fixture({
    bytes: await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 30, b: 80 } } }).webp({ lossless: true }).toBuffer(),
    mime: "image/webp",
  });
  for (const output of await generateThumbnails(f.bytes)) {
    assert.equal(output.byteSize, f.bytes.length);
    const thumbnail: StoredMedia = { assetId: mediaIdentity(OWNER, `thumbnail:${output.widthCap}:${f.assetId}`, output.sha256),
      ownerPageId: OWNER, objectKey: `sha256/${output.sha256}`, sha256: output.sha256, byteSize: output.byteSize,
      mime: output.mime, width: output.width, height: output.height };
    f.state.mappings.set(output.widthCap, thumbnail);
    f.state.objects.set(thumbnail.objectKey, output.bytes);
  }
  const before = structuredClone(f.state.mappings);
  const report = await generateAndRegisterThumbnails(f.options);
  assert.equal(report.alreadyPresent, 2); assert.equal(report.registered, 0); assert.equal(report.notSmaller, 0);
  assert.equal(f.state.downloads, 0); assert.equal(f.state.puts, 0); assert.equal(f.state.writes, 0);
  assert.deepEqual(f.state.mappings, before);
  const thumbnail = f.state.mappings.get(400)!;
  f.state.objects.set(thumbnail.objectKey, new Uint8Array(thumbnail.byteSize));
  await assert.rejects(generateAndRegisterThumbnails(f.options), controlled);
});

test("all-skipped fresh outputs still reject source changes during the final skip guard", async t => {
  for (const mode of ["run", "withdrawal", "binding", "live", "read-failure"] as const) await t.test(mode, async () => {
    const f = await compressedJpegFixture(10);
    let checksAfterDownload = 0;
    f.state.onResolve = () => {
      if (!f.state.downloads || ++checksAfterDownload !== 2) return;
      if (mode === "run") f.state.runId = NEXT_RUN;
      if (mode === "withdrawal") f.state.eligible = false;
      if (mode === "binding") f.state.binding.sourceFingerprint = "b".repeat(64);
      if (mode === "live") f.state.liveFingerprint = "b".repeat(64);
      if (mode === "read-failure") f.state.onRead = () => { throw new Error(`Synthetic denied ${SOURCE_URL}`); };
    };
    await assert.rejects(generateAndRegisterThumbnails(f.options), controlled);
    assert.equal(checksAfterDownload, 2, "qualification is checked after deciding to skip the first cap");
    assert.equal(f.state.puts, 0); assert.equal(f.state.writes, 0); assert.equal(f.state.mappings.size, 0);
  });
});

test("execution allocation is charged before transport and supplies the expected download cap and abort signal",async()=>{
  const f=await fixture();const allocation=await executionAllocation(f.options);
  const budget=await openThumbnailBudgetAttempt(allocation.file,allocation.plan);
  try {
    f.state.onDownload=async()=>{assert.equal(budget.snapshot().totalOriginalBytes,f.bytes.length);};
    f.state.onPut=async()=>{assert.equal(budget.snapshot().totalUploadRequests,1);assert.ok(budget.snapshot().totalUploadBodyBytes>0);};
    const originalDownload=f.options.download!;
    f.options.download=async(url,signal,maxBytes)=>{
      assert.equal(signal,budget.signal);assert.equal(maxBytes,f.bytes.length);return originalDownload(url);
    };
    const report=await generateAndRegisterThumbnails({...f.options,budget});
    assert.equal(report.registered,2);assert.equal(budget.snapshot().totalOriginalBytes,f.bytes.length);
    assert.equal(budget.snapshot().totalUploadRequests,f.state.puts);
    assert.equal(budget.snapshot().totalUploadBodyBytes,report.uploadAttemptBytes);
  } finally {await budget.close();await allocation.cleanup();}
});

test("failed immutable POST remains charged after reopening and blocks a retry before another upload",async()=>{
  const f=await fixture();const allocation=await executionAllocation(f.options,{maxUploadRequests:1,maxTotalUploadRequests:1});
  let budget=await openThumbnailBudgetAttempt(allocation.file,allocation.plan);
  try {
    f.state.onPut=async()=>{throw new Error("Synthetic connection lost after the object write");};
    await assert.rejects(generateAndRegisterThumbnails({...f.options,budget}),controlled);
    assert.equal(f.state.puts,1);assert.equal(f.state.writes,0);assert.equal(budget.snapshot().totalUploadRequests,1);
    await budget.close();budget=await openThumbnailBudgetAttempt(allocation.file,allocation.plan);
    f.state.onPut=undefined;
    await assert.rejects(generateAndRegisterThumbnails({...f.options,budget}),controlled);
    assert.equal(f.state.puts,1);assert.equal(f.state.writes,0);
    assert.equal(budget.snapshot().totalUploadRequests,1);assert.equal(budget.snapshot().totalOriginalBytes,f.bytes.length*2);
  } finally {await budget.close();await allocation.cleanup();}
});

test("encoded body bounds stop before upload and failed original reads consume their allowance",async t=>{
  await t.test("encoded byte cap",async()=>{
    const f=await fixture();const allocation=await executionAllocation(f.options,{maxUploadBodyBytes:1});
    const budget=await openThumbnailBudgetAttempt(allocation.file,allocation.plan);
    try {
      await assert.rejects(generateAndRegisterThumbnails({...f.options,budget}),controlled);
      assert.equal(f.state.downloads,1);assert.equal(f.state.puts,0);assert.equal(budget.snapshot().totalUploadRequests,0);
    } finally {await budget.close();await allocation.cleanup();}
  });
  await t.test("failed original read",async()=>{
    const f=await fixture();const allocation=await executionAllocation(f.options,{maxTotalOriginalBytes:f.bytes.length});
    let budget=await openThumbnailBudgetAttempt(allocation.file,allocation.plan);
    try {
      f.state.onDownload=async()=>{throw new Error("Synthetic partial download");};
      await assert.rejects(generateAndRegisterThumbnails({...f.options,budget}),controlled);
      assert.equal(f.state.downloads,1);assert.equal(budget.snapshot().totalOriginalBytes,f.bytes.length);
      await budget.close();budget=await openThumbnailBudgetAttempt(allocation.file,allocation.plan);f.state.onDownload=undefined;
      await assert.rejects(generateAndRegisterThumbnails({...f.options,budget}),controlled);
      assert.equal(f.state.downloads,1);assert.equal(f.state.puts,0);assert.equal(budget.snapshot().totalOriginalBytes,f.bytes.length);
    } finally {await budget.close();await allocation.cleanup();}
  });
});

test("a late original result after the batch deadline cannot encode, upload or register",async()=>{
  const f=await fixture();const allocation=await executionAllocation(f.options,{maxDurationSeconds:1});
  const budget=await openThumbnailBudgetAttempt(allocation.file,allocation.plan);
  try {
    f.state.onDownload=async()=>{await new Promise(resolve=>setTimeout(resolve,1100));};
    await assert.rejects(generateAndRegisterThumbnails({...f.options,budget}),controlled);
    assert.equal(budget.signal.aborted,true);assert.equal(f.state.puts,0);assert.equal(f.state.writes,0);
    assert.equal(budget.snapshot().totalOriginalBytes,f.bytes.length);
  } finally {await budget.close();await allocation.cleanup();}
});

test("the production immutable Storage adapter charges actual 400/409 POST conflicts before sending",async t=>{
  for(const status of [400,409])await t.test(String(status),async()=>{
    const f=await fixture();const allocation=await executionAllocation(f.options);
    const budget=await openThumbnailBudgetAttempt(allocation.file,allocation.plan);
    try {
      const encoded=await generateThumbnails(f.bytes);const objects=new Map(encoded.map(x=>[`sha256/${x.sha256}`,x.bytes]));
      const claims={role:"authenticated",exp:Math.floor(Date.now()/1000)+3600,app_metadata:{notionblog_storage_role:"writer"}};
      const token=`fictional.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.fictional`;
      let actualPOSTs=0,actualBodyBytes=0;
      f.options.storage=createSupabaseStorage({url:"https://fictional-storage.example.test/storage/v1",bucket:"fictional-media",
        apiKey:"sb_publishable_fictional",token,role:"writer",fetch:async(input,init)=>{
          const path=new URL(String(input)).pathname;const key=path.slice(path.indexOf("sha256/"));const bytes=objects.get(key)!;
          assert.ok(bytes);
          if(init?.method==="POST") {
            actualPOSTs++;actualBodyBytes+=Buffer.byteLength(init.body as Buffer);
            assert.equal(budget.snapshot().totalUploadRequests,actualPOSTs);
            assert.equal(budget.snapshot().totalUploadBodyBytes,actualBodyBytes);
            assert.equal(new Headers(init.headers).get("x-upsert"),"false");
            assert.deepEqual(Buffer.from(init.body as Buffer),Buffer.from(bytes));
            return new Response("Synthetic immutable conflict",{status});
          }
          return new Response(Buffer.from(bytes),{status:200,headers:{"Content-Type":"image/webp","Content-Length":String(bytes.length)}});
        }});
      const report=await generateAndRegisterThumbnails({...f.options,budget});
      assert.equal(report.registered,2);assert.equal(actualPOSTs,1,"identical small-image caps reuse the same verified object");
      assert.equal(budget.snapshot().totalUploadRequests,1);assert.equal(report.uploadAttemptBytes,actualBodyBytes);
    } finally {await budget.close();await allocation.cleanup();}
  });
});
