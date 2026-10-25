import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join, resolve, isAbsolute, sep } from "node:path";
import { createHash } from "node:crypto";
import { checkContentReadBudget } from "../content-read-budget.ts";
import { displayRunId, displayUnavailable, MAX_DISPLAY_MANIFEST_BYTES, validateDisplayFile, validateDisplayManifest, type DisplayFile, type DisplayManifest } from "./manifest.ts";

/** Header validation only; no image decoding, resizing or remote transport in the website. */
export function verifyDisplayBytes(file: DisplayFile, input: Uint8Array): void {
  validateDisplayFile(file); const b = Buffer.from(input);
  if (b.length !== file.byteSize || createHash("sha256").update(b).digest("hex") !== file.sha256 ||
      b.length < 20 || b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WEBP" || b.readUInt32LE(4) + 8 !== b.length) displayUnavailable();
  let width = 0, height = 0, canvas: [number, number] | undefined;
  for (let offset = 12; offset < b.length;) {
    if (offset + 8 > b.length) displayUnavailable();
    const tag = b.toString("ascii", offset, offset + 4), length = b.readUInt32LE(offset + 4), start = offset + 8;
    if (start + length + (length % 2) > b.length || ["ANIM", "ANMF", "EXIF", "XMP ", "ICCP"].includes(tag)) displayUnavailable();
    if (tag === "VP8X") {
      if (canvas || length !== 10 || (b[start] & ~0x10) !== 0) displayUnavailable();
      canvas = [b.readUIntLE(start + 4, 3) + 1, b.readUIntLE(start + 7, 3) + 1];
    } else if (tag === "VP8 ") {
      if (width || length < 10 || b.toString("hex", start + 3, start + 6) !== "9d012a") displayUnavailable();
      width = b.readUInt16LE(start + 6) & 0x3fff; height = b.readUInt16LE(start + 8) & 0x3fff;
    } else if (tag === "VP8L") {
      if (width || length < 5 || b[start] !== 0x2f) displayUnavailable();
      const bits = b.readUInt32LE(start + 1); if ((bits >>> 29) !== 0) displayUnavailable();
      width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1;
    } else if (tag !== "ALPH") displayUnavailable();
    offset = start + length + (length % 2);
  }
  if (width !== file.width || height !== file.height || canvas && (canvas[0] !== width || canvas[1] !== height)) displayUnavailable();
}
export interface DisplayStore {
  verifyRoot(): Promise<void>;
  manifest(runId: string): Promise<DisplayManifest>;
  read(file: DisplayFile): Promise<Uint8Array>;
}
/** Immutable operator-installed objects, mounted read-only; no writer method or URL fallback. */
export function createDisplayStore(directory: string): DisplayStore {
  const publicDirectory = resolve(process.cwd(), "public");
  const within = (value: string, folder: string) => value === folder || value.startsWith(folder + sep);
  if (!isAbsolute(directory) || resolve(directory) !== directory || within(directory, publicDirectory)) displayUnavailable();
  const root = directory;
  async function privateRoot() {
    try { if (within(root, await realpath(publicDirectory))) displayUnavailable(); }
    catch (error) { if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error; }
  }
  async function folder(path: string) {
    const s = await lstat(path);
    if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o077) !== 0 ||
        process.getuid && s.uid !== process.getuid() || await realpath(path) !== path) displayUnavailable();
  }
  async function verifyRoot() { await privateRoot(); await folder(root); await folder(join(root, "runs")); await folder(join(root, "objects")); }
  async function read(name: string, subdirectory: "runs" | "objects", maxBytes: number) {
    checkContentReadBudget(); await privateRoot(); await folder(root); await folder(join(root, subdirectory));
    const file = await open(join(root, subdirectory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await file.stat();
      if (!before.isFile() || before.nlink !== 1 || before.size > maxBytes || (before.mode & 0o777) !== 0o600 ||
          process.getuid && before.uid !== process.getuid()) displayUnavailable();
      const bytes = await file.readFile(), after = await file.stat();
      if (bytes.length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || after.nlink !== 1) displayUnavailable();
      checkContentReadBudget(); return bytes;
    } finally { await file.close(); }
  }
  return {
    async verifyRoot() { try { await verifyRoot(); } catch { displayUnavailable(); } },
    async manifest(runId) {
      if (!displayRunId(runId)) displayUnavailable();
      try {
        const value: unknown = JSON.parse((await read(runId + ".json", "runs", MAX_DISPLAY_MANIFEST_BYTES)).toString("utf8"));
        validateDisplayManifest(value); if (value.runId !== runId) displayUnavailable(); return value;
      } catch { return displayUnavailable(); }
    },
    async read(descriptor) {
      validateDisplayFile(descriptor);
      try { const bytes = await read(descriptor.sha256 + ".webp", "objects", descriptor.byteSize); verifyDisplayBytes(descriptor, bytes); return bytes; }
      catch { return displayUnavailable(); }
    },
  };
}
