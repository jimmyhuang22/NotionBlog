import type { PublishedRecord } from "../../src/server/database/incremental-reader.ts";
import { canonicalJson } from "../../src/server/database/website-validation.ts";
import {
  initializeContentBaseline, type ContentBaselineInventory, type ContentBaselineOptions,
} from "./content-baseline.ts";
import {
  initializeStudyBaseline, StudyBaselineError, validateStudyBaselineCollection, type StudyBaselineOptions,
} from "./study-baseline.ts";

export interface SharedStudyBaselineOptions {
  /** The complete artifact and actual independent reader, including all kinds and assets. */
  content: ContentBaselineOptions;
  /** The companion from that SAME full collection. No caller-supplied proof or receipt. */
  collection: StudyBaselineOptions["collection"];
  config: StudyBaselineOptions["config"];
  deniedPageIds: StudyBaselineOptions["deniedPageIds"];
  studyStore: StudyBaselineOptions["store"];
}

const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function fail(code: string): never { throw new StudyBaselineError(code); }

/** First bootstrap only. One successful complete independent raw-reader pass
 * supplies both caches; learning validation and fresh state checks still run.
 * A partial local install is recoverable using the existing missing-store
 * initializer. This function never overwrites an initialized content cache. */
export async function initializeStudyAndContentBaseline(options: SharedStudyBaselineOptions, signal: AbortSignal) {
  signal.throwIfAborted();
  // Capture dependencies and freeze all artifacts before the first await.
  const { reader, store, fullRunId, maxReads } = options.content;
  const studyStore = options.studyStore;
  let collection: SharedStudyBaselineOptions["collection"], baseline: ContentBaselineOptions["baseline"];
  let config: SharedStudyBaselineOptions["config"], denied: Set<string>;
  try {
    if (Buffer.byteLength(JSON.stringify({ collection: options.collection, baseline: options.content.baseline })) >
        128 * 1024 * 1024) fail("STUDY_BASELINE_BUDGET_EXCEEDED");
    collection = structuredClone(options.collection); baseline = structuredClone(options.content.baseline);
    config = structuredClone(options.config); denied = new Set(options.deniedPageIds);
    validateStudyBaselineCollection(collection, config, denied);
    if (!same(collection.records, baseline.records) || store.sourceDigest !== collection.baseline.sourceDigest ||
        studyStore.sourceDigest !== collection.baseline.sourceDigest) fail("STUDY_BASELINE_SCOPE_MISMATCH");
  } catch (error) {
    if (error instanceof StudyBaselineError) throw error;
    fail("STUDY_BASELINE_INVALID");
  }
  const learningIds = new Set(collection.baseline.entries.map(e => e.record.detail.item.id));
  const pages = new Map<string, PublishedRecord>();
  let inventory: ContentBaselineInventory | undefined;
  const content = await initializeContentBaseline({ baseline, store, fullRunId, maxReads, reader: {
    state: s => reader.state(s),
    async inventory(revision, s) {
      const value = await reader.inventory(revision, s);
      // Retain the actual complete inventory; its validation occurs inside
      // initializeContentBaseline before this evidence is ever reused.
      inventory = structuredClone(value);
      return structuredClone(value);
    },
    async read(input, s) {
      const value = await reader.read(input, s);
      const frozen = value === null ? null : structuredClone(value);
      if (frozen && learningIds.has(input.pageId)) pages.set(input.pageId, structuredClone(frozen));
      return frozen;
    },
  } }, signal);
  signal.throwIfAborted();
  // Only the successful complete initializer unlocks these ephemeral reads.
  // Receipts/booleans from outside this invocation cannot create this path.
  if (!inventory || pages.size !== learningIds.size) fail("STUDY_BASELINE_READER_MISMATCH");
  const verifiedInventory = inventory;
  const study = await initializeStudyBaseline({ collection, config, deniedPageIds: denied, fullRunId,
    store: studyStore, maxReads, reader: {
      async state(s) {
        const current = await reader.state(s); s.throwIfAborted();
        if (!same(current, baseline.state)) fail("STUDY_BASELINE_PUBLICATION_CHANGED");
        store.assertState(current);
        return current;
      },
      async inventory(revision, s) {
        s.throwIfAborted();
        if (revision !== verifiedInventory.publicationRevision) fail("STUDY_BASELINE_PUBLICATION_CHANGED");
        return { publicationRevision: verifiedInventory.publicationRevision, schemaDigest: verifiedInventory.schemaDigest,
          ids: verifiedInventory.pageIds.filter(id => learningIds.has(id)), readerVerified: verifiedInventory.readerVerified };
      },
      async read(input, s) {
        s.throwIfAborted();
        const value = pages.get(input.pageId);
        if (!value || value.record.evidence.sourceKey !== input.sourceKey ||
            value.publicationRevision !== input.expectedRevision) fail("STUDY_BASELINE_READER_MISMATCH");
        return structuredClone(value);
      },
    } }, signal);
  return { content, study: { publicationRevision: study.publicationRevision, courses: study.courses,
    pages: study.pages, reusedPageReads: study.reads }, databasePageReads: content.reads };
}
