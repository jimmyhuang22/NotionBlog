import type { ImageAsset } from "../../contracts/content.ts";
import { isFullPage, type PageObjectResponse } from "@notionhq/client";
import type { StoredMedia } from "../../contracts/sync.ts";
import type { WebsiteRecord } from "../../contracts/website-sync.ts";
import { canonicalJson, configDigest, validateMedia, validateWebsiteRecord } from "../../src/server/database/website-validation.ts";
import type { RegisterBlockImageInput } from "../../src/server/notion/blocks.ts";
import { normalizeId } from "../../src/server/notion/config.ts";
import { createWebsiteNotionRepository } from "../../src/server/notion/website-repository.ts";
import { assertWebsiteSourceSchema, websiteCollectionTimeZone, type WebsiteNotionConfig } from "../../src/server/notion/website-config.ts";
import type { ConfirmedWithdrawal } from "../../src/server/database/incremental-publication.ts";
import type { NotionReadClient } from "../../src/server/notion/types.ts";
import { sanitizePublicText } from "../../src/server/notion/public-text.ts";
import { assertCompleteTraversal } from "../website-sync/worker.ts";
import type { QueueTicket } from "./queue.ts";
import type { PreparedDelta, Preparation, PublicationState } from "./executor.ts";

export interface PreparedImage { image: ImageAsset; media: StoredMedia; verified: true }
export interface PagePreparationOptions {
  client: NotionReadClient; config: WebsiteNotionConfig; expectedConfigDigest: string;
  ticket: QueueTicket; ordinal: number; deniedPageIds?: ReadonlySet<string>; signal: AbortSignal;
  /** Stable descriptors for reused or newly verified independent assets. */
  prepareImage(input: RegisterBlockImageInput, signal: AbortSignal): Promise<PreparedImage | null>;
}
export type PreparedPage = { outcome: "ready"; record: WebsiteRecord; media: StoredMedia[] } |
  { outcome: "review"; code: string } | { outcome: "pending"; code: string };
function guard(signal: AbortSignal) { if (signal.aborted) throw new Error("CANCELLED"); }
function pageVersion(page: PageObjectResponse) {
  return canonicalJson([normalizeId(page.id), page.last_edited_time, page.parent, page.archived, page.in_trash, page.is_archived ?? false]);
}

/** Page bodies are fetched here; publication and storage transport remain separate ports. */
export async function prepareSinglePage(options: PagePreparationOptions): Promise<PreparedPage> {
  guard(options.signal);
  const source = options.config.sources.find(s => s.enabled && s.key === options.ticket.sourceKey);
  if (!source || configDigest(options.config) !== options.expectedConfigDigest) return { outcome: "review", code: "SOURCE_SCOPE_MISMATCH" };
  const timeZone = websiteCollectionTimeZone(options.config);
  let canonical: string;
  try { canonical = normalizeId(options.ticket.pageKey); } catch { return { outcome: "review", code: "SOURCE_PAGE_ID_INVALID" }; }
  const media = new Map<string, StoredMedia>();
  let firstVersion: string | undefined, unavailable = false;
  async function read<T>(call: () => Promise<T>) { guard(options.signal); const value = await call(); guard(options.signal); return value; }
  const client: NotionReadClient = {
    getPage: id => read(async () => {
      const page = await options.client.getPage(id);
      if (page && normalizeId(page.id) === canonical && firstVersion === undefined) {
        firstVersion = pageVersion(page);
      }
      return page;
    }),
    getDataSource: id => read(() => options.client.getDataSource(id)),
    getBlock: id => read(() => options.client.getBlock(id)),
    listBlocks: id => read(() => options.client.listBlocks(id)),
    ...(options.client.listPages ? { listPages: (id: string) => read(() => options.client.listPages!(id)) } : {}),
    ...(options.client.getDatabase ? { getDatabase: (id: string) => read(() => options.client.getDatabase!(id)) } : {}),
  };
  const repository = createWebsiteNotionRepository({ client, config: options.config, timeZone,
    registerImage: async input => {
      const asset = await read(() => options.prepareImage(input, options.signal));
      if (!asset || asset.verified !== true) { unavailable = true; return null; }
      validateMedia(asset.media);
      if (asset.media.assetId !== asset.image.id || asset.media.ownerPageId !== normalizeId(input.ownerPageId) ||
        asset.image.src !== `/media/v2/${asset.media.assetId}` ||
        asset.image.width !== asset.media.width || asset.image.height !== asset.media.height) throw new Error("MEDIA_DESCRIPTOR_MISMATCH");
      const old = media.get(asset.media.assetId);
      if (old && JSON.stringify(old) !== JSON.stringify(asset.media)) throw new Error("MEDIA_DESCRIPTOR_MISMATCH");
      media.set(asset.media.assetId, asset.media); return { ...asset.image, alt: sanitizePublicText(asset.image.alt) };
    },
  });
  const record = await repository.collectRecord(canonical, { kind: source.kind, ordinal: options.ordinal, denied: options.deniedPageIds });
  if (!record || record.evidence.sourceKey !== options.ticket.sourceKey) return { outcome: "review", code: "SOURCE_SCOPE_UNKNOWN" };
  if (unavailable) return { outcome: "pending", code: "MEDIA_PENDING" };
  if (!record.detail.document) return { outcome: "review", code: "CONTENT_INCOMPLETE" };
  // Preserve existing supported partial representations, reject traversal/media loss.
  assertCompleteTraversal(record.detail.document.blocks); validateWebsiteRecord(record);
  const latest = await read(() => options.client.getPage(canonical));
  const version = latest && pageVersion(latest);
  if (!firstVersion || version !== firstVersion) return { outcome: "pending", code: "SOURCE_CHANGED_DURING_PREPARATION" };
  return { outcome: "ready", record, media: [...media.values()] };
}

