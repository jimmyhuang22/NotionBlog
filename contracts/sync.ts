/** Server/worker protocol. Never import into client components. */
import type { ContentDetail, Course, StatusEntry, StudyNote } from "./content.ts";
import protocol from "../database/protocol.json" with { type: "json" };

export const SYNC_PROTOCOL = "notionblog-sync-v1";
export const SYNC_SCHEMA_DIGEST = protocol.schemaDigest;
export type SyncKind = "status" | "course" | "study-note";
export interface PolicySource {
  key: string;
  kind: SyncKind;
  mode: "all" | "allowlist";
  dataSourceId: string | null;
  /** Containing page of data_source.database_parent; for study-note this equals coursePageId. */
  databaseParentId: string | null;
}
/** Nearest containing page, not a block ID. Roots have parentId=null. */
export interface PolicyPermit {
  id: string;
  kind: "course" | "study-note";
  sourceKey: string;
  courseId: string | null;
  parentId: string | null;
}
export interface PublicationPolicy {
  configDigest: string;
  /** Required explicit staging/production freshness budget; no implicit default. */
  freshnessSeconds: number;
  sources: PolicySource[];
  permits: PolicyPermit[];
}
export interface SyncRecord {
  detail: ContentDetail<StatusEntry | Course | StudyNote>;
  evidence: {
    sourceKey: string;
    dataSourceId: string | null;
    databaseParentId: string | null;
    /** Reuse Notion repository checks before supplying this evidence. */
    courseId: string | null;
    parentId: string | null;
    ordinal: number;
  };
}
export interface StoredMedia {
  assetId: string;
  ownerPageId: string;
  /** Immutable content-addressed key; never a URL. */
  objectKey: string;
  sha256: string;
  byteSize: number;
  mime: "image/jpeg" | "image/png" | "image/webp" | "image/gif" | "image/avif";
  width: number | null;
  height: number | null;
}
export interface RunLease {
  runId: string;
  fence: string;
  revision: string;
  configDigest: string;
  deniedPageIds: string[];
}
export interface PublicationReceipt {
  records: number;
  media: number;
  /** True only after ALL configured pages/blocks/cursors completed successfully. */
  complete: boolean;
  confirmedAbsent?: number;
}
export interface ConfirmedAbsence {
  id: string;
  /** Fresh metadata proves this state. 404/network/permission failures are NOT proof. */
  reason: "archived" | "deleted" | "out-of-scope";
}
export interface SyncWriter {
  begin(runId: string, configDigest: string, leaseSeconds?: number): Promise<RunLease>;
  renew(lease: RunLease, leaseSeconds?: number): Promise<void>;
  stage(lease: RunLease, records: SyncRecord[], media?: StoredMedia[], absences?: ConfirmedAbsence[]): Promise<void>;
  promote(lease: RunLease, receipt: PublicationReceipt): Promise<void>;
  fail(lease: RunLease): Promise<void>;
}
