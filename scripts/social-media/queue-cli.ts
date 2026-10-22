import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { writeJson } from "../game-sync/private.ts";
import { acquireLock } from "../notion-sync/state.ts";
import { randomUUID } from "node:crypto";
import { SocialSyncError } from "../social-sync/model.ts";
import { readCoverPolicy } from "./handoff.ts";
import { openCoverQueue } from "./queue.ts";
import { sourcePlan } from "./worker.ts";
import { withCoverSession } from "./cli.ts";
import { refreshQueuedCollections } from "./collection-refresh.ts";
import { consumeCoverQueue } from "./queue-worker.ts";
import { seedAcknowledgedCovers } from "./seed.ts";
import { readRefreshScope } from "../social-sync/refresh-scope.ts";
import { readHttpNoteScope } from "../social-sync/xiaohongshu-http-config.ts";

export const usage = "node scripts/social-media/queue-cli.ts <status|plan> <absolute-social-runtime>\nnode scripts/social-media/queue-cli.ts <retry|seed-bilibili|seed-xiaohongshu> <absolute-social-runtime> --execute\nnode scripts/social-media/queue-cli.ts <sync|refresh-collections> <absolute-social-runtime> <absolute-media-directory> --execute";
export async function runCoverQueueCli(args: string[]) {
  if (args.length === 1 && args[0] === "--help") { console.log(usage); return; }
  const [command, root, third, fourth] = args;
  if (!root || !isAbsolute(root) || resolve(root) !== root ||
      (["sync", "refresh-collections"].includes(command!) ? args.length !== 4 || fourth !== "--execute" || !third || !isAbsolute(third) || resolve(third) !== third || third === root || third === join(root,"social-cover-queue") :
        ["retry", "seed-bilibili", "seed-xiaohongshu"].includes(command!) ? args.length !== 3 || third !== "--execute" : !["status", "plan"].includes(command!) || args.length !== 2)) throw new SocialSyncError("COVER_USAGE");
  process.umask(0o077);
  const policy = await readCoverPolicy(root);
  if (!policy?.enabled) { console.log(JSON.stringify({ enabled: false, executed: false })); return; }
  if (command!.startsWith("seed-")) {
    const summary=await seedAcknowledgedCovers(root,command==="seed-bilibili"?async()=>{const s=await readRefreshScope(root,"bilibili");return {...s,publications:s.publications.filter(p=>p.target.platform==="bilibili")};}:async()=>(await readHttpNoteScope(root)).scope,policy.mode);
    const seeded=await openCoverQueue(root,true);
    try { if(seeded)await writeJson(join(root,"social-cover-queue","health.json"),seeded.summary(new Date().toISOString())); }
    finally { seeded?.close(); }
    console.log(JSON.stringify({...summary,sourceRequests:0,cloudRequests:0,executed:false}));return;
  }
  let queue = await openCoverQueue(root, true);
  if (!queue) { console.log(JSON.stringify({ enabled: true, state: "not-initialized", executed: false })); return; }
  try {
    const summary = queue.summary(new Date().toISOString());
    if (command === "status") { console.log(JSON.stringify({ ...summary, executed: false })); return; }
    const jobs = queue.pending(policy.mode), plan = sourcePlan(jobs.map(j => j.source));
    if (command === "plan") { console.log(JSON.stringify({ ...summary, ...plan, executed: false })); return; }
    queue.close(); queue = null;
    if (command === "retry") {
      queue = await openCoverQueue(root);
      if (!queue) throw new SocialSyncError("COVER_QUEUE_UNAVAILABLE");
      const reset = Number(queue.retry(policy.mode));
      await writeJson(join(root, "social-cover-queue", "health.json"), queue.summary(new Date().toISOString()));
      console.log(JSON.stringify({ reset, sourceRequests: 0, executed: false })); return;
    }
    // Idle checks must not open media.env, a database connection or an Auth session.
    if (!jobs.length) { console.log(JSON.stringify({ ...summary, selected: 0, executed: false })); return; }
    const releaseConsumer=await acquireLock(join(root,"social-cover-queue"),randomUUID());
    try { await withCoverSession(third!, async ports => {
      queue = await openCoverQueue(root);
      if (!queue) throw new SocialSyncError("COVER_QUEUE_UNAVAILABLE");
      try {
        const metadataRefresh=ports.writer.refreshUnchangedCollections
          ? await refreshQueuedCollections(queue,policy.mode,ports.writer.refreshUnchangedCollections,ports.signal)
          : null;
        if(command === "refresh-collections") {
          const receipt={version:1,finishedAt:new Date().toISOString(),metadataRefresh,sourceRequests:0,uploads:0,objectReads:0};
          await writeJson(join(root,"social-cover-queue","metadata-refresh.json"),receipt);
          console.log(JSON.stringify(receipt));return;
        }
        const report={...await consumeCoverQueue(queue,policy.mode,ports),metadataRefresh};
        await writeJson(join(root,"social-cover-queue","latest-run.json"),{version:1,finishedAt:new Date().toISOString(),...report});
        console.log(JSON.stringify(report));
        if(report.failed||report.code)process.exitCode=1;
      }
      finally { await writeJson(join(root, "social-cover-queue", "health.json"), queue.summary(new Date().toISOString())); }
    },180000,true); } finally { await releaseConsumer(); }
  } finally { queue?.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) runCoverQueueCli(process.argv.slice(2)).catch(error => {
  if(error?.code==="BUSY"){console.log(JSON.stringify({state:"deferred",code:"BUSY",executed:false}));return;}
  console.error(JSON.stringify({ code: error instanceof SocialSyncError ? error.code : "COVER_QUEUE_FAILED" })); process.exitCode = 1;
});
