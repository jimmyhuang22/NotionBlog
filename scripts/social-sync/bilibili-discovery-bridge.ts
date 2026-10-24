import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { acquireLock, privateDirectory, readPrivateFile } from "../notion-sync/state.ts";
import { writeJson } from "../game-sync/private.ts";
import { createCoverHandoff } from "../social-media/handoff.ts";
import { automaticVideoTarget, captureDiscoveredVideo, collectionProbeTarget, completeDirectory, readClassification, validateDiscoveredVideo } from "./bilibili-discovery.ts";
import type { Directory } from "./bilibili-discovery.ts";
import { discoveredScope, readAccountPolicy, readDiscoveredScope } from "./bilibili-account-scope.ts";
import { collectionKey } from "./collection.ts";
import { collectionMemberShas, MAX_REFRESH_CONFIG_BYTES, refreshConfig } from "./refresh.ts";
import { readRefreshScope } from "./refresh-scope.ts";
import { hash, object, publicationKey, SocialSyncError, timestamp } from "./model.ts";
import { openStore } from "./store.ts";
import { openCollectionStore } from "./collection-store.ts";
import { executeAtRoot } from "./execute-cli.ts";
import type { RefreshReport } from "./refresh-executor.ts";
import { CycleCloudSession } from "./cycle-cloud.ts";
import { readBilibiliApiPolicy, bilibiliMetadataRoot, requireApiMetadataTransfer } from "./bilibili-api-policy.ts";
import { captureApiDiscoveredVideo } from "./bilibili-api-collect.ts";
import { refreshRequest } from "./refresh-executor.ts";
import { trackedBilibiliRequest, parseBilibiliHealth } from "./bilibili-cycle.ts";
import type { RefreshConfig } from "./refresh.ts";
function classificationTargets(scope:RefreshConfig,accountId:string){
  const pubs=scope.publications.filter(p=>p.target.platform==="bilibili"&&p.target.accountId===accountId).map(p=>p.target);
  const all=[...pubs,...scope.collections.filter(c=>c.target.kind==="multi-part"&&c.target.accountId===accountId).map(c=>collectionProbeTarget(c.target,pubs))];
  return [...new Map(all.map(t=>[publicationKey(t),t])).values()];
}

