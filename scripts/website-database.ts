import { closeOwnerPool } from "./cleanup.ts";
import { createDatabasePool } from "../src/server/database/connection.ts";
import { exportWebsiteArchive, restoreWebsiteArchive } from "../src/server/database/website-archive.ts";
import { createWebsiteArchiveStore } from "../src/server/database/website-archive-files.ts";
import { createLocalMediaStorage } from "../src/server/database/local-storage.ts";
import { createSupabaseStorage } from "../src/server/database/storage.ts";
import { createWebsiteArchiveMediaReader } from "../src/server/database/website-archive-media.ts";
import { createNotionClient } from "../src/server/notion/client.ts";
import { createImageDownloader } from "./notion-sync/download.ts";

/** Operator only. Load a private --env-file; this module never enters the web runtime. */
async function main() {
  const [command, path, flag, ...extra] = process.argv.slice(2);
  if (!["export", "verify", "restore"].includes(command ?? "") || !path || extra.length ||
    (flag !== undefined && !(command === "export" && flag === "--media"))) throw new Error("Invalid archive command.");
  const files = createWebsiteArchiveStore();
  // Verification is completely offline and does not require any database credentials.
  const bundle = command === "export" ? undefined : await files.load(path);
  if (command === "verify") {
    console.log(JSON.stringify({ verified: true, mediaIncluded: bundle!.mediaIncluded, mediaFiles: bundle!.mediaFiles })); return;
  }
  const url = process.env.DATABASE_MIGRATION_URL;
  const pool = createDatabasePool(url, process.env.DATABASE_TLS, process.env.DATABASE_CA_CERT);
  let client;
  let failed = false;
  try {
    client = await pool.connect();
    if (command === "export") {
      const archive = await exportWebsiteArchive(client);
      let stored: ReturnType<typeof createSupabaseStorage> | undefined;
      let notionClient: ReturnType<typeof createNotionClient> | undefined;
      const storage = flag !== "--media" ? undefined : createWebsiteArchiveMediaReader(archive, {
        storage: () => stored ??= process.env.DATABASE_MEDIA_DIRECTORY ?
          createLocalMediaStorage(process.env.DATABASE_MEDIA_DIRECTORY, url ?? "", "reader") :
          createSupabaseStorage({ url: process.env.STORAGE_URL ?? "", bucket: process.env.STORAGE_BUCKET ?? "", apiKey: process.env.STORAGE_API_KEY ?? "", token: process.env.STORAGE_READ_TOKEN ?? "", role: "reader" }),
        client: () => notionClient ??= createNotionClient({ token: process.env.NOTION_TOKEN ?? "", notionVersion: process.env.NOTION_API_VERSION }),
        download: createImageDownloader({ userAgent: process.env.SYNC_IMAGE_USER_AGENT }),
      });
      console.log(JSON.stringify({ exported: true, ...await files.save(path, archive, storage) }));
    } else {
      await restoreWebsiteArchive(client, bundle!.archive);
      console.log(JSON.stringify({ restored: true, publicationEnabled: false, objectUploads: 0, mediaBackupVerified: bundle!.mediaIncluded }));
    }
  } catch (error) { failed = true; throw error; }
  finally { await closeOwnerPool(pool, client, failed); }
}
main().catch(() => {
  console.error("Website backup operation failed. Check the private files, version, empty target and operator permissions; provider details are withheld."); process.exitCode = 1;
});
