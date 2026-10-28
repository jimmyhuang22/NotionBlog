import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { loadManagementConfig } from "./cli.ts";
import { createManagementBackup } from "./backup.ts";
import { installFreeze } from "../website-sync/freeze-migration.ts";
import { createFreezeStore } from "../../src/server/database/freeze.ts";
import { createDatabasePool } from "../../src/server/database/connection.ts";
import { closeOwnerPool } from "../cleanup.ts";
import { acquireLock, readPrivateFile } from "../notion-sync/state.ts";
import { parseWebsiteNotionConfig } from "../../src/server/notion/website-config.ts";
import { configDigest } from "../../src/server/database/website-validation.ts";
import { openIncrementalQueue } from "../website-incremental-sync/queue.ts";
import { openStudyCheckpoint } from "../website-incremental-sync/study-checkpoint.ts";
import { openContentCache } from "../website-incremental-sync/content-cache.ts";
import { readHostJson } from "../website-incremental-sync/host-state.ts";
import { readPublicationState } from "../../src/server/database/incremental-publication.ts";
import { archivedPublicationObjects } from "../../src/server/database/publication-archive.ts";
import { createWebsiteArchiveMediaReader } from "../../src/server/database/website-archive-media.ts";
import { createLocalMediaStorage } from "../../src/server/database/local-storage.ts";
import { createSupabaseStorage, verifyMediaBytes, type ObjectStorage } from "../../src/server/database/storage.ts";
import { configuredCosStorage, storageProvider, thumbnailStorageProvider } from "../../src/server/database/cos-config.ts";
import { createNotionClient } from "../../src/server/notion/client.ts";
import { createImageDownloader } from "../notion-sync/download.ts";
import { exportPublicationArchive } from "../../src/server/database/publication-archive.ts";