type Job = { id: string; accountId: string; expiresAt: string };
type LinkJob = { id:string;key:string;accountId:string;collectionId:string;representativeId:string;expiresAt:string };
interface State {
  version: 1; policyDigest: string; status: "capturing" | "processing" | "complete" | "paused";
  checkedAt: string | null; job: Job | null; directory: Directory | null; remaining: string[];
  uploaded: number; lastSubmission: { id: string; sha256: string } | null; code: string | null;
  budgetStartedAt: string; budgetRequests: number; budgetBytes: number;
  links: LinkJob[];
}
const summary = (s: State) => ({ status: s.status, remaining: s.remaining.length, uploaded: s.uploaded, code: s.code, pendingLinks:s.links.length });
async function optional(path: string) {
  try { return JSON.parse(await readPrivateFile(path, 256 * 1024)); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
}
/** Invoked only after the native host has checked the fixed extension origin. */
export async function handleBilibiliDiscovery(root: string, message: unknown, ports: {
  now?: () => string; capture?: typeof captureDiscoveredVideo; execute?: typeof executeAtRoot; cloud?: (signal?:AbortSignal)=>CycleCloudSession;
} = {}) {
  const base = refreshConfig(JSON.parse(await readPrivateFile(join(root, "refresh-config.json"), MAX_REFRESH_CONFIG_BYTES))), policy = await readAccountPolicy(root, base);
  const msg = object(message), op = msg.op;
  const shapes: Record<string, string[]> = { "bilibili-start": ["op", "manual"], "bilibili-next": ["op"], "bilibili-submit": ["op", "jobId", "pages"], "bilibili-pause": ["op", "code"],"bilibili-links":["op","proofs"] };
  if (typeof op !== "string" || !shapes[op] || Object.keys(msg).sort().join() !== [...shapes[op]!].sort().join() ||
      op === "bilibili-start" && typeof msg.manual !== "boolean") throw new SocialSyncError("BRIDGE_REQUEST_INVALID");
  if (!policy?.enabled) return { status: "disabled", remaining: 0, uploaded: 0 };
  const apiPolicy=await readBilibiliApiPolicy(root,base),apiMode=apiPolicy?.enabled===true,stateDirectories=apiMode?apiPolicy.stateDirectories:base.stateDirectories,metadataRoot=bilibiliMetadataRoot(root,apiPolicy);
  await requireApiMetadataTransfer(root,metadataRoot,"discovery-bilibili","state.json");
  await requireApiMetadataTransfer(root,metadataRoot,"cycle-bilibili","health.json");
  await requireApiMetadataTransfer(root,metadataRoot,"cycle-bilibili","latest-cycle.json");
  const digest = hash(JSON.stringify(policy)), dir = join(metadataRoot, "discovery-bilibili"), now = ports.now ?? (() => new Date().toISOString());
  await privateDirectory(dir); const release = await acquireLock(dir, randomUUID()), file = join(dir, "state.json");
  let s: State | null = null;
  const save = async () => writeJson(file, s);
  try {
    s = await optional(file);
    if (s && (s.version !== 1 || s.policyDigest !== digest || !Array.isArray(s.links)||s.links.length>500||!Array.isArray(s.remaining) || s.remaining.length > 1000 ||
        !["capturing", "processing", "complete", "paused"].includes(s.status))) throw new SocialSyncError("BILIBILI_DISCOVERY_STATE_INVALID");
    if (op === "bilibili-pause") {
      if (!s || typeof msg.code !== "string" || !/^[A-Z][A-Z_]{0,63}$/.test(msg.code)) throw new SocialSyncError("BRIDGE_REQUEST_INVALID");
      s.status = "paused"; s.code = msg.code; await save(); return summary(s);
    }
    if(op==="bilibili-links"){
      if(!s||!Array.isArray(msg.proofs)||msg.proofs.length<1||msg.proofs.length>3)throw new SocialSyncError("BRIDGE_REQUEST_INVALID");
      const proofs=msg.proofs.map(input=>{
        const p=object(input),job=s!.links.find(j=>j.id===p.id&&j.key===p.key);
        if(Object.keys(p).sort().join()!=="checkedAt,id,key,url"||!job||job.expiresAt<now()||typeof p.checkedAt!=="string"||
           p.url!==`https://space.bilibili.com/${job.accountId}/lists/${job.collectionId}?type=season`||Date.parse(timestamp(p.checkedAt))>Date.parse(now())+30000)throw new SocialSyncError("BRIDGE_LINKS_INVALID");
        return {job,proof:{key:job.key,url:p.url as string,checkedAt:p.checkedAt}};
      });
      if(new Set(proofs.map(p=>p.job.id)).size!==proofs.length)throw new SocialSyncError("BRIDGE_LINKS_INVALID");
      const locks:(()=>Promise<void>)[]=[];
      try{for(const path of [join(metadataRoot,"cycle-bilibili"),root])locks.push(await acquireLock(path,randomUUID()));}
      catch(e){for(const lock of locks.reverse())await lock();if((e as {code?:string}).code==="BUSY")return {...summary(s),deferred:true};throw e;}
      let session:CycleCloudSession|undefined,timer:NodeJS.Timeout|undefined;
      try{
        const scope=await readRefreshScope(root,"bilibili"),scopeDigest=hash(JSON.stringify(scope)),controller=new AbortController();session=ports.cloud?.(controller.signal)??new CycleCloudSession(controller.signal);
        timer=setTimeout(()=>controller.abort(),60000);timer.unref();
        const checkScope=async()=>{if(hash(JSON.stringify(await readRefreshScope(root,"bilibili")))!==scopeDigest)throw new SocialSyncError("REFRESH_SCOPE_CHANGED");};
        const raw=await readPrivateFile(join(root,"cloud.env"),65536);
        for(const {job,proof} of proofs){
          await session.bindSeasonLink(raw,scopeDigest,proof,checkScope);
          s.links=s.links.filter(j=>j.id!==job.id);await save();
        }return summary(s);
      }finally{clearTimeout(timer);try{await session?.close();}finally{for(const lock of locks.reverse())await lock();}}
    }
    if(s?.links.length&&(op==="bilibili-next"||op==="bilibili-start")){
      if(s.status==="paused"&&msg.manual!==true)return summary(s);
      for(const job of s.links)if(job.expiresAt<now()){job.id=randomUUID();job.expiresAt=new Date(Date.parse(now())+24*3600000).toISOString();}
      if(s.status==="paused"){s.status=s.remaining.length?"processing":"complete";s.code=null;}
      await save();return {...summary(s),linkJobs:s.links.slice(0,3)};
    }
    if (op === "bilibili-start") {
      if (s?.status === "paused" && msg.manual !== true) return summary(s);
      if (s?.status === "processing") return summary(s);
      if (s?.status === "complete" && s.checkedAt && Date.parse(now()) < Date.parse(timestamp(s.checkedAt)) + 6 * 3600000) {
        const current=await readRefreshScope(root,"bilibili"),known=new Set(current.collections.map(c=>collectionKey(c.target))),changed:string[]=[];
        for(const target of classificationTargets(current,policy.accountId)){
          const c=await readClassification(metadataRoot,target,digest,now());if(c?.type==="collection"&&!known.has(collectionKey(c.value.target)))changed.push(target.publicationId);
        }
        if(!changed.length)return { ...summary(s), due: false };
        s.remaining=changed;s.status="processing";await save();return summary(s);
      }
      if (s?.status === "capturing" && s.job && s.job.expiresAt > now()) return { ...summary(s), job: s.job };
      s = { version: 1, policyDigest: digest, status: "capturing", checkedAt: s?.checkedAt ?? null,
        job: { id: randomUUID(), accountId: policy.accountId, expiresAt: new Date(Date.parse(now()) + 5 * 60000).toISOString() },
        directory: null, remaining: [], uploaded: 0, lastSubmission: null, code: null, budgetStartedAt: now(), budgetRequests: 0, budgetBytes: 0,links:[] };
      await save(); return { ...summary(s), job: s.job };
    }
    if (!s) throw new SocialSyncError("BILIBILI_DISCOVERY_STATE_INVALID");
    if (op === "bilibili-submit") {
      const sha256 = hash(JSON.stringify(msg.pages));
      if (s.lastSubmission && s.lastSubmission.id === msg.jobId) {
        if (s.lastSubmission.sha256 !== sha256) throw new SocialSyncError("BRIDGE_JOB_REPLAY_CHANGED");
        return summary(s);
      }
      if (s.status !== "capturing" || !s.job || msg.jobId !== s.job.id || s.job.expiresAt < now()) throw new SocialSyncError("BRIDGE_JOB_EXPIRED");
      s.directory = completeDirectory(msg.pages, policy.accountId, now());
      s.remaining = [...s.directory.ids]; s.lastSubmission = { id: s.job.id, sha256 }; s.job = null; s.status = "processing";
      await save(); // A BUSY source lock never requires another browser traversal.
    }
    if (s.status !== "processing") return summary(s);
    if (!Number.isSafeInteger(s.budgetRequests) || s.budgetRequests < 0 || s.budgetRequests > 20 || !Number.isSafeInteger(s.budgetBytes) || s.budgetBytes < 0) throw new SocialSyncError("BILIBILI_DISCOVERY_STATE_INVALID");
    if (s.budgetRequests >= 20 || s.budgetBytes >= 128*1024*1024 || Date.parse(now()) - Date.parse(timestamp(s.budgetStartedAt)) >= 16 * 60000) {
      const nextAt = new Date(Date.parse(s.budgetStartedAt) + 6 * 3600000).toISOString();
      if (nextAt > now()) return { ...summary(s), deferred: true, nextAt };
      s.budgetStartedAt = now(); s.budgetRequests = 0; s.budgetBytes = 0; await save();
    }
    let cycleRelease: (() => Promise<void>) | undefined;
    try { cycleRelease = await acquireLock(join(metadataRoot, "cycle-bilibili"), randomUUID()); }
    catch (e) { if ((e as { code?: string }).code === "BUSY") return { ...summary(s), deferred: true }; throw e; }
    const controller = new AbortController(), cancel=()=>controller.abort(), timer = setTimeout(cancel, 90000); timer.unref();
    process.once("SIGTERM",cancel);process.once("SIGINT",cancel);
    const session = ports.cloud?.(controller.signal)??new CycleCloudSession(controller.signal,undefined,{bilibiliApi:apiMode});
    const tracked=trackedBilibiliRequest();
    try {
      const apiHealth=apiMode?await optional(join(metadataRoot,"cycle-bilibili","health.json")):null;
      if(apiHealth!==null&&parseBilibiliHealth(apiHealth).recovery.manualRequired)return {...summary(s),deferred:true};
      const previous = await optional(join(metadataRoot, "cycle-bilibili", "latest-cycle.json"));
      if (previous && !["complete", "review-required"].includes(previous.status)) return { ...summary(s), deferred: true };
      const before = await readRefreshScope(root, "bilibili"), beforeDigest = hash(JSON.stringify(before));
      const extra = await readDiscoveredScope(root, base, policy);
      // Reviewed singletons are already checked by the normal six-hour request; only a
      // cached classification change needs another card, never another HTTP request.
      const changed=new Set<string>();
      const probeTargets=classificationTargets(before,policy.accountId);
      for(const target of probeTargets){
        const c=await readClassification(metadataRoot,target,digest,now());if(c?.type==="collection"&&!before.collections.some(v=>collectionKey(v.target)===collectionKey(c.value.target)))changed.add(target.publicationId);
      }
      const known = new Set([...before.publications.filter(p => p.target.platform === "bilibili"&&!changed.has(p.target.publicationId)).map(p => p.target.publicationId),
        ...before.collections.map(c => c.target.representativeUrl.split("/")[4]!).filter(id=>!changed.has(id)) ]);
      // The UI can choose a different member as its season's visible cover card.
      // It is still known: consult the verified roster, not only our HTTP representative.
      const rosterRelease=await acquireLock(stateDirectories.collections,randomUUID());
      let roster:Awaited<ReturnType<typeof openCollectionStore>>=null;
      try{roster=await openCollectionStore(stateDirectories.collections,true);if(!roster)throw new SocialSyncError("REFRESH_STATE_MISSING");
        for(const c of before.collections)for(const m of roster.latest(c.target)?.snapshot.members??[])if(!changed.has(m.id))known.add(m.id);
      }finally{roster?.close();await rosterRelease();}
      s.remaining = s.remaining.filter(id => !known.has(id));
      if (!s.remaining.length) { s.status = "complete"; s.checkedAt = s.directory!.observedAt; await save(); return summary(s); }
      const ids = s.remaining.slice(0, Math.min(3, 20 - s.budgetRequests)), request = refreshRequest(tracked.request, { requests: ids.length, bytes: Math.min(24 * 1024 * 1024,128*1024*1024-s.budgetBytes) });
      const cloudRaw=apiMode?await readPrivateFile(join(root,"cloud.env"),65536):null;
      if(cloudRaw!==null)await session.prepareBilibiliApi(cloudRaw,beforeDigest,true,controller.signal);
      const captures = [];
      let packet:Record<string,unknown>|null=null;
      try{packet=object(JSON.parse(await readPrivateFile(join(dir,"captured.json"),2*1024*1024)));}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
      if(packet){
        if(packet.version!==1||packet.policyDigest!==digest||packet.scopeDigest!==beforeDigest||JSON.stringify(packet.ids)!==JSON.stringify(ids)||
           !Array.isArray(packet.captures)||packet.captures.length!==ids.length||packet.sha256!==hash(JSON.stringify(packet.captures)))throw new SocialSyncError("REFRESH_SCOPE_CHANGED");
        for(let i=0;i<ids.length;i++){
          const target=probeTargets.find(p=>p.publicationId===ids[i])??automaticVideoTarget(policy.accountId,ids[i]!);
          const c=validateDiscoveredVideo(packet.captures[i],target);if(Date.parse(now())-Date.parse(c.value.observedAt)>24*3600000)throw new SocialSyncError("REFRESH_CAPTURE_EXPIRED");captures.push(c);
        }
      }
      for (const id of packet?[]:ids) {
        const knownTarget=probeTargets.find(p=>p.publicationId===id);
        const cached=knownTarget?await readClassification(metadataRoot,knownTarget,digest,now()):null;
        if(cached){captures.push(cached);continue;}
        s.budgetRequests++; await save(); captures.push(await (ports.capture ?? (apiMode?captureApiDiscoveredVideo:captureDiscoveredVideo))(policy.accountId, id, controller.signal, request,knownTarget,apiMode?createCoverHandoff(root).stageApiCollection:createCoverHandoff(root).stageCollection));
      }
      if(!packet)await writeJson(join(dir,"captured.json"),{version:1,policyDigest:digest,scopeDigest:beforeDigest,ids,captures,sha256:hash(JSON.stringify(captures))});
      const locks: (() => Promise<void>)[] = [];
      let pubs: Awaited<ReturnType<typeof openStore>> = null, cols: Awaited<ReturnType<typeof openCollectionStore>> = null;
      const keys: string[] = [];
      const planned: typeof captures = [];
      for (const c of captures) {
        if (c.type === "publication") {
          const key = publicationKey(c.value), { platform, workId, accountId, publicationId, originalUrl: url } = c.value;
          if (!before.publications.some(p => publicationKey(p.target) === key) && !extra.publications.some(p => publicationKey(p.target) === key)) extra.publications.push({ target: { platform, workId, accountId, publicationId, url }, kind: "video" });
          planned.push(c); keys.push(key);
        } else {
          const key = collectionKey(c.value.target);
          if (before.collections.some(v => collectionKey(v.target) === key) || extra.collections.some(v => collectionKey(v.target) === key)) continue;
          extra.collections.push({ target: c.value.target, memberShas: collectionMemberShas(c.value), membershipMode: "follow-public" });
          planned.push(c); keys.push(key);
        }
      }
      discoveredScope(extra, base, policy);
      try {
        for (const path of [...new Set([root, stateDirectories.publications, stateDirectories.collections])].sort()) locks.push(await acquireLock(path, randomUUID()));
        if (hash(JSON.stringify(await readRefreshScope(root, "bilibili"))) !== beforeDigest ||
            hash(JSON.stringify(await readAccountPolicy(root, base))) !== digest) throw new SocialSyncError("REFRESH_SCOPE_CHANGED");
        const checkPubs = await openStore(stateDirectories.publications, true), checkCols = await openCollectionStore(stateDirectories.collections, true);
        if (!checkPubs || !checkCols) { checkPubs?.close(); checkCols?.close(); throw new SocialSyncError("REFRESH_STATE_MISSING"); }
        checkPubs.close(); checkCols.close();
        pubs = await openStore(stateDirectories.publications); cols = await openCollectionStore(stateDirectories.collections);
        if (!pubs || !cols) throw new SocialSyncError("REFRESH_STATE_MISSING");
        // Register durable local scope before writing outboxes; an interrupted ingest is
        // still visible to the normal refresh cycle, and cannot strand an unknown target.
        await writeJson(join(root, "bilibili-discovered.json"), extra);
        for (const c of planned) { if (c.type === "publication") pubs.ingest(c.value); else cols.ingest(c.value); }
        for(const c of planned)if(c.type==="collection"&&c.value.target.kind==="season"&&!s.links.some(j=>j.key===collectionKey(c.value.target))){
          s.links.push({id:randomUUID(),key:collectionKey(c.value.target),accountId:policy.accountId,collectionId:c.value.target.collectionId,
            representativeId:c.value.target.representativeUrl.split("/")[4]!,expiresAt:new Date(Date.parse(now())+24*3600000).toISOString()});
        }
        await save();
        await unlink(join(dir,"captured.json"));
      } finally { pubs?.close(); cols?.close(); for (const lock of locks.reverse()) await lock(); }
      if (keys.length) {
        const scope = await readRefreshScope(root, "bilibili"),scopeDigest=hash(JSON.stringify(scope));
        if(cloudRaw!==null)session.adoptDiscoveredBilibiliScope(cloudRaw,beforeDigest,scopeDigest);
        const report = await (ports.execute ?? executeAtRoot)(root, {
          platform: "bilibili", limit: 3, keys: [...new Set(keys)], scopeDigest, uploadOnly: true, signal: controller.signal, cloudSession: session,bilibiliApi:apiMode,
        }) as RefreshReport;
        if (report.failed || report.paused || report.cancelled || report.superseded || report.uploaded !== new Set(keys).size) throw new SocialSyncError("BILIBILI_AUTO_UPLOAD_FAILED");
        s.uploaded += report.uploaded;
      }
      s.remaining = s.remaining.filter(id => !ids.includes(id));
      if (!s.remaining.length) { s.status = "complete"; s.checkedAt = s.directory!.observedAt; }
      await save(); return summary(s);
    } catch (e) {
      if ((e as { code?: string }).code === "BUSY") return { ...summary(s), deferred: true };
      s.status = "paused"; s.code = e instanceof SocialSyncError ? e.code : "BILIBILI_DISCOVERY_FAILED"; await save(); throw e;
    } finally {
      clearTimeout(timer);process.removeListener("SIGTERM",cancel);process.removeListener("SIGINT",cancel);
      s.budgetBytes+=tracked.cost.sourceBytes;
      try{await save();}finally{try{await session.close();}finally{await cycleRelease();}}
    }
  } finally { await release(); }
}
