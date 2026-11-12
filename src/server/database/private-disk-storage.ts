import { constants } from "node:fs";
import { lstat, realpath, open, link, unlink } from "node:fs/promises";
import { isAbsolute, resolve, join, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { ContentServiceError } from "../../../contracts/repository.ts";
import { validateMedia } from "./validation.ts";
import { verifyMediaBytes, type ObjectStorage } from "./storage.ts";

/** Explicit production adapter. Authorization remains in the PG media route;
 * this port accepts only immutable, SHA-addressed files and never calls a cloud. */
export function createPrivateDiskStorage(root: string, role: "reader" | "writer"): ObjectStorage {
  const publicRoot = resolve("public");
  if (!isAbsolute(root) || resolve(root) !== root || root === publicRoot || root.startsWith(publicRoot + sep))
    throw new ContentServiceError("MISCONFIGURED", "Private media root must be outside public.");
  const unavailable = (): never => { throw new ContentServiceError("CONTENT_UNAVAILABLE", "Private media is unavailable."); };
  async function directory() {
    if (await realpath(root) !== root) unavailable();
    const s = await lstat(root);
    if (!s.isDirectory() || (s.mode & 0o077) !== 0 || process.getuid && s.uid !== process.getuid()) unavailable();
  }
  const storage: ObjectStorage = {
    async read(media, signal) {
      validateMedia(media);
      try {
        signal?.throwIfAborted(); await directory();
        const file = await open(join(root, media.sha256), constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const s = await file.stat();
          if (!s.isFile() || s.nlink !== 1 || s.size !== media.byteSize || s.size > 20 * 1024 * 1024 ||
              (s.mode & 0o077) !== 0 || process.getuid && s.uid !== process.getuid()) unavailable();
          const bytes = await file.readFile(); signal?.throwIfAborted();
          verifyMediaBytes(media, bytes); return bytes;
        } finally { await file.close(); }
      } catch { return unavailable(); }
    },
    async put(media, bytes) {
      validateMedia(media); verifyMediaBytes(media, bytes);
      if (role !== "writer" || bytes.length > 20 * 1024 * 1024) unavailable();
      let temporary: string | undefined;
      try {
        await directory(); temporary = join(root, ".upload-" + randomUUID());
        const file = await open(temporary, "wx", 0o600);
        try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
        try { await link(temporary, join(root, media.sha256)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
        await unlink(temporary); temporary = undefined;
        const directoryHandle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
        await storage.read(media);
      } catch { unavailable(); }
      finally { if (temporary) await unlink(temporary).catch(() => {}); }
    },
  };
  return storage;
}

export function privateDiskEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  if (env.STORAGE_PROVIDER !== "private-disk") return false;
  if (env.MEDIA_DELIVERY_MODE !== "display-only" || env.DATABASE_CONTENT_VERSION !== "2" ||
      env.MEDIA_PROVIDER !== "storage" || env.DATABASE_MEDIA_DIRECTORY || !env.PRIVATE_MEDIA_ROOT)
    throw new ContentServiceError("MISCONFIGURED", "Private disk requires the explicit display-only profile.");
  return true;
}
