import type { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { lstat } from "node:fs/promises";
import { openSocialDatabase } from "../social-sync/sqlite-file.ts";
import { hash, SocialSyncError, timestamp } from "../social-sync/model.ts";
import { sourceDigest, validateCoverSource, type CoverSource } from "./sources.ts";
import type { CoverMode } from "../../src/server/social/covers.ts";

export interface CoverJob { id: string; token: string; mode: CoverMode; source: CoverSource }
const modes = new Set(["trial", "retained"]);
const jobId = (source: CoverSource, mode: CoverMode) => hash(JSON.stringify([mode, source.kind, source.key]));
const token = (source: CoverSource) => hash(JSON.stringify(source));
const checked = (source: CoverSource, mode: CoverMode) => {
  validateCoverSource(source);
  if (!modes.has(mode)) throw new SocialSyncError("COVER_QUEUE_INVALID");
};

/** Separate private SQLite: never migrates source history or the statistics outbox. */
export class CoverQueue {
  private db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; }
  close() { this.db.close(); }
  private transaction<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const value = run(); this.db.exec("COMMIT"); return value; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  stage(source: CoverSource, sampleSha: string) {
    checked(source, "retained");
    if (source.kind !== "collection" || !/^[a-f0-9]{64}$/.test(sampleSha)) throw new SocialSyncError("COVER_QUEUE_INVALID");
    this.transaction(() => {
      const old = this.db.prepare("SELECT observed_at,sample_sha,payload FROM stages WHERE key=?").get(source.key);
      if (old && String(old.observed_at) > source.observedAt) return;
      if (old?.observed_at === source.observedAt && (old.sample_sha !== sampleSha || old.payload !== JSON.stringify(source))) throw new SocialSyncError("COVER_OBSERVATION_CONFLICT");
      if (!old && this.count("stages") >= 500) throw new SocialSyncError("COVER_QUEUE_LIMIT");
      this.db.prepare(`INSERT INTO stages VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET
        sample_sha=excluded.sample_sha,payload=excluded.payload,observed_at=excluded.observed_at`)
        .run(source.key, sampleSha, JSON.stringify(source), source.observedAt);
    });
  }
  /** Only called after an exact statistics ACK. A staged HTML alone is never consumable. */
  acknowledgeCollection(key: string, sampleSha: string, observedAt: string, mode: CoverMode) {
    if (!/^[a-f0-9]{64}$/.test(key) || !/^[a-f0-9]{64}$/.test(sampleSha) || !modes.has(mode)) throw new SocialSyncError("COVER_QUEUE_INVALID");
    timestamp(observedAt);
    return this.transaction(() => {
      const stage = this.db.prepare("SELECT payload,observed_at,sample_sha FROM stages WHERE key=?").get(key);
      if (!stage || stage.sample_sha !== sampleSha || stage.observed_at !== observedAt) {
        this.db.prepare(`INSERT INTO gaps VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET observed_at=excluded.observed_at,code=excluded.code
          WHERE excluded.observed_at>=gaps.observed_at`).run(key, observedAt, "COVER_COLLECTION_SOURCE_MISSING");
        if (this.count("gaps") > 500) throw new SocialSyncError("COVER_QUEUE_LIMIT");
        return false;
      }
      const source = JSON.parse(String(stage.payload)) as CoverSource;
      if (source.kind !== "collection" || source.key !== key || source.observedAt !== observedAt) throw new SocialSyncError("COVER_QUEUE_INVALID");
      this.offerRow(source, mode);
      this.db.prepare("DELETE FROM gaps WHERE key=? AND observed_at<=?").run(key, observedAt);
      return true;
    });
  }
  offer(source: CoverSource, mode: CoverMode) { return this.transaction(() => this.offerRow(source, mode)); }
  private offerRow(source: CoverSource, mode: CoverMode) {
    checked(source, mode);
    const id = jobId(source, mode), sha = sourceDigest(source), payload = JSON.stringify(source), generation = token(source);
    const old = this.db.prepare("SELECT observed_at,source_sha,token,status,payload FROM jobs WHERE id=?").get(id);
    if (old && String(old.observed_at) > source.observedAt) return false;
    if (old && old.observed_at === source.observedAt) {
      if (old.token !== generation) throw new SocialSyncError("COVER_OBSERVATION_CONFLICT");
      return false;
    }
    if (!old && this.count("jobs") >= 1000) throw new SocialSyncError("COVER_QUEUE_LIMIT");
    const changed = !old || old.source_sha !== sha;
    // Collection source eligibility includes the current observation timestamp, even for an unchanged URL.
    const status = changed || source.kind === "collection" && old?.status !== "failed" ? "pending" : String(old!.status);
    this.db.prepare(`INSERT INTO jobs(id,kind,owner_key,mode,source_sha,token,payload,observed_at,status,attempts,last_attempt,error_code)
      VALUES(?,?,?,?,?,?,?,?,?,0,NULL,NULL) ON CONFLICT(id) DO UPDATE SET source_sha=excluded.source_sha,token=excluded.token,
      payload=excluded.payload,observed_at=excluded.observed_at,status=excluded.status,
      attempts=CASE WHEN jobs.source_sha IS NOT excluded.source_sha THEN 0 ELSE jobs.attempts END,
      last_attempt=CASE WHEN jobs.source_sha IS NOT excluded.source_sha THEN NULL ELSE jobs.last_attempt END,
      error_code=CASE WHEN jobs.source_sha IS NOT excluded.source_sha THEN NULL ELSE jobs.error_code END`)
      .run(id, source.kind, source.key, mode, sha, generation, payload, source.observedAt, status);
    return true;
  }
  pending(mode: CoverMode, limit = 20): CoverJob[] {
    if (!modes.has(mode) || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new SocialSyncError("COVER_QUEUE_INVALID");
    return this.db.prepare("SELECT id,token,payload FROM jobs WHERE mode=? AND status='pending' ORDER BY observed_at,id LIMIT ?").all(mode, limit).map(row => {
      const source = JSON.parse(String(row.payload)) as CoverSource; checked(source, mode);
      if (jobId(source, mode) !== row.id || token(source) !== row.token) throw new SocialSyncError("COVER_QUEUE_INVALID");
      return { id: String(row.id), token: String(row.token), mode, source };
    });
  }
  /** ACKed collection metadata only; this never admits more image work. */
  pendingCollections(mode: CoverMode): CoverJob[] {
    if (!modes.has(mode)) throw new SocialSyncError("COVER_QUEUE_INVALID");
    const rows = this.db.prepare("SELECT id,token,payload FROM jobs WHERE mode=? AND kind='collection' AND status='pending' ORDER BY observed_at,id LIMIT 501").all(mode);
    if (rows.length > 500) throw new SocialSyncError("COVER_QUEUE_LIMIT");
    return rows.map(row => {
      const source = JSON.parse(String(row.payload)) as CoverSource; checked(source, mode);
      if (source.kind !== "collection" || jobId(source, mode) !== row.id || token(source) !== row.token) throw new SocialSyncError("COVER_QUEUE_INVALID");
      return { id: String(row.id), token: String(row.token), mode, source };
    });
  }
  current(job: CoverJob) { return Boolean(this.db.prepare("SELECT 1 FROM jobs WHERE id=? AND token=? AND status='pending'").get(job.id, job.token)); }
  attempt(job: CoverJob, at: string) {
    timestamp(at);
    return Number(this.db.prepare("UPDATE jobs SET attempts=attempts+1,last_attempt=? WHERE id=? AND token=? AND status='pending'").run(at, job.id, job.token).changes) === 1;
  }
  finish(job: CoverJob, status: "complete" | "missing" | "failed", code: string | null = null) {
    if (!["complete", "missing", "failed"].includes(status) || status === "failed" && (!code || !/^[A-Z][A-Z_]{0,63}$/.test(code)) || status !== "failed" && code !== null) throw new SocialSyncError("COVER_QUEUE_INVALID");
    return Number(this.db.prepare("UPDATE jobs SET status=?,error_code=? WHERE id=? AND token=? AND status='pending'").run(status, code, job.id, job.token).changes) === 1;
  }
  retry(mode: CoverMode) {
    if (!modes.has(mode)) throw new SocialSyncError("COVER_QUEUE_INVALID");
    return this.transaction(() => this.db.prepare(`UPDATE jobs SET status='pending',error_code=NULL WHERE id IN
      (SELECT id FROM jobs WHERE mode=? AND status='failed' ORDER BY observed_at,id LIMIT 20)`).run(mode).changes);
  }
  private count(table: "jobs" | "stages" | "gaps") { return Number(this.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n); }
  summary(at: string) {
    timestamp(at);
    const totals = Object.fromEntries(this.db.prepare("SELECT status,count(*) AS n FROM jobs GROUP BY status").all().map(row => [String(row.status), Number(row.n)]));
    const last = this.db.prepare("SELECT last_attempt,error_code FROM jobs WHERE last_attempt IS NOT NULL ORDER BY last_attempt DESC LIMIT 1").get();
    return { version: 1, checkedAt: at, pending: totals.pending ?? 0, failed: totals.failed ?? 0, complete: totals.complete ?? 0,
      missing: totals.missing ?? 0, stagedCollections: this.count("stages"), missingCollectionSources: this.count("gaps"),
      lastAttemptAt: last?.last_attempt ?? null, lastAttemptCode: last?.error_code ?? null };
  }
}
export async function openCoverQueue(root: string, readOnly = false) {
  if (readOnly) try { await lstat(join(root, "social-cover-queue")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  const db = await openSocialDatabase(join(root, "social-cover-queue"), "social.sqlite", readOnly);
  if (!db) return null;
  try {
    const version = Number(db.prepare("PRAGMA user_version").get()!.user_version);
    if (version === 0 && !readOnly && db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().length === 0) {
      db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE jobs(id TEXT PRIMARY KEY,kind TEXT NOT NULL,owner_key TEXT NOT NULL,mode TEXT NOT NULL,source_sha TEXT,token TEXT NOT NULL,
          payload TEXT NOT NULL,observed_at TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('pending','complete','missing','failed')),
          attempts INTEGER NOT NULL,last_attempt TEXT,error_code TEXT) STRICT;
        CREATE TABLE stages(key TEXT PRIMARY KEY,sample_sha TEXT NOT NULL,payload TEXT NOT NULL,observed_at TEXT NOT NULL) STRICT;
        CREATE TABLE gaps(key TEXT PRIMARY KEY,observed_at TEXT NOT NULL,code TEXT NOT NULL) STRICT;
        PRAGMA user_version=1; COMMIT;`);
    } else if (version !== 1) throw new SocialSyncError("COVER_QUEUE_SCHEMA_UNSUPPORTED");
    return new CoverQueue(db);
  } catch (error) { db.close(); throw error; }
}
