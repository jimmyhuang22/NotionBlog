import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { enqueuePublicationRefresh } from "./control.ts";
import { consumeCacheRefresh } from "./consume.ts";
import { cacheClientConfig, cacheOperatorConnection, readCacheJournal } from "./local.ts";

/** The caller's final successful publication receipt is required, not a pending capture. */
export async function runCacheRefreshCli(args: string[]) {
  if (args.length === 1 && args[0] === "--help") { console.log("node --env-file=<private publisher env> scripts/public-cache/refresh-cli.ts <private success receipt> --execute\nnode --env-file=<private publisher env> scripts/public-cache/refresh-cli.ts --flush"); return; }
  if (!(args.length === 1 && args[0] === "--flush") && !(args.length === 2 && args[1] === "--execute")) throw Error("CACHE_REFRESH_USAGE");
  const config = cacheClientConfig(), connection = await cacheOperatorConnection("nb_cache_publisher");
  try {
    if (args[0] !== "--flush") {
      const receipt = await readCacheJournal(args[0]!);
      await enqueuePublicationRefresh(connection.db, config, receipt);
    }
    const result = await consumeCacheRefresh(connection.db, config, { signal: AbortSignal.timeout(30_000) });
    console.log(JSON.stringify(result));
    if (result.status === "failed") process.exitCode = 1;
    else if (result.status === "pending" || result.status === "operator-required") process.exitCode = 2;
  } finally { await connection.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  runCacheRefreshCli(process.argv.slice(2)).catch(() => { console.error("Cache refresh remains pending. Retry only the durable refresh event; do not repeat collection or publication."); process.exitCode = 1; });
