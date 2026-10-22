import type { StoredMedia } from "../../../contracts/sync.ts";
import type { ObjectStorage } from "../database/storage.ts";
import { verifyMediaBytes } from "../database/storage.ts";
import { validateMedia } from "../database/validation.ts";

export type ThumbnailByteSource = "hit" | "miss" | "coalesced" | "bypass";
interface Entry {
  size: number;
  expiresAt: number;
  ready: boolean;
  bytes: Promise<Buffer>;
}

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_OBJECT_BYTES = 1024 * 1024;
const MAX_ENTRIES = 128;
const TTL_MS = 5 * 60 * 1000;

/** Bytes only. Callers must qualify every request both before and after this read. */
export function createThumbnailByteReader(storage: ObjectStorage, now = () => performance.now()) {
  const entries = new Map<string, Entry>();
  let reservedBytes = 0;
  function remove(key: string, entry: Entry) {
    if (entries.get(key) !== entry) return;
    entries.delete(key);
    reservedBytes -= entry.size;
  }
  return async (input: StoredMedia): Promise<{ bytes: Uint8Array; source: ThumbnailByteSource }> => {
    // Snapshot the complete descriptor; a caller cannot mutate an in-flight cache key.
    const media = { ...input };
    validateMedia(media);
    if (media.mime !== "image/webp" || media.byteSize > MAX_OBJECT_BYTES) {
      return { bytes: await storage.read(media), source: "bypass" };
    }
    const key = JSON.stringify([media.assetId, media.ownerPageId, media.objectKey, media.sha256,
      media.byteSize, media.mime, media.width, media.height]);
    const time = now();
    for (const [storedKey, entry] of entries) {
      if (entry.ready && entry.expiresAt <= time) remove(storedKey, entry);
    }
    const existing = entries.get(key);
    if (existing) {
      entries.delete(key); entries.set(key, existing);
      const source = existing.ready ? "hit" : "coalesced";
      return { bytes: Buffer.from(await existing.bytes), source };
    }
    // Completed entries can be evicted; pending reservations are never multiplied.
    for (const [storedKey, entry] of entries) {
      if (entries.size < MAX_ENTRIES && reservedBytes + media.byteSize <= MAX_BYTES) break;
      if (entry.ready) remove(storedKey, entry);
    }
    if (entries.size >= MAX_ENTRIES || reservedBytes + media.byteSize > MAX_BYTES) {
      return { bytes: await storage.read(media), source: "bypass" };
    }
    const entry: Entry = { size: media.byteSize, expiresAt: 0, ready: false, bytes: undefined! };
    reservedBytes += media.byteSize;
    entries.set(key, entry);
    entry.bytes = Promise.resolve().then(async () => {
      try {
        const bytes = await storage.read(media);
        verifyMediaBytes(media, bytes);
        const verified = Buffer.from(bytes);
        entry.expiresAt = now() + TTL_MS;
        entry.ready = true;
        return verified;
      } catch (error) {
        remove(key, entry);
        throw error;
      }
    });
    return { bytes: Buffer.from(await entry.bytes), source: "miss" };
  };
}

// Credentials, provider and endpoint are isolated by the actual runtime storage instance.
const readers = new WeakMap<ObjectStorage, ReturnType<typeof createThumbnailByteReader>>();
export function readThumbnailBytes(storage: ObjectStorage, media: StoredMedia) {
  let read = readers.get(storage);
  if (!read) { read = createThumbnailByteReader(storage); readers.set(storage, read); }
  return read(media);
}
