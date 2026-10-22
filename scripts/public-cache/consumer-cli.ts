import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { cacheClientConfig, cacheOperatorConnection } from "./local.ts";
import { runCacheConsumer } from "./consumer.ts";

export async function runCacheConsumerCli(args: string[]) {
  if (args.length === 1 && args[0] === "--help") {
    console.log("node --env-file=<private publisher env> scripts/public-cache/consumer-cli.ts --once --state <absolute .local state.json>"); return;
  }
  if (args.length !== 3 || args[0] !== "--once" || args[1] !== "--state") throw Error("CACHE_CONSUMER_USAGE");
  const result = await runCacheConsumer(args[2]!, cacheClientConfig(), process.env.PUBLIC_CACHE_OPERATOR_DATABASE_URL ?? "", {
    connect: () => cacheOperatorConnection("nb_cache_publisher"),
  });
  console.log(JSON.stringify(result));
  if (result.status === "failed") process.exitCode = 1;
  else if (result.status === "pending" || result.status === "operator-required") process.exitCode = 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  runCacheConsumerCli(process.argv.slice(2)).catch(() => {
    console.error("CACHE_CONSUMER_INCOMPLETE: check private configuration, receipts and the dedicated lock; reconcile the SQL queue before retrying, never repeat source publication."); process.exitCode = 1;
  });
