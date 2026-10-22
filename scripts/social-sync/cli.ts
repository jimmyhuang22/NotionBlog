import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { acquireLock, privateDirectory, readPrivateFile } from "../notion-sync/state.ts";
import { writeJson } from "../game-sync/private.ts";
import { config, publicationKey, SocialSyncError } from "./model.ts";
import { openStore, flushOutbox } from "./store.ts";
import { collectTargets } from "./worker.ts";
import { browserCaptureScript, MAX_SNAPSHOT_BYTES, snapshotBatch } from "./xiaohongshu.ts";
import { cloudConfig, connectCloud } from "./cloud.ts";
import { collectionConfig, collectionKey } from "./collection.ts";
import { openCollectionStore, flushCollectionOutbox } from "./collection-store.ts";
import { collectCollections } from "./collection-worker.ts";
import { planDetailBatches } from "./detail-plan.ts";
import { connectCollectionCloud } from "./collection-cloud.ts";

const commands = ["collect", "capture-script", "import-xhs", "upload", "status", "export", "collect-collections", "collections-status", "collections-export", "upload-collections", "plan-details"];
export const usage = `node scripts/social-sync/cli.ts <${commands.join("|")}> <absolute-private-directory>`;
export async function runCli(args: string[]) {
  if (args.length === 1 && ["--help", "help"].includes(args[0])) { console.log(usage); return; }
  const [command, root] = args;
  if (args.length !== 2 || !commands.includes(command) || !isAbsolute(root) || resolve(root) !== root) {
    throw new SocialSyncError("USAGE");
  }
  process.umask(0o077);
  await privateDirectory(root);
  if (command === "status" || command === "collections-status") {
    const store = await (command === "status" ? openStore(root, true) : openCollectionStore(root, true));
    try { console.log(JSON.stringify(store ? { initialized: true, ...store.status() } : { initialized: false })); }
    finally { store?.close(); }
    return;
  }
  const release = await acquireLock(root, randomUUID());
  let store: Awaited<ReturnType<typeof openStore>> = null;
  let collections: Awaited<ReturnType<typeof openCollectionStore>> = null;
  const controller = new AbortController(), cancel = () => controller.abort();
  const timer = setTimeout(cancel, 120000); timer.unref();
  process.once("SIGTERM", cancel); process.once("SIGINT", cancel);
  try {
    // Validate inputs before creating or migrating the local database.
    if (command === "plan-details") {
      const existing = config(JSON.parse(await readPrivateFile(join(root, "config.json"))));
      const plan = planDetailBatches(JSON.parse(await readPrivateFile(join(root, "catalog.json"), 512 * 1024)), existing);
      await writeJson(join(root, "detail-plan.json"), plan);
      console.log(JSON.stringify({ planned: plan.ready, skippedConfigured: plan.skippedConfigured, blocked: plan.blocked.length, batches: plan.batches.length, executed: false }));
      return;
    }
    if (["collect-collections","collections-export","upload-collections"].includes(command)) {
      const targets = command !== "collections-export" ? collectionConfig(JSON.parse(await readPrivateFile(join(root, "collection-config.json")))) : null;
      const cloud = command === "upload-collections" ? await readPrivateFile(join(root,"cloud.env"),65536) : null;
      if(cloud!==null) cloudConfig(cloud);
      collections = await openCollectionStore(root, command === "collections-export");
      if (command === "collections-export") {
        const items = collections?.cards() ?? [];
        await writeJson(join(root, "collection-candidates.json"), { version: 1, cloudUploadSupported: true, websitePublicationApproved: false, items });
        console.log(JSON.stringify({ exported: items.length, cloudUploaded: 0 })); return;
      }
      if (!collections) throw new SocialSyncError("PRIVATE_STATE_INVALID");
      if(cloud!==null) {
        const session=await connectCollectionCloud(cloud,controller.signal);
        try {
          const report=await flushCollectionOutbox(collections,session.send,{allowedKeys:new Set(targets!.map(collectionKey)),signal:controller.signal});
          await writeJson(join(root,"latest-collection-upload.json"),{finishedAt:new Date().toISOString(),...report,pending:collections.status().pending});
          console.log(JSON.stringify({...report,pending:collections.status().pending}));
          if(report.failed || report.cancelled || report.skipped)process.exitCode=1;
        } finally {await session.close();}
        return;
      }
      const report = await collectCollections(targets!, collections, { signal: controller.signal });
      await writeJson(join(root, "latest-collection-run.json"), { finishedAt: new Date().toISOString(), ...report });
      console.log(JSON.stringify(report));
      if (report.failed || report.cancelled) process.exitCode = 1;
      return;
    }
    const targets = ["collect", "capture-script", "import-xhs", "upload"].includes(command) ? config(JSON.parse(await readPrivateFile(join(root, "config.json")))) : null;
    if (command === "capture-script") {
      await writeJson(join(root, "browser-capture.json"), { version: 1, script: browserCaptureScript(targets!) });
      console.log(JSON.stringify({ generated: true, captured: 0 })); return;
    }
    const snapshots = command === "import-xhs" ? snapshotBatch(await readPrivateFile(join(root, "xiaohongshu-snapshot.json"), MAX_SNAPSHOT_BYTES), targets!) : null;
    const cloud = command === "upload" ? await readPrivateFile(join(root, "cloud.env"), 65536) : null;
    if (cloud !== null) cloudConfig(cloud);
    store = await openStore(root);
    if (!store) throw new SocialSyncError("PRIVATE_STATE_INVALID");
    if (cloud !== null) {
      store.checkTargets(targets!);
      const session = await connectCloud(cloud, controller.signal);
      try {
        const report = await flushOutbox(store, session.send, { allowedKeys: new Set(targets!.map(publicationKey)), signal: controller.signal });
        await writeJson(join(root, "latest-upload.json"), { finishedAt: new Date().toISOString(), ...report, pending: store.status().pending });
        console.log(JSON.stringify({ ...report, pending: store.status().pending }));
        if (report.failed || report.cancelled || report.skipped) process.exitCode = 1;
      } finally { await session.close(); }
    } else if (snapshots) {
      const report = { inserted: 0, updated: 0, duplicate: 0, older: 0, imported: snapshots.length };
      const results = store.ingestBatch(snapshots);
      for (const [index, row] of snapshots.entries()) {
        report[results[index]]++;
        store.recordAttempt({ ...row, url: row.originalUrl }, new Date().toISOString(), "OK");
      }
      await writeJson(join(root, "latest-import.json"), { finishedAt: new Date().toISOString(), ...report, pending: store.status().pending });
      console.log(JSON.stringify({ ...report, pending: store.status().pending }));
    } else if (command === "export") {
      const items = store.pending();
      await writeJson(join(root, "pending.json"), { version: 1, items });
      console.log(JSON.stringify({ exported: items.length, acknowledged: 0 }));
    } else {
      const report = await collectTargets(targets!, store, { signal: controller.signal });
      await writeJson(join(root, "latest-run.json"), { finishedAt: new Date().toISOString(), ...report });
      console.log(JSON.stringify(report));
      if (report.failed || report.cancelled) process.exitCode = 1;
    }
  } finally {
    clearTimeout(timer); process.removeListener("SIGTERM", cancel); process.removeListener("SIGINT", cancel);
    store?.close(); collections?.close(); await release();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli(process.argv.slice(2)).catch(error => {
    const code = error instanceof SocialSyncError ? error.code :
      (error && typeof error === "object" && "code" in error && error.code === "BUSY") ? "BUSY" : "SOCIAL_SYNC_FAILED";
    console.error(JSON.stringify({ code })); process.exitCode = 1;
  });
}
