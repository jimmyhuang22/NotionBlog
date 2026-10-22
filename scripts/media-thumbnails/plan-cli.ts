import { constants, type Stats } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ContentServiceError } from "../../contracts/repository.ts";
import type { ContentKind } from "../../contracts/content.ts";
import type { PublicContentSnapshot } from "../../contracts/website.ts";
import { planThumbnailCoverage, type ThumbnailPlanningInventory, type ThumbnailPlanningLimits } from "./planning.ts";

const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const MAX_OPTIONS_BYTES = 2 * 1024 * 1024;
const usage = `Usage: node scripts/media-thumbnails/plan-cli.ts
  --snapshot ABSOLUTE_PRIVATE_JSON --inventory ABSOLUTE_PRIVATE_JSON
  --options ABSOLUTE_PRIVATE_JSON --output-dir ABSOLUTE_NEW_PRIVATE_DIRECTORY
Inputs must be owner-only 600 files under canonical 700 directories.
The output parent must be owner-only 700; an existing output must be empty.
This creates proposals only. No credentials, SQL, network, encoding or execution.`;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function failed(): never {
  throw new ContentServiceError("MISCONFIGURED", "Thumbnail coverage planning failed. Check private inputs, qualification and the output directory.");
}
function sameInode(a: Stats, b: Stats): boolean { return a.dev === b.dev && a.ino === b.ino; }
async function directory(path: string): Promise<Stats> {
  if (!isAbsolute(path) || resolve(path) !== path) failed();
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700 ||
      (process.getuid && info.uid !== process.getuid()) || await realpath(path) !== path) failed();
  return info;
}
function privateFile(info: Stats): void {
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600 ||
      (process.getuid && info.uid !== process.getuid())) failed();
}
async function readJSON(path: string, maximum: number): Promise<{ value: unknown; sha256: string }> {
  if (!isAbsolute(path) || resolve(path) !== path) failed();
  await directory(dirname(path));
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat(); privateFile(before);
    if (before.size > maximum) failed();
    const chunks: Buffer[] = []; let size = 0;
    while (true) {
      const chunk = Buffer.alloc(Math.min(65536, maximum + 1 - size));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      size += bytesRead; if (size > maximum) failed();
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const after = await file.stat(); privateFile(after);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || after.size !== size) failed();
    const text = Buffer.concat(chunks, size).toString("utf8");
    return { value: JSON.parse(text), sha256: hash(text) };
  } finally { await file.close(); }
}
async function outputTarget(path: string): Promise<Stats | undefined> {
  if (!isAbsolute(path) || resolve(path) !== path) failed();
  await directory(dirname(path));
  const info = await lstat(path).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (info) {
    await directory(path);
    if ((await readdir(path)).length !== 0) failed();
  }
  return info;
}
function anonymousSummary(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) failed();
  const entries = Object.entries(value);
  if (entries.some(([key, count]) => !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) ||
      typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)) failed();
  return Object.fromEntries(entries) as Record<string, number>;
}

