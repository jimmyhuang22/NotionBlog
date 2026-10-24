import { rewriteStudyLinks } from "../../src/server/notion/rewrite-study-links.ts";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import * as sqlite from "node:sqlite";
import type { StoredMedia } from "../../contracts/sync.ts";
import { WEBSITE_SCHEMA_DIGEST, type WebsiteRecord } from "../../contracts/website-sync.ts";
import { preparePublicationDelta, type PreparedPublicationDelta, type PublicationState } from "../../src/server/database/incremental-publication.ts";
import { canonicalJson, configDigest, validateMedia, validateWebsiteRecord } from "../../src/server/database/website-validation.ts";
import { normalizeId } from "../../src/server/notion/config.ts";
import type { StudyDelta } from "../../src/server/notion/study-incremental.ts";
import { privateDirectory } from "../notion-sync/state.ts";
import type { KnownPageCatalog } from "./discovery.ts";
import type { AttemptClosure } from "./queue.ts";
import type { PublishedPage } from "./source.ts";

const APP = 0x4e424343, MAX_RECORDS = 20000, MAX_BYTES = 128 * 1024 * 1024;
const uuid = (v: string) => typeof v === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const hash = (v: string) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const revision = (v: string) => typeof v === "string" && v.split(":").length === 2 && uuid(v.split(":")[0]) && /^[0-9]+$/.test(v.split(":")[1]);
export class ContentCacheError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = "ContentCacheError"; this.code = code; }
}
function fail(code = "CONTENT_CACHE_INVALID"): never { throw new ContentCacheError(code); }
function safe(error: unknown): never {
  if (error instanceof ContentCacheError) throw error;
  fail((error as { errcode?: number } | null)?.errcode === 5 ? "CONTENT_CACHE_BUSY" : "CONTENT_CACHE_UNAVAILABLE");
}
function validState(s: PublicationState, digest: string) {
  if (!s || !revision(s.publicationRevision) || s.configDigest !== digest || s.schemaDigest !== WEBSITE_SCHEMA_DIGEST ||
    typeof s.policyEpoch !== "string" || !/^[0-9]+$/.test(s.policyEpoch)) fail("CONTENT_CACHE_SCOPE_MISMATCH");
}
type Row = Record<string, string | number | null>;
export interface ContentCacheBaseline { state: PublicationState; records: WebsiteRecord[]; media: StoredMedia[] }
/** Supplied by the full-publication independent reader verifier, not by a
 * local export, writer acknowledgement or an old single-course snapshot. */
export interface ContentCacheBaselineProof extends PublicationState {
  readerVerified: true; complete: true; records: number; media: number; contentDigest: string;
}
export interface ContentCacheCommitProof extends PublicationState {
  operationId: string; payloadDigest: string; readerVerified: true;
}
export function contentCacheBaselineDigest(baseline: Pick<ContentCacheBaseline, "records" | "media">): string {
  return configDigest({ records: [...baseline.records].sort((a, b) => a.detail.item.id.localeCompare(b.detail.item.id)),
    media: [...baseline.media].sort((a, b) => a.assetId.localeCompare(b.assetId)) });
}
type Ref = { owner: string; width: number | null; height: number | null };
function references(record: WebsiteRecord): Map<string, Ref> {
  const refs = new Map<string, Ref>();
  const visit = (v: unknown) => {
    if (Array.isArray(v)) { v.forEach(visit); return; }
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    if (typeof o.src === "string" && o.src.startsWith("/media/v2/")) {
      const id = o.id as string, ref = { owner: record.detail.item.id, width: o.width as number | null, height: o.height as number | null };
      if (refs.has(id) && canonicalJson(refs.get(id)) !== canonicalJson(ref)) fail("CONTENT_CACHE_MEDIA_MISMATCH");
      refs.set(id, ref);
    }
    Object.values(o).forEach(visit);
  };
  visit(record.detail); return refs;
}
function links(record: WebsiteRecord): Set<string> {
  const found = new Set<string>();
  const visit = (v: unknown) => {
    if (Array.isArray(v)) { v.forEach(visit); return; }
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    if (typeof o.href === "string" && o.href.startsWith("/study/")) found.add(o.href);
    Object.values(o).forEach(visit);
  };
  visit(record.detail); return found;
}
function matches(media: StoredMedia | undefined, ref: Ref | undefined) {
  return !!media && !!ref && media.ownerPageId === ref.owner && media.width === ref.width && media.height === ref.height;
}
const SCHEMA = `
 CREATE TABLE scope(digest TEXT NOT NULL,sources TEXT NOT NULL) STRICT;
 CREATE TABLE state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),value TEXT NOT NULL,digest TEXT NOT NULL) STRICT;
 CREATE TABLE records(id TEXT PRIMARY KEY,source TEXT NOT NULL,kind TEXT NOT NULL,parent TEXT,course TEXT,ordinal INTEGER NOT NULL,value TEXT NOT NULL,digest TEXT NOT NULL) STRICT;
 CREATE INDEX records_source ON records(source,id);
 CREATE INDEX records_parent ON records(parent);
 CREATE TABLE media(id TEXT PRIMARY KEY,owner TEXT NOT NULL,value TEXT NOT NULL,digest TEXT NOT NULL) STRICT;
 CREATE INDEX media_owner ON media(owner,id);
 CREATE TABLE image_refs(id TEXT NOT NULL,owner TEXT NOT NULL,PRIMARY KEY(id,owner)) STRICT;
 CREATE TABLE links(href TEXT NOT NULL,owner TEXT NOT NULL,PRIMARY KEY(href,owner)) STRICT;
 CREATE TABLE operations(id TEXT PRIMARY KEY,base TEXT NOT NULL,payload_digest TEXT NOT NULL,request_digest TEXT NOT NULL,
   request TEXT,status TEXT NOT NULL CHECK(status IN ('prepared','applied','retired')),committed_revision TEXT) STRICT;
`;

