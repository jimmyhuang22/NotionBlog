import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { StoredMedia } from "../../contracts/sync.ts";
import { WEBSITE_SCHEMA_DIGEST } from "../../contracts/website-sync.ts";
import { openIncrementalDatabase, type IncrementalDatabaseOptions, IncrementalDatabaseError } from "../../src/server/database/incremental-connection.ts";
import { readPublicationState, PublicationDeltaError, type PublicationState } from "../../src/server/database/incremental-publication.ts";
import { canonicalJson, configDigest } from "../../src/server/database/website-validation.ts";
import { normalizeId } from "../../src/server/notion/config.ts";
import { parseWebsiteNotionConfig, websiteCollectionTimeZone, type WebsiteNotionConfig } from "../../src/server/notion/website-config.ts";
import type { WebsiteStudyCollection } from "../../src/server/notion/website-repository.ts";
import { acquireLock, privateDirectory, readPrivateFile } from "../notion-sync/state.ts";
import { WorkerError } from "../notion-sync/errors.ts";
import { openIncrementalQueue, type QueueTicket } from "./queue.ts";
import { openContentCache, ContentCacheError, contentCacheBaselineDigest, type ContentCacheStore, type ContentCacheBaselineProof } from "./content-cache.ts";
import { openStudyCheckpoint, StudyCheckpointError } from "./study-checkpoint.ts";
import { createDatabaseStudyBaselineReader, initializeStudyBaseline, validateStudyBaselineCollection, StudyBaselineError } from "./study-baseline.ts";
import { createDatabaseContentBaselineReader, readContentBaselineProof, ContentBaselineError } from "./content-baseline.ts";
import { initializeStudyAndContentBaseline } from "./study-shared-baseline.ts";
import { initializeDirectoryBaseline, type DirectoryBaselineCapture } from "./discovery-baseline.ts";
import { createDatabasePublicationPort } from "./publication-port.ts";
import { createStudyDomainPort } from "./study-domain.ts";
import { createIncrementalCoordinator } from "./coordinator.ts";
import { withContentCache } from "./content-cache-ports.ts";
import { recoverIncrementalCycle, runIncrementalCycle } from "./executor.ts";
import { runDirectoryDiscovery } from "./discovery.ts";
import { runStudyChildDiscovery } from "./study-child-discovery.ts";
import { createHostBudget, hostAwait, hostFail, IncrementalHostError, type HostBudget, type HostBudgetOptions } from "./host-budget.ts";
import { readHostJson, writeHostJson } from "./host-state.ts";
import type { RuntimeSources } from "./runtime-sources.ts";
import { createHostResources, type RegisterHostCleanup } from "./host-resources.ts";
import { createFreezeStore, type FreezeState } from "../../src/server/database/freeze.ts";

