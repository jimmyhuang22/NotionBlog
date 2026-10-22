import { constants, type Stats } from "node:fs";
import { randomUUID } from "node:crypto";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { ContentServiceError } from "../../contracts/repository.ts";
import type { StoredMedia } from "../../contracts/sync.ts";
import type { ThumbnailProjection, ThumbnailWidth } from "../../src/server/database/thumbnail-index.ts";
import { canonicalJson, mediaIdentity, validateMedia } from "../../src/server/database/validation.ts";
import { validateMediaSource, type MediaSourceProjection, type MediaSourceVersion } from "../../src/server/media/notion-source.ts";

const FORMAT = "notionblog-verified-thumbnail-cache-v1";
const FILE = "verified-thumbnails.json";
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_SOURCES = 20_000;
const MAX_ENTRIES = 40_000;
const RUN_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

interface CacheEntry {
  version: MediaSourceVersion;
  source: MediaSourceProjection;
  widthCap: ThumbnailWidth;
  thumbnail: StoredMedia;
}
interface CacheSnapshot { format: typeof FORMAT; recipe: string; entries: CacheEntry[] }

/** Candidate byte locations only: this cache never supplies publication eligibility. */
export interface VerifiedThumbnailCache {
  readonly recipe: string;
  lookup(projection: ThumbnailProjection, widthCap: ThumbnailWidth): StoredMedia | null;
  /** Call only after byte verification, registration and the final current-source guard. */
  record(projection: ThumbnailProjection, widthCap: ThumbnailWidth, thumbnail: StoredMedia): void;
  snapshot(): unknown;
}

function unavailable(): never {
  throw new ContentServiceError("CONTENT_UNAVAILABLE", "The private thumbnail cache is unavailable.");
}
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function validRecipe(value: unknown): value is string {
  return typeof value === "string" && /^[\x21-\x7e]{1,256}$/.test(value);
}
function validWidth(value: unknown): value is ThumbnailWidth { return value === 400 || value === 800 || value === 1600; }
function validateSource(source: unknown, version: unknown): asserts source is MediaSourceProjection {
  if ((version !== "v1" && version !== "v2") || !exact(source, ["media", "binding"])) unavailable();
  try { validateMediaSource(source.binding as MediaSourceProjection["binding"], source.media as StoredMedia, version); }
  catch { unavailable(); }
}
function validateThumbnail(value: unknown, source: MediaSourceProjection, widthCap: unknown): asserts value is StoredMedia {
  if (!validWidth(widthCap) || (widthCap === 1600 &&
      (!["cover", "block"].includes(source.binding.locator.kind) || (source.media.width ?? 0) < 1600 ||
       (source.binding.locator.kind === "block" && ((source.media.width ?? 0) <= 1600 ||
         (value as StoredMedia)?.byteSize >= source.media.byteSize))))) unavailable();
  try { validateMedia(value as StoredMedia); } catch { unavailable(); }
  const thumbnail = value as StoredMedia;
  if (thumbnail.ownerPageId !== source.media.ownerPageId || thumbnail.mime !== "image/webp" ||
      thumbnail.assetId !== mediaIdentity(source.media.ownerPageId, `thumbnail:${widthCap}:${source.media.assetId}`, thumbnail.sha256) ||
      !Number.isInteger(thumbnail.width) || thumbnail.width! < 1 || thumbnail.width! > widthCap ||
      !Number.isInteger(thumbnail.height) || thumbnail.height! < 1 || thumbnail.height! > 16383) unavailable();
}
function validateProjection(projection: ThumbnailProjection, widthCap: unknown): void {
  if (!exact(projection, ["version", "runId", "source", "thumbnail"]) ||
      typeof projection.runId !== "string" || !RUN_ID.test(projection.runId) || !validWidth(widthCap)) unavailable();
  validateSource(projection.source, projection.version);
  if (widthCap === 1600 && projection.version !== "v2") unavailable();
  if (projection.thumbnail !== null) validateThumbnail(projection.thumbnail, projection.source, widthCap);
}
// No runId: the caller must qualify the current published source before reuse.
function sourceKey(version: MediaSourceVersion, source: MediaSourceProjection): string {
  return canonicalJson([version, source]);
}
function entryKey(recipe: string, entry: Pick<CacheEntry, "version" | "source" | "widthCap">): string {
  return canonicalJson([recipe, entry.version, entry.source, entry.widthCap]);
}
function byteBound(value: unknown): void {
  try { if (Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES) unavailable(); }
  catch { unavailable(); }
}

