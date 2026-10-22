import { join } from "node:path";
import { privateDirectory, readPrivateFile } from "../notion-sync/state.ts";
import { writeJson } from "../game-sync/private.ts";
import { createLocalMediaStorage } from "../../src/server/database/local-storage.ts";
import { validateCoverFiles, type CoverFiles } from "../../src/server/social/covers.ts";
import { hash } from "../social-sync/model.ts";
import { sourceDigest, validateCoverSource, type CoverSource } from "./sources.ts";
import type { CoverCache } from "./worker.ts";

export async function createCoverCache(root: string): Promise<CoverCache> {
  await privateDirectory(root); await privateDirectory(join(root, "sha256"));
  const storage = createLocalMediaStorage(root, "postgresql://localhost/offline", "writer");
  const path = (kind: string, key: string) => join(root, `${kind}-${key}.json`);
  const candidate = async (source: CoverSource, recipe: string) => {
    validateCoverSource(source);
    let raw: string;
    try { raw = await readPrivateFile(path(source.kind, source.key), 16384); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    const row = JSON.parse(raw);
    if (!row || Object.keys(row).sort().join(",") !== "files,recipe,sourceSha256,version" || row.version !== 1 ||
        typeof row.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(row.sourceSha256) ||
        typeof row.recipe !== "string" || !/^[a-f0-9]{64}$/.test(row.recipe)) throw Error("Invalid cover cache metadata");
    validateCoverFiles(row.files, source.kind, source.key);
    if (row.recipe !== hash(recipe)) return null;
    // A prior reference is only an encoding candidate, never proof of current source/visibility.
    for (const media of new Map([row.files.original, row.files.previews["400"], row.files.previews["800"]].map(m => [m.sha256, m])).values()) await storage.read(media);
    return { sourceSha256: row.sourceSha256 as string, files: row.files as CoverFiles };
  };
  return {
    async read(source, recipe) {
      const row = await candidate(source, recipe);
      return row?.sourceSha256 === sourceDigest(source) ? row.files : null;
    },
    previous: candidate,
    async save(source, recipe, files, bodies) {
      validateCoverSource(source);
      if (sourceDigest(source) === null) throw Error("Missing cover cache source");
      validateCoverFiles(files, source.kind, source.key);
      for (const media of [files.original, files.previews["400"], files.previews["800"]]) {
        const bytes = bodies.get(media.sha256); if (!bytes) throw Error("Missing cover cache body"); await storage.put(media, bytes);
      }
      await writeJson(path(source.kind, source.key), { version: 1, sourceSha256: sourceDigest(source), recipe: hash(recipe), files });
    },
    bytes: media => storage.read(media),
  };
}
