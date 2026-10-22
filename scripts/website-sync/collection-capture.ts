import { mkdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import type { RunLease, StoredMedia } from "../../contracts/sync.ts";
import type { WebsiteRecord } from "../../contracts/website-sync.ts";
import type { MediaSourceBinding } from "../../src/server/media/notion-source.ts";
import { validateMediaSource } from "../../src/server/media/notion-source.ts";
import { configDigest, validateMedia, validateWebsiteRecord } from "../../src/server/database/website-validation.ts";
import { normalizeId } from "../../src/server/notion/config.ts";
import { privateDirectory, readPrivateFile } from "../notion-sync/state.ts";
import { WorkerError } from "../notion-sync/errors.ts";
import { savePrivateJson } from "./private-json.ts";

import { validateSourceReadProof, type SourceReadProof } from "./collection-source-proof.ts";

export interface CollectedPage {
  sourceReads?: SourceReadProof[];
  record: WebsiteRecord;
  media: StoredMedia[];
  bindings: MediaSourceBinding[];
  lease: RunLease | null;
}
export interface CaptureIdentity { runId: string; sourceSha256: string; releaseCommit: string; configDigest: string }
interface CaptureIndex extends CaptureIdentity {
  format: "website-collection-capture-v1";
  collectionComplete: boolean;
  publicationEvidence: false;
  pages: { id: string; digest: string; bytes: number; file?: string }[];
  order: string[] | null;
}
// Bounded records plus source proofs and media descriptors; no image bytes.
const MAX_BYTES = 128 * 1024 * 1024;
const fail = (): never => { throw new WorkerError("CHECKPOINT_FAILED"); };
function validIdentity(value: CaptureIdentity) {
  return /^[a-f0-9-]{36}$/.test(value.runId) && /^[a-f0-9]{40}$/.test(value.releaseCommit) &&
    [value.sourceSha256, value.configDigest].every(x => /^[a-f0-9]{64}$/.test(x));
}
function validate(page: CollectedPage, identity: CaptureIdentity) {
  validateWebsiteRecord(page.record);
  if (page.sourceReads !== undefined) validateSourceReadProof(page.sourceReads);
  if (!page.record.detail.document || !Array.isArray(page.media) || !Array.isArray(page.bindings) ||
      (page.lease && (page.lease.runId !== identity.runId || page.lease.configDigest !== identity.configDigest))) fail();
  const id = page.record.detail.item.id, media = new Map<string, StoredMedia>();
  for (const m of page.media) { validateMedia(m); if (m.ownerPageId !== id || media.has(m.assetId)) fail(); media.set(m.assetId, m); }
  const bound = new Set<string>();
  for (const b of page.bindings) {
    const m = media.get(b.assetId); if (!m) return fail(); if (bound.has(b.assetId)) fail();
    validateMediaSource(b, m, "v2"); bound.add(b.assetId);
  }
  const referenced = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== "object") return;
    const o = value as Record<string, unknown>;
    if (typeof o.src === "string" && o.src.startsWith("/media/v2/")) {
      const m = media.get(String(o.id));
      if (!m) return fail();
      if (o.src !== `/media/v2/${m.assetId}` || o.width !== m.width || o.height !== m.height) fail();
      referenced.add(m.assetId);
    }
    Object.values(o).forEach(visit);
  };
  visit(page.record.detail);
  if (referenced.size !== media.size) fail();
}

/** Durable partial work only. No loader here authorizes replay into a publisher.
 * A failed run's lease/qualification is retained as history, never renewed by loading.
 */