export interface PublishedPage {
  record: WebsiteRecord; media: StoredMedia[]; publicationRevision: string;
  configDigest: string; schemaDigest: string; readerVerified: true;
}
export interface PageDeltaInput {
  expectedRevision: string; configDigest: string; upserts: WebsiteRecord[]; media: StoredMedia[]; withdrawals: ConfirmedWithdrawal[];
}
export interface PageWithdrawalOptions {
  client: NotionReadClient; config: WebsiteNotionConfig; ticket: QueueTicket; state: PublicationState;
  published: PublishedPage; deniedPageIds?: ReadonlySet<string>; signal: AbortSignal;
}
export type PageWithdrawal = { outcome: "confirmed"; withdrawal: ConfirmedWithdrawal } |
  { outcome: "review" | "retry"; code: string };

/** Positive current source facts plus the exact published identity, never absence alone. */
export async function preparePublishedWithdrawal(options: PageWithdrawalOptions): Promise<PageWithdrawal> {
  const { client, config, ticket, state, published, signal } = options;
  guard(signal);
  const source = config.sources.find(s => s.enabled && s.key === ticket.sourceKey);
  if (!source || configDigest(config) !== state.configDigest) return { outcome: "review", code: "SOURCE_SCOPE_MISMATCH" };
  if (source.kind === "course" || source.kind === "study-note") return { outcome: "review", code: "DEPENDENCY_WITHDRAWAL_REQUIRED" };
  let id: string;
  try { id = normalizeId(ticket.pageKey); } catch { return { outcome: "review", code: "SOURCE_PAGE_ID_INVALID" }; }
  if (published.readerVerified !== true || published.publicationRevision !== state.publicationRevision ||
    published.configDigest !== state.configDigest || published.schemaDigest !== state.schemaDigest) return { outcome: "retry", code: "PUBLICATION_VERSION_CHANGED" };
  try {
    validateWebsiteRecord(published.record); published.media.forEach(validateMedia);
    if (published.record.detail.item.id !== id || published.record.evidence.sourceKey !== ticket.sourceKey ||
      published.record.detail.item.kind !== source.kind || published.media.some(m => m.ownerPageId !== id)) throw new Error();
  } catch { return { outcome: "review", code: "PUBLISHED_PAGE_MISMATCH" }; }
  if (options.deniedPageIds?.has(id)) return { outcome: "review", code: "POLICY_RECONCILIATION_REQUIRED" };
  if (source.publication.mode === "allowlist" && !source.publication.allowlistPageIds.includes(id)) return { outcome: "review", code: "POLICY_RECONCILIATION_REQUIRED" };
  if (source.kind === "page" && source.pageId !== id) return { outcome: "review", code: "PUBLISHED_PAGE_MISMATCH" };
  async function read<T>(call: () => Promise<T>) { guard(signal); const value = await call(); guard(signal); return value; }
  if (source.dataSourceId) {
    const schema = await read(() => client.getDataSource(source.dataSourceId!));
    try {
      if (normalizeId(schema.id) !== source.dataSourceId) throw new Error();
      assertWebsiteSourceSchema(source, schema);
    } catch { return { outcome: "review", code: "SOURCE_SCHEMA_UNCONFIRMED" }; }
  }
  const page = await read(() => client.getPage(id));
  if (!page || !isFullPage(page) || normalizeId(page.id) !== id || !page.parent) return { outcome: "review", code: "SOURCE_SCOPE_UNKNOWN" };
  let reason: ConfirmedWithdrawal["reason"] | null = null;
  if (page.archived === true || page.in_trash === true || page.is_archived === true) reason = "archived";
  else if (source.dataSourceId) {
    if (page.parent.type === "data_source_id") {
      if (normalizeId(page.parent.data_source_id) !== source.dataSourceId) reason = "out-of-scope";
    } else if (["page_id", "block_id", "workspace"].includes(page.parent.type)) reason = "out-of-scope";
    // A legacy database parent cannot distinguish its individual data sources.
  }
  if (!reason) return { outcome: "review", code: "SOURCE_SCOPE_UNKNOWN" };
  const latest = await read(() => client.getPage(id));
  if (!latest || !isFullPage(latest) || pageVersion(latest) !== pageVersion(page)) return { outcome: "retry", code: "SOURCE_CHANGED_DURING_PREPARATION" };
  return { outcome: "confirmed", withdrawal: { id, sourceKey: source.key, reason } };
}
export interface ContentPreparationOptions<T extends PreparedDelta> {
  client: NotionReadClient; config: WebsiteNotionConfig; prepareImage: PagePreparationOptions["prepareImage"];
  placement(ticket: QueueTicket, state: PublicationState, signal: AbortSignal): Promise<{ ordinal: number; deniedPageIds?: ReadonlySet<string> }>;
  /** Bounded single-page projection from the independent reader, never an unqualified cache. */
  readPublished(ticket: QueueTicket, state: PublicationState, signal: AbortSignal): Promise<PublishedPage | null>;
  /** Supplied by the separately owned publication helper, which validates and hashes the delta. */
  prepareDelta(input: PageDeltaInput): T;
}
function comparable(record: WebsiteRecord, media: StoredMedia[]) {
  return canonicalJson({ record, media: [...media].sort((a, b) => a.assetId.localeCompare(b.assetId)) });
}

