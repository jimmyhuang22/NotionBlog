import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ThumbnailProjection } from "../../src/server/database/thumbnail-index.ts";
import { validateMediaSource } from "../../src/server/media/notion-source.ts";
import { verifyMediaBytes } from "../../src/server/database/storage.ts";
import { verifyDisplayBytes } from "../../src/server/self-hosted-media/files.ts";
import { displayRunId, validateDisplayManifest, MAX_DISPLAY_FILE_BYTES, MAX_DISPLAY_MANIFEST_BYTES, type DisplayAsset, type DisplayFile, type DisplayManifest } from "../../src/server/self-hosted-media/manifest.ts";
import { displayEncodingRecipe, generateDisplayVariants } from "./encode.ts";

function fail(): never { throw Error("SELF_HOSTED_DISPLAY_BUILD_FAILED"); }
const file = (v: DisplayFile): DisplayFile => ({ sha256: v.sha256, byteSize: v.byteSize, mime: v.mime, width: v.width, height: v.height });
export async function prepareDisplayAsset(source: ThumbnailProjection, input: Uint8Array): Promise<{ asset: DisplayAsset; objects: Map<string, Uint8Array> }> {
  if (source.version !== "v2" || !displayRunId(source.runId)) fail();
  validateMediaSource(source.source.binding, source.source.media, "v2");
  verifyMediaBytes(source.source.media, input);
  const generated = await generateDisplayVariants(input), base = generated.find(v => v.widthCap === 1600);
  if (!base || base.byteSize > MAX_DISPLAY_FILE_BYTES) fail();
  const asset: DisplayAsset = { assetId: source.source.media.assetId, ownerPageId: source.source.media.ownerPageId,
    sourceSha256: source.source.media.sha256, sourceFingerprint: source.source.binding.sourceFingerprint, base: file(base), variants: {} };
  const objects = new Map<string, Uint8Array>([[base.sha256, base.bytes]]);
  for (const preview of generated.filter(v => v.widthCap !== 1600)) {
    if (preview.sha256 === base.sha256) asset.variants[String(preview.widthCap) as "400" | "800"] = file(base);
    else if (preview.byteSize < base.byteSize) {
      asset.variants[String(preview.widthCap) as "400" | "800"] = file(preview); objects.set(preview.sha256, preview.bytes);
    }
  }
  for (const descriptor of [asset.base, ...Object.values(asset.variants)] as DisplayFile[]) verifyDisplayBytes(descriptor, objects.get(descriptor.sha256)!);
  return { asset, objects };
}
/** Private, explicit local input only; never follows a URL or falls back to downloading. */
export async function readDisplayInput(filename: string, maxBytes = MAX_DISPLAY_FILE_BYTES): Promise<Buffer> {
  if (!isAbsolute(filename) || resolve(filename) !== filename || await realpath(filename) !== filename) fail();
  const parent = await lstat(dirname(filename));
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0 || process.getuid && parent.uid !== process.getuid()) fail();
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o777) !== 0o600 || before.size > maxBytes || process.getuid && before.uid !== process.getuid()) fail();
    const bytes = await handle.readFile(), after = await handle.stat();
    if (bytes.length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail();
    return bytes;
  } finally { await handle.close(); }
}
export async function buildDisplayBundle(directory: string, runId: string, inputs: AsyncIterable<{ source: ThumbnailProjection; bytes: Uint8Array }> | Iterable<{ source: ThumbnailProjection; bytes: Uint8Array }>, maxOutputBytes = 128 * 1024 * 1024): Promise<DisplayManifest> {
  if (!displayRunId(runId) || !isAbsolute(directory) || resolve(directory) !== directory ||
      !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 1024 ** 3 || await realpath(dirname(directory)) !== dirname(directory)) fail();
  const parent = await lstat(dirname(directory)); if (!parent.isDirectory() || (parent.mode & 0o077) !== 0 || process.getuid && parent.uid !== process.getuid()) fail();
  // A fresh staging directory makes wx writes and failure retention unambiguous.
  await mkdir(directory, { mode: 0o700 }); await mkdir(join(directory, "runs"), { mode: 0o700 }); await mkdir(join(directory, "objects"), { mode: 0o700 });
  const manifest: DisplayManifest = { format: "notionblog-display-v1", runId, recipe: displayEncodingRecipe(), assets: [] };
  const objects = new Map<string, string>(), assets = new Set<string>(); let total = 0, originalBytes = 0;
  for await (const input of inputs) {
    if (input.source.runId !== runId || assets.has(input.source.source.media.assetId) || assets.size >= 20000) fail();
    originalBytes += input.bytes.byteLength; if (originalBytes > 1024 ** 3) fail();
    const prepared = await prepareDisplayAsset(input.source, input.bytes);
    assets.add(prepared.asset.assetId);
    for (const [sha, bytes] of prepared.objects) {
      if (objects.has(sha)) continue;
      total += bytes.byteLength; if (total > maxOutputBytes || createHash("sha256").update(bytes).digest("hex") !== sha) fail();
      const target = join(directory, "objects", sha + ".webp"), handle = await open(target, "wx", 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      const readback = await readDisplayInput(target); if (!readback.equals(Buffer.from(bytes))) fail(); objects.set(sha, target);
    }
    manifest.assets.push(prepared.asset);
  }
  manifest.assets.sort((a, b) => a.assetId.localeCompare(b.assetId)); validateDisplayManifest(manifest);
  const data = JSON.stringify(manifest) + "\n"; if (Buffer.byteLength(data) > MAX_DISPLAY_MANIFEST_BYTES) fail();
  const target = await open(join(directory, "runs", runId + ".json"), "wx", 0o600);
  try { await target.writeFile(data); await target.sync(); } finally { await target.close(); }
  return manifest;
}
