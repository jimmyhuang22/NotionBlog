import type { WebsiteRecord } from "../../contracts/website-sync.ts";
import type { StudyNote } from "../../contracts/content.ts";
import { WEBSITE_SCHEMA_DIGEST } from "../../contracts/website-sync.ts";
import { readPublicationState, type PublicationState } from "../../src/server/database/incremental-publication.ts";
import { readPublishedRecord, type PublishedRecord, type PublishedRecordQuery } from "../../src/server/database/incremental-reader.ts";
import { publicationReader } from "../../src/server/database/publication.ts";
import type { SqlExecutor } from "../../src/server/database/sql.ts";
import { createWebsiteDatabaseRepository } from "../../src/server/database/website-repository.ts";
import { canonicalJson, configDigest, validateWebsiteRecord } from "../../src/server/database/website-validation.ts";
import { normalizeId } from "../../src/server/notion/config.ts";
import { validateStudyCheckpoint, type StudyCheckpoint } from "../../src/server/notion/study-incremental.ts";
import { studyPreorder } from "../../src/server/notion/study-order.ts";
import type { WebsiteNotionConfig } from "../../src/server/notion/website-config.ts";
import type { WebsiteStudyCollection } from "../../src/server/notion/website-repository.ts";
import type { StudyCheckpointStore } from "./study-checkpoint.ts";

export class StudyBaselineError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = "StudyBaselineError"; this.code = code; }
}
const fail = (code: string): never => { throw new StudyBaselineError(code); };
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);

/** The host supplies independent reader connections, its pinned source/deny
 * policy and the UUID of the accepted complete full publication. No defaults,
 * source reads, remote writes, files, queue acknowledgements or asset I/O. */
export interface StudyBaselineOptions {
  collection: WebsiteStudyCollection;
  config: WebsiteNotionConfig;
  deniedPageIds: ReadonlySet<string>;
  fullRunId: string;
  store: StudyCheckpointStore;
  reader: {
    state(signal: AbortSignal): Promise<PublicationState>;
    inventory(expectedRevision: string, signal: AbortSignal): Promise<{ publicationRevision: string; schemaDigest: string; ids: string[]; readerVerified: true }>;
    read(input: PublishedRecordQuery, signal: AbortSignal): Promise<PublishedRecord | null>;
  };
  /** Baseline-only page reads; normal increments never run this initializer. */
  maxReads?: number;
}

/** Real read-only composition using the existing restricted reader APIs.
 * The public metadata projection supplies membership only; raw private page
 * reads still prove every body and ownership record. No new SQL capability. */
export function createDatabaseStudyBaselineReader(reader: SqlExecutor): StudyBaselineOptions["reader"] {
  const repository = createWebsiteDatabaseRepository(publicationReader(reader, "published"));
  return {
    async state(signal) { signal.throwIfAborted(); const state = await readPublicationState(reader); signal.throwIfAborted(); return state; },
    async inventory(expectedRevision, signal) {
      signal.throwIfAborted();
      const snapshot = await repository.readSnapshot!(["course", "study-note"], false);
      signal.throwIfAborted();
      if (snapshot.version !== expectedRevision) fail("STUDY_BASELINE_PUBLICATION_CHANGED");
      return { publicationRevision: snapshot.version, schemaDigest: WEBSITE_SCHEMA_DIGEST, ids: snapshot.records.map(record => record.item.id), readerVerified: true };
    },
    read: (input, signal) => readPublishedRecord(reader, input, signal),
  };
}

/** Validate a persisted companion before opening a connection. The digest is
 * an integrity check, not an independent publication or completeness proof. */
