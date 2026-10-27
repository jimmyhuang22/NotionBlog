import { constants } from "node:fs";
import { mkdir, open, realpath, lstat, rm } from "node:fs/promises";
import { join, dirname, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { exportPublicationArchive, restorePublicationArchive, createPublicationArchiveStore, type PublicationArchive } from "../../src/server/database/publication-archive.ts";
import type { SqlExecutor } from "../../src/server/database/sql.ts";
import type { ObjectStorage } from "../../src/server/database/storage.ts";
import { WEBSITE_SCHEMA_DIGEST } from "../../contracts/website-sync.ts";
import { privateDirectory, readPrivateFile } from "../notion-sync/state.ts";

const files = ["queue/incremental.sqlite", "study/study.sqlite", "content/content.sqlite", "incremental-ready.json"] as const;
const maxBytes = 192 * 1024 * 1024;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const fail = (): never => { throw Error("MANAGEMENT_BACKUP_INVALID"); };
interface RuntimeBackup {
  format: "notionblog-runtime-backup-1"; configDigest: string; publicationRevision: string;
  files: {path: string; byteSize: number; sha256: string}[];
}
function scope(archive: PublicationArchive) {
  const state = archive.core.tables.state[0], run = archive.publication[0].run_id;
  if (!run || state.lease_run !== null || state.schema_digest !== WEBSITE_SCHEMA_DIGEST) fail();
  return {configDigest: String(state.config_digest), publicationRevision: `${run}:${state.revision}`, policyEpoch: String(state.epoch)};
}
async function bytes(path: string, limit = maxBytes): Promise<Buffer> {
  if (await realpath(dirname(path)) !== dirname(path)) fail();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = await file.stat();
    if (!s.isFile() || s.nlink !== 1 || s.size < 1 || s.size > limit || s.mode & 0o077 || process.getuid && s.uid !== process.getuid()) fail();
    const data = await file.readFile(); if (data.length !== s.size) fail(); return data;
  } finally { await file.close(); }
}
async function write(path: string, data: Uint8Array) {
  await privateDirectory(dirname(path));
  const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
}
async function absent(path: string) {
  try { await lstat(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
  fail();
}
/** Read-only checks on closed SQLite files; the caller holds the existing worker lock. */
async function validateRuntime(directory: string, archive: PublicationArchive) {
  const expected = scope(archive), ready = JSON.parse(await readPrivateFile(join(directory, "incremental-ready.json")));
  if (ready.format !== "incremental-host-ready-v1" || ready.configDigest !== expected.configDigest || ready.schemaDigest !== WEBSITE_SCHEMA_DIGEST ||
      ready.policyEpoch !== expected.policyEpoch || ready.directorySeeded !== true || !Array.isArray(ready.deniedPageIds)) fail();
  const apps = [0x4e424951, 0x4e425343, 0x4e424343];
  for (let i = 0; i < 3; i++) {
    const path = join(directory, files[i]); await bytes(path);
    for (const suffix of ["-journal", "-wal", "-shm"]) await absent(path + suffix);
    const db = new DatabaseSync(path, {readOnly: true});
    try {
      if (db.prepare("PRAGMA quick_check").all().some(row => row.quick_check !== "ok") || db.prepare("PRAGMA foreign_key_check").all().length ||
          db.prepare("PRAGMA application_id").get()?.application_id !== apps[i] ||
          db.prepare("PRAGMA user_version").get()?.user_version !== (i === 0 ? 5 : 1) ||
          db.prepare("SELECT digest FROM scope").get()?.digest !== expected.configDigest) fail();
      if (i === 0) {
        if (db.prepare("SELECT count(*) AS n FROM jobs WHERE state IN ('leased','awaiting_verification')").get()?.n ||
            db.prepare("SELECT count(*) AS n FROM retirements WHERE acknowledged=0").get()?.n) fail();
      } else {
        const row = db.prepare(i === 1 ? "SELECT value FROM checkpoint WHERE singleton=1" : "SELECT value FROM state WHERE singleton=1").get();
        const state = JSON.parse(String(row?.value));
        if ((i === 1 ? state.version : state.publicationRevision) !== expected.publicationRevision ||
            (i === 1 ? state.sourceDigest : state.configDigest) !== expected.configDigest ||
            i === 2 && state.policyEpoch !== expected.policyEpoch || db.prepare("SELECT count(*) AS n FROM operations WHERE status='prepared'").get()?.n) fail();
      }
    } finally { db.close(); }
  }
}

/** Owner-only paired database/local backup. No browser endpoint or implicit network call. */
export function createManagementBackup(privateRoot: string) {
  const root = resolve(privateRoot), publication = createPublicationArchiveStore(root);
  function path(input: string) { const p = resolve(input); if (!p.startsWith(root + sep)) fail(); return p; }
  return {
    async save(db: SqlExecutor, runtime: string, input: string, storage?: Pick<ObjectStorage, "read">) {
      const archive = await exportPublicationArchive(db), expected = scope(archive);
      await validateRuntime(runtime, archive);
      const snapshots = await Promise.all(files.map(async name => ({name, data: await bytes(join(runtime, name))})));
      if (snapshots.reduce((n, file) => n + file.data.length, 0) > maxBytes) fail();
      const destination = path(input); await privateDirectory(dirname(destination)); await mkdir(destination, {mode: 0o700});
      try {
        const saved = await publication.save(join(destination, "publication"), archive, storage);
        const metadata: RuntimeBackup = {format: "notionblog-runtime-backup-1", configDigest: expected.configDigest,
          publicationRevision: expected.publicationRevision, files: []};
        for (const file of snapshots) {
          await write(join(destination, "runtime", file.name), file.data);
          metadata.files.push({path: file.name, byteSize: file.data.length, sha256: sha(file.data)});
        }
        await validateRuntime(join(destination, "runtime"), archive);
        // Completion marker last. Interrupted backups are rejected by load().
        await write(join(destination, "runtime.json"), Buffer.from(JSON.stringify(metadata)));
        return {...saved, runtimeFiles: files.length, runtimeBytes: snapshots.reduce((n, file) => n + file.data.length, 0)};
      } catch (e) { await rm(destination, {recursive: true, force: true}); throw e; }
    },
    async load(input: string) {
      const source = path(input), saved = await publication.load(join(source, "publication"));
      const metadata = JSON.parse((await bytes(join(source, "runtime.json"), 65536)).toString()) as RuntimeBackup;
      const expected = scope(saved.archive);
      if (!metadata || Object.keys(metadata).sort().join() !== "configDigest,files,format,publicationRevision" ||
          metadata.format !== "notionblog-runtime-backup-1" || metadata.configDigest !== expected.configDigest ||
          metadata.publicationRevision !== expected.publicationRevision || !Array.isArray(metadata.files) || metadata.files.length !== files.length ||
          metadata.files.reduce((n, file) => n + file.byteSize, 0) > maxBytes) fail();
      for (const [i, name] of files.entries()) {
        const info = metadata.files[i], data = await bytes(join(source, "runtime", name));
        if (!info || Object.keys(info).sort().join() !== "byteSize,path,sha256" || info.path !== name || info.byteSize !== data.length || info.sha256 !== sha(data)) fail();
      }
      await validateRuntime(join(source, "runtime"), saved.archive);
      return {...saved, source};
    },
    /** New runtime only. Its ready marker is deliberately withheld, so old work cannot replay. */
    async restore(db: SqlExecutor, input: string, runtime: string) {
      const saved = await this.load(input); await absent(runtime); await privateDirectory(dirname(runtime));
      await mkdir(runtime, {mode: 0o700});
      // Prepare every local file BEFORE the database write. On an uncertain SQL result,
      // retain this inactive directory for inspection and never automatically retry.
      for (const name of files) await write(join(runtime, name === "incremental-ready.json" ? "restored-ready.json" : name), await bytes(join(saved.source, "runtime", name)));
      await write(join(runtime, "rebaseline-required.json"), Buffer.from(JSON.stringify({format: "notionblog-runtime-restore-1", publicationEnabled: false, runtimeReady: false})));
      await restorePublicationArchive(db, saved.archive);
      return {restored: true, publicationEnabled: false, freezeEnabled: false, runtimeReady: false, objectUploads: 0};
    },
  };
}
