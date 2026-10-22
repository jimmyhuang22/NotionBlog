import { createDatabasePool } from "../src/server/database/connection.ts";
import { exportPublicationArchive, restorePublicationArchive, createPublicationArchiveStore, validatePublicationArchive, archivedPublicationObjects } from "../src/server/database/publication-archive.ts";
import { createWebsiteArchiveMediaReader } from "../src/server/database/website-archive-media.ts";
import { createLocalMediaStorage } from "../src/server/database/local-storage.ts";
import { createSupabaseStorage, verifyMediaBytes } from "../src/server/database/storage.ts";
import { createNotionClient } from "../src/server/notion/client.ts";
import { createImageDownloader } from "./notion-sync/download.ts";

/** Owner-only backup/restore, never imported by the website or a recurring worker. */
async function main() {
  const [command, path, flag, ...extra] = process.argv.slice(2);
  if (!["export", "verify", "restore"].includes(command ?? "") || !path || extra.length ||
      flag !== undefined && !(command === "export" && flag === "--media")) throw new Error("Invalid publication archive command.");
  const files = createPublicationArchiveStore(), bundle = command === "export" ? undefined : await files.load(path);
  if (command === "verify") { console.log(JSON.stringify({verified: true, mediaIncluded: bundle!.mediaIncluded, mediaFiles: bundle!.mediaFiles})); return; }
  const url = process.env.DATABASE_MIGRATION_URL, pool = createDatabasePool(url, process.env.DATABASE_TLS, process.env.DATABASE_CA_CERT);
  let client;
  try {
    client = await pool.connect();
    if (command === "restore") {
      await restorePublicationArchive(client, bundle!.archive);
      console.log(JSON.stringify({restored: true, publicationEnabled: false, operationHistoryRestored: true, objectUploads: 0}));
      return;
    }
    const archive = await exportPublicationArchive(client); validatePublicationArchive(archive);
    let stored: ReturnType<typeof createSupabaseStorage> | undefined, notion: ReturnType<typeof createNotionClient> | undefined;
    const storage = () => stored ??= process.env.DATABASE_MEDIA_DIRECTORY ? createLocalMediaStorage(process.env.DATABASE_MEDIA_DIRECTORY, url ?? "", "reader") :
      createSupabaseStorage({url: process.env.STORAGE_URL ?? "", bucket: process.env.STORAGE_BUCKET ?? "", apiKey: process.env.STORAGE_API_KEY ?? "", token: process.env.STORAGE_READ_TOKEN ?? "", role: "reader"});
    const core = createWebsiteArchiveMediaReader(archive.core, {storage,
      client: () => notion ??= createNotionClient({token: process.env.NOTION_TOKEN ?? "", notionVersion: process.env.NOTION_API_VERSION}),
      download: createImageDownloader({userAgent: process.env.SYNC_IMAGE_USER_AGENT})});
    const derivatives = new Set((archive.thumbnails?.media ?? []).map(t => (t.descriptor as {objectKey: string}).objectKey));
    const objects = archivedPublicationObjects(archive);
    const bytes = flag !== "--media" ? undefined : {read: async (media: Parameters<typeof core.read>[0]) => {
      if (!objects.some(m => JSON.stringify(m) === JSON.stringify(media))) throw new Error("Unexpected backup object.");
      const data = derivatives.has(media.objectKey) ? await storage().read(media) : await core.read(media);
      verifyMediaBytes(media, data); return data;
    }};
    console.log(JSON.stringify({exported: true, operationHistoryIncluded: true, ...await files.save(path, archive, bytes)}));
  } finally {client?.release(); await pool.end();}
}
main().catch(() => {console.error("Publication backup failed. Check private files, complete migrations and an empty owner-only target; provider details are withheld."); process.exitCode = 1;});
