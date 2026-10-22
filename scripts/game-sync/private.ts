import { constants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, basename, join } from "node:path";
import { privateDirectory, readPrivateFile } from "../notion-sync/state.ts";
import { GameSyncError } from "./model.ts";

export async function readJson(path: string, maxBytes?: number): Promise<unknown> {
  try { return JSON.parse(await readPrivateFile(path, maxBytes)); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw new GameSyncError("PRIVATE_CONFIG_INVALID"); }
}
export async function writeText(path: string, value: string): Promise<void> {
  const dir = dirname(path); await privateDirectory(dir);
  const temp = join(dir, `.${basename(path)}-${randomUUID()}`);
  const file = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await file.writeFile(value); await file.sync();
  } finally { await file.close(); }
  try { await rename(temp, path); } finally { await unlink(temp).catch(() => {}); }
}
export async function writeJson(path: string, value: unknown): Promise<void> {
  return writeText(path, JSON.stringify(value, null, 2) + "\n");
}
export async function readEnv(path: string): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const line of (await readPrivateFile(path)).split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!m || Object.hasOwn(env, m[1])) throw new GameSyncError("PRIVATE_CONFIG_INVALID");
    env[m[1]] = m[2].trim();
  }
  return env;
}
