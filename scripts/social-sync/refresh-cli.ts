import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { privateDirectory, readPrivateFile, acquireLock } from "../notion-sync/state.ts";
import { writeJson } from "../game-sync/private.ts";
import { openStore } from "./store.ts";
import { openCollectionStore } from "./collection-store.ts";
import { planRefresh, refreshConfig, MAX_REFRESH_CONFIG_BYTES } from "./refresh.ts";
import { SocialSyncError } from "./model.ts";

export const usage = "node scripts/social-sync/refresh-cli.ts plan <absolute-private-directory>";
export async function runRefreshCli(args: string[]) {
  if (args.length === 1 && args[0] === "--help") { console.log(usage); return; }
  const [command, root] = args;
  if (args.length !== 2 || command !== "plan" || !root || !isAbsolute(root) || resolve(root) !== root) throw new SocialSyncError("USAGE");
  process.umask(0o077);
  await privateDirectory(root);
  const release = await acquireLock(root, randomUUID());
  let publications: Awaited<ReturnType<typeof openStore>> = null, collections: Awaited<ReturnType<typeof openCollectionStore>> = null;
  try {
    const raw = JSON.parse(await readPrivateFile(join(root, "refresh-config.json"), MAX_REFRESH_CONFIG_BYTES)), scope = refreshConfig(raw);
    // Read-only opening must not initialize a missing source or migrate an older store.
    if (scope.publications.length) {
      await lstat(scope.stateDirectories.publications); await privateDirectory(scope.stateDirectories.publications);
      publications = await openStore(scope.stateDirectories.publications, true);
      if (!publications) throw new SocialSyncError("REFRESH_STATE_MISSING");
    }
    if (scope.collections.length) {
      await lstat(scope.stateDirectories.collections); await privateDirectory(scope.stateDirectories.collections);
      collections = await openCollectionStore(scope.stateDirectories.collections, true);
      if (!collections) throw new SocialSyncError("REFRESH_STATE_MISSING");
    }
    const plan = planRefresh(raw, { publication: target => publications?.latest(target) ?? null, collection: target => collections?.latest(target)?.snapshot ?? null }, new Date().toISOString());
    await writeJson(join(root, "refresh-plan.json"), plan);
    console.log(JSON.stringify({ ...plan.summary, batches: plan.batches.length, browserSessionRequired: plan.browserSessionRequired, executed: false, websiteEligibilityRenewed: false }));
  } finally { publications?.close(); collections?.close(); await release(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runRefreshCli(process.argv.slice(2)).catch(error => {
    const code = error instanceof SocialSyncError ? error.code : error?.code === "BUSY" ? "BUSY" : "REFRESH_PLAN_FAILED";
    console.error(JSON.stringify({ code })); process.exitCode = 1;
  });
}
