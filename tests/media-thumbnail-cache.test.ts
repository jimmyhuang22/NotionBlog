import assert from "node:assert/strict";
import { promises as fsPromises } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import type { StoredMedia } from "../contracts/sync.ts";
import { createVerifiedThumbnailCache, loadVerifiedThumbnailCache } from "../scripts/media-thumbnails/cache.ts";
import type { ThumbnailProjection, ThumbnailWidth } from "../src/server/database/thumbnail-index.ts";
import { mediaIdentity } from "../src/server/database/validation.ts";

const RECIPE = `webp-preview-v1:${"1".repeat(64)}`;
const NEXT_RECIPE = `webp-preview-v2:${"2".repeat(64)}`;
const FILE = "verified-thumbnails.json";
const RUN = "00000000-0000-4000-8000-000000000001";
const NEXT_RUN = "00000000-0000-4000-8000-000000000002";
const OWNER = "00000000000000000000000000000010";
const controlled = (error: unknown) => error instanceof Error && "code" in error &&
  error.code === "CONTENT_UNAVAILABLE" && error.message === "The private thumbnail cache is unavailable.";

interface Snapshot {
  format: string;
  recipe: string;
  entries: { version: "v1" | "v2"; source: ThumbnailProjection["source"]; widthCap: ThumbnailWidth; thumbnail: StoredMedia }[];
}
function projection(settings: { owner?: string; sha?: string; fingerprint?: string; version?: "v1" | "v2" } = {}): ThumbnailProjection {
  const owner = settings.owner ?? OWNER, sha = settings.sha ?? "a".repeat(64);
  const assetId = mediaIdentity(owner, "cover", sha);
  return { version: settings.version ?? "v2", runId: RUN, thumbnail: null, source: {
    media: { assetId, ownerPageId: owner, sha256: sha, objectKey: `sha256/${sha}`, byteSize: 2048,
      mime: "image/png", width: 1200, height: 900 },
    binding: { assetId, ownerPageId: owner, sha256: sha, locator: { kind: "cover" },
      delivery: "notion", sourceFingerprint: settings.fingerprint ?? "b".repeat(64) },
  } };
}
function thumbnail(parent: ThumbnailProjection, widthCap: ThumbnailWidth, sha = "c".repeat(64)): StoredMedia {
  const owner = parent.source.media.ownerPageId;
  return { assetId: mediaIdentity(owner, `thumbnail:${widthCap}:${parent.source.media.assetId}`, sha),
    ownerPageId: owner, objectKey: `sha256/${sha}`, sha256: sha, byteSize: 123,
    mime: "image/webp", width: widthCap, height: widthCap * 3 / 4 };
}
function populated(): { source: ThumbnailProjection; snapshot: Snapshot } {
  const source = projection(), cache = createVerifiedThumbnailCache(RECIPE);
  for (const cap of [400, 800] as const) cache.record(source, cap, thumbnail(source, cap));
  return { source, snapshot: cache.snapshot() as Snapshot };
}
async function privateState(): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "nb-thumbnail-cache-")));
  await chmod(directory, 0o700); return directory;
}

test("verified candidates survive a new run while version, owner, parent bytes and source stay isolated", () => {
  const source = projection(), cache = createVerifiedThumbnailCache(RECIPE);
  cache.record(source, 400, thumbnail(source, 400));
  assert.deepEqual(cache.lookup({ ...source, runId: NEXT_RUN }, 400), thumbnail(source, 400));
  for (const changed of [projection({ owner: "00000000000000000000000000000011" }),
    projection({ sha: "d".repeat(64) }), projection({ fingerprint: "e".repeat(64) }), projection({ version: "v1" })]) {
    assert.equal(cache.lookup(changed, 400), null);
  }
  const metadataChanged = structuredClone(source); metadataChanged.source.media.width = 1000;
  assert.equal(cache.lookup(metadataChanged, 400), null, "changed parent metadata is conservatively isolated too");
  assert.equal(cache.lookup(source, 800), null);
  assert.ok(!JSON.stringify(cache.snapshot()).includes(RUN), "persistent candidates do not retain a publishing run ID");
});