/** Connect the page/media preparation to the executor without a default cloud or source client. */
export function createSinglePagePreparationPort<T extends PreparedDelta>(options: ContentPreparationOptions<T>) {
  return async (ticket: QueueTicket, state: PublicationState, signal: AbortSignal): Promise<Preparation<T>> => {
    guard(signal);
    const placement = await options.placement(ticket, state, signal); guard(signal);
    const current = await prepareSinglePage({ client: options.client, config: options.config, ticket, signal,
      expectedConfigDigest: state.configDigest, ordinal: placement.ordinal, deniedPageIds: placement.deniedPageIds,
      prepareImage: options.prepareImage });
    if (current.outcome === "pending") return { outcome: "retry", code: current.code };
    if (current.outcome === "review") {
      if (current.code !== "SOURCE_SCOPE_UNKNOWN") return current;
      const published = await options.readPublished(ticket, state, signal); guard(signal);
      if (!published) return current;
      const withdrawal = await preparePublishedWithdrawal({ client: options.client, config: options.config, ticket, state,
        published, signal, deniedPageIds: placement.deniedPageIds });
      if (withdrawal.outcome !== "confirmed") return withdrawal;
      const delta = options.prepareDelta({ expectedRevision: state.publicationRevision, configDigest: state.configDigest,
        upserts: [], media: [], withdrawals: [withdrawal.withdrawal] });
      guard(signal); return { outcome: "prepared", delta };
    }
    const previous = await options.readPublished(ticket, state, signal); guard(signal);
    if (previous) {
      if (previous.readerVerified !== true || previous.publicationRevision !== state.publicationRevision ||
        previous.configDigest !== state.configDigest || previous.schemaDigest !== state.schemaDigest) {
        return { outcome: "retry", code: "PUBLICATION_VERSION_CHANGED" };
      }
      if (previous.record.detail.item.id !== current.record.detail.item.id || previous.record.evidence.sourceKey !== ticket.sourceKey) {
        return { outcome: "review", code: "PUBLISHED_PAGE_MISMATCH" };
      }
      validateWebsiteRecord(previous.record); previous.media.forEach(validateMedia);
      if (comparable(current.record, current.media) === comparable(previous.record, previous.media)) return { outcome: "unchanged" };
    }
    const delta = options.prepareDelta({ expectedRevision: state.publicationRevision, configDigest: state.configDigest,
      upserts: [current.record], media: current.media, withdrawals: [] });
    guard(signal); return { outcome: "prepared", delta };
  };
}
