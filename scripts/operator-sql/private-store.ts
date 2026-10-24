import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve, dirname } from "node:path";

async function syncDirectory(path: string): Promise<void> {
  const file = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await file.sync(); } finally { await file.close(); }
}
export async function privateFolder(path: string): Promise<boolean> {
  if (resolve(path) !== path) throw Error("OPERATOR_PRIVATE_PATH_INVALID");
  const firstCreated = await mkdir(path, { mode: 0o700, recursive: true });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || (stat.mode & 0o777) !== 0o700)
    throw Error("OPERATOR_PRIVATE_DIRECTORY_INVALID");
  if (firstCreated) {
    for (let current = path;; current = dirname(current)) {
      await syncDirectory(current); await syncDirectory(dirname(current));
      if (current === firstCreated) break;
    }
  }
  return firstCreated !== undefined;
}
export async function privateRead(path: string, maximum: number): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.uid !== process.getuid!() || (before.mode & 0o777) !== 0o600 || before.nlink !== 1 || before.size > maximum)
      throw Error("OPERATOR_PRIVATE_FILE_INVALID");
    const text = await file.readFile("utf8"), after = await file.stat(), current = await lstat(path);
    if (Buffer.byteLength(text) !== before.size || before.ino !== current.ino || before.dev !== current.dev ||
        before.mtimeMs !== after.mtimeMs || before.size !== after.size || current.isSymbolicLink())
      throw Error("OPERATOR_PRIVATE_FILE_CHANGED");
    return text;
  } finally { await file.close(); }
}
export async function privateWrite(path: string, text: string): Promise<void> {
  const temporary = path + ".tmp-" + randomUUID();
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try { await file.writeFile(text); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
}
/** No stale-lock deletion. A busy/killed owner requires review, not a new budget. */
export async function privateLock<T>(path: string, work: () => Promise<T>): Promise<T> {
  const until = Date.now() + 1000;
  let file;
  while (!file) {
    try { file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= until) throw error;
      const current = await lstat(path).catch(error => { if (error.code === "ENOENT") return null; throw error; });
      if (current && (!current.isFile() || current.isSymbolicLink() || current.uid !== process.getuid!() || (current.mode & 0o777) !== 0o600))
        throw Error("OPERATOR_LOCK_INVALID");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  const identity = await file.stat();
  try { return await work(); }
  finally {
    try {
      const current = await lstat(path);
      if (current.ino !== identity.ino || current.dev !== identity.dev || current.isSymbolicLink()) throw Error("OPERATOR_LOCK_CHANGED");
      await unlink(path);
    } finally { await file.close(); }
  }
}
