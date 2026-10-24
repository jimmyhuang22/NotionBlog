import { Pool } from "pg";
import type { SqlExecutor } from "../../src/server/database/sql.ts";
import { cloudConfig, createCloudTransport } from "./cloud.ts";
import type { XhsAccountTransport } from "./cloud.ts";
import { createCollectionTransport } from "./collection-cloud.ts";
import { hash, SocialSyncError } from "./model.ts";
import type { Pending } from "./store.ts";
import type { CollectionPending } from "./collection-store.ts";

export interface CycleUploadCost {
  connectionAttempts: number; connections: number; connectMs: number;
  handshakeAttempts: number; publicationHandshakes: number; collectionHandshakes: number; handshakeMs: number;
  ingestAttempts: number; receipts: number; ingestMs: number; closeMs: number;
}
export function emptyUploadCost(): CycleUploadCost {
  return { connectionAttempts: 0, connections: 0, connectMs: 0, handshakeAttempts: 0,
    publicationHandshakes: 0, collectionHandshakes: 0, handshakeMs: 0,
    ingestAttempts: 0, receipts: 0, ingestMs: 0, closeMs: 0 };
}
export function parseUploadCost(value: unknown): CycleUploadCost {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SocialSyncError("BILIBILI_HEALTH_INVALID");
  const raw = value as Record<string, unknown>, out = emptyUploadCost();
  for (const key of Object.keys(out) as (keyof CycleUploadCost)[]) {
    const n = raw[key];
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 1000000000000 ||
      !key.endsWith("Ms") && !Number.isSafeInteger(n)) throw new SocialSyncError("BILIBILI_HEALTH_INVALID");
    out[key] = n;
  }
  if (out.connections > out.connectionAttempts || out.receipts > out.ingestAttempts ||
    out.publicationHandshakes + out.collectionHandshakes > out.handshakeAttempts) throw new SocialSyncError("BILIBILI_HEALTH_INVALID");
  return out;
}
export interface CycleConnection { sql: SqlExecutor; close: () => Promise<void> }
export interface CycleCloudPorts {
  connect: (raw: string, onError: () => void) => Promise<CycleConnection>;
  now?: () => number;
}
async function openConnection(raw: string, onError: () => void): Promise<CycleConnection> {
  const pool = new Pool(cloudConfig(raw)); pool.on("error", onError);
  let client;
  try {
    client = await pool.connect(); client.on("error", onError);
    const checkedOut = client;
    return { sql: checkedOut, close: async () => {
      try { checkedOut.release(true); await pool.end(); }
      finally { checkedOut.removeListener("error", onError); }
    } };
  } catch {
    client?.release(true); await pool.end(); throw new SocialSyncError("CLOUD_UNAVAILABLE");
  }
}

