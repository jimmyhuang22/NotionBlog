import { canonicalJson, configDigest, validateWebsiteRecord } from "../../src/server/database/website-validation.ts";
import { normalizeId } from "../../src/server/notion/config.ts";
import { validateStudyCheckpoint, type StudyCheckpoint, type StudyChangeSource, type StudyEntry, type StudyObservation } from "../../src/server/notion/study-incremental.ts";
import type { WebsiteNotionConfig } from "../../src/server/notion/website-config.ts";
import { IncrementalQueueError, type ChangeHint, type IncrementalQueue } from "./queue.ts";

const NAME = "study-children-v1";
export class StudyDiscoveryError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = "StudyDiscoveryError"; this.code = code; }
}
function fail(code: string): never { throw new StudyDiscoveryError(code); }
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const key = (value: string) => { try { if (normalizeId(value) !== value) fail("STUDY_DISCOVERY_RESPONSE_INVALID"); return value; } catch { return fail("STUDY_DISCOVERY_RESPONSE_INVALID"); } };
const hash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
type Queue = Pick<IncrementalQueue, "scopeDigest" | "checkpoint" | "commitDiscovery" | "commitLocalDiscovery">;
export interface StudyChildDiscoveryOptions {
  queue: Queue;
  /** Verified durable domain cache; caller holds the canonical sync mutex. */
  store: { load(): StudyCheckpoint };
  config: WebsiteNotionConfig;
  sourceKey: string;
  /** Create a fresh, physically budgeted/cancellable source for this batch. */
  source(checkpoint: StudyCheckpoint, signal: AbortSignal): StudyChangeSource;
  signal?: AbortSignal;
  maxParents?: number;
  maxChildren?: number;
  maxDurationMs?: number;
  now?: () => number;
}
export interface StudyChildDiscoveryResult {
  outcome: "completed" | "limited" | "retry" | "needs_review" | "cancelled";
  parents: number;
  hints: number;
  unavailable: number;
  errorCode?: string;
}
function identity(entry: StudyEntry) { return entry.record.detail.item.id; }
function metadata(entry: StudyEntry) {
  const { ordinal: _ordinal, ...evidence } = entry.record.evidence;
  return { item: { ...entry.record.detail.item, cover: null }, evidence, override: entry.override };
}
function children(entries: StudyEntry[], root: boolean) {
  const ordered = [...entries].sort(root ? (a, b) => identity(a).localeCompare(identity(b)) :
    (a, b) => (a.position ?? a.record.evidence.ordinal) - (b.position ?? b.record.evidence.ordinal) || identity(a).localeCompare(identity(b)));
  return ordered.map(entry => ({ id: identity(entry), updatedAt: entry.record.detail.item.updatedAt }));
}
function observation(value: StudyObservation, expectedId: string, root: boolean) {
  if (value?.state === "withdrawn") {
    if (!["archived", "deleted", "out-of-scope", "denied"].includes(value.reason)) fail("STUDY_DISCOVERY_RESPONSE_INVALID");
    return { fingerprint: { state: value.state, reason: value.reason }, children: null, metadata: null };
  }
  if (!value || value.state !== "active" || !value.entry || identity(value.entry) !== expectedId ||
      !["course", "study-note"].includes(value.entry.record.detail.item.kind) || !Array.isArray(value.ancestors) ||
      value.ancestors.length > 24 || new Set(value.ancestors).size !== value.ancestors.length || value.ancestors.includes(expectedId) ||
      !Array.isArray(value.children) || value.children.length > 20000 ||
      (value.entry.override !== null && !Number.isFinite(value.entry.override))) fail("STUDY_DISCOVERY_RESPONSE_INVALID");
  try { validateWebsiteRecord(value.entry.record); value.ancestors.forEach(key); } catch { fail("STUDY_DISCOVERY_RESPONSE_INVALID"); }
  const parentId = value.entry.record.evidence.parentId;
  if ((parentId === null && value.ancestors.length) || (parentId !== null && value.ancestors.at(-1) !== parentId)) fail("STUDY_DISCOVERY_RESPONSE_INVALID");
  const ids = new Set<string>();
  for (const [index, child] of value.children.entries()) {
    key(child.id);
    if (ids.has(child.id) || child.id === expectedId || child.position !== index ||
        (child.updatedAt !== null && (typeof child.updatedAt !== "string" || !Number.isFinite(Date.parse(child.updatedAt))))) fail("STUDY_DISCOVERY_RESPONSE_INVALID");
    ids.add(child.id);
  }
  const selected = root ? [...value.children].sort((a, b) => a.id.localeCompare(b.id)) : value.children;
  const list = selected.map(child => ({ id: child.id, updatedAt: child.updatedAt }));
  const meta = metadata(value.entry);
  return { fingerprint: { state: "active", metadata: meta, children: list }, metadata: meta, children: list };
}
function position(cursor: string | null) {
  if (cursor === null) return null;
  try {
    const value = JSON.parse(cursor) as { afterKey?: unknown };
    if (!value || Object.keys(value).length !== 1 || typeof value.afterKey !== "string") fail("STUDY_DISCOVERY_CURSOR_INVALID");
    return key(value.afterKey);
  } catch { return fail("STUDY_DISCOVERY_CURSOR_INVALID"); }
}
function fingerprint(cursor: string | null): { pageKey: string; digest: string } | null {
  if (cursor === null) return null;
  try {
    const value = JSON.parse(cursor) as { pageKey: string; digest: string };
    if (!value || Object.keys(value).length !== 2 || !hash(value.digest)) fail("STUDY_DISCOVERY_CURSOR_INVALID");
    key(value.pageKey); return value;
  } catch { return fail("STUDY_DISCOVERY_CURSOR_INVALID"); }
}
async function bounded<T>(call: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(new StudyDiscoveryError("STUDY_DISCOVERY_CANCELLED"));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return call(); }).then(value => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) reject(new StudyDiscoveryError("STUDY_DISCOVERY_CANCELLED")); else resolve(value);
    }, error => { signal.removeEventListener("abort", abort); reject(error); });
  });
}

