import { join } from "node:path";
import { readPrivateFile } from "../notion-sync/state.ts";
import { writeJson } from "../game-sync/private.ts";
import { hash, SocialSyncError } from "../social-sync/model.ts";
import type { Pending } from "../social-sync/store.ts";
import { collectionKey, validateCollectionSnapshot, type CollectionSnapshot } from "../social-sync/collection.ts";
import type { CollectionPending } from "../social-sync/collection-store.ts";
import { collectionCoverSource, collectionApiCoverSource, publicationCoverSource } from "./sources.ts";
import { openCoverQueue, type CoverQueue } from "./queue.ts";
import type { CoverMode } from "../../src/server/social/covers.ts";

export async function readCoverPolicy(root: string): Promise<{ version: 1; enabled: boolean; mode: CoverMode } | null> {
  let raw: string;
  try { raw = await readPrivateFile(join(root, "social-cover-policy.json"), 1024); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  const p = JSON.parse(raw);
  if (!p || Object.keys(p).sort().join() !== "enabled,mode,version" || p.version !== 1 || typeof p.enabled !== "boolean" || !["trial", "retained"].includes(p.mode)) throw new SocialSyncError("COVER_QUEUE_POLICY_INVALID");
  return p;
}
/** Media failures are separate receipts, never a reason to replay acknowledged statistics. */
export function createCoverHandoff(root: string) {
  const safe = async (run: (queue: CoverQueue, mode: CoverMode) => void) => {
    let queue: CoverQueue | null = null;
    try {
      const policy = await readCoverPolicy(root);
      if (!policy?.enabled) return;
      queue = await openCoverQueue(root);
      if (!queue) throw new SocialSyncError("COVER_QUEUE_UNAVAILABLE");
      run(queue, policy.mode);
      await writeJson(join(root, "social-cover-queue", "health.json"), queue.summary(new Date().toISOString()));
    } catch (error) {
      const code = error instanceof SocialSyncError && /^[A-Z][A-Z_]{0,47}$/.test(error.code)
        ? error.code.startsWith("COVER_") ? error.code : `COVER_HANDOFF_${error.code}` : "COVER_HANDOFF_FAILED";
      try { await writeJson(join(root, "social-cover-queue", "hook-error.json"), { version: 1, recordedAt: new Date().toISOString(), code }); }
      catch { console.error(JSON.stringify({ code: "COVER_HANDOFF_RECEIPT_FAILED" })); }
    } finally { try { queue?.close(); } catch { console.error(JSON.stringify({ code: "COVER_HANDOFF_CLOSE_FAILED" })); } }
  };
  return {
    stageCollection: (html: string, snapshot: CollectionSnapshot) => safe(queue => {
      validateCollectionSnapshot(snapshot);
      const sha=hash(JSON.stringify(snapshot));
      const source = collectionCoverSource(html, snapshot.target, snapshot.observedAt,sha);
      queue.stage(source, sha);
    }),
    stageApiCollection: (raw: string, snapshot: CollectionSnapshot) => safe(queue => {
      validateCollectionSnapshot(snapshot);
      if (snapshot.source !== "bilibili-collection-api-json") throw new SocialSyncError("COVER_COLLECTION_SOURCE_MISMATCH");
      const sha = hash(JSON.stringify(snapshot));
      queue.stage(collectionApiCoverSource(raw, snapshot.target, snapshot.observedAt, sha), sha);
    }),
    acknowledged: (item: Pending | CollectionPending) => safe((queue, mode) => {
      const payload = "observation" in item ? item.observation : item.snapshot;
      if (hash(JSON.stringify(payload)) !== item.sha256) throw new SocialSyncError("COVER_ACK_MISMATCH");
      if ("observation" in item) {
        const source = publicationCoverSource(item.observation);
        if (source.key !== item.key) throw new SocialSyncError("COVER_ACK_MISMATCH");
        queue.offer(source, mode);
      } else {
        if (collectionKey(item.snapshot.target) !== item.key) throw new SocialSyncError("COVER_ACK_MISMATCH");
        queue.acknowledgeCollection(item.key, item.sha256, item.snapshot.observedAt, mode);
      }
    }),
  };
}
