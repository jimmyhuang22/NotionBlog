import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { lstat } from "node:fs/promises";
import { acquireLock, readPrivateFile } from "../notion-sync/state.ts";
import { parseWebsiteNotionConfig } from "../../src/server/notion/website-config.ts";
import { configDigest } from "../../src/server/database/website-validation.ts";
import { openIncrementalQueue } from "./queue.ts";

/** Local operator action only: no database connection, source reads or publication. */
export async function reviewIncrementalQueue(input: { command: "list-review" | "resume" | "compact-history"; configPath: string; lockDirectory: string; runtimeDirectory: string; sourceKey?: string; pageKey?: string }) {
  const config = parseWebsiteNotionConfig(JSON.parse(await readPrivateFile(input.configPath)));
  const release = await acquireLock(input.lockDirectory, randomUUID());
  let queue: Awaited<ReturnType<typeof openIncrementalQueue>> | undefined;
  try {
    const directory = join(input.runtimeDirectory, "queue");
    await lstat(join(directory, "incremental.sqlite")); // Never initialize an empty queue during recovery.
    queue = await openIncrementalQueue(directory, { digest: configDigest(config), sourceKeys: config.sources.map(source => source.key) });
    if (input.command === "compact-history") return queue.compactHistory();
    return input.command === "resume" ? { resumed: queue.resume(input.sourceKey!, input.pageKey!) } :
      { entries: queue.listReview(100, input.sourceKey ? { sourceKey: input.sourceKey, pageKey: input.pageKey! } : undefined) };
  } finally { try { queue?.close(); } finally { await release(); } }
}
