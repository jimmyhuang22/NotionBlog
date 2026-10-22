import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, rm } from "node:fs/promises";
import { resolve, sep, dirname, join, parse } from "node:path";
import { createHash } from "node:crypto";
import type { StoredMedia } from "../../../contracts/sync.ts";
import type { ObjectStorage } from "./storage.ts";
import { verifyMediaBytes } from "./storage.ts";
import { archivedWebsiteObjects, validateWebsiteArchive, WEBSITE_ARCHIVE_MAX_BYTES, type WebsiteDatabaseArchive } from "./website-archive.ts";

const MAX_OBJECTS = 10_000, MAX_MEDIA_BYTES = 2 * 1024 * 1024 * 1024;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
interface Manifest {
  format: "notionblog-website-bundle-1";
  archive: { byteSize: number; sha256: string };
  mediaIncluded: boolean;
  media: { objectKey: string; byteSize: number; sha256: string }[];
}
function fail(): never { throw new Error("Private website backup is unavailable or invalid."); }
function owned(stat: Stats) {
  if (stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) fail();
}
/** Archive files remain owner-only under an ignored root; ancestor symlinks are refused. */
export interface WebsiteArchiveCodec<T> {
  validate(value: unknown): asserts value is T;
  objects(archive: T): StoredMedia[];
}
/** Same private bundle transport; each format must supply its own strict codec. */
export function createPrivateWebsiteArchiveStore<T>(privateRoot: string, codec: WebsiteArchiveCodec<T>) {
  const root = resolve(privateRoot);
  async function directory(input: string, createParents = false): Promise<string> {
    const path = resolve(input);
    if (path !== root && !path.startsWith(root + sep)) fail();
    const parts = path.slice(parse(path).root.length).split(sep);
    let current = parse(path).root;
    for (const part of parts) {
      current = join(current, part);
      let stat;
      try { stat = await lstat(current); }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT" || !createParents || !(current === root || current.startsWith(root + sep))) throw e;
        await mkdir(current, { mode: 0o700 }); stat = await lstat(current);
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) fail();
      if (current === root || current.startsWith(root + sep)) owned(stat);
    }
    return path;
  }
  async function write(path: string, bytes: Uint8Array) {
    await directory(dirname(path));
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  }
  async function read(path: string, maxBytes: number): Promise<Buffer> {
    await directory(dirname(path));
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat(); owned(stat);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > maxBytes) fail();
      const bytes = Buffer.alloc(stat.size + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const result = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (result.bytesRead === 0) break;
        offset += result.bytesRead;
      }
      if (offset !== stat.size) fail();
      return bytes.subarray(0, offset);
    } finally { await handle.close(); }
  }
  return {
    /** Exclusive new directory; the completion manifest is written last. No overwrites. */
    async save(input: string, archive: T, storage?: Pick<ObjectStorage, "read">) {
      codec.validate(archive);
      const path = resolve(input);
      // Validate output before creating anything, including traversal outside the ignored root.
      if (!path.startsWith(root + sep)) fail();
      await directory(dirname(path), true);
      await mkdir(path, { mode: 0o700 });
      try {
        const bytes = Buffer.from(JSON.stringify(archive));
        const objects = codec.objects(archive);
        if (storage && (objects.length > MAX_OBJECTS || objects.reduce((n, m) => n + m.byteSize, 0) > MAX_MEDIA_BYTES)) fail();
        await write(join(path, "content.json"), bytes);
        const manifest: Manifest = { format: "notionblog-website-bundle-1", archive: { byteSize: bytes.length, sha256: sha(bytes) }, mediaIncluded: !!storage, media: [] };
        if (storage) {
          await mkdir(join(path, "sha256"), { mode: 0o700 });
          for (const media of objects) {
            const data = await storage.read(media); verifyMediaBytes(media, data);
            await write(join(path, media.objectKey), data);
            manifest.media.push({ objectKey: media.objectKey, byteSize: data.length, sha256: media.sha256 });
          }
        }
        await write(join(path, "manifest.json"), Buffer.from(JSON.stringify(manifest)));
        return { archiveBytes: bytes.length, mediaFiles: manifest.media.length, mediaBytes: manifest.media.reduce((n, m) => n + m.byteSize, 0), mediaIncluded: manifest.mediaIncluded };
      } catch (cause) { await rm(path, { recursive: true, force: true }); throw cause; }
    },
    /** Validate ALL saved object bytes before restore opens a database transaction. */
    async load(input: string): Promise<{ archive: T; mediaIncluded: boolean; mediaFiles: number }> {
      const path = await directory(input);
      const manifest = JSON.parse((await read(join(path, "manifest.json"), 2 * 1024 * 1024)).toString()) as Manifest;
      if (!manifest || Object.keys(manifest).sort().join() !== "archive,format,media,mediaIncluded" || manifest.format !== "notionblog-website-bundle-1" ||
        typeof manifest.mediaIncluded !== "boolean" || !Array.isArray(manifest.media) || manifest.media.length > MAX_OBJECTS || !manifest.archive ||
        Object.keys(manifest.archive).sort().join() !== "byteSize,sha256") fail();
      const bytes = await read(join(path, "content.json"), WEBSITE_ARCHIVE_MAX_BYTES);
      if (bytes.length !== manifest.archive.byteSize || sha(bytes) !== manifest.archive.sha256) fail();
      const archive: unknown = JSON.parse(bytes.toString()); codec.validate(archive);
      const objects = codec.objects(archive);
      if (!manifest.mediaIncluded && manifest.media.length !== 0) fail();
      if (manifest.mediaIncluded) {
        if (manifest.media.length !== objects.length || objects.reduce((n, m) => n + m.byteSize, 0) > MAX_MEDIA_BYTES) fail();
        const byKey = new Map(manifest.media.map(m => [m.objectKey, m]));
        if (byKey.size !== manifest.media.length) fail();
        for (const media of objects) {
          const entry = byKey.get(media.objectKey);
          if (!entry || Object.keys(entry).sort().join() !== "byteSize,objectKey,sha256" || entry.byteSize !== media.byteSize || entry.sha256 !== media.sha256) fail();
          verifyMediaBytes(media, await read(join(path, media.objectKey), media.byteSize));
        }
      }
      return { archive, mediaIncluded: manifest.mediaIncluded, mediaFiles: manifest.media.length };
    },
  };
}
export function createWebsiteArchiveStore(privateRoot = resolve(".local")) {
  return createPrivateWebsiteArchiveStore<WebsiteDatabaseArchive>(privateRoot, {validate: validateWebsiteArchive, objects: archivedWebsiteObjects});
}
