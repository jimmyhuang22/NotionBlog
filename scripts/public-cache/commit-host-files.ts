import { constants } from "node:fs";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { createHash } from "node:crypto";
import { privateDirectory } from "../notion-sync/state.ts";
import { commitCatalogDigest } from "./commit-catalog.ts";

export interface HostPin { path: string; sha256: string; private: boolean }
export interface HostGraph {
  version: 1; actors: { id: string; kind: "source" | "social" | "media" | "consumer" | "withdrawal" | "retention"; entries: HostPin[]; locks: string[] }[];
  lockOrder: string[]; statePins: HostPin[];
}
export interface HostClosure { version: 1; scopeNonce: string; runtimeSHA256: string; at: number; expires: number; serverLeaseClosed: boolean; drainedActors: string[] }
export interface HeldFile { path: string; device: string; inode: string; bytes: string }
export const hostNeed = (ok: unknown, code = "CACHE_HOST_INPUT"): void => { if (!ok) throw Error(code); };
const sha = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
const canonical = (path: string) => isAbsolute(path) && resolve(path) === path;
const signature = (s: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }) => [s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(":");
const syncDirectory = async (path: string) => { const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { await fd.sync(); } finally { await fd.close(); } };

export async function hostRead(path: string, maximum = 65536, privateOnly = true) {
  hostNeed(canonical(path) && await realpath(path) === path, "CACHE_HOST_PATH");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat({ bigint: true });
    hostNeed(before.isFile() && before.nlink === 1n && before.uid === BigInt(process.getuid!()) && !(before.mode & BigInt(privateOnly ? 0o077 : 0o022)) && before.size <= BigInt(maximum), "CACHE_HOST_FILE");
    const bytes = await file.readFile(), after = await file.stat({ bigint: true }), named = await lstat(path, { bigint: true });
    hostNeed(signature(before) === signature(after) && before.dev === named.dev && before.ino === named.ino && bytes.length === Number(before.size), "CACHE_HOST_CHANGED");
    return { bytes, info: before };
  } finally { await file.close(); }
}
export async function hostWrite(path: string, value: unknown) {
  hostNeed(canonical(path), "CACHE_HOST_PATH"); await privateDirectory(dirname(path));
  const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY, 0o600);
  try { await file.writeFile(JSON.stringify(value) + "\n"); await file.sync(); } finally { await file.close(); }
  const directory = await open(dirname(path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
}
export function validateHostGraph(graph: HostGraph, packagePins: HostPin[]) {
  hostNeed(graph?.version === 1 && Array.isArray(graph.actors) && graph.actors.length >= 6 && graph.actors.length <= 64 && Array.isArray(packagePins) && packagePins.length > 0 && packagePins.length <= 20000);
  hostNeed(new Set(graph.actors.map(a => a.id)).size === graph.actors.length && ["source","social","media","consumer","withdrawal","retention"].every(k => graph.actors.some(a => a.kind === k)));
  const pins = [...packagePins, ...graph.statePins, ...graph.actors.flatMap(a => a.entries)];
  hostNeed(pins.length <= 40000 && pins.every(p => canonical(p.path) && /^[a-f0-9]{64}$/.test(p.sha256) && typeof p.private === "boolean" && !/(?:^|[\/_-])(?:env|credentials?|password|secret|token)(?:[._/-]|$)|-url\.txt$/i.test(p.path)), "CACHE_HOST_PIN");
  hostNeed(new Set(packagePins.map(p => p.path)).size === packagePins.length && graph.actors.every(a => /^[a-z0-9-]{1,64}$/.test(a.id) && a.entries.length > 0 && a.locks.length > 0 && a.entries.every(p => packagePins.some(q => commitCatalogDigest(p) === commitCatalogDigest(q)))));
  const paths = [...new Set(graph.actors.flatMap(a => a.locks))];
  hostNeed(graph.lockOrder.length === paths.length && new Set(graph.lockOrder).size === paths.length && paths.every(p => graph.lockOrder.includes(p) && canonical(p)) && paths.length <= 128, "CACHE_HOST_LOCK_COVERAGE");
}
export async function verifyHostPins(pins: HostPin[]) {
  const seen = new Map<string, string>();
  for (const pin of pins) {
    const file = await hostRead(pin.path, 4 * 1024 * 1024, pin.private);
    hostNeed(sha(file.bytes) === pin.sha256, "CACHE_HOST_PIN_CHANGED");
    const prior = seen.get(pin.path); hostNeed(!prior || prior === pin.sha256, "CACHE_HOST_PIN"); seen.set(pin.path, pin.sha256);
  }
  return async () => {
    // Rehash before each phase: these are reviewed files, never credential files.
    for (const pin of pins) hostNeed(sha((await hostRead(pin.path, 4 * 1024 * 1024, pin.private)).bytes) === pin.sha256, "CACHE_HOST_PIN_CHANGED");
  };
}
export async function hostLock(path: string, operation: string): Promise<HeldFile> {
  hostNeed(canonical(path), "CACHE_HOST_PATH");
  const parent = await lstat(dirname(path));
  hostNeed(parent.isDirectory() && !parent.isSymbolicLink() && !(parent.mode & 0o077) && parent.uid === process.getuid!() && await realpath(dirname(path)) === dirname(path), "CACHE_HOST_LOCK_PARENT");
  const bytes = JSON.stringify({ pid: process.pid, runId: operation, startedAt: new Date().toISOString() });
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = await file.stat({ bigint: true });
    await file.writeFile(bytes); await file.sync();
    await syncDirectory(dirname(path));
    return { path, device: String(stat.dev), inode: String(stat.ino), bytes };
  } finally { await file.close(); }
}
export async function verifyHeld(files: HeldFile[]) {
  for (const file of files) {
    const current = await hostRead(file.path, 4096);
    hostNeed(String(current.info.dev) === file.device && String(current.info.ino) === file.inode && current.bytes.toString() === file.bytes, "CACHE_HOST_LOCK_CHANGED");
  }
}
export async function releaseHeld(files: HeldFile[]) {
  let failed = false;
  for (const file of [...files].reverse()) {
    try { await verifyHeld([file]); await unlink(file.path); await syncDirectory(dirname(file.path)); } catch { failed = true; }
  }
  hostNeed(!failed, "CACHE_HOST_LOCK_CHANGED");
}
export async function createHostHold(graph: HostGraph, packagePins: HostPin[], closurePin: HostPin, scopeNonce: string, operation: string, receipt: string) {
  const verifyPins = await verifyHostPins([...packagePins, ...graph.statePins]);
  hostNeed(packagePins.some(p => commitCatalogDigest(p) === commitCatalogDigest(closurePin)), "CACHE_HOST_CLOSURE");
  const checkClosure = async () => {
    const value = JSON.parse((await hostRead(closurePin.path)).bytes.toString()) as HostClosure;
    hostNeed(value.version === 1 && value.scopeNonce === scopeNonce && value.runtimeSHA256 === commitCatalogDigest(graph) && value.serverLeaseClosed === true &&
      Number.isSafeInteger(value.at) && Number.isSafeInteger(value.expires) && value.at <= Date.now() && Date.now() < value.expires && value.expires - value.at <= 30 * 60_000 &&
      commitCatalogDigest([...value.drainedActors].sort()) === commitCatalogDigest(graph.actors.map(a => a.id).sort()), "CACHE_HOST_CLOSURE");
  };
  await checkClosure();
  const files: HeldFile[] = [];
  try {
    for (const path of graph.lockOrder) files.push(await hostLock(path, operation));
    await verifyPins(); await checkClosure(); await verifyHeld(files);
    await hostWrite(receipt, { version: 1, operation, scopeNonce, runtimeSHA256: commitCatalogDigest(graph), files });
  } catch (cause) { await releaseHeld(files); throw cause; }
  return { verify: async () => { await verifyPins(); await checkClosure(); await verifyHeld(files); }, release: () => releaseHeld(files) };
}
