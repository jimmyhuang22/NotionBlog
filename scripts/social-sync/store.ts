import type * as sqlite from "node:sqlite";
import { openSocialDatabase } from "./sqlite-file.ts";
import { hash, publicationKey, validateObservation, SocialSyncError, timestamp } from "./model.ts";
import type { Observation, Target } from "./model.ts";

export interface Pending { key: string; sha256: string; observation: Observation }
export type IngestResult = "inserted" | "updated" | "duplicate" | "older";
export class SocialStore {
  private db: sqlite.DatabaseSync;
  constructor(db: sqlite.DatabaseSync) { this.db = db; }
  close() { this.db.close(); }
  checkTargets(targets: Target[]) {
    for (const target of targets) {
      const old = this.db.prepare("SELECT work_id FROM publications WHERE key=?").get(publicationKey(target));
      if (old && old.work_id !== target.workId) throw new SocialSyncError("WORK_BINDING_CONFLICT");
    }
  }
  ingest(row: Observation): IngestResult {
    return this.ingestBatch([row])[0];
  }
  ingestBatch(rows: Observation[]): IngestResult[] {
    for (const row of rows) validateObservation(row);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const results = rows.map(row => this.ingestRow(row));
      this.db.exec("COMMIT"); return results;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private ingestRow(row: Observation): IngestResult {
    const key = publicationKey(row), payload = JSON.stringify(row), sha = hash(payload);
    const old = this.db.prepare("SELECT work_id,observed_at,sha256 FROM publications WHERE key=?").get(key);
    if (old && old.work_id !== row.workId) throw new SocialSyncError("WORK_BINDING_CONFLICT");
    let result: IngestResult;
    if (old && row.observedAt < String(old.observed_at)) result = "older";
    else if (old && row.observedAt === old.observed_at) {
      if (sha !== old.sha256) throw new SocialSyncError("OBSERVATION_CONFLICT");
      result = "duplicate";
    } else {
      this.db.prepare("INSERT INTO samples(key,observed_at,sha256,payload) VALUES(?,?,?,?)").run(key, row.observedAt, sha, payload);
      this.db.prepare(`INSERT INTO publications VALUES(?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET
        observed_at=excluded.observed_at,payload=excluded.payload,sha256=excluded.sha256`).run(key, row.workId, row.observedAt, payload, sha);
      this.db.prepare(`INSERT INTO outbox(key,sha256,payload,status,attempts,error_code) VALUES(?,?,?,'pending',0,NULL)
        ON CONFLICT(key) DO UPDATE SET sha256=excluded.sha256,payload=excluded.payload,status='pending',attempts=0,error_code=NULL`).run(key, sha, payload);
      result = old ? "updated" : "inserted";
    }
    return result;
  }
  recordAttempt(target: Target, at: string, code: string) {
    timestamp(at);
    if (!/^[A-Z][A-Z_]{0,63}$/.test(code)) throw new SocialSyncError("INVALID_DATA");
    this.db.prepare(`INSERT INTO source_attempts VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET attempted_at=excluded.attempted_at,code=excluded.code
      WHERE excluded.attempted_at>=source_attempts.attempted_at`).run(publicationKey(target), at, code);
  }
  latest(target: Target): Observation | null {
    const row = this.db.prepare("SELECT payload,sha256 FROM publications WHERE key=?").get(publicationKey(target));
    return row ? this.decode(String(row.payload), String(row.sha256)) : null;
  }
  /** Local proof of the exact latest ACK; never treats a pending/newer sample as sent. */
  acknowledged(target: Target): Pending | null {
    const key=publicationKey(target),row=this.db.prepare(`SELECT p.payload,p.sha256 FROM publications p JOIN outbox o ON o.key=p.key
      AND o.sha256=p.sha256 AND o.status='acked' WHERE p.key=?`).get(key);
    if(!row)return null;
    const observation=this.decode(String(row.payload),String(row.sha256));
    if(publicationKey(observation)!==key||observation.workId!==target.workId)throw new SocialSyncError("LOCAL_DATA_INVALID");
    return {key,sha256:String(row.sha256),observation};
  }
  private decode(payload: string, sha: string): Observation {
    if (hash(payload) !== sha) throw new SocialSyncError("LOCAL_DATA_INVALID");
    const row = JSON.parse(payload) as Observation; validateObservation(row); return row;
  }
  pending(): Pending[] {
    return this.db.prepare("SELECT key,payload,sha256 FROM outbox WHERE status='pending' ORDER BY key LIMIT 100").all().map(row =>
      ({ key: String(row.key), sha256: String(row.sha256), observation: this.decode(String(row.payload), String(row.sha256)) }));
  }
  /** Select one fixed target, so an unrelated or larger outbox cannot hide its retry. */
  pendingFor(target: Target): Pending | null {
    const key = publicationKey(target), row = this.db.prepare("SELECT payload,sha256 FROM outbox WHERE key=? AND status='pending'").get(key);
    return row ? { key, sha256: String(row.sha256), observation: this.decode(String(row.payload), String(row.sha256)) } : null;
  }
  /** Evidence of an actual matching ACK, rather than merely the absence of pending work. */
  acknowledgedFor(target: Target, sha256: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM outbox WHERE key=? AND sha256=? AND status='acked'").get(publicationKey(target), sha256);
  }
  acknowledge(key: string, sha: string): boolean {
    return Number(this.db.prepare("UPDATE outbox SET status='acked',error_code=NULL WHERE key=? AND sha256=? AND status='pending'").run(key, sha).changes) === 1;
  }
  fail(key: string, sha: string, code: string) {
    if (!["TRANSPORT_FAILED", "ACK_MISMATCH"].includes(code)) throw new SocialSyncError("INVALID_DATA");
    this.db.prepare("UPDATE outbox SET attempts=attempts+1,error_code=? WHERE key=? AND sha256=? AND status='pending'").run(code, key, sha);
  }
  status() {
    const total = (sql: string) => Number(this.db.prepare(sql).get()!.n);
    return { publications: total("SELECT count(*) n FROM publications"), works: total("SELECT count(DISTINCT work_id) n FROM publications"),
      samples: total("SELECT count(*) n FROM samples"), pending: total("SELECT count(*) n FROM outbox WHERE status='pending'"),
      failedUploads: total("SELECT count(*) n FROM outbox WHERE status='pending' AND error_code IS NOT NULL"),
      latestAttempts: this.db.prepare("SELECT key,attempted_at,code FROM source_attempts ORDER BY key").all() };
  }
}
export async function openStore(root: string, readOnly = false): Promise<SocialStore | null> {
  const db = await openSocialDatabase(root, "social.sqlite", readOnly);
  if (!db) return null;
  try {
    const version = Number(db.prepare("PRAGMA user_version").get()!.user_version);
    if (version === 0 && !readOnly && db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().length === 0) {
      db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE publications(key TEXT PRIMARY KEY,work_id TEXT NOT NULL,observed_at TEXT NOT NULL,payload TEXT NOT NULL,sha256 TEXT NOT NULL) STRICT;
        CREATE TABLE samples(key TEXT NOT NULL,observed_at TEXT NOT NULL,sha256 TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(key,observed_at)) STRICT;
        CREATE TABLE outbox(key TEXT PRIMARY KEY,sha256 TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('pending','acked')),
          attempts INTEGER NOT NULL DEFAULT 0,error_code TEXT) STRICT;
        CREATE TABLE source_attempts(key TEXT PRIMARY KEY,attempted_at TEXT NOT NULL,code TEXT NOT NULL) STRICT;
        PRAGMA user_version=1; COMMIT;`);
    } else if (version !== 1) throw new SocialSyncError("LOCAL_SCHEMA_UNSUPPORTED");
    return new SocialStore(db);
  } catch (error) { db.close(); throw error; }
}
/** Only a matching receipt can acknowledge that exact queued payload; removed targets remain local. */
export async function flushOutbox(store: SocialStore, send: (item: Pending) => Promise<{ key: string; sha256: string }>, options: {
  allowedKeys?: ReadonlySet<string>; signal?: AbortSignal;
} = {}) {
  const report = { acknowledged: 0, failed: 0, superseded: 0, skipped: 0, cancelled: false };
  for (const item of store.pending()) {
    if (options.signal?.aborted) { report.cancelled = true; break; }
    if (options.allowedKeys && !options.allowedKeys.has(item.key)) { report.skipped++; continue; }
    try {
      const receipt = await send(item);
      if (options.signal?.aborted) throw new SocialSyncError("CANCELLED");
      if (receipt.key !== item.key || receipt.sha256 !== item.sha256) throw new SocialSyncError("ACK_MISMATCH");
      if (store.acknowledge(item.key, item.sha256)) report.acknowledged++; else report.superseded++;
    } catch (error) {
      store.fail(item.key, item.sha256, error instanceof SocialSyncError && error.code === "ACK_MISMATCH" ? "ACK_MISMATCH" : "TRANSPORT_FAILED");
      report.failed++;
      if (options.signal?.aborted) { report.cancelled = true; break; }
    }
  }
  return report;
}
