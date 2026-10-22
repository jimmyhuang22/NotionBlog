import { constants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { ContentServiceError } from "../../contracts/repository.ts";
import type { StoredMedia } from "../../contracts/sync.ts";
import { verifyMediaBytes } from "../../src/server/database/storage.ts";
import { validateMedia } from "../../src/server/database/validation.ts";

const MAX_BYTES = 20 * 1024 * 1024;
function unavailable(): never {
  throw new ContentServiceError("CONTENT_UNAVAILABLE", "The private original mirror is unavailable.");
}
function sameInode(a: Stats, b: Stats): boolean { return a.dev === b.dev && a.ino === b.ino; }
function privateFile(info: Stats, expected: number): void {
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size !== expected ||
      (info.mode & 0o777) !== 0o600 || (process.getuid && info.uid !== process.getuid())) unavailable();
}
async function directory(path: string): Promise<Stats> {
  if (!isAbsolute(path) || resolve(path) !== path) unavailable();
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700 ||
      (process.getuid && info.uid !== process.getuid()) || await realpath(path) !== path) unavailable();
  return info;
}

/**
 * Read only a pinned SHA-named original. Missing/bad files never trigger a
 * network fallback. The caller still reserves read bytes and checks live scope.
 */
export async function createThumbnailOriginalMirror(directoryPath: string): Promise<
  (media: StoredMedia, signal?: AbortSignal) => Promise<Uint8Array>
> {
  try {
    const root = await directory(directoryPath);
    return async (media, signal) => {
      try {
        signal?.throwIfAborted();
        validateMedia(media);
        if (media.byteSize > MAX_BYTES) unavailable();
        if (!sameInode(root, await directory(directoryPath))) unavailable();
        const path = join(directoryPath, media.sha256);
        const before = await lstat(path); privateFile(before, media.byteSize);
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const opened = await handle.stat(); privateFile(opened, media.byteSize);
          if (!sameInode(before, opened)) unavailable();
          // One extra byte detects growth without an unbounded readFile call.
          const bytes = Buffer.alloc(media.byteSize + 1);
          let size = 0;
          while (size < bytes.byteLength) {
            signal?.throwIfAborted();
            const chunk = await handle.read(bytes, size, Math.min(65536, bytes.byteLength - size), null);
            if (!chunk.bytesRead) break;
            size += chunk.bytesRead;
          }
          signal?.throwIfAborted();
          const after = await handle.stat(), linked = await lstat(path);
          privateFile(after, media.byteSize); privateFile(linked, media.byteSize);
          if (size !== media.byteSize || !sameInode(opened, linked) ||
              opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs ||
              !sameInode(root, await directory(directoryPath))) unavailable();
          const result = bytes.subarray(0, size);
          verifyMediaBytes(media, result);
          signal?.throwIfAborted();
          return result;
        } finally { await handle.close(); }
      } catch { return unavailable(); }
    };
  } catch { return unavailable(); }
}