export async function createCollectionCapture(directory: string, identity: CaptureIdentity) {
  if (!validIdentity(identity)) fail();
  await mkdir(directory, { mode: 0o700 }); // Never overwrite an earlier run's capture.
  await privateDirectory(directory);
  const index: CaptureIndex = { ...identity, format: "website-collection-capture-v1", collectionComplete: false,
    publicationEvidence: false, pages: [], order: null };
  await savePrivateJson(directory, "index-private.json", index);
  let bytes = 0, persistedBytes = 0, chain: Promise<unknown> = Promise.resolve();
  const queued = <T>(work: () => Promise<T>) => { const result = chain.then(work); chain = result; return result; };
  return {
    save(input: CollectedPage) {
      const page = structuredClone(input);
      return queued(async () => {
        validate(page, identity);
        const id = normalizeId(page.record.detail.item.id), size = Buffer.byteLength(JSON.stringify(page));
        if (index.collectionComplete || index.pages.length >= 20_000 || index.pages.some(p => p.id === id) || bytes + size > MAX_BYTES || persistedBytes + size > MAX_BYTES) fail();
        await savePrivateJson(directory, `page-${id}.json`, page);
        index.pages.push({ id, digest: configDigest(page), bytes: size }); bytes += size; persistedBytes += size;
        await savePrivateJson(directory, "index-private.json", index);
      });
    },
    /** Commit a new immutable revision before atomically replacing its index
     * pointer. A crash cannot destroy the previous indexed page or its proof. */
    replace(input: CollectedPage) {
      const page = structuredClone(input);
      return queued(async () => {
        validate(page, identity);
        const id = normalizeId(page.record.detail.item.id), position = index.pages.findIndex(p => p.id === id);
        const size = Buffer.byteLength(JSON.stringify(page)), digest = configDigest(page);
        if (index.collectionComplete || position < 0 || bytes - index.pages[position].bytes + size > MAX_BYTES || persistedBytes + size > MAX_BYTES) fail();
        const file = `page-${id}-${digest}.json`;
        await savePrivateJson(directory, file, page);
        persistedBytes += size;
        bytes += size - index.pages[position].bytes;
        index.pages[position] = { id, digest, bytes: size, file };
        await savePrivateJson(directory, "index-private.json", index);
      });
    },
    seal(order: string[]) {
      return queued(async () => {
        if (index.collectionComplete || order.length !== index.pages.length || new Set(order).size !== order.length ||
            order.some(id => !index.pages.some(page => page.id === id))) fail();
        index.order = [...order]; index.collectionComplete = true;
        await savePrivateJson(directory, "index-private.json", index);
      });
    },
    statistics: () => ({ pages: index.pages.length, bytes, collectionComplete: index.collectionComplete, publicationEvidence: false }),
  };
}

async function read(directory: string, name: string) {
  await privateDirectory(directory);
  const path = join(directory, name), before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || (before.mode & 0o777) !== 0o600) fail();
  const text = await readPrivateFile(path, MAX_BYTES), after = await lstat(path);
  if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail();
  return JSON.parse(text);
}

/** Untrusted saved input for comparison against fresh collection only. This
 * checks hashes/bindings, but grants no lease or permission to replay records. */
export async function readCollectionCaptureForRevalidation(directory: string, expected: CaptureIdentity) {
  if (!validIdentity(expected)) fail();
  const index = await read(directory, "index-private.json") as CaptureIndex;
  if (index.format !== "website-collection-capture-v1" || index.publicationEvidence !== false ||
      typeof index.collectionComplete !== "boolean" || Object.entries(expected).some(([k, v]) => index[k as keyof CaptureIdentity] !== v) ||
      !Array.isArray(index.pages) || index.pages.length > 20_000 || new Set(index.pages.map(p => p.id)).size !== index.pages.length) fail();
  let bytes = 0;
  const pages: CollectedPage[] = [];
  for (const entry of index.pages) {
    if (normalizeId(entry.id) !== entry.id || !Number.isSafeInteger(entry.bytes) || entry.bytes < 1 || !/^[a-f0-9]{64}$/.test(entry.digest) || (bytes += entry.bytes) > MAX_BYTES) fail();
    if (entry.file !== undefined && entry.file !== `page-${entry.id}-${entry.digest}.json`) fail();
    const page = await read(directory, entry.file ?? `page-${entry.id}.json`) as CollectedPage;
    validate(page, expected);
    if (page.record.detail.item.id !== entry.id || Buffer.byteLength(JSON.stringify(page)) !== entry.bytes || configDigest(page) !== entry.digest) fail();
    pages.push(page);
  }
  if (index.collectionComplete ? !Array.isArray(index.order) || index.order.length !== index.pages.length ||
      new Set(index.order).size !== index.order.length || index.order.some(id => !index.pages.some(p => p.id === id)) : index.order !== null) fail();
  return { pages, bytes, collectionComplete: index.collectionComplete, publicationEvidence: false, resumable: false };
}

/** Inspection never returns saved content as publication authority. */
export async function inspectCollectionCapture(directory: string, expected: CaptureIdentity) {
  const checked = await readCollectionCaptureForRevalidation(directory, expected);
  return { ...checked, pages: checked.pages.length };
}