export interface IncrementalBaselineArtifact {
  format: "incremental-baseline-v1"; fullRunId: string; state: PublicationState;
  collection: WebsiteStudyCollection; media: StoredMedia[]; deniedPageIds: string[]; directory: DirectoryBaselineCapture;
}
type Database = Awaited<ReturnType<typeof openIncrementalDatabase>>;
export interface IncrementalHostOptions extends HostBudgetOptions {
  command: "initialize" | "recover" | "run"; config: unknown; lockDirectory: string; runtimeDirectory: string;
  database: Omit<IncrementalDatabaseOptions, "configDigest">; artifactPath?: string; maxTasks?: number; maxSources?: number;
  freezeEnabled?: boolean; target?: { sourceKey: string; pageKey: string };
  refreshFrozenGroup?: string; expectedFreezeGeneration?: string;
  expectedPublicationRevision?: string;
  maxBaselineReads?: number;
}
export interface IncrementalHostDependencies {
  /** Internal transport seam only. The CLI always opens the reviewed real binding. */
  database?(options: IncrementalDatabaseOptions, signal: AbortSignal): Promise<Database>;
  /** Lazy: never constructed or called during initialize, recovery or blocked startup. */
  sources(input: { config: WebsiteNotionConfig; store: ContentCacheStore; budget: HostBudget; deniedPageIds: ReadonlySet<string>; frozenPageIds?: ReadonlySet<string>; registerCleanup: RegisterHostCleanup }): Promise<RuntimeSources>;
}
function safeCode(e: unknown): string {
  if (e instanceof WorkerError) return e.code === "BUSY" ? "HOST_BUSY" : "HOST_PRIVATE_STATE_INVALID";
  if (e instanceof IncrementalHostError || e instanceof ContentCacheError || e instanceof StudyCheckpointError ||
    e instanceof IncrementalDatabaseError || e instanceof PublicationDeltaError || e instanceof StudyBaselineError || e instanceof ContentBaselineError) return e.code;
  return "HOST_UNAVAILABLE";
}
function same(a: unknown, b: unknown) { return canonicalJson(a) === canonicalJson(b); }
function denied(value: unknown): Set<string> {
  if (!Array.isArray(value) || value.length > 20000 || value.some(v => typeof v !== "string")) hostFail("HOST_POLICY_INVALID");
  try { const ids = value.map(normalizeId); if (new Set(ids).size !== ids.length) hostFail("HOST_POLICY_INVALID"); return new Set(ids); }
  catch { hostFail("HOST_POLICY_INVALID"); }
}
function existingContent(store: ContentCacheStore, config: WebsiteNotionConfig, baseline: { state: PublicationState; records: WebsiteStudyCollection["records"]; media: StoredMedia[] }) {
  try { store.assertState(baseline.state); }
  catch (e) { if (e instanceof ContentCacheError && e.code === "CONTENT_CACHE_BASELINE_MISSING") return false; throw e; }
  const cachedRecords = [], cachedMedia = [];
  for (const source of config.sources) for (const id of store.knownPages(source.key, baseline.state).pageKeys) {
    const page = store.readPublished({ sourceKey: source.key, pageKey: id }, baseline.state)!;
    cachedRecords.push(page.record); cachedMedia.push(...page.media);
  }
  if (contentCacheBaselineDigest({ records: cachedRecords, media: cachedMedia }) !== contentCacheBaselineDigest(baseline)) hostFail("HOST_BASELINE_CONFLICT");
  return true;
}

/** The caller supplies the canonical lock directory used by the old publisher.
 * No schedules, defaults to real credentials, deployments or implicit crawl. */
