import { fetchApiVideo } from "./bilibili-api.ts";
import { observationFromVideoData } from "./bilibili.ts";
import { collectionFromVideoData } from "./collection.ts";
import type { CollectionSnapshot, CollectionTarget } from "./collection.ts";
import { classifyVideoData, collectionProbeTarget, automaticVideoTarget } from "./bilibili-discovery.ts";
import { hash, publicationKey, SocialSyncError } from "./model.ts";
import type { Target } from "./model.ts";
import { join } from "node:path";
import { privateDirectory } from "../notion-sync/state.ts";
import { writeJson } from "../game-sync/private.ts";

type Captured = (raw: string, snapshot: CollectionSnapshot) => Promise<void>;
export async function captureApiDiscoveredVideo(accountId: string, id: string, signal?: AbortSignal, request?: typeof fetch, knownTarget?: Target, captured?: Captured) {
  const target = knownTarget ?? automaticVideoTarget(accountId,id);
  if(target.accountId!==accountId||target.publicationId!==id)throw new SocialSyncError("IDENTITY_MISMATCH");
  const {raw,videoData,observedAt}=await fetchApiVideo(target,signal,request),candidate=classifyVideoData(videoData,target,observedAt,"public-video-api-json",hash(raw));
  if(candidate.type==="collection")await captured?.(raw,candidate.value);return candidate;
}
export async function collectApiPublication(root: string, policyDigest: string | null, target: Target, signal?: AbortSignal, request?: typeof fetch, captured?: Captured) {
  const { raw, videoData, observedAt } = await fetchApiVideo(target, signal, request), digest = hash(raw);
  if (policyDigest !== null) {
    const candidate = classifyVideoData(videoData, target, observedAt, "public-video-api-json", digest);
    if (candidate.type === "collection") await captured?.(raw, candidate.value);
    const dir = join(root, "bilibili-classifications"); await privateDirectory(dir);
    signal?.throwIfAborted();
    await writeJson(join(dir, `${publicationKey(target)}.json`), { version: 1, policyDigest, targetKey: publicationKey(target), candidate, sha256: hash(JSON.stringify(candidate)) });
    if (candidate.type === "publication") return candidate.value;
  }
  return observationFromVideoData(videoData, target, observedAt, "public-video-api-json", digest);
}
export async function collectApiCollection(root: string, policyDigest: string | null, target: CollectionTarget, publications: Target[], signal?: AbortSignal, request?: typeof fetch, captured?: Captured) {
  const probe = collectionProbeTarget(target, publications), { raw, videoData, observedAt } = await fetchApiVideo(probe, signal, request), digest = hash(raw);
  if (policyDigest !== null && target.kind === "multi-part") {
    const candidate = classifyVideoData(videoData, probe, observedAt, "public-video-api-json", digest), dir = join(root, "bilibili-classifications");
    await privateDirectory(dir); signal?.throwIfAborted();
    await writeJson(join(dir, `${publicationKey(probe)}.json`), { version: 1, policyDigest, targetKey: publicationKey(probe), candidate, sha256: hash(JSON.stringify(candidate)) });
  }
  const snapshot = collectionFromVideoData(videoData, target, observedAt, "bilibili-collection-api-json", digest);
  await captured?.(raw, snapshot); return snapshot;
}
