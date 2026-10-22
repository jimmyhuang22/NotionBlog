import { constants } from "node:fs";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { DownloadedImage } from "../notion-sync/download.ts";
import { imageMime } from "../notion-sync/download.ts";
import { WorkerError, checkSignal } from "../notion-sync/errors.ts";
import { privateDirectory } from "../notion-sync/state.ts";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
export const strongImageEtag = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 512 && /^"[\x21\x23-\x7e]*"$/.test(value);

export interface ImageCacheReceipt {
  version: 1; key: string; etag: string; sha256: string; byteSize: number;
  mime: DownloadedImage["mime"]; wireMime: string; vary: string;
}
export interface CachedImage { receipt: ImageCacheReceipt; image: DownloadedImage }
/** Cache evidence is useful only after the CURRENT checked origin confirms the strong validator. */
export interface WebsiteImageCache {
  read(key: string, signal?: AbortSignal): Promise<CachedImage | undefined>;
  write(receipt: ImageCacheReceipt, image: DownloadedImage, signal?: AbortSignal): Promise<void>;
}

/** Preserve semantic query parameters; only S3 query-authentication fields may rotate. */
export function imageCacheKey(url: URL, userAgent: string): string {
  const identity = new URL(url);
  if (/^(?:s3\.[a-z0-9-]+|[a-z0-9.-]+\.s3\.[a-z0-9-]+)\.amazonaws\.com$/.test(identity.hostname) &&
      identity.searchParams.get("X-Amz-Algorithm") === "AWS4-HMAC-SHA256" &&
      identity.searchParams.get("X-Amz-SignedHeaders") === "host") {
    const authentication = new Set(["X-Amz-Credential", "X-Amz-Date", "X-Amz-Expires", "X-Amz-Security-Token", "X-Amz-Signature"]);
    // Keep the exact encoding/order of every non-authentication query field.
    identity.search = identity.search.slice(1).split("&").filter(field => !authentication.has(field.split("=", 1)[0])).join("&");
  }
  return digest(JSON.stringify(["original-strong-etag-1", identity.href, userAgent,
    "image/jpeg,image/png,image/webp,image/gif,image/avif,image/heic,image/heif", "identity"]));
}

export function imageCacheVary(value: string | undefined): string | undefined {
  const fields = (value ?? "").toLowerCase().split(",").map(v => v.trim()).filter(Boolean);
  return fields.every(v => ["accept", "accept-encoding", "user-agent"].includes(v)) ? [...new Set(fields)].sort().join(",") : undefined;
}
function validReceipt(value: unknown, key: string): value is ImageCacheReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as ImageCacheReceipt;
  return Object.keys(v).sort().join(",") === "byteSize,etag,key,mime,sha256,vary,version,wireMime" &&
    v.version === 1 && v.key === key && /^[a-f0-9]{64}$/.test(key) && strongImageEtag(v.etag) &&
    /^[a-f0-9]{64}$/.test(v.sha256) && Number.isSafeInteger(v.byteSize) && v.byteSize > 0 && v.byteSize <= MAX_IMAGE_BYTES &&
    ["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"].includes(v.mime) &&
    ["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"].includes(v.wireMime) &&
    typeof v.vary === "string" && imageCacheVary(v.vary) === v.vary;
}