/** One lazy, sequential, checked-out worker connection, owned by one fixed-scope cycle. */
export class CycleCloudSession {
  readonly cost = emptyUploadCost();
  private connection: CycleConnection | null = null;
  private publication: Awaited<ReturnType<typeof createCloudTransport>> | null = null;
  private collection: Awaited<ReturnType<typeof createCollectionTransport>> | null = null;
  private binding: { credentials: string; scope: string } | null = null;
  private active: Promise<unknown> | null = null;
  private closing: Promise<void> | null = null;
  private failed = false;
  private accountMode: boolean | null = null;
  private stopped = false;
  private readonly now: () => number;
  private readonly signal?: AbortSignal;
  private readonly ports: CycleCloudPorts;
  private readonly httpNotes: boolean;
  private readonly xhsAccount?:XhsAccountTransport;
  private readonly bilibiliApi: boolean;
  constructor(signal?: AbortSignal, ports: CycleCloudPorts = { connect: openConnection }, options: { httpNotes?: boolean;xhsAccount?:XhsAccountTransport;bilibiliApi?:boolean } = {}) {
    this.signal = signal; this.ports = ports;
    this.httpNotes = options.httpNotes === true;
    this.xhsAccount=options.xhsAccount;
    this.bilibiliApi=options.bilibiliApi===true;
    if(this.bilibiliApi&&(this.httpNotes||this.xhsAccount))throw new SocialSyncError("LOCAL_DATA_INVALID");
    this.now = ports.now ?? (() => performance.now());
  }
  get closed() { return this.stopped; }
  get httpNotesPrepared() { return this.httpNotes && this.publication !== null && !this.failed && !this.stopped && !this.closing; }
  get bilibiliApiPrepared() { return this.bilibiliApi && this.publication !== null && this.collection !== null && !this.failed && !this.stopped && !this.closing; }
  hasPreparedBilibiliApi(raw: string, scope: string, accountMode?: boolean) { return this.bilibiliApiPrepared && this.binding?.credentials === hash(raw) && this.binding.scope === scope && (accountMode===undefined||this.accountMode===accountMode); }
  private check(signal?: AbortSignal) {
    if (this.signal?.aborted || signal?.aborted) throw new SocialSyncError("CANCELLED");
    if (this.stopped || this.closing) throw new SocialSyncError("CLOUD_SESSION_CLOSED");
    if (this.failed) throw new SocialSyncError("CLOUD_SESSION_FAILED");
  }
  private async measured<T>(phase: "connectMs" | "handshakeMs" | "ingestMs" | "closeMs", run: () => Promise<T>) {
    const start = this.now();
    try { return await run(); } finally { this.cost[phase] += Math.max(0, this.now() - start); }
  }
  private async ready(raw: string, scope: string, signal?: AbortSignal) {
    this.check(signal); cloudConfig(raw);
    if (!/^[a-f0-9]{64}$/.test(scope)) throw new SocialSyncError("REFRESH_SCOPE_CHANGED");
    const credentials = hash(raw);
    if (this.binding && (this.binding.credentials !== credentials || this.binding.scope !== scope)) throw new SocialSyncError("CLOUD_SESSION_INPUT_CHANGED");
    this.binding ??= { credentials, scope };
    if (!this.connection) {
      this.cost.connectionAttempts++;
      this.connection = await this.measured("connectMs", () => this.ports.connect(raw, () => { this.failed = true; }));
      this.cost.connections++;
    }
    this.check(signal);
  }
  private async send<T>(operation: () => Promise<T>): Promise<T> {
    this.check(); if (this.active) throw new SocialSyncError("CLOUD_SESSION_BUSY");
    const active = operation(); this.active = active;
    try { return await active; }
    catch (error) { this.failed = true; throw error instanceof SocialSyncError ? error : new SocialSyncError("CLOUD_UNAVAILABLE"); }
    finally { this.active = null; }
  }
  /** Check the additive capability before collecting HTTP notes or changing their local store. */
  async preparePublications(raw: string, scope: string, signal?: AbortSignal) {
    if(this.bilibiliApi)throw new SocialSyncError("LOCAL_DATA_INVALID");
    return this.send(async () => {
      await this.ready(raw, scope, signal);
      if (this.accountMode !== null && this.accountMode !== false) throw new SocialSyncError("CLOUD_SESSION_INPUT_CHANGED");
      this.accountMode = false;
      if (!this.publication) {
        this.cost.handshakeAttempts++;
        this.publication = await this.measured("handshakeMs", () => createCloudTransport(this.connection!.sql, this.signal, false, this.httpNotes,this.xhsAccount));
        this.cost.publicationHandshakes++;
      }
    });
  }
  /** Both additive capabilities are checked before the first new-source GET. */
  async prepareBilibiliApi(raw: string, scope: string, accountMode: boolean, signal?: AbortSignal) {
    if(!this.bilibiliApi)throw new SocialSyncError("BILIBILI_API_PROTOCOL_REQUIRED");
    return this.send(async()=>{
      await this.ready(raw,scope,signal);
      if(this.accountMode!==null&&this.accountMode!==accountMode)throw new SocialSyncError("CLOUD_SESSION_INPUT_CHANGED");this.accountMode=accountMode;
      if(!this.publication){this.cost.handshakeAttempts++;this.publication=await this.measured("handshakeMs",()=>createCloudTransport(this.connection!.sql,this.signal,accountMode,false,undefined,true));this.cost.publicationHandshakes++;}
      if(!this.collection){this.cost.handshakeAttempts++;this.collection=await this.measured("handshakeMs",()=>createCollectionTransport(this.connection!.sql,this.signal,accountMode,true));this.cost.collectionHandshakes++;}
    });
  }
  /** The account-discovery writer has validated and durably registered a new local scope.
   * Only an unused, same-credential account session may adopt it, before any ingest. */
  adoptDiscoveredBilibiliScope(raw: string, previousScope: string, nextScope: string) {
    this.check();
    if(!this.hasPreparedBilibiliApi(raw,previousScope)||this.accountMode!==true||this.active||this.cost.ingestAttempts!==0||!/^[a-f0-9]{64}$/.test(nextScope))throw new SocialSyncError("CLOUD_SESSION_INPUT_CHANGED");
    this.binding={credentials:hash(raw),scope:nextScope};
  }
  async sendPublication(raw: string, scope: string, item: Pending, signal: AbortSignal | undefined, checkScope: () => Promise<void>, accountMode = false) {
    return this.send(async () => {
      await this.ready(raw, scope, signal);
      if (this.accountMode !== null && this.accountMode !== accountMode) throw new SocialSyncError("CLOUD_SESSION_INPUT_CHANGED");
      this.accountMode = accountMode;
      if (!this.publication) {
        this.cost.handshakeAttempts++;
        this.publication = await this.measured("handshakeMs", () => createCloudTransport(this.connection!.sql, this.signal, accountMode, this.httpNotes,this.xhsAccount,this.bilibiliApi));
        this.cost.publicationHandshakes++;
      }
      await checkScope(); this.check(signal); this.cost.ingestAttempts++;
      const receipt = await this.measured("ingestMs", () => this.publication!(item, signal));
      this.check(signal); this.cost.receipts++; return receipt;
    });
  }
  async sendCollection(raw: string, scope: string, item: CollectionPending, signal: AbortSignal | undefined, checkScope: () => Promise<void>, accountMode = false) {
    if (this.httpNotes) throw new SocialSyncError("LOCAL_DATA_INVALID");
    return this.send(async () => {
      await this.ready(raw, scope, signal);
      if (this.accountMode !== null && this.accountMode !== accountMode) throw new SocialSyncError("CLOUD_SESSION_INPUT_CHANGED");
      this.accountMode = accountMode;
      if (!this.collection) {
        this.cost.handshakeAttempts++;
        this.collection = await this.measured("handshakeMs", () => createCollectionTransport(this.connection!.sql, this.signal, accountMode,this.bilibiliApi));
        this.cost.collectionHandshakes++;
      }
      await checkScope(); this.check(signal); this.cost.ingestAttempts++;
      const receipt = await this.measured("ingestMs", () => this.collection!(item, signal));
      this.check(signal); this.cost.receipts++; return receipt;
    });
  }
  async close() {
    if (this.closing) return this.closing;
    // Wait for any in-flight statement before destroying the checked-out connection.
    this.closing = (async () => {
      await this.active?.catch(() => {});
      try { if (this.connection) await this.measured("closeMs", () => this.connection!.close()); }
      catch { throw new SocialSyncError("CLOUD_CLOSE_FAILED"); }
      finally { this.connection = null; this.stopped = true; }
    })();
    return this.closing;
  }
  async bindSeasonLink(raw:string,scope:string,proof:{key:string;url:string;checkedAt:string},checkScope:()=>Promise<void>){
    return this.send(async()=>{
      await this.ready(raw,scope);this.check();
      if(!this.collection){this.cost.handshakeAttempts++;this.collection=await this.measured("handshakeMs",()=>createCollectionTransport(this.connection!.sql,this.signal,true,this.bilibiliApi));this.cost.collectionHandshakes++;}
      await checkScope();this.cost.ingestAttempts++;
      const r=await this.measured("ingestMs",()=>this.connection!.sql.query<{accepted:boolean}>("SELECT social_sync.bind_bilibili_season_link($1,$2,$3) accepted",[proof.key,proof.url,proof.checkedAt]));
      this.check();if(r.rows.length!==1||r.rows[0]!.accepted!==true)throw new SocialSyncError("ACK_MISMATCH");this.cost.receipts++;return {key:proof.key,accepted:true};
    });
  }
}
