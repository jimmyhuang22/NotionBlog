import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { link, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { StoredMedia } from "../../contracts/sync.ts";
import { WEBSITE_SCHEMA_DIGEST } from "../../contracts/website-sync.ts";
import type { PublicationState } from "../../src/server/database/incremental-publication.ts";
import { canonicalJson, configDigest, validateMedia } from "../../src/server/database/website-validation.ts";
import { normalizeId } from "../../src/server/notion/config.ts";
import type { WebsiteNotionConfig } from "../../src/server/notion/website-config.ts";
import type { WebsiteStudyCollection } from "../../src/server/notion/website-repository.ts";
import { privateDirectory } from "../notion-sync/state.ts";
import type { DirectoryBaselineCapture } from "./discovery-baseline.ts";
import type { ContentBaselineReader } from "./content-baseline.ts";
import { validateStudyBaselineCollection } from "./study-baseline.ts";

const MAX_BYTES = 48 * 1024 * 1024;
const uuid = (s: unknown): s is string => typeof s === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(s);
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
export class FullBaselineArtifactError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = "FullBaselineArtifactError"; this.code = code; }
}
function fail(code = "FULL_BASELINE_INVALID"): never { throw new FullBaselineArtifactError(code); }
export interface PreparedFullBaseline {
  format: "incremental-prepared-baseline-v1";
  fullRunId: string;
  configDigest: string;
  collection: WebsiteStudyCollection;
  media: StoredMedia[];
  deniedPageIds: string[];
  directory: DirectoryBaselineCapture;
}
export interface AcceptedFullBaseline {
  format: "incremental-baseline-v1";
  fullRunId: string;
  state: PublicationState;
  collection: WebsiteStudyCollection;
  media: StoredMedia[];
  deniedPageIds: string[];
  directory: DirectoryBaselineCapture;
}

/** Opt-in capture requires all learning sources, before a lease or Source call. */
export function assertFullBaselineConfig(config: WebsiteNotionConfig) {
  const courses = config.sources.filter(s => s.kind === "course"), notes = config.sources.filter(s => s.kind === "study-note");
  if (!courses.length || config.sources.length > 50 || courses.some(s => s.publication.mode !== "all") ||
      notes.some(s => s.publication.mode !== "course-descendants") ||
      courses.some(c => !notes.some(n => n.dataSourceId === c.dataSourceId)) ||
      notes.some(n => !courses.some(c => c.dataSourceId === n.dataSourceId))) fail("FULL_BASELINE_SCOPE_MISMATCH");
}
function validate(input: PreparedFullBaseline, config: WebsiteNotionConfig) {
  try {
    assertFullBaselineConfig(config);
    if (!input || Object.keys(input).length !== 7 || input.format !== "incremental-prepared-baseline-v1" || !uuid(input.fullRunId) ||
        input.configDigest !== configDigest(config) || !Array.isArray(input.deniedPageIds) || input.deniedPageIds.length > 20000 ||
        !same(input.deniedPageIds, [...new Set(input.deniedPageIds.map(normalizeId))].sort()) ||
        !Array.isArray(input.media) || input.media.length > 20000 || Buffer.byteLength(JSON.stringify(input)) > MAX_BYTES) fail();
    validateStudyBaselineCollection(input.collection, config, new Set(input.deniedPageIds));
    const owners = new Map(input.collection.records.map(r => [r.detail.item.id, r]));
    for (const record of owners.values()) if (!config.sources.some(s => s.key === record.evidence.sourceKey && s.kind === record.detail.item.kind)) fail();
    const assets = new Set<string>();
    for (const media of input.media) {
      validateMedia(media);
      if (!owners.has(media.ownerPageId) || assets.has(media.assetId)) fail();
      assets.add(media.assetId);
    }
    const directory = input.directory;
    if (!directory || directory.format !== "directory-baseline-v1" || directory.configDigest !== input.configDigest ||
        directory.recordsDigest !== configDigest([...input.collection.records].sort((a, b) => a.detail.item.id.localeCompare(b.detail.item.id))) ||
        !Array.isArray(directory.sources) || directory.sources.length !== config.sources.length ||
        new Set(directory.sources.map(s => s.sourceKey)).size !== config.sources.length ||
        !Number.isSafeInteger(directory.skipped) || directory.skipped < 0) fail();
    const seen = new Set<string>();
    for (const source of directory.sources) {
      if (!config.sources.some(s => s.key === source.sourceKey) || !Array.isArray(source.members) || source.members.length > owners.size) fail();
      for (const member of source.members) {
        const owner = owners.get(member.pageKey);
        if (!owner || seen.has(member.pageKey) || owner.evidence.sourceKey !== source.sourceKey ||
            !/^[a-f0-9]{64}$/.test(member.fingerprint) || !Number.isSafeInteger(member.lastEditedAt) || member.lastEditedAt < 0 ||
            !owner.detail.item.updatedAt || Date.parse(owner.detail.item.updatedAt) !== member.lastEditedAt) fail();
        seen.add(member.pageKey);
      }
    }
    if (seen.size + directory.skipped !== owners.size) fail();
  } catch (e) { if (e instanceof FullBaselineArtifactError) throw e; fail(); }
}
async function readJson(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.mode & 0o077 || info.size > MAX_BYTES ||
        process.getuid && info.uid !== process.getuid()) fail("FULL_BASELINE_PRIVATE_FILE_INVALID");
    return JSON.parse(await file.readFile("utf8"));
  } finally { await file.close(); }
}
/** Atomic, immutable installation; retrying the identical file is idempotent.
 * The temporary hard link is removed before return, leaving a single link. */