async function checkedDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!isAbsolute(path) || resolve(path) !== path || !info.isDirectory() || info.isSymbolicLink() ||
      (info.mode & 0o777) !== 0o700 || info.uid !== process.getuid?.() || await realpath(path) !== path) throw new WorkerError("MISCONFIGURED");
}
async function privateBytes(path: string, maxBytes: number): Promise<Uint8Array | undefined> {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new WorkerError("MISCONFIGURED"); }
  try {
    const before = await handle.stat();
    if (!before.isFile() || (before.mode & 0o777) !== 0o600 || before.uid !== process.getuid?.() || before.nlink !== 1) throw new WorkerError("MISCONFIGURED");
    if (before.size < 1 || before.size > maxBytes) return undefined;
    const bytes = Buffer.alloc(before.size + 1); let count = 0;
    while (count < bytes.length) { const part = await handle.read(bytes, count, bytes.length - count, count); if (!part.bytesRead) break; count += part.bytesRead; }
    const after = await handle.stat(), current = await lstat(path);
    if (count !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
        current.ino !== before.ino || current.dev !== before.dev || current.isSymbolicLink()) return undefined;
    return bytes.subarray(0, count);
  } finally { await handle.close(); }
}
async function atomicBytes(directory: string, name: string, bytes: Uint8Array): Promise<void> {
  await checkedDirectory(directory);
  const path = join(directory, name), existing = await lstat(path).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error;
  });
  if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1 ||
      (existing.mode & 0o777) !== 0o600 || existing.uid !== process.getuid?.())) throw new WorkerError("MISCONFIGURED");
  const temporary = join(directory, ".tmp-" + randomUUID());
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await checkedDirectory(directory); await rename(temporary, path);
  } finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); }
}

/** Private receipts and content-addressed originals. An existing mirror is read-only and never rescanned. */
export async function createWebsiteImageCache(options: { directory: string; originalsDirectory?: string }): Promise<WebsiteImageCache> {
  const root = options.directory, objects = join(root, "sha256"), validators = join(root, "validators");
  const originalRoot = options.originalsDirectory;
  if (!isAbsolute(root) || resolve(root) !== root || (originalRoot &&
      (!isAbsolute(originalRoot) || resolve(originalRoot) !== originalRoot || root === originalRoot ||
       root.startsWith(originalRoot + sep) || originalRoot.startsWith(root + sep)))) throw new WorkerError("MISCONFIGURED");
  for (const path of [root, objects, validators]) { await privateDirectory(path); await checkedDirectory(path); }
  const mirror = options.originalsDirectory ? join(options.originalsDirectory, "sha256") : undefined;
  if (options.originalsDirectory) { await checkedDirectory(options.originalsDirectory); await checkedDirectory(mirror!); }
  const readObject = async (receipt: ImageCacheReceipt) => {
    for (const dir of [mirror, objects]) {
      if (!dir) continue; await checkedDirectory(dir);
      const bytes = await privateBytes(join(dir, receipt.sha256), MAX_IMAGE_BYTES);
      if (bytes && bytes.length === receipt.byteSize && digest(bytes) === receipt.sha256 && imageMime(bytes) === receipt.mime) return bytes;
    }
    return undefined;
  };
  return {
    async read(key, signal) {
      checkSignal(signal); if (!/^[a-f0-9]{64}$/.test(key)) throw new WorkerError("MISCONFIGURED");
      await checkedDirectory(root); await checkedDirectory(validators);
      const bytes = await privateBytes(join(validators, key + ".json"), 4096); if (!bytes) return undefined;
      let receipt: unknown; try { receipt = JSON.parse(Buffer.from(bytes).toString("utf8")); } catch { return undefined; }
      if (!validReceipt(receipt, key)) return undefined;
      const original = await readObject(receipt); checkSignal(signal);
      return original ? { receipt, image: { bytes: original, mime: receipt.mime } } : undefined;
    },
    async write(receipt, image, signal) {
      checkSignal(signal);
      await checkedDirectory(root);
      if (!validReceipt(receipt, receipt.key) || image.transformed || image.bytes.length !== receipt.byteSize ||
          digest(image.bytes) !== receipt.sha256 || imageMime(image.bytes) !== receipt.mime || image.mime !== receipt.mime) throw new WorkerError("IMAGE_REJECTED");
      if (!await readObject(receipt)) await atomicBytes(objects, receipt.sha256, image.bytes);
      checkSignal(signal); await atomicBytes(validators, receipt.key + ".json", Buffer.from(JSON.stringify(receipt) + "\n")); checkSignal(signal);
    },
  };
}