/** Poll immediate owned child directories even if the parent's edited time is
 * unchanged. Hints never authorize new pages or delete missing descendants. */
export async function runStudyChildDiscovery(options: StudyChildDiscoveryOptions): Promise<StudyChildDiscoveryResult> {
  const result: StudyChildDiscoveryResult = { outcome: "limited", parents: 0, hints: 0, unavailable: 0 };
  const controller = new AbortController(), signal = controller.signal;
  const cancel = () => controller.abort();
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  let timer: ReturnType<typeof setTimeout> | undefined, expired = false;
  try {
    signal.throwIfAborted();
    const maximum = options.maxParents ?? 20, childLimit = options.maxChildren ?? 2000, duration = options.maxDurationMs ?? 30000;
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > 50 || !Number.isInteger(childLimit) || childLimit < 1 || childLimit > 20000 ||
        !Number.isInteger(duration) || duration < 1 || duration > 120000) fail("STUDY_DISCOVERY_LIMIT_INVALID");
    timer = setTimeout(() => { expired = true; controller.abort(); }, duration);
    const config = structuredClone(options.config), before = structuredClone(options.store.load());
    validateStudyCheckpoint(before);
    if (before.sourceDigest !== options.queue.scopeDigest || before.sourceDigest !== configDigest(config)) fail("STUDY_DISCOVERY_SCOPE_CHANGED");
    const configured = config.sources.find(source => source.key === options.sourceKey);
    const rootSource = configured?.kind === "course" ? configured : config.sources.find(source => source.kind === "course" && source.dataSourceId === configured?.dataSourceId);
    if (!configured || !rootSource || rootSource.publication.mode !== "all" ||
        (configured.kind !== "course" && (configured.kind !== "study-note" || configured.publication.mode !== "course-descendants")) ||
        !config.sources.some(source => source.kind === "study-note" && source.dataSourceId === rootSource.dataSourceId && source.publication.mode === "course-descendants")) fail("STUDY_DISCOVERY_SOURCE_UNSUPPORTED");
    const catalog = before.entries.filter(entry => entry.record.evidence.sourceKey === options.sourceKey).sort((a, b) => identity(a).localeCompare(identity(b)));
    if (catalog.some(entry => entry.record.detail.item.kind !== configured.kind)) fail("STUDY_DISCOVERY_SCOPE_CHANGED");
    const control = options.queue.checkpoint(options.sourceKey, NAME), afterKey = position(control.cursor);
    const start = afterKey === null ? 0 : catalog.findIndex(entry => identity(entry) > afterKey);
    const selected = start < 0 ? [] : catalog.slice(start, start + maximum);
    const childrenByParent = new Map<string, StudyEntry[]>();
    for (const entry of before.entries) {
      const parent = entry.record.evidence.parentId;
      if (parent !== null) { const group = childrenByParent.get(parent) ?? []; group.push(entry); childrenByParent.set(parent, group); }
    }
    let source = options.source(before, signal);
    if (source.sourceDigest !== before.sourceDigest) fail("STUDY_DISCOVERY_SCOPE_CHANGED");
    source = source.openOperation?.() ?? source;
    if (source.sourceDigest !== before.sourceDigest) fail("STUDY_DISCOVERY_SCOPE_CHANGED");
    const proposals: { name: string; revision: number; cursor: string; event: ChangeHint | null }[] = [];
    let totalChildren = 0;
    for (const [offset, entry] of selected.entries()) {
      const pageKey = identity(entry), name = `${NAME}:${start + offset}`, previous = options.queue.checkpoint(options.sourceKey, name);
      const saved = fingerprint(previous.cursor);
      let current: StudyObservation | undefined, unavailable = false;
      try { current = await bounded(() => source.read(pageKey, { document: false, children: true }), signal); }
      catch (error) {
        signal.throwIfAborted();
        if (error instanceof StudyDiscoveryError || error instanceof IncrementalQueueError) throw error;
        if ((error as { code?: string } | null)?.code === "MISCONFIGURED") fail("STUDY_DISCOVERY_SOURCE_UNSUPPORTED");
        // Unknown availability is a recheck, never withdrawal. Advancing past
        // this parent keeps one unavailable page from starving the entire source.
        result.unavailable++;
        unavailable = true;
      }
      signal.throwIfAborted();
      const root = entry.record.detail.item.kind === "course", actual = unavailable ?
        { fingerprint: { state: "unavailable" }, children: null, metadata: null } : observation(current!, pageKey, root);
      totalChildren += actual.children?.length ?? 0;
      if (totalChildren > childLimit) fail("STUDY_DISCOVERY_CHILD_LIMIT");
      const baseline = { metadata: metadata(entry), children: children(childrenByParent.get(pageKey) ?? [], root) };
      const digest = configDigest([baseline, actual.fingerprint]);
      const membershipChanged = actual.children === null || !equal(baseline.children, actual.children);
      const changed = membershipChanged || !equal(baseline.metadata, actual.metadata) || actual.children?.some(child => child.updatedAt === null);
      const shouldHint = changed && (saved?.pageKey !== pageKey || saved.digest !== digest);
      result.parents++;
      if (saved?.pageKey === pageKey && saved.digest === digest) continue;
      const observedAt = (options.now ?? Date.now)();
      if (!Number.isSafeInteger(observedAt) || observedAt < 0) fail("STUDY_DISCOVERY_CLOCK_INVALID");
      proposals.push({ name, revision: previous.revision, cursor: JSON.stringify({ pageKey, digest }), event: shouldHint ? {
        eventId: `study-children:${configDigest([before.sourceDigest, options.sourceKey, pageKey, name, previous.revision, digest])}`,
        sourceKey: options.sourceKey, pageKey, observedAt,
        reason: actual.children === null ? "reconcile" : membershipChanged ? "relation" : "properties",
      } : null });
    }
    signal.throwIfAborted();
    const after = options.store.load();
    if (!equal(before, after)) fail("STUDY_DISCOVERY_BASELINE_CHANGED");
    if (!equal(control, options.queue.checkpoint(options.sourceKey, NAME))) fail("STUDY_DISCOVERY_CURSOR_CHANGED");
    // No awaits between the baseline/queue fence and these durable commits.
    // Each hint and its fingerprint commit atomically. A later slot conflict
    // leaves the control cursor unchanged; replay skips matching fingerprints,
    // while slot revisions fence writes. Internal hints use no permanent event ledger.
    for (const proposal of proposals) {
      signal.throwIfAborted();
      result.hints += options.queue.commitLocalDiscovery({ sourceKey: options.sourceKey, name: proposal.name, expectedRevision: proposal.revision,
        nextCursor: proposal.cursor, events: proposal.event ? [proposal.event] : [] }).inserted;
    }
    const last = selected.at(-1), more = last && catalog.some(entry => identity(entry) > identity(last));
    options.queue.commitDiscovery({ sourceKey: options.sourceKey, name: NAME, expectedRevision: control.revision,
      nextCursor: more ? JSON.stringify({ afterKey: identity(last!) }) : null, events: [] });
    result.outcome = more ? "limited" : "completed";
  } catch (error) {
    const code = error instanceof StudyDiscoveryError || error instanceof IncrementalQueueError ? error.code : "STUDY_DISCOVERY_UNAVAILABLE";
    result.errorCode = expired ? "STUDY_DISCOVERY_DEADLINE" : signal.aborted ? "STUDY_DISCOVERY_CANCELLED" : code;
    result.outcome = signal.aborted ? expired ? "retry" : "cancelled" :
      ["STUDY_DISCOVERY_SCOPE_CHANGED", "STUDY_DISCOVERY_SOURCE_UNSUPPORTED", "STUDY_DISCOVERY_RESPONSE_INVALID", "STUDY_DISCOVERY_CURSOR_INVALID",
        "STUDY_DISCOVERY_CHILD_LIMIT", "STUDY_DISCOVERY_CLOCK_INVALID", "STUDY_DISCOVERY_LIMIT_INVALID", "QUEUE_SCOPE_MISMATCH", "QUEUE_SCHEMA_MISMATCH"].includes(code) ? "needs_review" : "retry";
  } finally { if (timer) clearTimeout(timer); options.signal?.removeEventListener("abort", cancel); }
  return result;
}