export function validateStudyBaselineCollection(collection: WebsiteStudyCollection, config: WebsiteNotionConfig, deniedPageIds: ReadonlySet<string>): void {
  try {
    const sources = config.sources.filter(s => s.kind === "course" || s.kind === "study-note"), courses = sources.filter(s => s.kind === "course");
    if (!courses.length || sources.some(s => s.kind === "course" ? s.publication.mode !== "all" : s.publication.mode !== "course-descendants") ||
        courses.some(c => !sources.some(s => s.kind === "study-note" && s.dataSourceId === c.dataSourceId)) ||
        sources.some(s => s.kind === "study-note" && !courses.some(c => c.dataSourceId === s.dataSourceId))) fail("STUDY_BASELINE_SCOPE_MISMATCH");
    const baseline = collection?.baseline;
    if (!baseline || baseline.format !== "study-baseline-v1" || baseline.sourceDigest !== configDigest(config) ||
        !equal(baseline.sourceKeys, sources.map(s => s.key).sort()) ||
        baseline.deniedDigest !== configDigest([...new Set([...deniedPageIds].map(normalizeId))].sort())) fail("STUDY_BASELINE_SCOPE_MISMATCH");
    if (!Array.isArray(collection.records) || collection.records.length > 20000 ||
        Buffer.byteLength(JSON.stringify(collection)) > 32 * 1024 * 1024 || configDigest(collection.records) !== baseline.recordsDigest) fail("STUDY_BASELINE_INVALID");
    const records = new Map<string, WebsiteRecord>();
    const denied = new Set([...deniedPageIds].map(normalizeId));
    for (const record of collection.records) {
      validateWebsiteRecord(record);
      const id = record.detail.item.id;
      if (records.has(id) || denied.has(id) || !record.detail.document) fail("STUDY_BASELINE_INVALID");
      records.set(id, record);
    }
    if (configDigest(baseline.entries) !== baseline.entriesDigest) fail("STUDY_BASELINE_INVALID");
    validateStudyCheckpoint({ version: "collected", sourceDigest: baseline.sourceDigest, entries: baseline.entries });
    const study = new Set(collection.records.filter(r => ["course", "study-note"].includes(r.detail.item.kind)).map(r => r.detail.item.id));
    if (study.size !== baseline.entries.length) fail("STUDY_BASELINE_INVALID");
    for (const entry of baseline.entries) {
      const id = entry.record.detail.item.id, source = sources.find(s => s.key === entry.record.evidence.sourceKey);
      if (!study.has(id) || !equal(records.get(id), entry.record) || !source || source.kind !== entry.record.detail.item.kind ||
          entry.position !== (entry.record.detail.item.kind === "course" ? null : entry.record.evidence.ordinal) ||
          (entry.record.detail.item.kind === "course" && entry.record.evidence.dataSourceId !== source.dataSourceId)) fail("STUDY_BASELINE_INVALID");
    }
    for (const course of baseline.entries.filter(entry => entry.record.detail.item.kind === "course")) {
      const notes = baseline.entries.filter(entry => entry.record.detail.item.kind === "study-note" && entry.record.detail.item.courseId === course.record.detail.item.id);
      const sorted = studyPreorder(notes.map(entry => ({ item: entry.record.detail.item as StudyNote, override: entry.override, bodyPosition: entry.position ?? undefined })));
      if (new Set(notes.map(entry => entry.record.evidence.ordinal)).size !== notes.length ||
          !equal(sorted.map(note => note.id), [...notes].sort((a, b) => a.record.evidence.ordinal - b.record.evidence.ordinal).map(entry => entry.record.detail.item.id))) fail("STUDY_BASELINE_INVALID");
    }
  } catch (error) {
    if (error instanceof StudyBaselineError) throw error;
    fail("STUDY_BASELINE_INVALID");
  }
}

/** Install once after every collected learning record matches the actual
 * current full publication through the independent reader. A later delta,
 * central policy change, cancellation or omitted page leaves the store alone. */
export async function initializeStudyBaseline(options: StudyBaselineOptions, signal: AbortSignal): Promise<{ publicationRevision: string; courses: number; pages: number; reads: number }> {
  signal.throwIfAborted();
  const { reader, store, fullRunId } = options;
  // Freeze caller-owned input across reader awaits.
  const collection = structuredClone(options.collection), config = structuredClone(options.config), denied = new Set(options.deniedPageIds);
  validateStudyBaselineCollection(collection, config, denied);
  const maximum = options.maxReads ?? 2000;
  if (!uuid(fullRunId) || !Number.isInteger(maximum) || maximum < 1 || maximum > 20000 || collection.baseline.entries.length > maximum) fail("STUDY_BASELINE_BUDGET_EXCEEDED");
  const digest = collection.baseline.sourceDigest;
  if (store.sourceDigest !== digest) fail("STUDY_BASELINE_SCOPE_MISMATCH");
  const before = await reader.state(signal); signal.throwIfAborted();
  if (typeof before.publicationRevision !== "string" || !before.publicationRevision.startsWith(`${fullRunId}:`) ||
      !/^[0-9]+$/.test(before.publicationRevision.slice(fullRunId.length + 1)) || before.configDigest !== digest || before.schemaDigest !== WEBSITE_SCHEMA_DIGEST ||
      !/^[0-9]+$/.test(before.policyEpoch)) fail("STUDY_BASELINE_PUBLICATION_CHANGED");
  const expected = before.publicationRevision;
  const inventory = await reader.inventory(expected, signal); signal.throwIfAborted();
  if (!inventory || inventory.readerVerified !== true || inventory.publicationRevision !== expected || inventory.schemaDigest !== WEBSITE_SCHEMA_DIGEST ||
      !Array.isArray(inventory.ids) || inventory.ids.length > 20000 || new Set(inventory.ids).size !== inventory.ids.length ||
      !equal([...inventory.ids].sort(), collection.baseline.entries.map(entry => entry.record.detail.item.id).sort())) fail("STUDY_BASELINE_INVENTORY_MISMATCH");
  let reads = 0;
  for (const entry of collection.baseline.entries) {
    const record = entry.record;
    signal.throwIfAborted();
    const actual = await reader.read({ pageId: record.detail.item.id, sourceKey: record.evidence.sourceKey, expectedRevision: expected }, signal);
    signal.throwIfAborted(); reads++;
    if (!actual || actual.readerVerified !== true || actual.publicationRevision !== expected || actual.configDigest !== digest ||
        actual.schemaDigest !== WEBSITE_SCHEMA_DIGEST || !equal(actual.record, record)) fail("STUDY_BASELINE_READER_MISMATCH");
  }
  const after = await reader.state(signal); signal.throwIfAborted();
  if (!equal(before, after)) fail("STUDY_BASELINE_PUBLICATION_CHANGED");
  const checkpoint: StudyCheckpoint = { version: expected, sourceDigest: digest, entries: collection.baseline.entries };
  store.initialize(checkpoint, { publicationRevision: expected, configDigest: digest, readerVerified: true });
  const courses = checkpoint.entries.filter(e => e.record.detail.item.kind === "course").length;
  return { publicationRevision: expected, courses, pages: checkpoint.entries.length - courses, reads };
}
