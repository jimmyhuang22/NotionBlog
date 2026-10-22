import type { AnyContent, ContentDetail, ContentKind } from "./content.ts";
import type { SyncRecord, StoredMedia, RunLease, PublicationReceipt } from "./sync.ts";
import protocol from "../database/website-protocol.json" with { type: "json" };
export const WEBSITE_PROTOCOL = protocol.protocol;
export const WEBSITE_SCHEMA_DIGEST = protocol.schemaDigest;
export interface WebsiteRecord { detail: ContentDetail<AnyContent>; evidence: SyncRecord["evidence"] }
export interface WebsitePolicy {
  configDigest: string; freshnessSeconds: number;
  sources: {key: string; kind: ContentKind; mode: "all" | "allowlist" | "course-descendants"; dataSourceId: string | null; databaseParentId: string | null; pageId: string | null}[];
  permits: {id: string; kind: ContentKind; sourceKey: string; courseId: string | null; parentId: string | null}[];
}
export interface WebsiteWriter {
  /** Mandatory before beginning a run that uses automatic study policy. */
  verifyStudy?(): Promise<void>;
  begin(runId: string,digest: string,seconds?: number): Promise<RunLease>;
  renew(lease: RunLease,seconds?: number): Promise<void>;
  stage(lease: RunLease,records: WebsiteRecord[],media?: StoredMedia[]): Promise<void>;
  promote(lease: RunLease,receipt: PublicationReceipt): Promise<void>;
  fail(lease: RunLease): Promise<void>;
}