/** Offline-only file adapter. Reports and batch files never establish execution eligibility. */
export async function thumbnailPlanCommand(args: string[]): Promise<{ status: "PLANNING_ONLY"; summary: Record<string, number> } | undefined> {
  try {
    const { values, positionals, tokens } = parseArgs({ args, strict: true, allowPositionals: false, tokens: true, options: {
      snapshot: { type: "string" }, inventory: { type: "string" }, options: { type: "string" },
      "output-dir": { type: "string" }, help: { type: "boolean" },
    } });
    const optionNames = tokens.filter(token => token.kind === "option").map(token => token.name);
    if (new Set(optionNames).size !== optionNames.length) failed();
    if (values.help && Object.keys(values).length === 1) { console.log(usage); return; }
    if (positionals.length || values.help || !values.snapshot || !values.inventory || !values.options || !values["output-dir"]) failed();
    const output = values["output-dir"], target = await outputTarget(output);
    const [snapshot, inventory, options] = await Promise.all([
      readJSON(values.snapshot, MAX_INPUT_BYTES), readJSON(values.inventory, MAX_INPUT_BYTES), readJSON(values.options, MAX_OPTIONS_BYTES),
    ]);
    if (!options.value || typeof options.value !== "object" || Array.isArray(options.value) ||
        Object.keys(options.value).length !== 2 || !Object.hasOwn(options.value, "enabledKinds") || !Object.hasOwn(options.value, "limits")) failed();
    const config = options.value as { enabledKinds: readonly ContentKind[]; limits: ThumbnailPlanningLimits };
    const report = await planThumbnailCoverage({ snapshot: snapshot.value as PublicContentSnapshot,
      inventory: inventory.value as ThumbnailPlanningInventory, enabledKinds: config.enabledKinds, limits: config.limits });
    if (report.status !== "PLANNING_ONLY") failed();
    const summary = anonymousSummary(report.summary);
    const parent = dirname(output), parentInode = await directory(parent);
    const staging = join(parent, `.thumbnail-coverage-${process.pid}-${randomUUID()}`);
    const written: { path: string; inode: Stats }[] = [];
    let stagingInode: Stats | undefined, installed = false;
    try {
      await mkdir(staging, { mode: 0o700 }); stagingInode = await directory(staging);
      const files: { file: string; sha256: string }[] = [];
      async function save(name: string, value: unknown) {
        if (!/^[a-z0-9][a-z0-9.-]*\.json$/.test(name)) failed();
        const text = JSON.stringify(value, null, 2) + "\n";
        if (Buffer.byteLength(text) > MAX_INPUT_BYTES) failed();
        const path = join(staging, name);
        const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {
          const inode = await file.stat(); privateFile(inode); written.push({ path, inode });
          await file.writeFile(text); await file.sync();
        } finally { await file.close(); }
        files.push({ file: name, sha256: hash(text) });
      }
      await save("coverage-report.json", report);
      for (const batch of report.batches) {
        if (!Number.isSafeInteger(batch.number) || batch.number < 1) failed();
        const prefix = `batch-${String(batch.number).padStart(4, "0")}`;
        await save(`${prefix}-plan.json`, batch.plan);
        await save(`${prefix}-widths.json`, batch.widths);
        await save(`${prefix}-budget.json`, batch.budget);
      }
      // The marker is last, and the whole directory is installed only after all
      // files are synced. A failed staging tree is never a completed proposal.
      await save("coverage-complete.json", { status: "PLANNING_ONLY", proposalsOnly: true,
        executionAuthorized: false, batchCount: report.batches.length, files,
        inputSHA256: { snapshot: snapshot.sha256, inventory: inventory.sha256, options: options.sha256 } });
      const staged = await open(staging, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { await staged.sync(); } finally { await staged.close(); }
      if (!sameInode(await directory(parent), parentInode) || !sameInode(await directory(staging), stagingInode)) failed();
      const current = await outputTarget(output);
      if (target ? !current || !sameInode(current, target) : current !== undefined) failed();
      await rename(staging, output); installed = true;
      const parentHandle = await open(parent, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { await parentHandle.sync(); } finally { await parentHandle.close(); }
    } finally {
      if (!installed && stagingInode) {
        const now = await lstat(staging).catch(error => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw error;
        });
        if (now && now.isDirectory() && !now.isSymbolicLink() && sameInode(now, stagingInode)) {
          for (const own of [...written].reverse()) {
            const file = await lstat(own.path).catch(error => {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
              throw error;
            });
            if (file && !file.isSymbolicLink() && sameInode(file, own.inode)) await unlink(own.path);
          }
          await rmdir(staging);
        }
      }
    }
    return { status: "PLANNING_ONLY", summary };
  } catch { return failed(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  thumbnailPlanCommand(process.argv.slice(2)).then(result => {
    if (result) console.log(JSON.stringify(result));
  }).catch(() => {
    console.error(JSON.stringify({ status: "FAILED", error: "Thumbnail coverage planning failed. No execution was attempted." }));
    process.exitCode = 1;
  });
}