async function writeImmutable(directory: string, name: string, value: unknown, signal: AbortSignal) {
  signal.throwIfAborted(); await privateDirectory(directory); signal.throwIfAborted();
  const bytes = JSON.stringify(value) + "\n", path = join(directory, name), temporary = join(directory, `.baseline-${randomUUID()}`);
  if (Buffer.byteLength(bytes) > MAX_BYTES) fail("FULL_BASELINE_LIMIT_EXCEEDED");
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    signal.throwIfAborted();
    try { await link(temporary, path); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (!same(await readJson(path), value)) fail("FULL_BASELINE_FILE_CONFLICT");
    }
  } finally { await unlink(temporary); }
  const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try { await parent.sync(); } finally { await parent.close(); }
  signal.throwIfAborted(); return path;
}

/** Persist before stage/promote. This file has NO accepted publication state. */
export async function savePreparedFullBaseline(options: { directory: string; config: WebsiteNotionConfig; capture: PreparedFullBaseline }, signal: AbortSignal) {
  signal.throwIfAborted();
  const config = structuredClone(options.config), capture = structuredClone(options.capture), directory = options.directory;
  validate(capture, config);
  const path = await writeImmutable(directory, "incremental-prepared.json", capture, signal);
  return { path, records: capture.collection.records.length, media: capture.media.length };
}

/** Seal the persisted SAME collection only when the actual independent reader
 * sees this accepted full run and an unchanged state. This is an INPUT to the
 * host's complete raw-page proof, never a proof or grant to initialize stores. */
export async function sealFullBaselineArtifact(options: { directory: string; config: WebsiteNotionConfig;
  reader: Pick<ContentBaselineReader, "state" | "inventory"> }, signal: AbortSignal) {
  signal.throwIfAborted();
  const config = structuredClone(options.config), directory = options.directory, readState = options.reader.state.bind(options.reader);
  const inventory = options.reader.inventory.bind(options.reader);
  await privateDirectory(directory); signal.throwIfAborted();
  const capture = await readJson(join(directory, "incremental-prepared.json")) as PreparedFullBaseline;
  signal.throwIfAborted(); validate(capture, config);
  const before = structuredClone(await readState(signal)); signal.throwIfAborted();
  if (!before || Object.keys(before).length !== 4 || before.configDigest !== capture.configDigest || before.schemaDigest !== WEBSITE_SCHEMA_DIGEST ||
      !/^[0-9]+$/.test(before.policyEpoch) || typeof before.publicationRevision !== "string" ||
      !before.publicationRevision.startsWith(`${capture.fullRunId}:`) ||
      !/^[0-9]+$/.test(before.publicationRevision.slice(capture.fullRunId.length + 1))) fail("FULL_BASELINE_PUBLICATION_UNCONFIRMED");
  // read_state is intentionally available to writers too. The real complete
  // membership API is reader-only; status alone cannot prove this boundary.
  const members = await inventory(before.publicationRevision, signal); signal.throwIfAborted();
  if (!members || members.readerVerified !== true || members.publicationRevision !== before.publicationRevision ||
      members.schemaDigest !== WEBSITE_SCHEMA_DIGEST || !Array.isArray(members.pageIds) || !Array.isArray(members.mediaIds) ||
      members.pageIds.length > 20000 || members.mediaIds.length > 20000 ||
      !same([...members.pageIds].sort(), capture.collection.records.map(r => r.detail.item.id).sort()) ||
      !same([...members.mediaIds].sort(), capture.media.map(m => m.assetId).sort())) fail("FULL_BASELINE_INVENTORY_MISMATCH");
  const after = await readState(signal); signal.throwIfAborted();
  if (!same(before, after)) fail("FULL_BASELINE_PUBLICATION_CHANGED");
  const artifact: AcceptedFullBaseline = { format: "incremental-baseline-v1", fullRunId: capture.fullRunId, state: before,
    collection: capture.collection, media: capture.media, deniedPageIds: capture.deniedPageIds, directory: capture.directory };
  const path = await writeImmutable(directory, "incremental-baseline.json", artifact, signal);
  return { path, publicationRevision: before.publicationRevision, records: capture.collection.records.length, media: capture.media.length };
}