test("lookup, input and snapshot copies cannot mutate cache candidates or its recipe", () => {
  const { source, snapshot } = populated();
  const cache = createVerifiedThumbnailCache(RECIPE, snapshot);
  snapshot.entries[0]!.thumbnail.sha256 = "d".repeat(64);
  const first = cache.lookup(source, 400)!;
  first.sha256 = "e".repeat(64); first.width = 1;
  const exported = cache.snapshot() as Snapshot;
  exported.entries.length = 0;
  assert.deepEqual(cache.lookup(source, 400), thumbnail(source, 400));
  assert.equal((cache.snapshot() as Snapshot).entries.length, 2);
  assert.throws(() => { (cache as { recipe: string }).recipe = NEXT_RECIPE; }, TypeError);
  const mutableSource = projection(), mutableThumbnail = thumbnail(mutableSource, 400);
  const other = createVerifiedThumbnailCache(RECIPE); other.record(mutableSource, 400, mutableThumbnail);
  mutableSource.source.media.width = 1; mutableThumbnail.width = 1;
  assert.deepEqual(other.lookup(projection(), 400), thumbnail(projection(), 400));
});

test("a valid old recipe is cleared locally, but old corrupt candidates still fail", () => {
  const { source, snapshot } = populated();
  const newer = createVerifiedThumbnailCache(NEXT_RECIPE, snapshot);
  assert.equal(newer.recipe, NEXT_RECIPE);
  assert.equal(newer.lookup(source, 400), null);
  assert.deepEqual((newer.snapshot() as Snapshot).entries, []);
  const corrupt = structuredClone(snapshot); corrupt.entries[0]!.thumbnail.assetId = `a1.${"0".repeat(64)}`;
  assert.throws(() => createVerifiedThumbnailCache(NEXT_RECIPE, corrupt), controlled);
});

test("malformed formats, duplicate keys and invalid source or derived identities are refused anonymously", async t => {
  const { snapshot } = populated();
  const cases: [string, (value: Snapshot) => unknown][] = [
    ["wrong format", value => ({ ...value, format: "unexpected" })],
    ["extra field", value => ({ ...value, temporaryUrl: "https://images.example.test/private" })],
    ["bad recipe", value => ({ ...value, recipe: "unsafe\nrecipe" })],
    ["duplicate width", value => { value.entries.push(structuredClone(value.entries[0]!)); return value; }],
    ["bad width", value => { (value.entries[0] as unknown as { widthCap: number }).widthCap = 999; return value; }],
    ["missing width", value => { delete (value.entries[0] as Partial<Snapshot["entries"][number]>).widthCap; return value; }],
    ["wrong derived id", value => { value.entries[0]!.thumbnail.assetId = `a1.${"0".repeat(64)}`; return value; }],
    ["wrong owner", value => { value.entries[0]!.thumbnail.ownerPageId = "00000000000000000000000000000011"; return value; }],
    ["wrong object key", value => { value.entries[0]!.thumbnail.objectKey = `sha256/${"d".repeat(64)}`; return value; }],
    ["wrong mime", value => { value.entries[0]!.thumbnail.mime = "image/png"; return value; }],
    ["unknown width", value => { value.entries[0]!.thumbnail.width = null; return value; }],
    ["fractional height", value => { value.entries[0]!.thumbnail.height = 10.5; return value; }],
    ["oversized dimensions", value => { value.entries[0]!.thumbnail.width = 801; return value; }],
    ["oversized bytes", value => { value.entries[0]!.thumbnail.byteSize = 20 * 1024 * 1024 + 1; return value; }],
    ["bad parent identity", value => { value.entries[0]!.source.binding.assetId = `a1.${"0".repeat(64)}`; return value; }],
    ["extra entry field", value => { return { ...value, entries: [{ ...value.entries[0], runId: RUN }] }; }],
  ];
  for (const [name, mutate] of cases) await t.test(name, () => {
    assert.throws(() => createVerifiedThumbnailCache(RECIPE, mutate(structuredClone(snapshot))), controlled);
  });
  assert.throws(() => createVerifiedThumbnailCache(RECIPE, null), controlled);
  assert.throws(() => createVerifiedThumbnailCache(""), controlled);
});

