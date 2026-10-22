import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock } from "../scripts/notion-sync/state.ts";
import { acquireWithdrawalLocks, privateCachePath, saveCacheJournal } from "../scripts/public-cache/local.ts";

async function fixture(work: (root: string, directories: string[]) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cache-lock-config-")));
  const directories = Array.from({ length: 6 }, (_, index) => join(root, ".config", "site", `worker-${index}`));
  const previous = process.env.PUBLIC_CACHE_SYNC_LOCK_DIRECTORIES_JSON;
  const previousPaths = process.env.PUBLIC_CACHE_SYNC_LOCK_PATHS_JSON;
  try {
    delete process.env.PUBLIC_CACHE_SYNC_LOCK_PATHS_JSON;
    for (const directory of directories) await mkdir(directory, { recursive: true, mode: 0o700 });
    process.env.PUBLIC_CACHE_SYNC_LOCK_DIRECTORIES_JSON = JSON.stringify(directories);
    await work(root, directories);
  } finally {
    if (previous === undefined) delete process.env.PUBLIC_CACHE_SYNC_LOCK_DIRECTORIES_JSON;
    else process.env.PUBLIC_CACHE_SYNC_LOCK_DIRECTORIES_JSON = previous;
    if (previousPaths === undefined) delete process.env.PUBLIC_CACHE_SYNC_LOCK_PATHS_JSON;
    else process.env.PUBLIC_CACHE_SYNC_LOCK_PATHS_JSON = previousPaths;
    await rm(root, { recursive: true, force: true });
  }
}
async function absent(directories: string[]) {
  for (const directory of directories) await assert.rejects(lstat(join(directory, "worker.lock")), { code: "ENOENT" });
}

test("withdrawal takes the six configured private business locks outside .local, then releases them", async () => fixture(async (root, directories) => {
  assert.ok(!root.split("/").includes(".local"));
  const release = await acquireWithdrawalLocks();
  for (const directory of directories) {
    const path = join(directory, "worker.lock");
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await readFile(path, "utf8")).pid, process.pid);
  }
  await release(); await absent(directories);
  const journal = join(root, "journal.json");
  assert.throws(() => privateCachePath(journal), /CACHE_PRIVATE_PATH/);
  await assert.rejects(saveCacheJournal(journal, { fixture: true }), /CACHE_PRIVATE_PATH/);
  await assert.rejects(lstat(journal), { code: "ENOENT" });
}));

function useFiles(directories: string[]) {
  const names = ["maintenance.lock", "manual-run.lock", "writer-session.lock", "worker.lock", "worker.lock", "maintenance.lock"];
  const paths = directories.map((directory, index) => join(directory, names[index]!));
  delete process.env.PUBLIC_CACHE_SYNC_LOCK_DIRECTORIES_JSON;
  process.env.PUBLIC_CACHE_SYNC_LOCK_PATHS_JSON = JSON.stringify(paths);
  return paths;
}

test("withdrawal occupies each original filename instead of creating replacement worker locks", async () => fixture(async (_root, directories) => {
  const paths = useFiles(directories), release = await acquireWithdrawalLocks();
  try {
    for (const path of paths) assert.equal(JSON.parse(await readFile(path, "utf8")).pid, process.pid);
    for (let index = 0; index < paths.length; index++) if (!paths[index]!.endsWith("/worker.lock"))
      await assert.rejects(lstat(join(directories[index]!, "worker.lock")), { code: "ENOENT" });
  } finally { await release(); }
  for (const path of paths) await assert.rejects(lstat(path), { code: "ENOENT" });
}));

test("busy original manual/session files and symlink locks are preserved with partial acquisition released", async () => fixture(async (_root, directories) => {
  const paths = useFiles(directories);
  for (const index of [1, 2]) {
    const path = paths[index]!; await writeFile(path, "other-owner", { mode: 0o600 });
    const inode = (await lstat(path)).ino;
    await assert.rejects(acquireWithdrawalLocks(), { code: "EEXIST" });
    assert.equal(await readFile(path, "utf8"), "other-owner"); assert.equal((await lstat(path)).ino, inode);
    for (const other of paths.filter(p => p !== path)) await assert.rejects(lstat(other), { code: "ENOENT" });
    await rm(path);
  }
  const target = join(directories[0]!, "unrelated"); await writeFile(target, "keep", { mode: 0o600 });
  await symlink(target, paths[1]!); await assert.rejects(acquireWithdrawalLocks(), { code: "EEXIST" });
  assert.equal(await readFile(target, "utf8"), "keep"); assert.equal((await lstat(paths[1]!)).isSymbolicLink(), true);
  await assert.rejects(lstat(paths[0]!), { code: "ENOENT" });
}));

