import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { planWithdrawal, executeWithdrawal, withdrawalDatabaseHash } from "./withdraw.ts";
import { cacheClientConfig, cacheOperatorConnection, saveCacheJournal, readCacheJournal, acquireWithdrawalLocks } from "./local.ts";

export async function runWithdrawalCli(args: string[]) {
  const [target, flag, path, ...extra] = args;
  if (args.length === 1 && target === "--help") {
    console.log("node --env-file=<private operator env> scripts/public-cache/withdraw-cli.ts <page URL> --plan <absolute .local journal>\nnode --env-file=<private operator env> scripts/public-cache/withdraw-cli.ts --execute <absolute .local journal>\nnode --env-file=<private operator env> scripts/public-cache/withdraw-cli.ts --resume <absolute .local journal>"); return;
  }
  const planning = flag === "--plan" && !!path && extra.length === 0;
  const executing = ["--execute", "--resume"].includes(target ?? "") && !!flag && path === undefined;
  if (!planning && !executing) throw Error("WITHDRAW_USAGE");
  const config = cacheClientConfig(), connection = await cacheOperatorConnection("nb_cache_operator");
  let release: (() => Promise<void>) | undefined;
  try {
    const hash = withdrawalDatabaseHash(connection.url);
    if (planning) {
      const journal = await planWithdrawal(connection.db, target!, config, hash);
      await saveCacheJournal(path!, journal, true);
      console.log(JSON.stringify({ planned: true, pages: journal.plan.pages.length, images: journal.plan.assets.length, sharedOwnerUrl: journal.plan.sharedOwnerUrl, syncBusy: journal.plan.leaseActive, executed: false }));
    } else {
      const journal = await readCacheJournal(flag!);
      if ((target === "--execute" && journal.phase !== "PLANNED") || (target === "--resume" && journal.phase === "PLANNED")) throw Error("WITHDRAW_PHASE");
      release = await acquireWithdrawalLocks();
      const result = await executeWithdrawal(journal, config, hash, { db: connection.db, save: value => saveCacheJournal(flag!, value) });
      console.log(JSON.stringify({ phase: result.phase, pages: result.plan.pages.length, imageRelations: result.plan.assets.length, checkedRequests: result.checkedPaths?.length ?? 0, objectsDeleted: 0 }));
    }
  } finally { try { await release?.(); } finally { await connection.close(); } }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  runWithdrawalCli(process.argv.slice(2)).catch(() => { console.error("Withdrawal not confirmed complete. Inspect the private journal; keep the deny and pending event. Do not restart synchronization or blindly repeat an unknown mutation."); process.exitCode = 1; });
