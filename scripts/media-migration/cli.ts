import { constants, type Stats } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { lstat, open, link, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { MigrationPlanError, planMediaMigration } from "./plan.ts";

const MAX_BYTES = 16 * 1024 * 1024;
const usage = `Usage: node scripts/media-migration/cli.ts --inventory ABSOLUTE_PRIVATE_JSON --output ABSOLUTE_NEW_PRIVATE_JSON
Owner-only 600 files under canonical 700 directories. Existing output is never replaced.
Offline metadata planning only; no credentials, image reads, network, upload, deletion or publication.`;
function fail(): never { throw new MigrationPlanError(); }
const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
async function directory(path: string) {
  if (!isAbsolute(path) || resolve(path) !== path) fail();
  const s = await lstat(path);
  if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o777) !== 0o700 ||
      process.getuid && s.uid !== process.getuid() || await realpath(path) !== path) fail();
  return s;
}
function file(s: Stats) {
  if (!s.isFile() || s.nlink !== 1 || (s.mode & 0o777) !== 0o600 || process.getuid && s.uid !== process.getuid()) fail();
}
async function read(path: string) {
  if (!isAbsolute(path) || resolve(path) !== path) fail();
  const parent = await directory(dirname(path));
  const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await f.stat(); file(before);
    if (before.size < 1 || before.size > MAX_BYTES) fail();
    // Bounded even if a file grows after stat.
    const bytes = Buffer.alloc(before.size + 1); let size = 0;
    while (size < bytes.length) { const part = await f.read(bytes, size, bytes.length - size, size); if (!part.bytesRead) break; size += part.bytesRead; }
    const after = await f.stat(), current = await lstat(path); file(after); file(current);
    if (size !== before.size || after.size !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
        !same(before, current) || current.isSymbolicLink() || !same(parent, await directory(dirname(path)))) fail();
    const data = bytes.subarray(0, size);
    return { value: JSON.parse(data.toString("utf8")) as unknown, sha256: createHash("sha256").update(data).digest("hex") };
  } finally { await f.close(); }
}
export async function mediaMigrationCommand(args: string[]) {
  try {
    const { values, tokens } = parseArgs({ args, strict: true, allowPositionals: false, tokens: true,
      options: { inventory: { type: "string" }, output: { type: "string" }, help: { type: "boolean" } } });
    const names = tokens.filter(t => t.kind === "option").map(t => t.name);
    if (new Set(names).size !== names.length) fail();
    if (values.help && Object.keys(values).length === 1) { console.log(usage); return; }
    if (values.help || !values.inventory || !values.output || !isAbsolute(values.output) || resolve(values.output) !== values.output) fail();
    const parentPath = dirname(values.output), parent = await directory(parentPath);
    const input = await read(values.inventory), plan = planMediaMigration(input.value);
    const bytes = JSON.stringify({ ...plan, inputSHA256: input.sha256 }) + "\n";
    if (Buffer.byteLength(bytes) > MAX_BYTES) fail();
    const temporary = join(parentPath, `.migration-${randomUUID()}`);
    const f = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const own = await f.stat();
    try {
      try { await f.writeFile(bytes); await f.sync(); } finally { await f.close(); }
      if (!same(parent, await directory(parentPath))) fail();
      // Immutable installation; never overwrite a receipt, symlink or input file.
      await link(temporary, values.output);
    } finally {
      const current = await lstat(temporary).catch(() => undefined);
      if (current && !current.isSymbolicLink() && same(own, current)) await unlink(temporary);
    }
    const d = await open(parentPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await d.sync(); } finally { await d.close(); }
    return { status: "PLANNING_ONLY" as const, executionAuthorized: false as const,
      summary: plan.summary, original: plan.original.summary, candidate: plan.candidate.summary };
  } catch { fail(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  mediaMigrationCommand(process.argv.slice(2)).then(result => { if (result) console.log(JSON.stringify(result)); })
    .catch(() => { console.error(JSON.stringify({ status: "FAILED", errorCode: "MEDIA_MIGRATION_INPUT_INVALID" })); process.exitCode = 1; });
}
