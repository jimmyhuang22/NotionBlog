import { lstat, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { privateFolder, privateLock, privateRead, privateWrite } from "./private-store.ts";
import { validateCachedProjection, type CachedProjection, type ProjectionCache } from "./projection.ts";

export interface ProjectionCacheLimits { maxBytes: number; maxEntries: number; maxEntryBytes: number }
/** Only operator-owned qualified result bytes. Nothing here grants eligibility:
 * every reuse needs a new, matching database fingerprint under the current role. */
export async function createProjectionCache(directory: string, requestedLimits: ProjectionCacheLimits): Promise<ProjectionCache> {
  const limits = Object.freeze({ ...requestedLimits });
  if (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1 || limits.maxBytes > 256 * 1024 ** 2 ||
      !Number.isSafeInteger(limits.maxEntries) || limits.maxEntries < 1 || limits.maxEntries > 2048 ||
      !Number.isSafeInteger(limits.maxEntryBytes) || limits.maxEntryBytes < 1 || limits.maxEntryBytes > limits.maxBytes)
    throw Error("OPERATOR_CACHE_LIMITS_INVALID");
  await privateFolder(directory);
  const locked = <T>(work: () => Promise<T>) => privateLock(join(directory, ".cache.lock"), work);
  const name = (key: string) => {
    if (!/^[a-f0-9]{64}$/.test(key)) throw Error("OPERATOR_CACHE_KEY_INVALID");
    return join(directory, key + ".json");
  };
  return {
    get: key => locked(async () => {
      try {
        const value: CachedProjection = JSON.parse(await privateRead(name(key), limits.maxEntryBytes * 2 + 1024));
        validateCachedProjection(value);
        if (Buffer.byteLength(value.payload) > limits.maxEntryBytes) throw Error("OPERATOR_CACHE_CORRUPT");
        return value;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        if (error instanceof SyntaxError) throw Error("OPERATOR_CACHE_CORRUPT");
        throw error;
      }
    }),
    put: (key, value) => locked(async () => {
      validateCachedProjection(value);
      const text = JSON.stringify(value), path = name(key), bytes = Buffer.byteLength(text);
      if (Buffer.byteLength(value.payload) > limits.maxEntryBytes || bytes > limits.maxBytes) return;
      const entries: { path: string; bytes: number; time: number }[] = [];
      for (const file of await readdir(directory)) {
        if (file === ".cache.lock") continue;
        if (!/^[a-f0-9]{64}\.json$/.test(file)) throw Error("OPERATOR_CACHE_DIRECTORY_CHANGED");
        const location = join(directory, file), stat = await lstat(location);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1)
          throw Error("OPERATOR_CACHE_DIRECTORY_CHANGED");
        if (location !== path) entries.push({ path: location, bytes: stat.size, time: stat.mtimeMs });
      }
      entries.sort((a, b) => a.time - b.time || a.path.localeCompare(b.path));
      let total = entries.reduce((n, entry) => n + entry.bytes, 0) + bytes;
      while (entries.length >= limits.maxEntries || total > limits.maxBytes) {
        const old = entries.shift();
        if (!old) throw Error("OPERATOR_CACHE_LIMITS_INVALID");
        await unlink(old.path); total -= old.bytes;
      }
      await privateWrite(path, text);
    }),
  };
}