test("replaced or modified lock ownership is retained while every other owned lock is released", async () => fixture(async (_root, directories) => {
  const paths = useFiles(directories), release = await acquireWithdrawalLocks();
  await writeFile(paths[2]!, "foreign-in-place");
  await rm(paths[4]!); await writeFile(paths[4]!, "foreign-replacement", { mode: 0o600 });
  await assert.rejects(release(), /CACHE_SYNC_LOCK_RELEASE_FAILED/);
  assert.equal(await readFile(paths[2]!, "utf8"), "foreign-in-place");
  assert.equal(await readFile(paths[4]!, "utf8"), "foreign-replacement");
  for (const path of paths.filter((_, i) => i !== 2 && i !== 4)) await assert.rejects(lstat(path), { code: "ENOENT" });
}));

test("ambiguous configurations and missing original parents cannot create substitute directories", async () => fixture(async (root, directories) => {
  const paths = useFiles(directories);
  process.env.PUBLIC_CACHE_SYNC_LOCK_DIRECTORIES_JSON = JSON.stringify(directories);
  await assert.rejects(acquireWithdrawalLocks(), /CACHE_SYNC_LOCK_CONFIG/);
  delete process.env.PUBLIC_CACHE_SYNC_LOCK_DIRECTORIES_JSON;
  const missing = join(root, "does-not-exist", "manual-run.lock");
  process.env.PUBLIC_CACHE_SYNC_LOCK_PATHS_JSON = JSON.stringify([...paths.slice(0, 5), missing]);
  await assert.rejects(acquireWithdrawalLocks(), { code: "ENOENT" });
  await assert.rejects(lstat(join(root, "does-not-exist")), { code: "ENOENT" });
  for (const path of paths) await assert.rejects(lstat(path), { code: "ENOENT" });
}));

test("a busy original lock is unchanged and all partially acquired locks are released", async () => fixture(async (_root, directories) => {
  const busy = directories[3]!, release = await acquireLock(busy, randomUUID());
  const path = join(busy, "worker.lock"), before = await readFile(path, "utf8"), inode = (await lstat(path)).ino;
  try {
    await assert.rejects(acquireWithdrawalLocks());
    assert.equal(await readFile(path, "utf8"), before); assert.equal((await lstat(path)).ino, inode);
    await absent(directories.filter(directory => directory !== busy));
  } finally { await release(); }
}));

test("all lock directories must already exist and pass validation before any lock is taken", async () => fixture(async (root, directories) => {
  const last = directories[5]!;
  await chmod(last, 0o755); await assert.rejects(acquireWithdrawalLocks(), /CACHE_SYNC_LOCK_CONFIG/);
  await absent(directories); await chmod(last, 0o700);
  await rm(last, { recursive: true }); await assert.rejects(acquireWithdrawalLocks(), { code: "ENOENT" });
  await absent(directories.slice(0, 5)); await assert.rejects(lstat(last), { code: "ENOENT" });
  await symlink(directories[0]!, last); await assert.rejects(acquireWithdrawalLocks(), /CACHE_SYNC_LOCK_CONFIG/);
  await absent(directories.slice(0, 5)); await rm(last);
  await writeFile(last, "fixture", { mode: 0o600 }); await assert.rejects(acquireWithdrawalLocks(), /CACHE_SYNC_LOCK_CONFIG/);
  await absent(directories.slice(0, 5));
  process.env.PUBLIC_CACHE_SYNC_LOCK_DIRECTORIES_JSON = JSON.stringify([...directories.slice(0, 5), `${root}/elsewhere/../worker`]);
  await assert.rejects(acquireWithdrawalLocks(), /CACHE_SYNC_LOCK_CONFIG/); await absent(directories.slice(0, 5));
  await rm(last); await mkdir(last, { mode: 0o700 });
  const alias = join(root, "alias"); await symlink(join(root, ".config", "site"), alias);
  process.env.PUBLIC_CACHE_SYNC_LOCK_DIRECTORIES_JSON = JSON.stringify([...directories.slice(0, 5), join(alias, "worker-5")]);
  await assert.rejects(acquireWithdrawalLocks(), /CACHE_SYNC_LOCK_CONFIG/); await absent(directories);
}));

test("missing, duplicate or relative lock configuration never creates substitute locks", async () => fixture(async (_root, directories) => {
  for (const input of [null, directories.slice(1), [...directories.slice(0, 5), directories[0]], [...directories.slice(0, 5), "relative-worker"]]) {
    process.env.PUBLIC_CACHE_SYNC_LOCK_DIRECTORIES_JSON = JSON.stringify(input);
    await assert.rejects(acquireWithdrawalLocks(), /CACHE_SYNC_LOCK_CONFIG/);
    await absent(directories);
  }
}));
