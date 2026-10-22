import { randomUUID } from "node:crypto";
import type { ConfirmedAbsence, PublicationReceipt, RunLease, StoredMedia, SyncRecord, SyncWriter } from "../../contracts/sync.ts";
import type { ObjectStorage } from "../../src/server/database/storage.ts";
import { verifyMediaBytes } from "../../src/server/database/storage.ts";
import { validateSyncRecord, validateMedia } from "../../src/server/database/validation.ts";
import { WorkerError } from "./errors.ts";

/** In-memory test port, not a replacement for PostgreSQL's scope/RLS enforcement. */
export class FakeWriter implements SyncWriter {
  records = new Map<string, SyncRecord>(); media = new Map<string, StoredMedia>(); absences = new Map<string, ConfirmedAbsence>();
  current = new Map<string, SyncRecord>(); calls: string[] = [];
  revision = "1"; fence = 0; deniedPageIds: string[] = [];
  lease: RunLease | null = null; expiresAt = 0;
  private valid(lease: RunLease) {
    if (!this.lease || lease.runId !== this.lease.runId || lease.fence !== String(this.fence) ||
        lease.revision !== this.revision || Date.now() >= this.expiresAt) throw new WorkerError("LEASE_INVALID");
  }
  async begin(runId: string = randomUUID(), digest: string, seconds = 300): Promise<RunLease> {
    this.calls.push("begin");
    if (this.lease && Date.now() < this.expiresAt) throw new WorkerError("BUSY");
    this.fence++; this.expiresAt = Date.now() + seconds * 1000;
    this.records.clear(); this.media.clear(); this.absences.clear();
    return this.lease = { runId, fence: String(this.fence), revision: this.revision, configDigest: digest, deniedPageIds: [...this.deniedPageIds] };
  }
  async renew(lease: RunLease, seconds = 300) { this.calls.push("renew"); this.valid(lease); this.expiresAt = Date.now() + seconds * 1000; }
  async stage(lease: RunLease, records: SyncRecord[], media: StoredMedia[] = [], absences: ConfirmedAbsence[] = []) {
    this.calls.push("stage"); this.valid(lease);
    if ([records, media, absences].some(batch => batch.length > 100)) throw new WorkerError("LIMIT_EXCEEDED");
    for (const record of records) { validateSyncRecord(record); this.records.set(record.detail.item.id, structuredClone(record)); }
    for (const asset of media) { validateMedia(asset); if (!this.records.has(asset.ownerPageId)) throw new WorkerError("SCOPE_INCOMPLETE"); this.media.set(asset.assetId, structuredClone(asset)); }
    for (const absence of absences) this.absences.set(absence.id, structuredClone(absence));
  }
  async promote(lease: RunLease, receipt: PublicationReceipt) {
    this.calls.push("promote"); this.valid(lease);
    if (!receipt.complete || receipt.records !== this.records.size || receipt.media !== this.media.size ||
        (receipt.confirmedAbsent ?? 0) !== this.absences.size || [...this.records.values()].some(r => !r.detail.document)) throw new WorkerError("SCOPE_INCOMPLETE");
    this.current = new Map(this.records); this.lease = null;
  }
  async fail(lease: RunLease) { this.calls.push("fail"); if (this.lease?.runId === lease.runId && this.lease.fence === lease.fence) this.lease = null; }
}
export class FakeStorage implements ObjectStorage {
  objects = new Map<string, Uint8Array>(); puts = 0;
  async put(media: StoredMedia, bytes: Uint8Array) {
    validateMedia(media); verifyMediaBytes(media, bytes); this.puts++;
    const existing = this.objects.get(media.objectKey);
    if (existing) verifyMediaBytes(media, existing); else this.objects.set(media.objectKey, Uint8Array.from(bytes));
  }
  async read(media: StoredMedia) {
    const bytes = this.objects.get(media.objectKey);
    if (!bytes) throw new WorkerError("IMAGE_UNAVAILABLE");
    verifyMediaBytes(media, bytes); return Uint8Array.from(bytes);
  }
}