/** Owner credentials stay in this explicit CLI. The bridge never launches it. */
export async function managementAdmin(args: string[], env: NodeJS.ProcessEnv = process.env) {
  if (args.length === 1 && args[0] === "--help") {
    console.log("node --env-file=PRIVATE_OWNER_ENV scripts/console-management/admin.ts install|enable --config ABSOLUTE_PRIVATE_JSON\nnode --env-file=PRIVATE_OWNER_ENV scripts/console-management/admin.ts export|restore --config ABSOLUTE_PRIVATE_JSON --path ABSOLUTE_PRIVATE_BACKUP [--media]\nnode scripts/console-management/admin.ts verify --path ABSOLUTE_PRIVATE_BACKUP"); return;
  }
  const [command, ...rest] = args, values = new Map<string, string>(); let media = false;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--media" && !media && command === "export") {media = true; continue;}
    if (!["--config", "--path"].includes(rest[i]) || values.has(rest[i]) || !rest[i + 1] || rest[i + 1].startsWith("--")) throw Error("INVALID_INPUT");
    values.set(rest[i], rest[++i]);
  }
  if (!["install", "enable", "export", "restore", "verify"].includes(command) ||
      ["export", "restore", "verify"].includes(command) !== values.has("--path") || (command !== "verify") !== values.has("--config")) throw Error("INVALID_INPUT");
  const backup = createManagementBackup(join(process.cwd(), ".local"));
  if (command === "verify") { const result = await backup.load(values.get("--path")!); console.log(JSON.stringify({verified: true, mediaIncluded: result.mediaIncluded, mediaFiles: result.mediaFiles})); return; }
  const config = await loadManagementConfig(values.get("--config")!);
  const pool = createDatabasePool(env.DATABASE_MIGRATION_URL, env.DATABASE_TLS, env.DATABASE_CA_CERT); let client, failed = false;
  const release = await acquireLock(config.lockDirectory, `management-owner-${randomUUID()}`);
  try {
    client = await pool.connect();
    if (command === "install") { await installFreeze(client); console.log(JSON.stringify({installed: true, activated: false})); return; }
    if (command === "enable") {
      if (!config.enabled || env.SYNC_PUBLICATION_MODE !== "published" || env.SYNC_MEDIA_PROVIDER !== "storage" || env.SYNC_FREEZE_ENABLED !== "1") throw Error("FREEZE_DISABLED");
      const source = parseWebsiteNotionConfig(JSON.parse(await readPrivateFile(config.sourceConfigPath))), digest = configDigest(source);
      const state = await readPublicationState(client), ready = await readHostJson(config.runtimeDirectory, "incremental-ready.json");
      await createFreezeStore(client).state();
      if (state.configDigest !== digest || !ready || ready.configDigest !== digest || ready.policyEpoch !== state.policyEpoch) throw Error("FREEZE_SCOPE_MISMATCH");
      const queue = await openIncrementalQueue(join(config.runtimeDirectory, "queue"), {digest, sourceKeys: source.sources.map(s => s.key)});
      try { const pending = queue.status(); if (pending.leased || pending.awaiting_verification || pending.retirement_pending) throw Error("BUSY"); } finally { queue.close(); }
      const study = await openStudyCheckpoint(join(config.runtimeDirectory, "study"), digest);
      try { if (study.load().version !== state.publicationRevision) throw Error("FREEZE_SCOPE_MISMATCH"); } finally { study.close(); }
      const content = await openContentCache(join(config.runtimeDirectory, "content"), digest, source.sources.map(s => s.key));
      try { content.assertState(state); } finally { content.close(); }
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout='5s'"); await client.query("SELECT nb_freeze.lock_state()");
      if ((await readPublicationState(client)).publicationRevision !== state.publicationRevision) throw Error("FREEZE_SCOPE_MISMATCH");
      await client.query("UPDATE nb_freeze.state SET enabled=true,generation=generation+1 WHERE singleton AND NOT enabled");
      // An unacknowledged COMMIT is not retried. Close the dedicated connection before unlocking.
      await client.query("COMMIT"); console.log(JSON.stringify({enabled: true, publicationRevision: state.publicationRevision})); return;
    }
    if (command === "restore") { console.log(JSON.stringify(await backup.restore(client, values.get("--path")!, config.runtimeDirectory))); return; }
    let reader: Pick<ObjectStorage, "read"> | undefined;
    if (media) {
      const archive = await exportPublicationArchive(client);
      const storage = (thumbnail: boolean) => env.DATABASE_MEDIA_DIRECTORY ? createLocalMediaStorage(env.DATABASE_MEDIA_DIRECTORY, env.DATABASE_MIGRATION_URL ?? "", "reader") :
        (thumbnail ? thumbnailStorageProvider(env) : storageProvider(env)) === "cos" ? configuredCosStorage(env, "reader") :
        createSupabaseStorage({url: env.STORAGE_URL ?? "", bucket: env.STORAGE_BUCKET ?? "", apiKey: env.STORAGE_API_KEY ?? "", token: env.STORAGE_READ_TOKEN ?? "", role: "reader"});
      const core = createWebsiteArchiveMediaReader(archive.core, {storage: () => storage(false),
        client: () => createNotionClient({token: env.NOTION_TOKEN ?? "", notionVersion: env.NOTION_API_VERSION}),
        download: createImageDownloader({userAgent: env.SYNC_IMAGE_USER_AGENT})});
      const thumbnails = new Set((archive.thumbnails?.media ?? []).map(row => (row.descriptor as {objectKey: string}).objectKey));
      const objects = new Map(archivedPublicationObjects(archive).map(m => [m.objectKey, m]));
      reader = {async read(media) {
        if (JSON.stringify(objects.get(media.objectKey)) !== JSON.stringify(media)) throw Error("BACKUP_OBJECT_CHANGED");
        const data = thumbnails.has(media.objectKey) ? await storage(true).read(media) : await core.read(media); verifyMediaBytes(media, data); return data;
      }};
    }
    console.log(JSON.stringify({exported: true, ...await backup.save(client, config.runtimeDirectory, values.get("--path")!, reader)}));
  } catch (error) { failed = true; throw error; }
  finally { try { await closeOwnerPool(pool, client, failed); } finally { await release(); } }
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) managementAdmin(process.argv.slice(2)).catch(() => {
  console.error("Management maintenance was not confirmed complete. Inspect the private backup and current database state before repeating a write; provider details are withheld."); process.exitCode = 1;
});
