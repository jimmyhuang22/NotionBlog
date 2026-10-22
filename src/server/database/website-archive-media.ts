import type { StoredMedia } from "../../../contracts/sync.ts";
import type { MediaSourceBinding } from "../media/notion-source.ts";
import { resolveNotionMediaSource } from "../notion/media-source.ts";
import type { NotionReadClient } from "../notion/types.ts";
import { archivedWebsiteObjects, validateWebsiteArchive, type WebsiteDatabaseArchive } from "./website-archive.ts";
import { verifyMediaBytes, type ObjectStorage } from "./storage.ts";

interface ArchiveMediaPorts {
  storage(): Pick<ObjectStorage, "read">;
  client(): NotionReadClient;
  download(url: string): Promise<{ bytes: Uint8Array; transformed?: true }>;
}
function unavailable(): never { throw new Error("Private website backup media is unavailable."); }

/** Operator-only bytes reader, including historical content; never a public media route. */
export function createWebsiteArchiveMediaReader(archive: WebsiteDatabaseArchive, ports: ArchiveMediaPorts): Pick<ObjectStorage, "read"> {
  validateWebsiteArchive(archive);
  const indexed = new Map(archive.format === "notionblog-website-archive-2" ?
    archive.mediaSources.sources.map(row => [`${row.run_id}/${row.asset_id}`, row.binding]) : []);
  const plan = new Map<string, { stored: StoredMedia | null; bindings: Map<string, MediaSourceBinding> }>();
  for (const row of archive.tables.media) {
    const media = row.descriptor as StoredMedia;
    const entry = plan.get(media.objectKey) ?? { stored: null, bindings: new Map() };
    const binding = indexed.get(`${row.run_id}/${row.asset_id}`);
    if (!binding || binding.delivery === "storage") entry.stored = media;
    else entry.bindings.set(JSON.stringify([binding.ownerPageId, binding.locator, binding.sourceFingerprint]), binding);
    plan.set(media.objectKey, entry);
  }
  const descriptors = new Map(archivedWebsiteObjects(archive).map(media => [media.objectKey, media]));
  return {
    async read(media) {
      // Accept only an exact descriptor from the validated archive.
      const expected = descriptors.get(media.objectKey), entry = plan.get(media.objectKey);
      if (!expected || !entry || JSON.stringify(media) !== JSON.stringify(expected)) unavailable();
      // Explicit Notion locators can also supply the same hash as an old or
      // incompletely indexed historical row; they still prove the exact bytes.
      if (entry.bindings.size === 0 && entry.stored) {
        const bytes = await ports.storage().read(entry.stored); verifyMediaBytes(media, bytes); return bytes;
      }
      const client = ports.client();
      // The locator itself supplies the private cover mapping. This is a backup
      // of archived bytes, not a publication decision or a source-list scan.
      for (const binding of entry.bindings.values()) {
        const resolved = await resolveNotionMediaSource(binding, {
          resolveMediaOwner: async id => {
            const page = await client.getPage(id);
            return page ? { page, source: { cover: binding.locator.kind === "property" ?
              { strategy: "files-property", property: binding.locator.name } : { strategy: "native-page-cover" } } } : null;
          },
        }, client);
        if (!resolved || resolved.sourceFingerprint !== binding.sourceFingerprint) continue;
        const downloaded = await ports.download(resolved.url);
        if (downloaded.transformed) unavailable();
        verifyMediaBytes(media, downloaded.bytes);
        return downloaded.bytes;
      }
      // Missing, moved, changed or expired originals cannot complete a backup.
      // No stale Storage object is tried for a Notion-only archived object.
      return unavailable();
    },
  };
}