test("record rejects invalid widths and an immutable recipe/source candidate conflict", () => {
  const source = projection(), cache = createVerifiedThumbnailCache(RECIPE);
  cache.record(source, 400, thumbnail(source, 400));
  cache.record(source, 400, thumbnail(source, 400));
  assert.equal((cache.snapshot() as Snapshot).entries.length, 1);
  assert.throws(() => cache.record(source, 400, thumbnail(source, 400, "d".repeat(64))), controlled);
  assert.throws(() => cache.record(source, 999 as ThumbnailWidth, thumbnail(source, 400)), controlled);
  assert.throws(() => cache.lookup({ ...source, runId: "private-invalid-run" }, 400), controlled);
  assert.throws(() => cache.record(source, 800, thumbnail(source, 400)), controlled);
});

test("1600 body candidates retain source isolation and reject small or unhelpful outputs", () => {
  const source = projection(), blockId = "00000000000000000000000000000020";
  const assetId = mediaIdentity(OWNER, blockId, source.source.media.sha256);
  Object.assign(source.source.media, { assetId, width: 2400, height: 1800 });
  Object.assign(source.source.binding, { assetId, locator: { kind: "block", id: blockId } });
  const cache = createVerifiedThumbnailCache(RECIPE), output = thumbnail(source, 1600);
  cache.record(source, 1600, output);
  assert.deepEqual(createVerifiedThumbnailCache(RECIPE, cache.snapshot()).lookup({ ...source, runId: NEXT_RUN }, 1600), output);
  assert.throws(() => createVerifiedThumbnailCache(RECIPE).record(source, 1600, { ...output, byteSize: source.source.media.byteSize }), controlled);
  const small = structuredClone(source); small.source.media.width = 1600;
  assert.throws(() => cache.record(small, 1600, output), controlled);
});

test("entry, source and serialized-byte ceilings reject unbounded cache inputs", () => {
  const { snapshot } = populated();
  assert.throws(() => createVerifiedThumbnailCache(RECIPE, { ...snapshot, entries: Array(40_001).fill(snapshot.entries[0]) }), controlled);
  const entries = Array.from({ length: 20_001 }, (_, index) => {
    const source = projection({ owner: index.toString(16).padStart(32, "0") });
    return { version: source.version, source: source.source, widthCap: 400 as const, thumbnail: thumbnail(source, 400) };
  });
  assert.throws(() => createVerifiedThumbnailCache(RECIPE, { ...snapshot, entries }), controlled);
  assert.throws(() => createVerifiedThumbnailCache(RECIPE, { ...snapshot, entries: [
    { ...snapshot.entries[0], thumbnail: { ...snapshot.entries[0]!.thumbnail, private: "x".repeat(32 * 1024 * 1024) } },
  ] }), controlled);
});

