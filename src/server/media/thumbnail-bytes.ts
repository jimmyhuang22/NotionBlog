import type { StoredMedia } from "../../../contracts/sync.ts";
import type { ObjectStorage } from "../database/storage.ts";
import { verifyMediaBytes } from "../database/storage.ts";
import { validateMedia } from "../database/validation.ts";
import { ContentServiceError } from "../../../contracts/repository.ts";
import { checkContentReadBudget, contentReadBudgetIdentity } from "../content-read-budget.ts";

export type ThumbnailByteSource = "hit" | "miss" | "coalesced" | "bypass";
interface Entry {
  size: number;
  expiresAt: number;
  ready: boolean;
  settled: boolean;
  reserved: boolean;
  waiters: number;
  controller: AbortController;
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
  let reservedEntries = 0;
  function release(entry: Entry) {
    if (!entry.reserved) return;
    entry.reserved = false;
    reservedBytes -= entry.size;
    reservedEntries--;
  }
  function remove(key: string, entry: Entry) {
    if (entries.get(key) !== entry) return;
    entries.delete(key);
    if (entry.settled) release(entry);
  }
  function wait(key: string, entry: Entry, signal?: AbortSignal): Promise<Buffer> {
    entry.waiters++;
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (ok: boolean, value: unknown) => {
        if (finished) return;
        finished = true;
        signal?.removeEventListener("abort", abort);
        entry.waiters--;
        if (!entry.ready && entry.waiters === 0) {
          remove(key, entry);
          entry.controller.abort();
        }
        if (ok) resolve(Buffer.from(value as Buffer)); else reject(value);
      };
      const abort = () => finish(false, new ContentServiceError("CONTENT_UNAVAILABLE", "The thumbnail read was cancelled."));
      // Always observe the shared result, including an already-cancelled waiter.
      void entry.bytes.then(bytes => finish(true, bytes), error => finish(false, error));
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
  return async (input: StoredMedia, signal?: AbortSignal): Promise<{ bytes: Uint8Array; source: ThumbnailByteSource }> => {
    signal?.throwIfAborted();
    // Snapshot the complete descriptor; a caller cannot mutate an in-flight cache key.
    const media = { ...input };
    validateMedia(media);
    if (media.mime !== "image/webp" || media.byteSize > MAX_OBJECT_BYTES) {
      return { bytes: await storage.read(media, signal), source: "bypass" };
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
      return { bytes: await wait(key, existing, signal), source };
    }
    // Completed entries can be evicted; pending reservations are never multiplied.
    for (const [storedKey, entry] of entries) {
      if (reservedEntries < MAX_ENTRIES && reservedBytes + media.byteSize <= MAX_BYTES) break;
      if (entry.ready) remove(storedKey, entry);
    }
    if (reservedEntries >= MAX_ENTRIES || reservedBytes + media.byteSize > MAX_BYTES) {
      return { bytes: await storage.read(media, signal), source: "bypass" };
    }
    const entry: Entry = { size: media.byteSize, expiresAt: 0, ready: false, settled: false,
      reserved: true, waiters: 0, controller: new AbortController(), bytes: undefined! };
    reservedBytes += media.byteSize;
    reservedEntries++;
    entries.set(key, entry);
    entry.bytes = Promise.resolve().then(async () => {
      try {
        entry.controller.signal.throwIfAborted();
        const bytes = await storage.read(media, entry.controller.signal);
        entry.controller.signal.throwIfAborted();
        verifyMediaBytes(media, bytes);
        const verified = Buffer.from(bytes);
        entry.expiresAt = now() + TTL_MS;
        entry.ready = true;
        return verified;
      } catch (error) {
        remove(key, entry);
        throw error;
      } finally {
        entry.settled = true;
        // An aborted transport keeps its reservation until it actually settles.
        if (entries.get(key) !== entry) release(entry);
      }
    });
    return { bytes: await wait(key, entry, signal), source: "miss" };
  };
}

// Credentials, provider and endpoint are isolated by the actual runtime storage instance.
const readers = new WeakMap<ObjectStorage, ReturnType<typeof createThumbnailByteReader>>();
export async function readThumbnailBytes(storage: ObjectStorage, media: StoredMedia) {
  checkContentReadBudget();
  let read = readers.get(storage);
  if (!read) { read = createThumbnailByteReader(storage); readers.set(storage, read); }
  const result = await read(media, contentReadBudgetIdentity()?.signal);
  checkContentReadBudget();
  return result;
}
