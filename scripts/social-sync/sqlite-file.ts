import * as sqlite from "node:sqlite";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { privateDirectory } from "../notion-sync/state.ts";
import { SocialSyncError } from "./model.ts";

async function checkFile(path: string) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o077) ||
        (process.getuid && info.uid !== process.getuid())) throw new SocialSyncError("PRIVATE_STATE_INVALID");
    return true;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
export async function openSocialDatabase(root: string, name: "social.sqlite" | "social-collections.sqlite", readOnly = false) {
  await privateDirectory(root);
  if (!["social.sqlite", "social-collections.sqlite"].includes(name)) throw new SocialSyncError("PRIVATE_STATE_INVALID");
  const path = join(root, name);
  if (!await checkFile(path)) {
    if (readOnly) return null;
    const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await file.close();
  }
  for (const suffix of ["-journal", "-wal", "-shm"]) await checkFile(path + suffix);
  const Constructor = (sqlite as unknown as { Database?: typeof sqlite.DatabaseSync }).Database ?? sqlite.DatabaseSync;
  return new Constructor(path, { readOnly, timeout: 1000, enableForeignKeyConstraints: true });
}
