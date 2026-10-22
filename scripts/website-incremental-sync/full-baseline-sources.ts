import type { NotionReadClient } from "../../src/server/notion/types.ts";
import { verifyMediaBytes, type ObjectStorage } from "../../src/server/database/storage.ts";
import type { DownloadedImage } from "../notion-sync/download.ts";
import { createWebsiteImageDownloader } from "../website-sync/download.ts";
import type { WebsiteImageCache } from "../website-sync/image-cache.ts";
import type { NotionRequestScheduler } from "../../src/server/notion/request-scheduler.ts";
import { createIncrementalNotionTransport } from "./notion-transport.ts";
import { hostAwait, type HostBudget } from "./host-budget.ts";

export interface FullBaselineSources {
  client: NotionReadClient; storage: ObjectStorage;
  download(url: string): Promise<DownloadedImage>;
}
type WebsiteDownloadOptions = NonNullable<Parameters<typeof createWebsiteImageDownloader>[0]>;
/** The same charged SDK and safe image/cache path used by daily increments.
 * No policy changes, source writes, implicit object provider or live fallback. */
export function createFullBaselineSources(options: { token: string; notionVersion?: string; budget: HostBudget;
  storage: ObjectStorage; imageCache?: WebsiteImageCache; convertHeic?: WebsiteDownloadOptions["convertHeic"];
  userAgent?: string; fetch?: typeof fetch; scheduler?: NotionRequestScheduler }) : FullBaselineSources {
  const { budget } = options;
  const transport = createIncrementalNotionTransport(options);
  const download = createWebsiteImageDownloader({ userAgent: options.userAgent, convertHeic: options.convertHeic }, {
    cache: options.imageCache, onReceivedBytes: n => budget.observe("mediaBytes", n),
  });
  return { client: transport.client,
    download: url => hostAwait(budget, () => download(url, budget.signal)),
    storage: {
      async read(media) {
        budget.charge("mediaBytes", media.byteSize);
        const bytes = await hostAwait(budget, () => options.storage.read(media));
        budget.guard(); verifyMediaBytes(media, bytes); return bytes;
      },
      async put(media, bytes) {
        budget.guard(); verifyMediaBytes(media, bytes);
        // Immutable put may internally verify an existing object once. Reserve
        // both attempts, even if put fails, and separately prove stored bytes.
        budget.charge("mediaBytes", media.byteSize * 2);
        await hostAwait(budget, () => options.storage.put(media, bytes)); budget.guard();
        budget.charge("mediaBytes", media.byteSize);
        const stored = await hostAwait(budget, () => options.storage.read(media));
        budget.guard(); verifyMediaBytes(media, stored);
      },
    },
  };
}