export async function runIncrementalHost(options: IncrementalHostOptions, dependencies: IncrementalHostDependencies) {
  const config = parseWebsiteNotionConfig(structuredClone(options.config)), digest = configDigest(config), sourceKeys = config.sources.map(s => s.key);
  websiteCollectionTimeZone(config);
  const studyKeys = config.sources.filter(s => s.kind === "course" || s.kind === "study-note").map(s => s.key);
  const tasks = options.maxTasks ?? 20, sourceLimit = options.maxSources ?? 3;
  const baselineReads = options.maxBaselineReads ?? 2000;
  if (!Number.isInteger(baselineReads) || baselineReads < 1 || baselineReads > 20000 ||
      options.maxBaselineReads !== undefined && options.command !== "initialize") hostFail("HOST_INPUT_INVALID");
  if (!["initialize", "recover", "run"].includes(options.command) || !sourceKeys.length || sourceKeys.length > 50 || !studyKeys.length ||
    config.sources.some(s => s.kind === "course" ? s.publication.mode !== "all" : s.kind === "study-note" && s.publication.mode !== "course-descendants") ||
    !Number.isInteger(tasks) || tasks < 1 || tasks > 50 || !Number.isInteger(sourceLimit) || sourceLimit < 1 || sourceLimit > 50 ||
    options.lockDirectory === options.runtimeDirectory) hostFail("HOST_INPUT_INVALID");
  if (options.target && (options.command !== "run" || !sourceKeys.includes(options.target.sourceKey) ||
      normalizeId(options.target.pageKey) !== options.target.pageKey) ||
      options.refreshFrozenGroup && (!options.freezeEnabled || !options.target || !/^[a-f0-9-]{36}$/.test(options.refreshFrozenGroup) || !/^[0-9]+$/.test(options.expectedFreezeGeneration ?? ""))) hostFail("HOST_INPUT_INVALID");
  const budget = createHostBudget({ ...options, durationMs: options.durationMs ?? (options.command === "initialize" ? 899000 : 120000) });
  const report = { format: "incremental-host-report-v1", outcome: "failed", phase: "lock", errorCode: null as string | null,
    startedAt: new Date().toISOString(), finishedAt: "", recovered: 0, published: 0, unchanged: 0, retired: 0,
    discoveredPages: 0, discoveredHints: 0, baselineRecords: 0, baselineMedia: 0,
    budget: budget.statistics(), queue: null as ReturnType<Awaited<ReturnType<typeof openIncrementalQueue>>["status"]> | null };
  let release: (() => Promise<void>) | undefined, db: Database | undefined;
  const resources = createHostResources();
  let queue: Awaited<ReturnType<typeof openIncrementalQueue>> | undefined, study: Awaited<ReturnType<typeof openStudyCheckpoint>> | undefined, cache: ContentCacheStore | undefined;
  try {
    budget.guard(); release = await acquireLock(options.lockDirectory, randomUUID()); budget.guard();
    await privateDirectory(options.runtimeDirectory); budget.guard();
    report.phase = "database";
    // Await cleanup of an opening connection even after cancellation; do not
    // leave a pool or release the canonical mutex while startup is still live.
    db = await (dependencies.database ?? ((input, signal) => openIncrementalDatabase(input, {}, signal)))({ ...options.database, configDigest: digest }, budget.signal);
    budget.guard();
    queue = await openIncrementalQueue(join(options.runtimeDirectory, "queue"), { digest, sourceKeys });
    study = await openStudyCheckpoint(join(options.runtimeDirectory, "study"), digest);
    cache = await openContentCache(join(options.runtimeDirectory, "content"), digest, sourceKeys);
    const readerState = (signal: AbortSignal) => { signal.throwIfAborted(); return readPublicationState(db!.reader); };
    if (options.command === "initialize") {
      report.phase = "initialize";
      if (!options.artifactPath || queue.status().awaiting_verification || queue.status().leased || queue.status().retirement_pending) hostFail("HOST_INITIALIZATION_BLOCKED");
      const artifact = JSON.parse(await readPrivateFile(options.artifactPath, 48 * 1024 * 1024)) as IncrementalBaselineArtifact;
      budget.guard();
      if (!artifact || artifact.format !== "incremental-baseline-v1" || Object.keys(artifact).length !== 7) hostFail("HOST_ARTIFACT_INVALID");
      const exclusions = denied(artifact.deniedPageIds);
      validateStudyBaselineCollection(artifact.collection, config, exclusions);
      const baseline = { state: artifact.state, records: artifact.collection.records, media: artifact.media };
      const hasContent = existingContent(cache, config, baseline);
      let previous;
      try { previous = study.load(); } catch (e) { if (!(e instanceof StudyCheckpointError && e.code === "STUDY_CHECKPOINT_MISSING")) throw e; }
      let proof: ContentCacheBaselineProof;
      if (!hasContent && !previous) {
        // Only this invocation's complete independent read can supply both
        // installations. A receipt or partially installed cache cannot do so.
        const result = await hostAwait(budget, () => initializeStudyAndContentBaseline({
          content: { baseline, fullRunId: artifact.fullRunId, store: cache!, reader: createDatabaseContentBaselineReader(db!.reader), maxReads: baselineReads },
          collection: artifact.collection, config, deniedPageIds: exclusions, studyStore: study!,
        }, budget.signal));
        proof = { ...baseline.state, readerVerified: true, complete: true, records: result.content.records,
          media: result.content.media, contentDigest: result.content.contentDigest };
      } else {
        const verified = await hostAwait(budget, () => readContentBaselineProof({ baseline, fullRunId: artifact.fullRunId, store: cache!,
          reader: createDatabaseContentBaselineReader(db!.reader), maxReads: baselineReads }, budget.signal)); budget.guard();
        if (!hasContent) cache.initialize(verified.baseline, verified.proof);
        if (previous) {
          if (previous.version !== artifact.state.publicationRevision || !same(previous.entries, artifact.collection.baseline.entries)) hostFail("HOST_BASELINE_CONFLICT");
        } else await hostAwait(budget, () => initializeStudyBaseline({ collection: artifact.collection, config, deniedPageIds: exclusions, fullRunId: artifact.fullRunId,
          store: study!, reader: createDatabaseStudyBaselineReader(db!.reader), maxReads: baselineReads }, budget.signal));
        proof = verified.proof;
      }
      const current = await hostAwait(budget, () => readerState(budget.signal)); budget.guard();
      if (!same(current, baseline.state)) hostFail("HOST_PUBLICATION_CHANGED");
      initializeDirectoryBaseline({ queue, config, capture: artifact.directory, baseline, proof, currentState: current });
      budget.guard();
      await writeHostJson(options.runtimeDirectory, "incremental-ready.json", { format: "incremental-host-ready-v1", configDigest: digest,
        schemaDigest: WEBSITE_SCHEMA_DIGEST, policyEpoch: current.policyEpoch, deniedPageIds: [...exclusions].sort(), directorySeeded: true }, budget.signal);
      report.baselineRecords = proof.records; report.baselineMedia = proof.media; report.outcome = "initialized";
    } else {
      const ready = await readHostJson(options.runtimeDirectory, "incremental-ready.json"); budget.guard();
      if (!ready || Object.keys(ready).length !== 6 || ready.format !== "incremental-host-ready-v1" || ready.configDigest !== digest ||
        ready.schemaDigest !== WEBSITE_SCHEMA_DIGEST || !/^[0-9]+$/.test(ready.policyEpoch) || ready.directorySeeded !== true) hostFail("HOST_BASELINE_MISSING");
      const exclusions = denied(ready.deniedPageIds);
      const frozenPageIds = new Set<string>();
      let freezeState: FreezeState | undefined;
      const loadFrozen = async () => {
        if (!options.freezeEnabled) return;
        freezeState = await createFreezeStore(db!.reader).state(); budget.guard();
        if (!freezeState.enabled || freezeState.configDigest !== digest) hostFail("HOST_FREEZE_DISABLED");
        if (options.expectedFreezeGeneration !== undefined && freezeState.generation !== options.expectedFreezeGeneration) hostFail("HOST_FREEZE_PREVIEW_STALE");
        if (options.refreshFrozenGroup && !freezeState.members.some(m => m.groupId === options.refreshFrozenGroup && m.rootId === options.target!.pageKey && m.id === m.rootId)) hostFail("HOST_TARGET_FROZEN");
        frozenPageIds.clear();
        for (const member of freezeState.members) if (member.groupId !== options.refreshFrozenGroup) frozenPageIds.add(member.id);
        queue!.setFrozenPages(frozenPageIds);
      };
      await loadFrozen();
      let source: RuntimeSources | undefined;
      const sources = () => { if (!source) hostFail("HOST_SOURCE_PHASE_INVALID"); return source; };
      const publication = createDatabasePublicationPort(db.writer, db.reader, options.refreshFrozenGroup ?
        () => ({ groupId: options.refreshFrozenGroup!, generation: freezeState!.generation }) : undefined);
      const domain = createStudyDomainPort<QueueTicket>({ store: study, sourceKeys: studyKeys, assertPreparing: ticket => queue!.assertPreparing(ticket),
        frozenPageIds, maxReads: options.refreshFrozenGroup ? 2000 : undefined,
        refreshPageIds: options.refreshFrozenGroup ? freezeState!.members.filter(m => m.groupId === options.refreshFrozenGroup).map(m => m.id) : undefined,
        source: (state, signal) => sources().study(state, signal), verify: (receipt, signal) => db!.verify(receipt, signal),
        incomingLinks: async (changes, state, signal) => { signal.throwIfAborted(); const links = cache!.incomingLinks(changes, state);
          return { ...links, records: links.records.filter(r => !frozenPageIds.has(r.detail.item.id)) }; },
        assets: async (records, state, signal) => sources().assets(records, state, signal) });
      const coordinator = createIncrementalCoordinator<QueueTicket>({ scopeDigest: digest, sourceKeys, studySourceKeys: studyKeys, queue,
        publication, checkpoint: study, study: domain, regular: { prepare: (ticket, state, signal) => sources().regular.prepare(ticket, state, signal) } });
      const ports = withContentCache({ store: cache, ports: coordinator, queue, readVerifiedState: readerState });
      const pending = queue.status(); report.phase = "recovery";
      if (pending.awaiting_verification || pending.retirement_pending || pending.leased) {
        const result = await recoverIncrementalCycle({ queue, schemaDigest: WEBSITE_SCHEMA_DIGEST, signal: budget.signal,
          maxTasks: 50, maxDurationMs: Math.max(10, budget.remainingMs()) }, ports);
        report.recovered += result.recovered; report.retired += result.retired;
      }
      budget.guard();
      const afterRecovery = queue.status();
      if (afterRecovery.awaiting_verification || afterRecovery.retirement_pending || afterRecovery.leased) hostFail("HOST_RECOVERY_BLOCKED");
      await loadFrozen();
      const state = await hostAwait(budget, () => readerState(budget.signal)); budget.guard();
      if (options.expectedPublicationRevision !== undefined && options.expectedPublicationRevision !== state.publicationRevision) hostFail("HOST_PUBLICATION_CHANGED");
      cache.assertState(state);
      if (study.load().version !== state.publicationRevision || state.policyEpoch !== ready.policyEpoch) hostFail("HOST_LOCAL_VERSION_CHANGED");
      if (options.command === "recover") report.outcome = "recovered";
      else {
        report.phase = "discovery";
        if (options.target && (frozenPageIds.has(options.target.pageKey) || !cache.readPublished(options.target, state))) hostFail("HOST_TARGET_FROZEN");
        source = await hostAwait(budget, () => resources.open(() => dependencies.sources({ config, store: cache!, budget, deniedPageIds: exclusions, frozenPageIds, registerCleanup: resources.register }))); budget.guard();
        if (options.target) queue.enqueue([{ eventId: `console:${randomUUID()}`, ...options.target, reason: "reconcile", observedAt: Date.now() }]);
        const checkpoint = queue.checkpoint(sourceKeys[0], "host-round-robin-v1");
        let offset = checkpoint.cursor === null ? 0 : Number(checkpoint.cursor), revision = checkpoint.revision;
        if (!Number.isInteger(offset) || offset < 0 || offset >= sourceKeys.length) hostFail("HOST_CURSOR_INVALID");
        for (let step = 0; !options.target && step < Math.min(sourceLimit, sourceKeys.length); step++) {
          budget.guard(); const key = sourceKeys[offset], selected = config.sources[offset];
          const discovery = await runDirectoryDiscovery({ queue, sourceKey: key, signal: budget.signal, maxSteps: 2,
            maxDurationMs: Math.max(10, Math.min(30000, budget.remainingMs())) }, source.directory(key, state));
          report.discoveredPages += discovery.pages; report.discoveredHints += discovery.hints;
          if (!["completed", "partial"].includes(discovery.outcome)) hostFail(discovery.outcome === "needs_review" ? "HOST_DISCOVERY_REVIEW" : "HOST_DISCOVERY_PENDING");
          if (selected.kind === "course" || selected.kind === "study-note") {
            const children = await runStudyChildDiscovery({ queue, store: study, config, sourceKey: key, signal: budget.signal,
              source: (_checkpoint, signal) => source!.children(signal), maxParents: 5, maxChildren: 2000,
              frozenPageIds,
              maxDurationMs: Math.max(10, Math.min(30000, budget.remainingMs())) });
            report.discoveredHints += children.hints;
            if (!["completed", "limited"].includes(children.outcome)) hostFail(children.outcome === "needs_review" ? "HOST_DISCOVERY_REVIEW" : "HOST_DISCOVERY_PENDING");
          }
          budget.guard(); offset = (offset + 1) % sourceKeys.length;
          revision = queue.commitDiscovery({ sourceKey: sourceKeys[0], name: "host-round-robin-v1", expectedRevision: revision, nextCursor: String(offset), events: [] }).revision;
        }
        report.phase = "publication";
        const result = await runIncrementalCycle({ queue, schemaDigest: WEBSITE_SCHEMA_DIGEST, signal: budget.signal,
          // One target attempt plus its durable local retirement share this budget.
          maxTasks: options.target ? 2 : tasks, target: options.target, maxDurationMs: Math.max(10, budget.remainingMs()) }, ports);
        report.published = result.published; report.recovered += result.recovered; report.unchanged = result.unchanged; report.retired += result.retired;
        report.outcome = result.outcome; report.errorCode = result.errorCode;
      }
    }
  } catch (e) { report.outcome = budget.signal.aborted ? "cancelled" : "failed"; report.errorCode = budget.statistics().errorCode ?? safeCode(e); }
  finally {
    budget.close();
    try { await resources.close(); } catch { report.outcome = "failed"; report.errorCode ??= "HOST_RESOURCE_CLOSE_FAILED"; }
    try { if (queue) report.queue = queue.status(); } catch { report.errorCode ??= "HOST_STATE_INVALID"; }
    // Never acknowledge work in cleanup. SQL close finishes possibly active
    // writes before the canonical mutex is released; unknown markers survive.
    try { await db?.close(); } catch { report.outcome = "failed"; report.errorCode ??= "HOST_CLOSE_FAILED"; }
    for (const store of [queue, study, cache]) try { store?.close(); } catch { report.outcome = "failed"; report.errorCode ??= "HOST_CLOSE_FAILED"; }
    report.finishedAt = new Date().toISOString(); report.budget = budget.statistics();
    try { if (release) await writeHostJson(options.runtimeDirectory, "incremental-latest.json", report); }
    catch { report.outcome = "failed"; report.errorCode = "HOST_REPORT_UNSAVED"; }
    try { await release?.(); } catch { report.outcome = "failed"; report.errorCode = "HOST_LOCK_RELEASE_FAILED"; }
  }
  return report;
}