/** A valid old encoder recipe is a miss; corrupt old data is still an error. */
export function createVerifiedThumbnailCache(recipe: string, input?: unknown): VerifiedThumbnailCache {
  if (!validRecipe(recipe)) unavailable();
  const entries = new Map<string, CacheEntry>();
  const sources = new Set<string>();
  if (input !== undefined) {
    if (!exact(input, ["format", "recipe", "entries"]) || input.format !== FORMAT ||
        !validRecipe(input.recipe) || !Array.isArray(input.entries) || input.entries.length > MAX_ENTRIES) unavailable();
    byteBound(input);
    const seen = new Set<string>(), previousSources = new Set<string>();
    for (const value of input.entries) {
      if (!exact(value, ["version", "source", "widthCap", "thumbnail"])) unavailable();
      validateSource(value.source, value.version);
      validateThumbnail(value.thumbnail, value.source, value.widthCap);
      const entry = value as unknown as CacheEntry;
      if (entry.widthCap === 1600 && entry.version !== "v2") unavailable();
      const key = entryKey(input.recipe, entry);
      if (seen.has(key)) unavailable();
      seen.add(key); previousSources.add(sourceKey(entry.version, entry.source));
      if (previousSources.size > MAX_SOURCES) unavailable();
      if (input.recipe === recipe) {
        entries.set(key, structuredClone(entry)); sources.add(sourceKey(entry.version, entry.source));
      }
    }
  }
  const cache: VerifiedThumbnailCache = {
    recipe,
    lookup(projection, widthCap) {
      validateProjection(projection, widthCap);
      const entry = entries.get(entryKey(recipe, { version: projection.version, source: projection.source, widthCap }));
      return entry ? structuredClone(entry.thumbnail) : null;
    },
    record(projection, widthCap, thumbnail) {
      validateProjection(projection, widthCap); validateThumbnail(thumbnail, projection.source, widthCap);
      const entry: CacheEntry = { version: projection.version, source: projection.source, widthCap, thumbnail };
      const key = entryKey(recipe, entry), prior = entries.get(key);
      if (prior) {
        if (canonicalJson(prior.thumbnail) !== canonicalJson(thumbnail)) unavailable();
        return;
      }
      const source = sourceKey(projection.version, projection.source);
      if (entries.size >= MAX_ENTRIES || (!sources.has(source) && sources.size >= MAX_SOURCES)) unavailable();
      entries.set(key, structuredClone(entry)); sources.add(source);
    },
    snapshot() {
      const snapshot: CacheSnapshot = { format: FORMAT, recipe,
        entries: [...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, value]) => structuredClone(value)) };
      byteBound(snapshot); return snapshot;
    },
  };
  return Object.freeze(cache);
}

async function privateDirectory(stateDir: string): Promise<void> {
  if (!isAbsolute(stateDir)) unavailable();
  const info = await lstat(stateDir);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700 ||
      (process.getuid && info.uid !== process.getuid()) || await realpath(stateDir) !== stateDir) unavailable();
}
function privateFile(info: Stats): void {
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600 ||
      (process.getuid && info.uid !== process.getuid())) unavailable();
}
async function readCache(path: string): Promise<unknown | undefined> {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  try {
    const before = await handle.stat(); privateFile(before);
    if (before.size > MAX_BYTES) unavailable();
    const chunks: Buffer[] = []; let total = 0;
    while (true) {
      const chunk = Buffer.alloc(Math.min(65536, MAX_BYTES + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > MAX_BYTES) unavailable();
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const after = await handle.stat(); privateFile(after);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || total !== after.size) unavailable();
    return JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
  } finally { await handle.close(); }
}
async function existingFile(path: string): Promise<void> {
  try { privateFile(await lstat(path)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

/** Save while the caller owns its state lock; persistence never touches cloud objects. */
export async function loadVerifiedThumbnailCache(stateDir: string, recipe: string): Promise<VerifiedThumbnailCache & { save(): Promise<void> }> {
  try {
    await privateDirectory(stateDir);
    const path = join(stateDir, FILE);
    const cache = createVerifiedThumbnailCache(recipe, await readCache(path));
    return Object.freeze({
      ...cache,
      async save() {
        const temporary = join(stateDir, `.verified-thumbnails-${process.pid}-${randomUUID()}.tmp`);
        let inode: { dev: number; ino: number } | undefined;
        try {
          await privateDirectory(stateDir); await existingFile(path);
          const content = JSON.stringify(cache.snapshot()) + "\n";
          if (Buffer.byteLength(content) > MAX_BYTES) unavailable();
          const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          try { inode = await handle.stat(); await handle.writeFile(content); await handle.sync(); }
          finally { await handle.close(); }
          await privateDirectory(stateDir); await existingFile(path);
          await rename(temporary, path);
          const directory = await open(stateDir, constants.O_RDONLY | constants.O_NOFOLLOW);
          try { await directory.sync(); } finally { await directory.close(); }
        } catch { unavailable(); }
        finally {
          if (inode) {
            const now = await lstat(temporary).catch(error => {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
              return unavailable();
            });
            if (now && !now.isSymbolicLink() && now.dev === inode.dev && now.ino === inode.ino) {
              try { await unlink(temporary); } catch { unavailable(); }
            }
          }
        }
      },
    });
  } catch { unavailable(); }
}
