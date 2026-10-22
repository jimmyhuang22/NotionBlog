import type * as sqlite from "node:sqlite";
import { openSocialDatabase } from "./sqlite-file.ts";
import { hash, SocialSyncError, timestamp } from "./model.ts";
import { collectionCard, collectionKey, MAX_COLLECTION_SNAPSHOT_BYTES, nextCollectionState, validateCollectionSnapshot, validateCollectionState } from "./collection.ts";
import type { CollectionSnapshot, CollectionState, CollectionTarget } from "./collection.ts";
import { replayCollectionAdditionHistory } from "./collection-addition-history.ts";

export class CollectionStore {
  private db: sqlite.DatabaseSync;
  private hasOutbox: boolean;
  constructor(db: sqlite.DatabaseSync, hasOutbox = true) { this.db = db; this.hasOutbox = hasOutbox; }
  close() { this.db.close(); }
  private decode(row: { key?: unknown; payload?: unknown; sha256?: unknown }): CollectionState {
    if (typeof row.payload !== "string" || Buffer.byteLength(row.payload) > 2*1024*1024 || hash(row.payload) !== row.sha256) throw new SocialSyncError("LOCAL_DATA_INVALID");
    let state: CollectionState;
    try { state = validateCollectionState(JSON.parse(row.payload)); } catch { throw new SocialSyncError("LOCAL_DATA_INVALID"); }
    if (collectionKey(state.snapshot.target) !== row.key) throw new SocialSyncError("LOCAL_DATA_INVALID");
    return state;
  }
  latest(target: CollectionTarget): CollectionState | null {
    const row = this.db.prepare("SELECT key,payload,sha256 FROM collection_states WHERE key=?").get(collectionKey(target));
    return row ? this.decode(row) : null;
  }
  acknowledged(target: CollectionTarget): CollectionPending | null {
    if (!this.hasOutbox || this.pendingFor(target)) return null;
    const current=this.latest(target);
    return current?{key:collectionKey(target),sha256:hash(JSON.stringify(current.snapshot)),snapshot:current.snapshot}:null;
  }
  ingest(input: CollectionSnapshot) {
    const snapshot = validateCollectionSnapshot(input), key = collectionKey(snapshot.target), raw = JSON.stringify(snapshot), sha = hash(raw);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const old = this.latest(snapshot.target);
      if (old && snapshot.observedAt < old.snapshot.observedAt) { this.db.exec("COMMIT"); return { status: "older" as const, addedVideos: 0, addedParts: 0 }; }
      if (old && snapshot.observedAt === old.snapshot.observedAt) {
        if (hash(JSON.stringify(old.snapshot)) !== sha) throw new SocialSyncError("OBSERVATION_CONFLICT");
        this.db.exec("COMMIT"); return { status: "duplicate" as const, addedVideos: 0, addedParts: 0 };
      }
      const state = nextCollectionState(old, snapshot), payload = JSON.stringify(state);
      if (Buffer.byteLength(payload) > 2*1024*1024) throw new SocialSyncError("COLLECTION_HISTORY_LIMIT");
      this.db.prepare("INSERT INTO collection_samples VALUES(?,?,?,?)").run(key, snapshot.observedAt, sha, raw);
      this.db.prepare(`INSERT INTO collection_states VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET
        observed_at=excluded.observed_at,payload=excluded.payload,sha256=excluded.sha256`).run(key, snapshot.observedAt, payload, hash(payload));
      this.db.prepare(`INSERT INTO collection_outbox(key,sha256,payload) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET
        sha256=excluded.sha256,payload=excluded.payload,attempts=0,last_error=NULL`).run(key,sha,raw);
      this.db.exec("COMMIT");
      const change = state.latestAddition?.detectedAt === snapshot.observedAt ? state.latestAddition : null;
      return { status: old ? "updated" as const : "baseline" as const, addedVideos: change?.addedVideos ?? 0, addedParts: change?.addedParts ?? 0 };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  recordAttempt(target: CollectionTarget, at: string, code: string) {
    timestamp(at);
    if (!/^[A-Z][A-Z_]{0,63}$/.test(code)) throw new SocialSyncError("INVALID_DATA");
    this.db.prepare(`INSERT INTO collection_attempts VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET attempted_at=excluded.attempted_at,code=excluded.code
      WHERE excluded.attempted_at>=collection_attempts.attempted_at`).run(collectionKey(target), at, code);
  }
  cards() {
    const result: ReturnType<typeof collectionCard>[] = []; let bytes = 0;
    for (const row of this.db.prepare("SELECT key,payload,sha256 FROM collection_states ORDER BY key LIMIT 501").iterate()) {
      if (result.length === 500 || (bytes += Buffer.byteLength(String(row.payload))) > 8*1024*1024) throw new SocialSyncError("COLLECTION_EXPORT_TOO_LARGE");
      result.push(collectionCard(this.decode(row)));
    }
    return result;
  }
  status() {
    const n = (sql: string) => Number(this.db.prepare(sql).get()!.n);
    return { collections: n("SELECT count(*) n FROM collection_states"), samples: n("SELECT count(*) n FROM collection_samples"),
      failedSources: n("SELECT count(*) n FROM collection_attempts WHERE code<>'OK'"),
      pending: this.hasOutbox ? n("SELECT count(*) n FROM collection_outbox") : null,
      failedUploads: this.hasOutbox ? n("SELECT count(*) n FROM collection_outbox WHERE last_error IS NOT NULL") : null };
  }
  /** Read-only replay plan. No outbox, current state, schema or cloud mutation. */
  additionHistoryPlans() {
    const plans=[];let bytes=0;
    for(const row of this.db.prepare("SELECT key,payload,sha256 FROM collection_states ORDER BY key LIMIT 501").iterate()){
      if(plans.length===500)throw new SocialSyncError("COLLECTION_EXPORT_TOO_LARGE");
      const expected=this.decode(row),samples:CollectionSnapshot[]=[];
      for(const sample of this.db.prepare("SELECT observed_at,payload,sha256 FROM collection_samples WHERE key=? ORDER BY observed_at LIMIT 10001").iterate(String(row.key))){
        if(samples.length===10000||typeof sample.payload!=="string"||(bytes+=Buffer.byteLength(sample.payload))>64*1024**2||hash(sample.payload)!==sample.sha256)throw new SocialSyncError("LOCAL_DATA_INVALID");
        const snapshot=validateCollectionSnapshot(JSON.parse(sample.payload));
        if(collectionKey(snapshot.target)!==row.key||snapshot.observedAt!==sample.observed_at)throw new SocialSyncError("LOCAL_DATA_INVALID");
        samples.push(snapshot);
      }
      plans.push({key:String(row.key),expectedPayloadSHA256:hash(JSON.stringify(expected.snapshot)),sampleCount:samples.length,
        history:replayCollectionAdditionHistory(samples,expected)});
    }
    return plans;
  }
  pending(): CollectionPending[] {
    if (!this.hasOutbox) throw new SocialSyncError("LOCAL_SCHEMA_UPGRADE_REQUIRED");
    const result: CollectionPending[]=[]; let bytes=0;
    for (const row of this.db.prepare("SELECT key,sha256,payload FROM collection_outbox ORDER BY key LIMIT 101").iterate()) {
      if (result.length===100 || typeof row.payload!=="string" || (bytes+=Buffer.byteLength(row.payload))>8*1024*1024) throw new SocialSyncError("COLLECTION_EXPORT_TOO_LARGE");
      if (typeof row.key!=="string" || typeof row.sha256!=="string" || hash(row.payload)!==row.sha256) throw new SocialSyncError("LOCAL_DATA_INVALID");
      let snapshot: CollectionSnapshot;
      try {snapshot=validateCollectionSnapshot(JSON.parse(row.payload));} catch {throw new SocialSyncError("LOCAL_DATA_INVALID");}
      if (collectionKey(snapshot.target)!==row.key || hash(JSON.stringify(snapshot))!==row.sha256) throw new SocialSyncError("LOCAL_DATA_INVALID");
      result.push({key:row.key,sha256:row.sha256,snapshot});
    }
    return result;
  }
  pendingFor(target: CollectionTarget): CollectionPending | null {
    if (!this.hasOutbox) throw new SocialSyncError("LOCAL_SCHEMA_UPGRADE_REQUIRED");
    const key = collectionKey(target), row = this.db.prepare("SELECT sha256,payload FROM collection_outbox WHERE key=?").get(key);
    if (!row) return null;
    if (typeof row.payload !== "string" || Buffer.byteLength(row.payload)>MAX_COLLECTION_SNAPSHOT_BYTES || hash(row.payload)!==row.sha256) throw new SocialSyncError("LOCAL_DATA_INVALID");
    const snapshot=validateCollectionSnapshot(JSON.parse(row.payload));
    if (collectionKey(snapshot.target)!==key || hash(JSON.stringify(snapshot))!==row.sha256) throw new SocialSyncError("LOCAL_DATA_INVALID");
    return {key,sha256:String(row.sha256),snapshot};
  }
  acknowledge(item: CollectionPending) {
    return Number(this.db.prepare("DELETE FROM collection_outbox WHERE key=? AND sha256=?").run(item.key,item.sha256).changes)===1;
  }
  fail(item: CollectionPending, code: string) {
    this.db.prepare("UPDATE collection_outbox SET attempts=attempts+1,last_error=? WHERE key=? AND sha256=?").run(code,item.key,item.sha256);
  }
}
export interface CollectionPending {key:string;sha256:string;snapshot:CollectionSnapshot}
export async function flushCollectionOutbox(store: CollectionStore, send: (item:CollectionPending)=>Promise<{key:string;sha256:string}>, options: {allowedKeys:Set<string>;signal?:AbortSignal}) {
  const report={acknowledged:0,failed:0,superseded:0,skipped:0,cancelled:false};
  for (const item of store.pending()) {
    if (options.signal?.aborted) {report.cancelled=true;break;}
    if (!options.allowedKeys.has(item.key)) {report.skipped++;continue;}
    try {
      const receipt=await send(item);
      if (options.signal?.aborted) throw new SocialSyncError("CANCELLED");
      if (receipt.key!==item.key || receipt.sha256!==item.sha256) throw new SocialSyncError("ACK_MISMATCH");
      if (store.acknowledge(item)) report.acknowledged++; else report.superseded++;
    } catch (error) {
      store.fail(item,error instanceof SocialSyncError?error.code:"UPLOAD_FAILED");report.failed++;
      if (options.signal?.aborted) {report.cancelled=true;break;}
    }
  }
  return report;
}
/** Independent database; never migrates the single-publication history or its cloud outbox. */
export async function openCollectionStore(root: string, readOnly = false): Promise<CollectionStore | null> {
  const db = await openSocialDatabase(root, "social-collections.sqlite", readOnly);
  if (!db) return null;
  try {
    let version = Number(db.prepare("PRAGMA user_version").get()!.user_version);
    if (version === 0 && !readOnly && db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().length === 0) {
      db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE collection_states(key TEXT PRIMARY KEY,observed_at TEXT NOT NULL,payload TEXT NOT NULL,sha256 TEXT NOT NULL) STRICT;
        CREATE TABLE collection_samples(key TEXT NOT NULL,observed_at TEXT NOT NULL,sha256 TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(key,observed_at)) STRICT;
        CREATE TABLE collection_attempts(key TEXT PRIMARY KEY,attempted_at TEXT NOT NULL,code TEXT NOT NULL) STRICT;
        PRAGMA user_version=1; COMMIT;`);
      version=1;
    } else if (![1,2].includes(version)) throw new SocialSyncError("LOCAL_SCHEMA_UNSUPPORTED");
    if (version===1 && !readOnly) {
      db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE collection_outbox(key TEXT PRIMARY KEY REFERENCES collection_states(key),sha256 TEXT NOT NULL,payload TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,last_error TEXT) STRICT;
        INSERT INTO collection_outbox(key,sha256,payload) SELECT s.key,p.sha256,p.payload FROM collection_states s
          JOIN collection_samples p ON p.key=s.key AND p.observed_at=s.observed_at;
        PRAGMA user_version=2; COMMIT;`);
      version=2;
    }
    return new CollectionStore(db,version===2);
  } catch (error) { db.close(); throw error; }
}
