import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { privateDirectory } from "../notion-sync/state.ts";

/** Replace diagnostics atomically so observers never read a truncated JSON file. */
export async function savePrivateJson(directory: string, name: string, value: unknown): Promise<void> {
  if (!/^[a-z][a-z0-9-]*\.json$/.test(name)) throw new Error("Invalid private report name.");
  const text = JSON.stringify(value, null, 2) + "\n";
  await privateDirectory(directory);
  const temporary = join(directory, `.tmp-${randomUUID()}`);
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
    await rename(temporary, join(directory, name));
    const parent = await open(directory, constants.O_RDONLY);
    try { await parent.sync(); } finally { await parent.close(); }
  } finally { await unlink(temporary).catch(() => {}); }
}