/** Complete private raw-record cache. It never reads Notion, downloads files,
 * publishes SQL, acknowledges a queue or makes browser authorization decisions. */
export class ContentCacheStore {
  readonly sourceDigest: string;
  private readonly sources: Set<string>;
  private readonly db: sqlite.DatabaseSync;
  constructor(db: sqlite.DatabaseSync, digest: string, sourceKeys: readonly string[]) {
    if (!hash(digest) || !Array.isArray(sourceKeys) || !sourceKeys.length || sourceKeys.length > 50 ||
      new Set(sourceKeys).size !== sourceKeys.length || sourceKeys.some(s => typeof s !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(s))) fail();
    this.sourceDigest = digest; this.sources = new Set(sourceKeys); this.db = db;
    const sources = canonicalJson([...sourceKeys].sort());
    db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; PRAGMA max_page_count=65536;");
    this.transaction(() => {
      const app = Number(db.prepare("PRAGMA application_id").get()!.application_id), version = Number(db.prepare("PRAGMA user_version").get()!.user_version);
      if (app === 0 && version === 0) {
        if (Number(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get()!.n)) fail("CONTENT_CACHE_SCHEMA_MISMATCH");
        db.exec(SCHEMA); db.prepare("INSERT INTO scope VALUES(?,?)").run(digest, sources);
        db.exec(`PRAGMA application_id=${APP}; PRAGMA user_version=1;`);
      } else if (app !== APP || version !== 1) fail("CONTENT_CACHE_SCHEMA_MISMATCH");
      const scope = db.prepare("SELECT * FROM scope").get();
      if (scope?.digest !== digest || scope.sources !== sources) fail("CONTENT_CACHE_SCOPE_MISMATCH");
    });
  }
  close() { this.db.close(); }
  private read<T>(fn: () => T): T { try { return fn(); } catch (e) { safe(e); } }
  private transaction<T>(fn: () => T): T {
    try { this.db.exec("BEGIN IMMEDIATE"); } catch (e) { safe(e); }
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (e) { try { this.db.exec("ROLLBACK"); } catch { /* Preserve the transaction failure. */ } safe(e); }
  }
  private record(row: Row): WebsiteRecord {
    const value = JSON.parse(String(row.value)) as WebsiteRecord;
    validateWebsiteRecord(value);
    if (!value.detail.document || value.detail.item.id !== row.id || value.detail.item.kind !== row.kind ||
      value.evidence.sourceKey !== row.source || value.evidence.ordinal !== row.ordinal ||
      value.evidence.parentId !== row.parent || value.evidence.courseId !== row.course ||
      !this.sources.has(value.evidence.sourceKey) || configDigest(value) !== row.digest) fail("CONTENT_CACHE_CORRUPT");
    return value;
  }
  private asset(row: Row): StoredMedia {
    const value = JSON.parse(String(row.value)) as StoredMedia; validateMedia(value);
    if (value.assetId !== row.id || value.ownerPageId !== row.owner || configDigest(value) !== row.digest) fail("CONTENT_CACHE_CORRUPT");
    return value;
  }
  private current(): PublicationState {
    const row = this.db.prepare("SELECT value,digest FROM state WHERE singleton=1").get();
    if (!row) fail("CONTENT_CACHE_BASELINE_MISSING");
    const s = JSON.parse(String(row.value)) as PublicationState; validState(s, this.sourceDigest);
    if (configDigest(s) !== row.digest) fail("CONTENT_CACHE_CORRUPT"); return s;
  }
  assertState(expected: PublicationState): void {
    this.read(() => { validState(expected, this.sourceDigest); if (canonicalJson(expected) !== canonicalJson(this.current())) fail("CONTENT_CACHE_VERSION_CHANGED"); });
  }
  private putRecord(record: WebsiteRecord) {
    const { item } = record.detail, e = record.evidence;
    this.db.prepare("INSERT OR REPLACE INTO records VALUES(?,?,?,?,?,?,?,?)").run(item.id, e.sourceKey, item.kind, e.parentId, e.courseId, e.ordinal, JSON.stringify(record), configDigest(record));
    this.db.prepare("DELETE FROM links WHERE owner=?").run(item.id);
    this.db.prepare("DELETE FROM image_refs WHERE owner=?").run(item.id);
    const statement = this.db.prepare("INSERT INTO links VALUES(?,?)");
    for (const href of links(record)) statement.run(href, item.id);
    const images = this.db.prepare("INSERT INTO image_refs VALUES(?,?)");
    for (const id of references(record).keys()) images.run(id, item.id);
  }
  private putMedia(media: StoredMedia) {
    this.db.prepare("INSERT OR REPLACE INTO media VALUES(?,?,?,?)").run(media.assetId, media.ownerPageId, JSON.stringify(media), configDigest(media));
  }
  initialize(baseline: ContentCacheBaseline, proof: ContentCacheBaselineProof): void {
    this.read(() => {
      validState(baseline?.state, this.sourceDigest);
      if (!Array.isArray(baseline.records) || !Array.isArray(baseline.media) || baseline.records.length > MAX_RECORDS || baseline.media.length > MAX_RECORDS ||
        Buffer.byteLength(JSON.stringify(baseline)) > MAX_BYTES) fail("CONTENT_CACHE_BUDGET_REACHED");
      const digest = contentCacheBaselineDigest(baseline);
      if (proof?.readerVerified !== true || proof.complete !== true || proof.records !== baseline.records.length || proof.media !== baseline.media.length ||
        proof.contentDigest !== digest || canonicalJson(baseline.state) !== canonicalJson({ publicationRevision: proof.publicationRevision,
          configDigest: proof.configDigest, schemaDigest: proof.schemaDigest, policyEpoch: proof.policyEpoch })) fail("CONTENT_CACHE_READER_UNVERIFIED");
      const records = new Map<string, WebsiteRecord>(), media = new Map<string, StoredMedia>();
      for (const r of baseline.records) {
        validateWebsiteRecord(r);
        if (!r.detail.document || r.evidence.ordinal > 2147483647 || records.has(r.detail.item.id) || !this.sources.has(r.evidence.sourceKey)) fail("CONTENT_CACHE_BASELINE_INVALID");
        records.set(r.detail.item.id, r);
      }
      for (const m of baseline.media) {
        validateMedia(m);
        if (media.has(m.assetId) || !records.has(m.ownerPageId)) fail("CONTENT_CACHE_MEDIA_MISMATCH"); media.set(m.assetId, m);
      }
      for (const r of records.values()) for (const [id, ref] of references(r)) if (!matches(media.get(id), ref)) fail("CONTENT_CACHE_MEDIA_MISMATCH");
      if ([...records.values()].reduce((n, r) => n + links(r).size, 0) > 200000) fail("CONTENT_CACHE_BUDGET_REACHED");
      this.transaction(() => {
        if (this.db.prepare("SELECT singleton FROM state").get()) fail("CONTENT_CACHE_ALREADY_INITIALIZED");
        baseline.records.forEach(r => this.putRecord(r)); baseline.media.forEach(m => this.putMedia(m));
        this.db.prepare("INSERT INTO state VALUES(1,?,?)").run(JSON.stringify(baseline.state), configDigest(baseline.state));
      });
    });
  }
  readPublished(ticket: { sourceKey: string; pageKey: string }, state: PublicationState): PublishedPage | null {
    return this.read(() => {
      this.assertState(state); if (!this.sources.has(ticket.sourceKey)) fail("CONTENT_CACHE_SOURCE_MISMATCH");
      const row = this.db.prepare("SELECT * FROM records WHERE id=?").get(ticket.pageKey) as Row | undefined;
      if (!row) return null;
      const record = this.record(row); if (record.evidence.sourceKey !== ticket.sourceKey) fail("CONTENT_CACHE_SOURCE_MISMATCH");
      const media = (this.db.prepare("SELECT * FROM media WHERE owner=? ORDER BY id").all(ticket.pageKey) as Row[]).map(r => this.asset(r));
      return { record, media, publicationRevision: state.publicationRevision, configDigest: state.configDigest, schemaDigest: state.schemaDigest, readerVerified: true };
    });
  }
  /** Unknown pages require a source-directory position supplied by the runtime. */
  placement(ticket: { sourceKey: string; pageKey: string }, state: PublicationState, newOrdinal?: number): { ordinal: number } {
    const previous = this.readPublished(ticket, state);
    if (previous) return { ordinal: previous.record.evidence.ordinal };
    if (!Number.isSafeInteger(newOrdinal) || newOrdinal! < 0 || newOrdinal! > 2147483647) fail("CONTENT_CACHE_NEW_PLACEMENT_REQUIRED");
    return { ordinal: newOrdinal! };
  }
  knownPages(sourceKey: string, state: PublicationState): KnownPageCatalog {
    return this.read(() => {
      this.assertState(state); if (!this.sources.has(sourceKey)) fail("CONTENT_CACHE_SOURCE_MISMATCH");
      const ids = this.db.prepare("SELECT id FROM records WHERE source=? ORDER BY id").all(sourceKey).map(r => normalizeId(String(r.id)));
      return { sourceKey, pageKeys: ids, publicationRevision: state.publicationRevision, configDigest: state.configDigest, readerVerified: true };
    });
  }
  assets(records: WebsiteRecord[], state: PublicationState): { media: StoredMedia[]; verified: true } {
    return this.read(() => {
      this.assertState(state); if (records.length > 100) fail("CONTENT_CACHE_BUDGET_REACHED");
      const found = new Map<string, StoredMedia>();
      for (const record of records) {
        validateWebsiteRecord(record);
        for (const [id, ref] of references(record)) {
          const row = this.db.prepare("SELECT * FROM media WHERE id=?").get(id) as Row | undefined;
          if (!row) fail("CONTENT_CACHE_MEDIA_PENDING"); const media = this.asset(row);
          if (!matches(media, ref)) fail("CONTENT_CACHE_MEDIA_MISMATCH"); found.set(id, media);
          if (found.size > 100) fail("CONTENT_CACHE_BUDGET_REACHED");
        }
      }
      return { media: [...found.values()], verified: true };
    });
  }
  incomingLinks(changes: StudyDelta["hrefChanges"], state: PublicationState): { records: WebsiteRecord[]; publicationRevision: string; configDigest: string; verified: true } {
    return this.read(() => {
      this.assertState(state);
      const route = (href: string) => typeof href === "string" && /^\/study\/[A-Za-z0-9_-]+(?:\/notes\/[A-Za-z0-9_-]+)?$/.test(href);
      if (!Array.isArray(changes) || changes.length > 100 || new Set(changes.map(c => c.previous)).size !== changes.length ||
        changes.some(c => !route(c.previous) || c.current !== null && (!route(c.current.href) || typeof c.current.title !== "string" ||
          c.current.title.length > 200000 || c.current.title.includes("\u0000")))) fail("CONTENT_CACHE_LINK_CHANGES_INVALID");
      const targets = new Map(changes.map(c => [c.previous, c.current])), ids = new Set<string>();
      for (const href of targets.keys()) for (const row of this.db.prepare("SELECT l.owner FROM links l JOIN records r ON r.id=l.owner WHERE l.href=? AND r.kind NOT IN ('course','study-note') LIMIT 101").all(href)) {
        ids.add(String(row.owner)); if (ids.size > 100) fail("CONTENT_CACHE_BUDGET_REACHED");
      }
      const records: WebsiteRecord[] = [];
      for (const id of [...ids].sort()) {
        const before = this.record(this.db.prepare("SELECT * FROM records WHERE id=?").get(id) as Row);
        const next = { ...before, detail: rewriteStudyLinks(before.detail, targets) as WebsiteRecord["detail"] }; validateWebsiteRecord(next);
        if (canonicalJson(before) !== canonicalJson(next)) records.push(next);
      }
      return { records, publicationRevision: state.publicationRevision, configDigest: state.configDigest, verified: true };
    });
  }
  ownsOperation(id: string, digest: string): boolean {
    return this.read(() => {
      if (!uuid(id) || !hash(digest)) fail(); const row = this.db.prepare("SELECT payload_digest,status FROM operations WHERE id=?").get(id);
      if (row && row.payload_digest !== digest) fail("CONTENT_CACHE_OPERATION_CONFLICT"); return !!row && row.status !== "retired";
    });
  }
  stage(id: string, input: PreparedPublicationDelta, state: PublicationState): void {
    this.read(() => {
      if (!uuid(id)) fail(); const delta = preparePublicationDelta(input);
      if (delta.payloadDigest !== input.payloadDigest || delta.configDigest !== this.sourceDigest || delta.expectedRevision !== state.publicationRevision) fail("CONTENT_CACHE_OPERATION_CONFLICT");
      this.transaction(() => {
        this.assertState(state);
        const upserts = new Map(delta.upserts.map(r => [r.detail.item.id, r])), assets = new Map(delta.media.map(m => [m.assetId, m]));
        if (delta.upserts.some(r => !this.sources.has(r.evidence.sourceKey))) fail("CONTENT_CACHE_SOURCE_MISMATCH");
        for (const w of delta.withdrawals) {
          const row = this.db.prepare("SELECT * FROM records WHERE id=?").get(w.id) as Row | undefined;
          if (!row || this.record(row).evidence.sourceKey !== w.sourceKey) fail("CONTENT_CACHE_WITHDRAWAL_UNCONFIRMED");
        }
        for (const r of delta.upserts) for (const [assetId, ref] of references(r)) {
          const row = this.db.prepare("SELECT * FROM media WHERE id=?").get(assetId) as Row | undefined;
          if (!matches(assets.get(assetId) ?? (row && this.asset(row)), ref)) fail("CONTENT_CACHE_MEDIA_PENDING");
        }
        for (const m of delta.media) {
          if (!upserts.has(m.ownerPageId) || !matches(m, references(upserts.get(m.ownerPageId)!).get(m.assetId)!)) fail("CONTENT_CACHE_MEDIA_MISMATCH");
          const row = this.db.prepare("SELECT owner FROM media WHERE id=?").get(m.assetId);
          if (row && row.owner !== m.ownerPageId) fail("CONTENT_CACHE_MEDIA_MISMATCH");
        }
        const request = JSON.stringify(delta), digest = configDigest(delta), old = this.db.prepare("SELECT * FROM operations WHERE id=?").get(id);
        if (old) {
          if (old.status !== "prepared" || old.payload_digest !== delta.payloadDigest || old.request_digest !== digest || old.base !== state.publicationRevision) fail("CONTENT_CACHE_OPERATION_CONFLICT"); return;
        }
        const counts = this.db.prepare("SELECT count(*) AS n,sum(status='prepared') AS pending,coalesce(sum(length(CAST(request AS BLOB))),0) AS bytes FROM operations").get()!;
        if (Number(counts.n) >= 10000 || Number(counts.pending) >= 8 || Number(counts.bytes) + Buffer.byteLength(request) > 64 * 1024 * 1024) fail("CONTENT_CACHE_BUDGET_REACHED");
        this.db.prepare("INSERT INTO operations VALUES(?,?,?,?,?,'prepared',NULL)").run(id, state.publicationRevision, delta.payloadDigest, digest, request);
      });
    });
  }
  install(proof: ContentCacheCommitProof): "installed" | "unchanged" {
    return this.read(() => {
      validState(proof, this.sourceDigest);
      if (proof.readerVerified !== true || !uuid(proof.operationId) || !hash(proof.payloadDigest) || !proof.publicationRevision.startsWith(`${proof.operationId}:`)) fail("CONTENT_CACHE_READER_UNVERIFIED");
      return this.transaction(() => {
        const current = this.current(), row = this.db.prepare("SELECT * FROM operations WHERE id=?").get(proof.operationId) as Row | undefined;
        if (!row || row.status === "retired" || row.payload_digest !== proof.payloadDigest) fail("CONTENT_CACHE_OPERATION_CONFLICT");
        if (proof.policyEpoch !== current.policyEpoch) fail("CONTENT_CACHE_VERSION_CHANGED");
        if (row.status === "applied") {
          if (row.committed_revision !== proof.publicationRevision || current.publicationRevision !== proof.publicationRevision) fail("CONTENT_CACHE_VERSION_CHANGED"); return "unchanged";
        }
        if (row.base !== current.publicationRevision || proof.publicationRevision === row.base) fail("CONTENT_CACHE_VERSION_CHANGED");
        const delta = preparePublicationDelta(JSON.parse(String(row.request)) as PreparedPublicationDelta);
        if (configDigest(delta) !== row.request_digest || delta.payloadDigest !== row.payload_digest) fail("CONTENT_CACHE_CORRUPT");
        const removed = new Set<string>();
        for (const w of delta.withdrawals) for (const r of this.db.prepare(`WITH RECURSIVE removed(id) AS (SELECT id FROM records WHERE id=? UNION SELECT r.id FROM records r JOIN removed d ON r.parent=d.id) SELECT id FROM removed`).all(w.id)) removed.add(String(r.id));
        for (const id of removed) {
          this.db.prepare("DELETE FROM records WHERE id=?").run(id); this.db.prepare("DELETE FROM media WHERE owner=?").run(id); this.db.prepare("DELETE FROM links WHERE owner=?").run(id); this.db.prepare("DELETE FROM image_refs WHERE owner=?").run(id);
        }
        delta.upserts.forEach(r => this.putRecord(r)); delta.media.forEach(m => this.putMedia(m));
        this.db.exec("DELETE FROM media WHERE NOT EXISTS(SELECT 1 FROM image_refs r WHERE r.id=media.id AND r.owner=media.owner)");
        const counts = this.db.prepare("SELECT (SELECT count(*) FROM records) AS records,(SELECT count(*) FROM media) AS media,(SELECT count(*) FROM links) AS links,(SELECT coalesce(sum(length(CAST(value AS BLOB))),0) FROM records)+(SELECT coalesce(sum(length(CAST(value AS BLOB))),0) FROM media) AS bytes").get()!;
        if (Number(counts.records) > MAX_RECORDS || Number(counts.media) > MAX_RECORDS || Number(counts.links) > 200000 || Number(counts.bytes) > MAX_BYTES) fail("CONTENT_CACHE_BUDGET_REACHED");
        const next: PublicationState = { publicationRevision: proof.publicationRevision, configDigest: proof.configDigest, schemaDigest: proof.schemaDigest, policyEpoch: proof.policyEpoch };
        this.db.prepare("UPDATE state SET value=?,digest=? WHERE singleton=1").run(JSON.stringify(next), configDigest(next));
        this.db.prepare("UPDATE operations SET request=NULL,status='applied',committed_revision=? WHERE id=?").run(proof.publicationRevision, proof.operationId);
        return "installed";
      });
    });
  }
  retire(proof: AttemptClosure): void {
    this.read(() => {
      if (!uuid(proof?.ticket?.operationId) || !(proof.disposition === "never_submitted" && proof.payloadDigest === null ||
        proof.disposition === "definitively_rejected" && hash(proof.payloadDigest))) fail("CONTENT_CACHE_TERMINAL_UNCONFIRMED");
      this.transaction(() => {
        const row = this.db.prepare("SELECT * FROM operations WHERE id=?").get(proof.ticket.operationId);
        if (!row) return;
        if (row.status === "applied" || proof.payloadDigest !== null && proof.payloadDigest !== row.payload_digest) fail("CONTENT_CACHE_OPERATION_CONFLICT");
        this.db.prepare("UPDATE operations SET request=NULL,status='retired' WHERE id=?").run(proof.ticket.operationId);
      });
    });
  }
}
async function privateFile(path: string) {
  try { const s = await lstat(path); if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || (s.mode & 0o077) || process.getuid && s.uid !== process.getuid()) fail("CONTENT_CACHE_PRIVATE_STATE_INVALID"); return true; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; }
}
export async function openContentCache(directory: string, digest: string, sourceKeys: readonly string[]): Promise<ContentCacheStore> {
  try {
    await privateDirectory(directory); const path = join(directory, "content.sqlite");
    if (!await privateFile(path)) { const f = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); await f.close(); }
    for (const suffix of ["-journal", "-wal", "-shm"]) await privateFile(path + suffix);
    const Constructor = (sqlite as unknown as { Database?: typeof sqlite.DatabaseSync }).Database ?? sqlite.DatabaseSync;
    const db = new Constructor(path, { timeout: 1000, enableForeignKeyConstraints: true });
    try { return new ContentCacheStore(db, digest, sourceKeys); } catch (e) { db.close(); throw e; }
  } catch (e) { safe(e); }
}