test("missing private file is empty, and atomic save/load retains both profiles and no temp files", async () => {
  const dir = await privateState();
  try {
    const cache = await loadVerifiedThumbnailCache(dir, RECIPE);
    const source = projection(); assert.equal(cache.lookup(source, 400), null);
    for (const cap of [400, 800] as const) cache.record(source, cap, thumbnail(source, cap));
    await cache.save();
    assert.equal((await lstat(join(dir, FILE))).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(dir), [FILE]);
    const loaded = await loadVerifiedThumbnailCache(dir, RECIPE);
    assert.deepEqual(loaded.lookup({ ...source, runId: NEXT_RUN }, 800), thumbnail(source, 800));
    const prior = await readFile(join(dir, FILE), "utf8"); await loaded.save();
    assert.equal(await readFile(join(dir, FILE), "utf8"), prior, "deterministic snapshots survive replacement");
    const newRecipe = await loadVerifiedThumbnailCache(dir, NEXT_RECIPE);
    assert.equal(newRecipe.lookup(source, 400), null);
    assert.equal(await readFile(join(dir, FILE), "utf8"), prior, "loading an old recipe does not write");
    await newRecipe.save();
    assert.deepEqual((JSON.parse(await readFile(join(dir, FILE), "utf8")) as Snapshot).entries, []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("corrupt files, non-private paths and symbolic links fail instead of acting as empty", async t => {
  for (const kind of ["invalid-json", "file-permissions", "directory-permissions", "file-symlink", "dangling-symlink", "directory-symlink", "ancestor-symlink", "file-directory"] as const) {
    await t.test(kind, async () => {
      const dir = await privateState(); let state = dir;
      try {
        const path = join(dir, FILE);
        if (kind === "invalid-json") await writeFile(path, "private-invalid-json", { mode: 0o600 });
        if (kind === "file-permissions") { await writeFile(path, JSON.stringify(populated().snapshot), { mode: 0o600 }); await chmod(path, 0o644); }
        if (kind === "directory-permissions") await chmod(dir, 0o755);
        if (kind === "file-symlink") { await writeFile(join(dir, "other.json"), JSON.stringify(populated().snapshot), { mode: 0o600 }); await symlink(join(dir, "other.json"), path); }
        if (kind === "dangling-symlink") await symlink(join(dir, "missing"), path);
        if (kind === "file-directory") await mkdir(path, { mode: 0o700 });
        if (kind === "directory-symlink") { await mkdir(join(dir, "target"), { mode: 0o700 }); await symlink(join(dir, "target"), join(dir, "link")); state = join(dir, "link"); }
        if (kind === "ancestor-symlink") { await mkdir(join(dir, "target", "state"), { recursive: true, mode: 0o700 }); await symlink(join(dir, "target"), join(dir, "link")); state = join(dir, "link", "state"); }
        await assert.rejects(loadVerifiedThumbnailCache(state, RECIPE), controlled);
      } finally { await chmod(dir, 0o700); await rm(dir, { recursive: true, force: true }); }
    });
  }
  await assert.rejects(loadVerifiedThumbnailCache("relative-private-dir", RECIPE), controlled);
});

test("bounded reads reject an oversized private file before parsing its body", async () => {
  const dir = await privateState();
  try {
    const file = await open(join(dir, FILE), "wx", 0o600);
    try { await file.truncate(32 * 1024 * 1024 + 1); } finally { await file.close(); }
    await assert.rejects(loadVerifiedThumbnailCache(dir, RECIPE), controlled);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("atomic replacement failure keeps the previous cache and removes the owned temporary file", async t => {
  const dir = await privateState();
  try {
    const cache = await loadVerifiedThumbnailCache(dir, RECIPE);
    const source = projection(); cache.record(source, 400, thumbnail(source, 400)); await cache.save();
    const prior = await readFile(join(dir, FILE), "utf8");
    cache.record(source, 800, thumbnail(source, 800));
    let attempts = 0;
    const failure = t.mock.method(fsPromises, "rename", async () => {
      attempts++; throw new Error("Synthetic private filesystem detail must not escape.");
    });
    syncBuiltinESMExports();
    try { await assert.rejects(cache.save(), controlled); }
    finally { failure.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(attempts, 1);
    assert.deepEqual(await readdir(dir), [FILE]);
    assert.equal(await readFile(join(dir, FILE), "utf8"), prior);
    await cache.save();
    assert.equal((JSON.parse(await readFile(join(dir, FILE), "utf8")) as Snapshot).entries.length, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("save refuses a newly linked target without modifying its destination", async () => {
  const dir = await privateState();
  try {
    const cache = await loadVerifiedThumbnailCache(dir, RECIPE);
    const destination = join(dir, "unrelated.json"); await writeFile(destination, "unrelated", { mode: 0o600 });
    await symlink(destination, join(dir, FILE));
    await assert.rejects(cache.save(), controlled);
    assert.equal(await readFile(destination, "utf8"), "unrelated");
    assert.deepEqual((await readdir(dir)).sort(), ["unrelated.json", FILE].sort());
    assert.equal((await lstat(join(dir, FILE))).isSymbolicLink(), true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
