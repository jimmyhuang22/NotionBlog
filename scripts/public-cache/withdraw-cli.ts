import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { planWithdrawal, planCompactWithdrawal, executeWithdrawal, executeCompactWithdrawal, withdrawalDatabaseHash, withdrawalTarget, validateWithdrawalJournalVersion } from "./withdraw.ts";
import { cacheClientConfig, cacheOperatorConnection, saveCacheJournal, readCacheJournal, acquireWithdrawalLocks } from "./local.ts";

export async function runWithdrawalCli(args: string[]) {
  if (args.length === 1 && args[0] === "--help") {
    console.log("node --env-file=<private operator env> scripts/public-cache/withdraw-cli.ts <page URL> --plan <absolute .local journal>\nnode --env-file=<private operator env> scripts/public-cache/withdraw-cli.ts --compact <page URL> --plan <absolute .local journal>\nnode --env-file=<private operator env> scripts/public-cache/withdraw-cli.ts --execute <absolute .local journal>\nnode --env-file=<private operator env> scripts/public-cache/withdraw-cli.ts --resume <absolute .local journal>"); return;
  }
  const compact = args[0] === "--compact", [target, flag, path, ...extra] = compact ? args.slice(1) : args;
  const planning = flag === "--plan" && !!path && extra.length === 0 && !!target && !target.startsWith("--");
  const executing = !compact && ["--execute", "--resume"].includes(target ?? "") && !!flag && path === undefined;
  if (!planning && !executing) throw Error("WITHDRAW_USAGE");
  // Reject malformed or mixed journals before configuration or connection setup.
  const existing = executing ? validateWithdrawalJournalVersion(await readCacheJournal(flag!)) : undefined;
  if (existing && ((target === "--execute" && existing.phase !== "PLANNED") || (target === "--resume" && existing.phase === "PLANNED"))) throw Error("WITHDRAW_PHASE");
  const config = cacheClientConfig();
  if (compact) withdrawalTarget(target!, config.origin);
  const connection = await cacheOperatorConnection("nb_cache_operator");
  let release: (() => Promise<void>) | undefined;
  try {
    const hash = withdrawalDatabaseHash(connection.url);
    if (planning) {
      const journal = compact ? await planCompactWithdrawal(connection.db, target!, config, hash) : await planWithdrawal(connection.db, target!, config, hash);
      await saveCacheJournal(path!, journal, true);
      console.log(JSON.stringify({ planned: true, pages: journal.plan.pages.length, images: journal.version === 2 ? journal.plan.assetSummary.count : journal.plan.assets.length,
        sharedOwnerUrl: journal.plan.sharedOwnerUrl, syncBusy: journal.plan.leaseActive, executed: false }));
    } else {
      const journal = existing!;
      release = await acquireWithdrawalLocks();
      const ports = { db: connection.db, save: (value: unknown) => saveCacheJournal(flag!, value) };
      const result = journal.version === 2 ? await executeCompactWithdrawal(journal, config, hash, ports) : await executeWithdrawal(journal, config, hash, ports);
      console.log(JSON.stringify({ phase: result.phase, pages: result.plan.pages.length, imageRelations: result.version === 2 ? result.plan.assetSummary.count : result.plan.assets.length,
        checkedRequests: result.checkedPaths?.length ?? 0, objectsDeleted: 0 }));
    }
  } finally { try { await release?.(); } finally { await connection.close(); } }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  runWithdrawalCli(process.argv.slice(2)).catch(() => { console.error("Withdrawal not confirmed complete. Inspect the private journal; keep the deny and pending event. Do not restart synchronization or blindly repeat an unknown mutation."); process.exitCode = 1; });
