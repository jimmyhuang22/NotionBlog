import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import * as sqlite from "node:sqlite";
import { privateDirectory } from "../notion-sync/state.ts";

const APPLICATION_ID = 0x4e424951;
const MAX_BATCH = 200;
const REASONS = ["content", "properties", "created", "moved", "removed", "relation", "policy", "reconcile"] as const;
export type ChangeReason = typeof REASONS[number];
export interface ChangeHint { eventId: string; sourceKey: string; pageKey: string; reason: ChangeReason; observedAt: number }
export interface QueueScope { digest: string; sourceKeys: readonly string[] }
export interface QueueTicket { operationId: string; sourceKey: string; pageKey: string; generation: number; reasons: ChangeReason[] }
export interface PendingVerification { ticket: QueueTicket; payloadDigest: string; expectedRevision: string }
export interface VerifiedCommit { operationId: string; payloadDigest: string; publicationRevision: string; readerVerified: true }
export type AttemptClosure = { ticket: QueueTicket; disposition: "never_submitted"; payloadDigest: null } |
  { ticket: QueueTicket; disposition: "definitively_rejected"; payloadDigest: string };
export interface DirectoryMember { pageKey: string; fingerprint: string; lastEditedAt: number }
export interface DirectoryBaselineSeed {
  baselineDigest: string;
  sources: { sourceKey: string; members: readonly DirectoryMember[] }[];
}
export interface DiscoveryScan {
  id: string; mode: "changes" | "membership"; phase: "query" | "missing";
  startedAt: number; since: number | null; cursor: string | null; afterKey: string | null; pages: number;
}
export interface DiscoveryState { revision: number; watermark: number | null; lastReconciledAt: number | null; scan: DiscoveryScan | null }
export class IncrementalQueueError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = "IncrementalQueueError"; this.code = code; }
}
function fail(code = "QUEUE_INPUT_INVALID"): never { throw new IncrementalQueueError(code); }
function key(value: string) { if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,200}$/.test(value)) fail(); }
function digest(value: string) { if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) fail(); }
function integer(value: number, minimum = 0, maximum = Number.MAX_SAFE_INTEGER - 1) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail();
}
function text(value: string) { if (typeof value !== "string" || value.length > 4096 || /[\u0000-\u001f]/.test(value)) fail(); }
function code(value: string) { if (typeof value !== "string" || !/^[A-Z][A-Z_]{0,63}$/.test(value)) fail(); }
function hash(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function safeError(error: unknown): never {
  if (error instanceof IncrementalQueueError) throw error;
  const busy = (error as { errcode?: number } | null)?.errcode === 5;
  throw new IncrementalQueueError(busy ? "QUEUE_BUSY" : "QUEUE_STATE_INVALID");
}
type Row = Record<string, string | number | null>;

const DIRECTORY_SCHEMA = `
  CREATE TABLE directory(source TEXT NOT NULL, page TEXT NOT NULL, fingerprint TEXT NOT NULL,
    edited_at INTEGER NOT NULL, seen_scan TEXT, missing INTEGER NOT NULL DEFAULT 0 CHECK(missing IN (0,1)),
    PRIMARY KEY(source,page)) STRICT;
  CREATE TABLE discovery(source TEXT PRIMARY KEY, revision INTEGER NOT NULL,
    watermark INTEGER, reconciled_at INTEGER, scan_id TEXT, mode TEXT, phase TEXT,
    started_at INTEGER, since INTEGER, cursor TEXT, after_key TEXT, pages INTEGER NOT NULL DEFAULT 0) STRICT;
  CREATE TABLE discovery_cursors(source TEXT NOT NULL, cursor_hash TEXT NOT NULL,
    PRIMARY KEY(source,cursor_hash)) STRICT;
`;
const RETIREMENT_SCHEMA = `
  CREATE TABLE retirements(id TEXT PRIMARY KEY REFERENCES attempts(id), acknowledged INTEGER NOT NULL DEFAULT 0
    CHECK(acknowledged IN (0,1))) STRICT;
  INSERT INTO retirements(id) SELECT id FROM attempts WHERE state IN ('abandoned','failed')
    OR (state='verified' AND payload_digest IS NULL);
`;
const BASELINE_SCHEMA = `
  CREATE TABLE directory_baseline(singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    baseline_digest TEXT NOT NULL, seed_digest TEXT NOT NULL, members INTEGER NOT NULL) STRICT;
`;

const HISTORY_INDEX = `CREATE INDEX attempt_history ON attempts(source,page,generation,state);`;

const SCHEMA = `
  CREATE TABLE scope(digest TEXT NOT NULL, sources TEXT NOT NULL) STRICT;
  CREATE TABLE events(id TEXT PRIMARY KEY, digest TEXT NOT NULL) STRICT;
  CREATE TABLE checkpoints(source TEXT NOT NULL, name TEXT NOT NULL, revision INTEGER NOT NULL,
    cursor TEXT, PRIMARY KEY(source,name)) STRICT;
  CREATE TABLE jobs(source TEXT NOT NULL, page TEXT NOT NULL, generation INTEGER NOT NULL,
    completed_generation INTEGER NOT NULL DEFAULT 0, reasons TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending','leased','retry','awaiting_verification','done','needs_review')),
    available_at INTEGER NOT NULL, active_attempt TEXT, error_code TEXT,
    PRIMARY KEY(source,page)) STRICT;
  CREATE TABLE attempts(id TEXT PRIMARY KEY, source TEXT NOT NULL, page TEXT NOT NULL,
    generation INTEGER NOT NULL, reasons TEXT NOT NULL, expires_at INTEGER NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('preparing','awaiting_verification','abandoned','failed','verified')),
    payload_digest TEXT, expected_revision TEXT, publication_revision TEXT,
    FOREIGN KEY(source,page) REFERENCES jobs(source,page)) STRICT;
  CREATE INDEX runnable_jobs ON jobs(state,available_at);
  CREATE INDEX active_attempts ON attempts(state,expires_at);
`;

/** Local change hints only: no source body, cloud credentials or publication access. */
export class IncrementalQueue {
  readonly scopeDigest: string;
  private db: sqlite.DatabaseSync;
  private sources: Set<string>;
  private clock: () => number;
  private frozen = new Set<string>();
  constructor(db: sqlite.DatabaseSync, scope: QueueScope, clock: () => number) {
    this.db = db; this.sources = new Set(scope.sourceKeys); this.clock = clock; this.scopeDigest = scope.digest;
    this.transaction(() => {
      const application = Number(db.prepare("PRAGMA application_id").get()!.application_id);
      const version = Number(db.prepare("PRAGMA user_version").get()!.user_version);
      if (application === 0 && version === 0) {
        if (Number(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get()!.n)) fail("QUEUE_SCHEMA_MISMATCH");
        db.exec(SCHEMA);
        db.prepare("INSERT INTO scope VALUES(?,?)").run(scope.digest, JSON.stringify([...this.sources].sort()));
        db.exec(DIRECTORY_SCHEMA);
        db.exec(RETIREMENT_SCHEMA);
        db.exec(BASELINE_SCHEMA);
        db.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=4;`);
      } else if (application !== APPLICATION_ID || version < 1 || version > 5) fail("QUEUE_SCHEMA_MISMATCH");
      else if (version < 4) {
        if (version === 1) db.exec(DIRECTORY_SCHEMA);
        if (version < 3) db.exec(RETIREMENT_SCHEMA);
        db.exec(BASELINE_SCHEMA); db.exec("PRAGMA user_version=4;");
      }
      if (version < 5) { db.exec(HISTORY_INDEX); db.exec("PRAGMA user_version=5;"); }
      const stored = db.prepare("SELECT digest,sources FROM scope").get();
      if (stored?.digest !== scope.digest || stored.sources !== JSON.stringify([...this.sources].sort())) fail("QUEUE_SCOPE_MISMATCH");
    });
  }
  close() { this.db.close(); }
  /** Per-invocation database-verified exclusions; no durable policy is inferred from local events. */
  setFrozenPages(ids: ReadonlySet<string>) {
    if (ids.size > 20000) fail();
    for (const page of ids) key(page);
    this.transaction(() => {
      this.db.exec("CREATE TEMP TABLE IF NOT EXISTS frozen_pages(page TEXT PRIMARY KEY) STRICT; DELETE FROM frozen_pages;");
      const insert = this.db.prepare("INSERT INTO frozen_pages VALUES(?)");
      for (const page of ids) insert.run(page);
    });
    this.frozen = new Set(ids);
  }
  private now() { const n = this.clock(); integer(n, 0, 8_640_000_000_000_000); return n; }
  private source(value: string) { key(value); if (!this.sources.has(value)) fail("QUEUE_SCOPE_MISMATCH"); }
  private transaction<T>(fn: () => T): T {
    try { this.db.exec("BEGIN IMMEDIATE"); } catch (error) { safeError(error); }
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { try { this.db.exec("ROLLBACK"); } catch { /* Preserve the transaction failure. */ } safeError(error); }
  }
  private validateHints(events: readonly ChangeHint[]) {
    if (!Array.isArray(events) || events.length > MAX_BATCH) fail();
    for (const event of events) {
      key(event.eventId); this.source(event.sourceKey); key(event.pageKey); integer(event.observedAt);
      if (!REASONS.includes(event.reason)) fail();
    }
  }
  private ingest(events: readonly ChangeHint[], now: number, rememberEvents = true) {
    let inserted = 0;
    for (const event of events) {
      if (this.frozen.has(event.pageKey)) continue;
      const fingerprint = hash([event.sourceKey, event.pageKey, event.reason, event.observedAt]);
      const oldEvent = this.db.prepare("SELECT digest FROM events WHERE id=?").get(event.eventId);
      if (oldEvent) { if (oldEvent.digest !== fingerprint) fail("QUEUE_EVENT_CONFLICT"); continue; }
      const job = this.db.prepare("SELECT * FROM jobs WHERE source=? AND page=?").get(event.sourceKey, event.pageKey) as Row | undefined;
      const generation = Number(job?.generation ?? 0) + 1; integer(generation, 1);
      const reasons: ChangeReason[] = job && job.state !== "done" ? JSON.parse(String(job.reasons)) : [];
      const merged = JSON.stringify([...new Set([...reasons, event.reason])].sort());
      if (rememberEvents) this.db.prepare("INSERT INTO events VALUES(?,?)").run(event.eventId, fingerprint);
      this.db.prepare(`INSERT INTO jobs(source,page,generation,reasons,state,available_at) VALUES(?,?,?,?,'pending',?)
        ON CONFLICT(source,page) DO UPDATE SET generation=excluded.generation,reasons=excluded.reasons,
          state=CASE WHEN jobs.state='done' THEN 'pending' ELSE jobs.state END,
          available_at=CASE WHEN jobs.state='done' THEN excluded.available_at ELSE jobs.available_at END`)
        .run(event.sourceKey, event.pageKey, generation, merged, now);
      inserted++;
    }
    return inserted;
  }
  enqueue(events: readonly ChangeHint[]) {
    this.validateHints(events); const now = this.now();
    return this.transaction(() => this.ingest(events, now));
  }
  checkpoint(sourceKey: string, name: string): { revision: number; cursor: string | null } {
    this.source(sourceKey); key(name);
    const row = this.db.prepare("SELECT revision,cursor FROM checkpoints WHERE source=? AND name=?").get(sourceKey, name);
    return { revision: Number(row?.revision ?? 0), cursor: row?.cursor == null ? null : String(row.cursor) };
  }
  /** Commit a fully fetched discovery page and its next cursor in one transaction. */
  commitDiscovery(input: { sourceKey: string; name: string; expectedRevision: number; nextCursor: string | null; events: readonly ChangeHint[] }) {
    return this.commitCheckpoint(input, true);
  }
  /** Internal hints whose identity includes the checkpoint revision. A stale
   * replay fails the checkpoint fence, so no permanent event ledger is needed. */
  commitLocalDiscovery(input: Parameters<IncrementalQueue["commitDiscovery"]>[0]) {
    return this.commitCheckpoint(input, false);
  }
  private commitCheckpoint(input: Parameters<IncrementalQueue["commitDiscovery"]>[0], rememberEvents: boolean) {
    this.source(input.sourceKey); key(input.name); integer(input.expectedRevision);
    if (input.nextCursor !== null) text(input.nextCursor);
    this.validateHints(input.events);
    if (input.events.some(e => e.sourceKey !== input.sourceKey)) fail("QUEUE_SCOPE_MISMATCH");
    const now = this.now();
    return this.transaction(() => {
      if (this.checkpoint(input.sourceKey, input.name).revision !== input.expectedRevision) fail("QUEUE_CHECKPOINT_CONFLICT");
      const inserted = this.ingest(input.events, now, rememberEvents), revision = input.expectedRevision + 1;
      integer(revision, 1);
      this.db.prepare(`INSERT INTO checkpoints VALUES(?,?,?,?) ON CONFLICT(source,name)
        DO UPDATE SET revision=excluded.revision,cursor=excluded.cursor`).run(input.sourceKey, input.name, revision, input.nextCursor);
      return { inserted, revision };
    });
  }
  discoveryState(sourceKey: string): DiscoveryState {
    this.source(sourceKey);
    const row = this.db.prepare("SELECT * FROM discovery WHERE source=?").get(sourceKey) as Row | undefined;
    return { revision: Number(row?.revision ?? 0), watermark: row?.watermark == null ? null : Number(row.watermark),
      lastReconciledAt: row?.reconciled_at == null ? null : Number(row.reconciled_at), scan: !row?.scan_id ? null : {
        id: String(row.scan_id), mode: row.mode as DiscoveryScan["mode"], phase: row.phase as DiscoveryScan["phase"],
        startedAt: Number(row.started_at), since: row.since == null ? null : Number(row.since),
        cursor: row.cursor == null ? null : String(row.cursor), afterKey: row.after_key == null ? null : String(row.after_key), pages: Number(row.pages),
      } };
  }
  /** First-start metadata only. Never erase jobs/attempts or advance a source
   * watermark. The host must first bind the seed to an independent full proof. */
  seedDirectoryBaseline(input: DirectoryBaselineSeed) {
    digest(input.baselineDigest);
    if (!Array.isArray(input.sources) || input.sources.length !== this.sources.size ||
      new Set(input.sources.map(s => s.sourceKey)).size !== this.sources.size) fail("QUEUE_SCOPE_MISMATCH");
    let members = 0;
    for (const source of input.sources) {
      this.source(source.sourceKey);
      if (!Array.isArray(source.members) || new Set(source.members.map(m => m.pageKey)).size !== source.members.length) fail();
      members += source.members.length;
      if (members > 20_000) fail("DISCOVERY_LIMIT_EXCEEDED");
      for (const m of source.members) { key(m.pageKey); digest(m.fingerprint); integer(m.lastEditedAt, 0, 8_640_000_000_000_000); }
    }
    const seedDigest = hash(input.sources.map(s => ({ sourceKey: s.sourceKey,
      members: [...s.members].sort((a, b) => a.pageKey.localeCompare(b.pageKey)).map(m => [m.pageKey, m.fingerprint, m.lastEditedAt]),
    })).sort((a, b) => a.sourceKey.localeCompare(b.sourceKey)));
    return this.transaction(() => {
      const receipt = this.db.prepare("SELECT * FROM directory_baseline WHERE singleton=1").get();
      if (receipt) {
        if (receipt.baseline_digest !== input.baselineDigest || receipt.seed_digest !== seedDigest) fail("DISCOVERY_BASELINE_CONFLICT");
        return { initialized: false, members: Number(receipt.members) };
      }
      if (Number(this.db.prepare("SELECT count(*) AS n FROM directory").get()!.n) ||
        Number(this.db.prepare("SELECT count(*) AS n FROM discovery").get()!.n)) fail("DISCOVERY_ALREADY_STARTED");
      const insert = this.db.prepare("INSERT INTO directory VALUES(?,?,?,?,NULL,0)");
      for (const source of input.sources) for (const m of source.members) insert.run(source.sourceKey, m.pageKey, m.fingerprint, m.lastEditedAt);
      this.db.prepare("INSERT INTO directory_baseline VALUES(1,?,?,?)").run(input.baselineDigest, seedDigest, members);
      return { initialized: true, members };
    });
  }
  private discoveryFence(sourceKey: string, expectedRevision: number, phase?: DiscoveryScan["phase"]) {
    const state = this.discoveryState(sourceKey);
    if (state.revision !== expectedRevision) fail("QUEUE_CHECKPOINT_CONFLICT");
    if (phase && state.scan?.phase !== phase) fail("DISCOVERY_SCAN_INVALID");
    return state;
  }
  /** Capture a fixed query window. A first discovery always reconciles membership. */
  beginDiscovery(sourceKey: string, expectedRevision: number, input: { mode: DiscoveryScan["mode"]; startedAt: number; overlapMs: number }) {
    this.source(sourceKey); integer(expectedRevision); integer(input.startedAt, 0, 8_640_000_000_000_000); integer(input.overlapMs, 0, 86_400_000);
    if (input.mode !== "changes" && input.mode !== "membership") fail();
    return this.transaction(() => {
      const state = this.discoveryFence(sourceKey, expectedRevision);
      if (state.scan) fail("DISCOVERY_SCAN_ACTIVE");
      if (state.watermark !== null && input.startedAt < state.watermark) fail("DISCOVERY_CLOCK_INVALID");
      const mode = state.watermark === null ? "membership" : input.mode;
      const since = mode === "changes" ? Math.max(0, state.watermark! - input.overlapMs) : null;
      this.db.prepare(`INSERT INTO discovery(source,revision,scan_id,mode,phase,started_at,since) VALUES(?,?,?,?,'query',?,?)
        ON CONFLICT(source) DO UPDATE SET revision=excluded.revision,scan_id=excluded.scan_id,mode=excluded.mode,
        phase='query',started_at=excluded.started_at,since=excluded.since,cursor=NULL,after_key=NULL,pages=0`)
        .run(sourceKey, expectedRevision + 1, randomUUID(), mode, input.startedAt, since);
      this.db.prepare("DELETE FROM discovery_cursors WHERE source=?").run(sourceKey);
      return this.discoveryState(sourceKey);
    });
  }
  /** Metadata, resulting hints and pagination progress are one local transaction. */
  commitDirectoryPage(sourceKey: string, expectedRevision: number, members: readonly DirectoryMember[], nextCursor: string | null,
    unavailablePageKeys: readonly string[] = []) {
    this.source(sourceKey); integer(expectedRevision);
    if (!Array.isArray(members) || members.length > MAX_BATCH || new Set(members.map(m => m.pageKey)).size !== members.length) fail();
    for (const m of members) { key(m.pageKey); digest(m.fingerprint); integer(m.lastEditedAt, 0, 8_640_000_000_000_000); }
    if (!Array.isArray(unavailablePageKeys) || members.length + unavailablePageKeys.length > MAX_BATCH ||
      new Set(unavailablePageKeys).size !== unavailablePageKeys.length || unavailablePageKeys.some(id => members.some(m => m.pageKey === id))) fail();
    unavailablePageKeys.forEach(key);
    if (nextCursor !== null) { text(nextCursor); if (!nextCursor.length || nextCursor.length > 2048) fail(); }
    return this.transaction(() => {
      const state = this.discoveryFence(sourceKey, expectedRevision, "query"), scan = state.scan!;
      if (scan.pages >= 200) fail("DISCOVERY_LIMIT_EXCEEDED");
      if (nextCursor !== null) {
        const fingerprint = hash(nextCursor);
        if (this.db.prepare("SELECT 1 FROM discovery_cursors WHERE source=? AND cursor_hash=?").get(sourceKey, fingerprint)) fail("DISCOVERY_CURSOR_LOOP");
        this.db.prepare("INSERT INTO discovery_cursors VALUES(?,?)").run(sourceKey, fingerprint);
      }
      const events: ChangeHint[] = [];
      for (const member of members) {
        const old = this.db.prepare("SELECT * FROM directory WHERE source=? AND page=?").get(sourceKey, member.pageKey) as Row | undefined;
        // A delayed query must not replace newer metadata; membership still records presence.
        const newer = !old || member.lastEditedAt >= Number(old.edited_at);
        const changed = !old || (newer && old.fingerprint !== member.fingerprint) || old.missing === 1;
        if (changed) events.push({ eventId: hash(["directory", scan.id, sourceKey, member.pageKey, member.fingerprint]),
          sourceKey, pageKey: member.pageKey, reason: !old ? "created" : old.missing === 1 ? "reconcile" : "content", observedAt: scan.startedAt });
        this.db.prepare(`INSERT INTO directory VALUES(?,?,?,?,?,0) ON CONFLICT(source,page) DO UPDATE SET
          fingerprint=CASE WHEN excluded.edited_at>=directory.edited_at THEN excluded.fingerprint ELSE directory.fingerprint END,
          edited_at=max(directory.edited_at,excluded.edited_at),
          seen_scan=CASE WHEN ? THEN excluded.seen_scan ELSE directory.seen_scan END,missing=0`)
          .run(sourceKey, member.pageKey, member.fingerprint, member.lastEditedAt, scan.mode === "membership" ? scan.id : null, scan.mode === "membership" ? 1 : 0);
      }
      for (const pageKey of unavailablePageKeys) {
        const old = this.db.prepare("SELECT missing FROM directory WHERE source=? AND page=?").get(sourceKey, pageKey);
        if (!old || old.missing !== 1) events.push({ eventId: hash(["unavailable", scan.id, sourceKey, pageKey]),
          sourceKey, pageKey, reason: "reconcile", observedAt: scan.startedAt });
        this.db.prepare(`INSERT INTO directory VALUES(?,?,?,0,?,1) ON CONFLICT(source,page) DO UPDATE SET missing=1,
          seen_scan=CASE WHEN ? THEN excluded.seen_scan ELSE directory.seen_scan END`)
          .run(sourceKey, pageKey, hash(["unavailable", pageKey]), scan.mode === "membership" ? scan.id : null, scan.mode === "membership" ? 1 : 0);
      }
      if (Number(this.db.prepare("SELECT count(*) AS n FROM directory WHERE source=?").get(sourceKey)!.n) > 20_000) fail("DISCOVERY_LIMIT_EXCEEDED");
      // The source revision and directory metadata fence replay atomically.
      // These internal hints need no permanent external-event deduplication row.
      const inserted = this.ingest(events, this.now(), false);
      if (nextCursor === null && scan.mode === "changes") this.finishDiscovery(sourceKey, scan.startedAt, false);
      else this.db.prepare("UPDATE discovery SET revision=revision+1,cursor=?,phase=?,pages=pages+1 WHERE source=?")
        .run(nextCursor, nextCursor === null ? "missing" : "query", sourceKey);
      return { inserted, state: this.discoveryState(sourceKey) };
    });
  }
  /** Absence is a verification hint, never evidence authorizing a withdrawal. */
  reconcileDirectoryAbsences(sourceKey: string, expectedRevision: number, limit = 100) {
    this.source(sourceKey); integer(expectedRevision); integer(limit, 1, MAX_BATCH);
    return this.transaction(() => {
      const state = this.discoveryFence(sourceKey, expectedRevision, "missing"), scan = state.scan!;
      const rows = this.db.prepare(`SELECT page,fingerprint FROM directory WHERE source=? AND page>? AND missing=0
        AND (seen_scan IS NULL OR seen_scan<>?) ORDER BY page LIMIT ?`)
        .all(sourceKey, scan.afterKey ?? "", scan.id, limit + 1) as Row[];
      const batch = rows.slice(0, limit);
      const inserted = this.ingest(batch.map(row => ({ eventId: hash(["absent", scan.id, sourceKey, row.page]),
        sourceKey, pageKey: String(row.page), reason: "reconcile", observedAt: scan.startedAt })), this.now(), false);
      for (const row of batch) this.db.prepare("UPDATE directory SET missing=1 WHERE source=? AND page=?").run(sourceKey, row.page);
      if (rows.length <= limit) this.finishDiscovery(sourceKey, scan.startedAt, true);
      else this.db.prepare("UPDATE discovery SET revision=revision+1,after_key=? WHERE source=?").run(batch.at(-1)!.page, sourceKey);
      return { inserted, state: this.discoveryState(sourceKey) };
    });
  }
  private finishDiscovery(sourceKey: string, startedAt: number, membership: boolean) {
    this.db.prepare(`UPDATE discovery SET revision=revision+1,watermark=?,reconciled_at=CASE WHEN ? THEN ? ELSE reconciled_at END,
      scan_id=NULL,mode=NULL,phase=NULL,started_at=NULL,since=NULL,cursor=NULL,after_key=NULL,pages=0 WHERE source=?`)
      .run(startedAt, membership ? 1 : 0, startedAt, sourceKey);
    this.db.prepare("DELETE FROM discovery_cursors WHERE source=?").run(sourceKey);
  }
  /** Explicit recovery from an invalid remote cursor; preserve hints and the last completed watermark. */
  restartDiscovery(sourceKey: string, expectedRevision: number) {
    this.source(sourceKey); integer(expectedRevision);
    return this.transaction(() => {
      const state = this.discoveryFence(sourceKey, expectedRevision);
      if (!state.scan) fail("DISCOVERY_SCAN_INVALID");
      this.db.prepare(`UPDATE discovery SET revision=revision+1,scan_id=NULL,mode=NULL,phase=NULL,started_at=NULL,
        since=NULL,cursor=NULL,after_key=NULL,pages=0 WHERE source=?`).run(sourceKey);
      this.db.prepare("DELETE FROM discovery_cursors WHERE source=?").run(sourceKey);
      return this.discoveryState(sourceKey);
    });
  }
  directoryPage(sourceKey: string, afterKey: string | null = null, limit = 100) {
    this.source(sourceKey); if (afterKey !== null) key(afterKey); integer(limit, 1, MAX_BATCH);
    return (this.db.prepare("SELECT * FROM directory WHERE source=? AND page>? ORDER BY page LIMIT ?")
      .all(sourceKey, afterKey ?? "", limit) as Row[]).map(row => ({ pageKey: String(row.page), fingerprint: String(row.fingerprint),
        lastEditedAt: Number(row.edited_at), missing: row.missing === 1 }));
  }
  private ticket(row: Row): QueueTicket {
    return { operationId: String(row.id), sourceKey: String(row.source), pageKey: String(row.page), generation: Number(row.generation), reasons: JSON.parse(String(row.reasons)) };
  }
  private active(ticket: QueueTicket, state: "preparing" | "awaiting_verification"): Row {
    key(ticket.operationId); this.source(ticket.sourceKey); key(ticket.pageKey); integer(ticket.generation, 1);
    const row = this.db.prepare(`SELECT a.* FROM attempts a JOIN jobs j ON j.active_attempt=a.id
      AND j.source=a.source AND j.page=a.page WHERE a.id=?`).get(ticket.operationId) as Row | undefined;
    if (!row || row.source !== ticket.sourceKey || row.page !== ticket.pageKey || row.generation !== ticket.generation || row.state !== state) fail("QUEUE_STALE_TICKET");
    if (state === "preparing" && Number(row.expires_at) <= this.now()) fail("QUEUE_STALE_TICKET");
    return row;
  }
  claim(limit = 20, leaseMs = 120_000, options: { requireRetirement?: boolean; target?: { sourceKey: string; pageKey: string } } = {}): QueueTicket[] {
    integer(limit, 1, 50); integer(leaseMs, 1_000, 900_000);
    if (options.requireRetirement !== undefined && typeof options.requireRetirement !== "boolean") fail();
    if (options.target) { this.source(options.target.sourceKey); key(options.target.pageKey); }
    const now = this.now();
    return this.transaction(() => {
      this.expirePreparations(now);
      if (options.requireRetirement && this.db.prepare("SELECT 1 FROM retirements WHERE acknowledged=0 LIMIT 1").get()) return [];
      const jobs = this.db.prepare(`SELECT * FROM jobs WHERE state IN ('pending','retry') AND available_at<=?
        ${this.frozen.size ? "AND NOT EXISTS(SELECT 1 FROM temp.frozen_pages f WHERE f.page=jobs.page)" : ""}
        ${options.target ? "AND source=? AND page=?" : ""}
        ORDER BY available_at,source,page LIMIT ?`).all(now, ...(options.target ? [options.target.sourceKey, options.target.pageKey] : []), limit) as Row[];
      return jobs.map(job => {
        const id = randomUUID();
        this.db.prepare(`INSERT INTO attempts(id,source,page,generation,reasons,expires_at,state)
          VALUES(?,?,?,?,?,?,'preparing')`).run(id, job.source, job.page, job.generation, job.reasons, now + leaseMs);
        this.db.prepare("UPDATE jobs SET state='leased',active_attempt=?,error_code=NULL WHERE source=? AND page=?").run(id, job.source, job.page);
        return this.ticket({ ...job, id });
      });
    });
  }
  /** Close expired preparation without claiming any pending or retry work. */
  recoverExpiredPreparations() {
    return this.transaction(() => this.expirePreparations(this.now()));
  }
  private expirePreparations(now: number) {
    // Only preparation is safe to retry. A submission marker survives expiry.
    const expired = this.db.prepare(`SELECT a.id FROM attempts a JOIN jobs j ON j.active_attempt=a.id
      WHERE a.state='preparing' AND a.expires_at<=? LIMIT 200`).all(now) as Row[];
    for (const a of expired) {
      this.db.prepare("UPDATE attempts SET state='abandoned' WHERE id=?").run(a.id);
      this.recordRetirement(String(a.id));
      this.db.prepare("UPDATE jobs SET state='pending',active_attempt=NULL,available_at=? WHERE active_attempt=?").run(now, a.id);
    }
    return expired.length;
  }
  private recordRetirement(operationId: string) {
    this.db.prepare("INSERT INTO retirements(id) VALUES(?) ON CONFLICT DO NOTHING").run(operationId);
  }
  /** A terminal attempt cannot pass markSubmitting again, even after a restart. */
  attemptClosure(operationId: string): AttemptClosure | null {
    key(operationId);
    const row = this.db.prepare(`SELECT a.*,j.active_attempt FROM attempts a JOIN jobs j ON j.source=a.source AND j.page=a.page WHERE a.id=?`)
      .get(operationId) as Row | undefined;
    if (!row || row.active_attempt === operationId) return null;
    if (row.state === "failed" && row.payload_digest !== null) return {
      ticket: this.ticket(row), disposition: "definitively_rejected", payloadDigest: String(row.payload_digest),
    };
    if (row.payload_digest === null && ["failed", "abandoned", "verified"].includes(String(row.state))) return {
      ticket: this.ticket(row), disposition: "never_submitted", payloadDigest: null,
    };
    return null;
  }
  pendingRetirements(limit = 20): AttemptClosure[] {
    integer(limit, 1, 50);
    return (this.db.prepare(`SELECT a.id FROM retirements r JOIN attempts a ON a.id=r.id WHERE r.acknowledged=0
      ORDER BY a.expires_at,a.id LIMIT ?`).all(limit) as Row[]).map(row => {
      const proof = this.attemptClosure(String(row.id)); if (!proof) fail("QUEUE_PROOF_MISMATCH"); return proof;
    });
  }
  acknowledgeRetirement(proof: AttemptClosure) {
    key(proof.ticket.operationId);
    this.transaction(() => {
      const current = this.attemptClosure(proof.ticket.operationId);
      if (!current || current.disposition !== proof.disposition || current.payloadDigest !== proof.payloadDigest ||
        current.ticket.sourceKey !== proof.ticket.sourceKey || current.ticket.pageKey !== proof.ticket.pageKey ||
        current.ticket.generation !== proof.ticket.generation || !this.db.prepare("SELECT id FROM retirements WHERE id=?").get(proof.ticket.operationId)) fail("QUEUE_PROOF_MISMATCH");
      this.db.prepare("UPDATE retirements SET acknowledged=1 WHERE id=?").run(proof.ticket.operationId);
    });
  }
  /** A domain may use this immediately before a synchronous staged-state write.
   * The runtime still owns the canonical lock and must honor cancellation. */
  assertPreparing(ticket: QueueTicket) { this.active(ticket, "preparing"); }
  /** Persist BEFORE issuing any cloud submission, even if its reply may be lost. */
  markSubmitting(ticket: QueueTicket, input: { payloadDigest: string; expectedRevision: string }) {
    digest(input.payloadDigest); key(input.expectedRevision);
    this.transaction(() => {
      this.active(ticket, "preparing");
      this.db.prepare("UPDATE attempts SET state='awaiting_verification',payload_digest=?,expected_revision=? WHERE id=?")
        .run(input.payloadDigest, input.expectedRevision, ticket.operationId);
      this.db.prepare("UPDATE jobs SET state='awaiting_verification' WHERE active_attempt=?").run(ticket.operationId);
    });
  }
  pendingVerifications(limit = 20): PendingVerification[] {
    integer(limit, 1, 50);
    return (this.db.prepare(`SELECT a.* FROM attempts a JOIN jobs j ON j.active_attempt=a.id
      WHERE a.state='awaiting_verification' ORDER BY a.expires_at,a.id LIMIT ?`).all(limit) as Row[])
      .map(a => ({ ticket: this.ticket(a), payloadDigest: String(a.payload_digest), expectedRevision: String(a.expected_revision) }));
  }
  private finish(ticket: QueueTicket, publicationRevision: string | null) {
    this.db.prepare("UPDATE attempts SET state='verified',publication_revision=? WHERE id=?").run(publicationRevision, ticket.operationId);
    this.db.prepare(`UPDATE jobs SET completed_generation=?,active_attempt=NULL,error_code=NULL,
      state=CASE WHEN generation>? THEN 'pending' ELSE 'done' END,
      reasons=CASE WHEN generation>? THEN reasons ELSE '[]' END,available_at=? WHERE active_attempt=?`)
      .run(ticket.generation, ticket.generation, ticket.generation, this.now(), ticket.operationId);
    if (publicationRevision === null) this.recordRetirement(ticket.operationId);
  }
  /** The adapter must have compared freshly prepared data with its published version. */
  completeUnchanged(ticket: QueueTicket) {
    this.transaction(() => { this.active(ticket, "preparing"); this.finish(ticket, null); });
  }
  confirmCommit(ticket: QueueTicket, proof: VerifiedCommit) {
    digest(proof.payloadDigest); key(proof.publicationRevision);
    this.transaction(() => {
      const a = this.active(ticket, "awaiting_verification");
      if (proof.readerVerified !== true || proof.operationId !== ticket.operationId || proof.payloadDigest !== a.payload_digest) fail("QUEUE_PROOF_MISMATCH");
      this.finish(ticket, proof.publicationRevision);
    });
  }
  retryPreparation(ticket: QueueTicket, errorCode: string, delayMs: number) {
    code(errorCode); integer(delayMs, 0, 86_400_000);
    return this.transaction(() => { this.active(ticket, "preparing"); return this.retry(ticket, errorCode, delayMs); });
  }
  /** A system failure or cancellation closes unsent work without charging the page. */
  deferPreparation(ticket: QueueTicket, errorCode: string, delayMs: number) {
    code(errorCode); integer(delayMs, 0, 86_400_000);
    this.transaction(() => {
      this.active(ticket, "preparing");
      this.db.prepare("UPDATE attempts SET state='abandoned' WHERE id=?").run(ticket.operationId);
      this.db.prepare("UPDATE jobs SET state='retry',active_attempt=NULL,error_code=?,available_at=? WHERE active_attempt=?")
        .run(errorCode, this.now() + delayMs, ticket.operationId);
      this.recordRetirement(ticket.operationId);
    });
  }
  /** Requires definitive server rejection; a timeout or missing lookup is NOT proof. */
  confirmRejected(ticket: QueueTicket, proof: { operationId: string; payloadDigest: string; definitivelyRejected: true; code: string }, delayMs: number,
    disposition: "retry" | "needs_review" = "retry") {
    code(proof.code); digest(proof.payloadDigest); integer(delayMs, 0, 86_400_000);
    if (disposition !== "retry" && disposition !== "needs_review") fail();
    this.transaction(() => {
      const a = this.active(ticket, "awaiting_verification");
      if (proof.definitivelyRejected !== true || proof.operationId !== ticket.operationId || proof.payloadDigest !== a.payload_digest) fail("QUEUE_PROOF_MISMATCH");
      this.retry(ticket, proof.code, delayMs);
      if (disposition === "needs_review") this.db.prepare("UPDATE jobs SET state='needs_review' WHERE source=? AND page=?")
        .run(ticket.sourceKey, ticket.pageKey);
    });
  }
  private retry(ticket: QueueTicket, errorCode: string, delayMs: number) {
    this.db.prepare("UPDATE attempts SET state='failed' WHERE id=?").run(ticket.operationId);
    const failures = Number(this.db.prepare("SELECT count(*) AS n FROM attempts WHERE source=? AND page=? AND generation=? AND state='failed'")
      .get(ticket.sourceKey, ticket.pageKey, ticket.generation)!.n);
    const state = failures >= 5 ? "needs_review" : "retry";
    const delay = Math.min(86_400_000, delayMs * 2 ** Math.min(20, Math.max(0, failures - 1)));
    this.db.prepare("UPDATE jobs SET state=?,active_attempt=NULL,error_code=?,available_at=? WHERE active_attempt=?")
      .run(state, errorCode, this.now() + delay, ticket.operationId);
    this.recordRetirement(ticket.operationId);
    return state;
  }
  requireReview(ticket: QueueTicket, errorCode: string) {
    code(errorCode);
    this.transaction(() => {
      this.active(ticket, "preparing");
      this.db.prepare("UPDATE attempts SET state='failed' WHERE id=?").run(ticket.operationId);
      this.db.prepare("UPDATE jobs SET state='needs_review',active_attempt=NULL,error_code=? WHERE active_attempt=?").run(errorCode, ticket.operationId);
      this.recordRetirement(ticket.operationId);
    });
  }
  /** Operator action only; fresh preparation still checks publication policy. */
  resume(sourceKey: string, pageKey: string) {
    this.source(sourceKey); key(pageKey);
    return this.transaction(() => Number(this.db.prepare(`UPDATE jobs SET state='pending',generation=generation+1,error_code=NULL,available_at=?
      WHERE source=? AND page=? AND state='needs_review'`).run(this.now(), sourceKey, pageKey).changes) === 1);
  }
  /** Private operator output; new hints remain visible without silently releasing a hold. */
  listReview(limit = 100, after?: { sourceKey: string; pageKey: string }) {
    integer(limit, 1, 1000);
    if (after) { this.source(after.sourceKey); key(after.pageKey); }
    return this.db.prepare(`SELECT j.source,j.page,j.generation,j.error_code,
      coalesce((SELECT max(a.generation) FROM attempts a WHERE a.source=j.source AND a.page=j.page),0) AS reviewed_generation
      FROM jobs j WHERE j.state='needs_review' AND (j.source,j.page)>(?,?) ORDER BY j.source,j.page LIMIT ?`)
      .all(after?.sourceKey ?? "", after?.pageKey ?? "", limit).map(row => ({ sourceKey: String(row.source), pageKey: String(row.page),
        generation: Number(row.generation), errorCode: row.error_code === null ? null : String(row.error_code),
        newChanges: Number(row.generation) > Number(row.reviewed_generation) }));
  }
  /** Bounded local history GC. Keep unresolved sends, the completed generation,
   * latest committed proof and unacknowledged domain retirements. External event
   * deduplication has no replay watermark, so those identifiers are never erased. */
  compactHistory(limit = 200) {
    integer(limit, 1, 1000);
    return this.transaction(() => {
      const rows = this.db.prepare(`SELECT a.id FROM attempts a
        JOIN jobs j ON j.source=a.source AND j.page=a.page
        LEFT JOIN retirements r ON r.id=a.id
        WHERE a.generation<j.completed_generation AND a.id IS NOT j.active_attempt
          AND a.state IN ('failed','abandoned','verified')
          AND (r.acknowledged=1 OR (r.id IS NULL AND a.state='verified' AND a.publication_revision IS NOT NULL))
          AND (a.publication_revision IS NULL OR EXISTS(SELECT 1 FROM attempts newer
            WHERE newer.source=a.source AND newer.page=a.page AND newer.state='verified'
              AND newer.publication_revision IS NOT NULL AND newer.generation>a.generation))
        ORDER BY a.generation,a.id LIMIT ?`).all(limit) as Row[];
      let retirements = 0;
      for (const row of rows) {
        retirements += Number(this.db.prepare("DELETE FROM retirements WHERE id=? AND acknowledged=1").run(row.id).changes);
        this.db.prepare("DELETE FROM attempts WHERE id=?").run(row.id);
      }
      return { attempts: rows.length, retirements };
    });
  }
  /** Counts only. Safe for a separate atomic Dashboard summary writer. */
  status() {
    const counts = { pending: 0, leased: 0, retry: 0, awaiting_verification: 0, needs_review: 0, done: 0 };
    for (const row of this.db.prepare(`SELECT state,count(*) AS n FROM jobs ${this.frozen.size ? "WHERE state NOT IN ('pending','retry','needs_review') OR NOT EXISTS(SELECT 1 FROM temp.frozen_pages f WHERE f.page=jobs.page)" : ""} GROUP BY state`).all()) counts[row.state as keyof typeof counts] = Number(row.n);
    return { ...counts, events: Number(this.db.prepare("SELECT count(*) AS n FROM events").get()!.n),
      checkpoints: Number(this.db.prepare("SELECT count(*) AS n FROM checkpoints").get()!.n),
      retirement_pending: Number(this.db.prepare("SELECT count(*) AS n FROM retirements WHERE acknowledged=0").get()!.n) };
  }
}

async function privateFile(path: string) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o077) ||
      (process.getuid && info.uid !== process.getuid())) fail("QUEUE_PRIVATE_STATE_INVALID");
    return true;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
export async function openIncrementalQueue(directory: string, scope: QueueScope, clock: () => number = Date.now) {
  digest(scope.digest);
  if (!Array.isArray(scope.sourceKeys) || !scope.sourceKeys.length || scope.sourceKeys.length > 50 || new Set(scope.sourceKeys).size !== scope.sourceKeys.length) fail();
  scope.sourceKeys.forEach(key);
  await privateDirectory(directory);
  const path = join(directory, "incremental.sqlite");
  if (!await privateFile(path)) {
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.close();
  }
  for (const suffix of ["-journal", "-wal", "-shm"]) await privateFile(path + suffix);
  const Constructor = (sqlite as unknown as { Database?: typeof sqlite.DatabaseSync }).Database ?? sqlite.DatabaseSync;
  const db = new Constructor(path, { timeout: 1000, enableForeignKeyConstraints: true });
  try { return new IncrementalQueue(db, scope, clock); }
  catch (error) { db.close(); safeError(error); }
}
