import { isFullPage } from "@notionhq/client";
import type { WebsiteRecord } from "../../contracts/website-sync.ts";
import type { PublicationState } from "../../src/server/database/incremental-publication.ts";
import { preparePublicationDelta } from "../../src/server/database/incremental-publication.ts";
import type { WebsiteNotionConfig } from "../../src/server/notion/website-config.ts";
import { normalizeId } from "../../src/server/notion/config.ts";
import { configDigest } from "../../src/server/database/website-validation.ts";
import { createWebsiteStudyChangeSource } from "../../src/server/notion/website-repository.ts";
import type { StudyChangeSource } from "../../src/server/notion/study-incremental.ts";
import type { ObjectStorage } from "../../src/server/database/storage.ts";
import type { WebsiteImageCache } from "../website-sync/image-cache.ts";
import type { DownloadOptions } from "../notion-sync/download.ts";
import { createWebsiteImageDownloader } from "../website-sync/download.ts";
import { createKnownPageDirectorySource, createNotionDirectorySource, type DirectorySource } from "./discovery.ts";
import { createSinglePagePreparationPort } from "./source.ts";
import type { ContentCacheStore } from "./content-cache.ts";
import type { QueueTicket } from "./queue.ts";
import { createIncrementalNotionTransport } from "./notion-transport.ts";
import type { NotionRequestScheduler } from "../../src/server/notion/request-scheduler.ts";
import { createIndependentMediaPort } from "./independent-media.ts";
import { hostFail, type HostBudget } from "./host-budget.ts";

export function createRuntimeSources(options: { config: WebsiteNotionConfig; store: ContentCacheStore; deniedPageIds: ReadonlySet<string>; frozenPageIds?: ReadonlySet<string>;
  token: string; notionVersion?: string; budget: HostBudget; storage: ObjectStorage; imageCache?: WebsiteImageCache; userAgent?: string;
  convertHeic?: DownloadOptions["convertHeic"]; fetch?: typeof fetch; scheduler?: NotionRequestScheduler }) {
  const { config, budget, store } = options, digest = configDigest(config);
  const transport = (signal: AbortSignal) => createIncrementalNotionTransport({ token: options.token, notionVersion: options.notionVersion,
    budget, signal, fetch: options.fetch, scheduler: options.scheduler });
  let state: PublicationState, ownersVersion = "", owners = new Map<string, string>();
  const select = (current: PublicationState) => { budget.guard(); store.assertState(current); state = current; };
  const download = createWebsiteImageDownloader({ userAgent: options.userAgent, convertHeic: options.convertHeic }, { cache: options.imageCache,
    onReceivedBytes: n => budget.observe("mediaBytes", n) });
  const media = createIndependentMediaPort({ budget, storage: options.storage, download: (url, signal) => download(url, AbortSignal.any([signal, budget.signal])),
    cached(id, owner) {
      if (ownersVersion !== state.publicationRevision) {
        owners = new Map(); for (const source of config.sources) for (const page of store.knownPages(source.key, state).pageKeys) owners.set(page, source.key);
        ownersVersion = state.publicationRevision;
      }
      const key = owners.get(owner); if (!key) return null;
      return store.readPublished({ sourceKey: key, pageKey: owner }, state)?.media.find(m => m.assetId === id) ?? null;
    } });
  // Ordinals for new ordinary pages come from a complete actual metadata query,
  // using the same iteration/eligibility rules as the full collector.
  async function newOrdinal(ticket: QueueTicket, signal: AbortSignal) {
    const source = config.sources.find(s => s.key === ticket.sourceKey);
    if (!source || !source.dataSourceId || ["course", "study-note", "page"].includes(source.kind)) hostFail("HOST_NEW_PLACEMENT_REQUIRED");
    const pages = await transport(signal).client.listPages(source.dataSourceId);
    budget.guard(); signal.throwIfAborted();
    const ids = pages.filter(p => isFullPage(p) && !p.archived && !p.in_trash && !p.is_archived && p.parent.type === "data_source_id" &&
      normalizeId(p.parent.data_source_id) === source.dataSourceId && (source.publication.mode === "all" || source.publication.allowlistPageIds.includes(normalizeId(p.id))))
      .map(p => normalizeId(p.id));
    const ordinal = ids.indexOf(normalizeId(ticket.pageKey)); if (ordinal < 0) hostFail("HOST_NEW_PLACEMENT_REQUIRED"); return ordinal;
  }
  return {
    regular: { async prepare(ticket: QueueTicket, current: PublicationState, signal: AbortSignal) {
      select(current);
      if (options.frozenPageIds?.has(ticket.pageKey)) return { outcome: "unchanged" as const };
      return createSinglePagePreparationPort({ client: transport(signal).client, config,
        prepareImage: (input, s) => media.prepare(input, s), prepareDelta: preparePublicationDelta,
        readPublished: async (t, v) => store.readPublished(t, v),
        placement: async (t, v, s) => ({ ...store.placement(t, v, store.readPublished(t, v) ? undefined : await newOrdinal(t, s)), deniedPageIds: options.deniedPageIds }),
      })(ticket, current, signal);
    } },
    study(current: PublicationState, signal: AbortSignal): StudyChangeSource {
      select(current); return createWebsiteStudyChangeSource({ config, client: transport(signal).client, deniedPageIds: options.deniedPageIds,
        registerImage: async input => (await media.prepare(input, signal)).image });
    },
    assets(records: WebsiteRecord[], current: PublicationState, signal: AbortSignal) {
      select(current); signal.throwIfAborted(); return media.assets(records);
    },
    directory(sourceKey: string, current: PublicationState): DirectorySource {
      select(current); const source = config.sources.find(s => s.key === sourceKey); if (!source) hostFail("HOST_SOURCE_UNKNOWN");
      if (source.kind === "page" || source.publication.mode === "course-descendants") {
        const catalog = store.knownPages(sourceKey, current);
        return createKnownPageDirectorySource({ getPage: (id, s) => transport(s).client.getPage(id),
          getDataSource: (id, s) => transport(s).client.getDataSource(id) }, config, current,
          { ...catalog, pageKeys: catalog.pageKeys.filter(id => !options.frozenPageIds?.has(id)) });
      }
      return createNotionDirectorySource(transport(budget.signal).directory, config, digest);
    },
    children(signal: AbortSignal): StudyChangeSource {
      return createWebsiteStudyChangeSource({ config, client: transport(signal).client, deniedPageIds: options.deniedPageIds });
    },
    statistics: () => ({ ...budget.statistics(), ...media.statistics(), imageRequests: download.statistics().requests }),
  };
}
export type RuntimeSources = ReturnType<typeof createRuntimeSources>;
