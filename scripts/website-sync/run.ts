import { createHash } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { createDatabasePool, sqlExecutor } from "../../src/server/database/connection.ts";
import { publicationMode, publicationReader, publicationWriter } from "../../src/server/database/publication.ts";
import { createWebsiteMediaSourceWriter } from "../../src/server/database/website-media-sources.ts";
import { createSupabaseStorage } from "../../src/server/database/storage.ts";
import { parseWebsiteNotionConfig } from "../../src/server/notion/website-config.ts";
import { WEBSITE_SCHEMA_DIGEST, type WebsiteWriter } from "../../contracts/website-sync.ts";
import { readPrivateFile, privateDirectory } from "../notion-sync/state.ts";
import { createHeicConverter } from "../notion-sync/heic.ts";
import { WorkerError, checkSignal, errorCode } from "../notion-sync/errors.ts";
import { createWebsiteImageCache } from "./image-cache.ts";
import { createWebsiteImageDownloader, websiteImageFailure, type WebsiteImageFailure } from "./download.ts";
import { finalizeWebsiteRun } from "./finalize-run.ts";
import { createRuntimeNotionReader } from "./runtime-reader.ts";
import { createRuntimeWriterSql } from "./runtime-sql.ts";
import { prepareCollectionResume, type ResumeQualification } from "./collection-revalidation.ts";
import { openSharedBudget } from "./shared-budget.ts";
import { runWebsiteSync } from "./worker.ts";
import { savePrivateJson } from "./private-json.ts";
import { createCollectionCapture } from "./collection-capture.ts";
import { configDigest } from "../../src/server/database/website-validation.ts";
import { exportPublicationHandoff } from "./publication-handoff.ts";
import { prepareHostCaptureRecovery } from "./capture-recovery-compatibility.ts";
import { PublicationRevalidationError, type PublicationRevalidationProgress } from "./publication-revalidation.ts";

/** Release-admission errors are already fixed codes; never echo arbitrary provider codes. */
function runtimeErrorCode(error: unknown): string {
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  return typeof code === "string" && ["RELEASE_INVALID", "PRIVATE_INPUT_INVALID", "PRIVATE_DIRECTORY_INVALID"].includes(code)
    ? code : errorCode(error);
}

/** Internal child: the host entry verifies the frozen release and holds BOTH host locks. */
async function main() {
  const env = process.env, args = process.argv.slice(2), mode = args[1];
  const publication = publicationMode(env.SYNC_PUBLICATION_MODE), mediaProvider = env.SYNC_MEDIA_PROVIDER ?? "notion";
  if (!["storage", "notion"].includes(mediaProvider) || (publication === "published" && mediaProvider !== "storage")) throw new WorkerError("MISCONFIGURED");
  const root = env.WEBSITE_PRIVATE_ROOT ?? "", state = env.WEBSITE_STATE_DIR ?? "", output = env.WEBSITE_OUTPUT_DIR ?? "", runId = env.WEBSITE_RUN_ID ?? "";
  const seconds = Number(env.WEBSITE_TIMEOUT_SECONDS), maxMediaBytes = Number(env.WEBSITE_MEDIA_MAX_BYTES), maxCollectionBytes = Number(env.WEBSITE_COLLECTION_MAX_BYTES ?? 16777216);
  if (args.length !== 2 || args[0] !== "--mode" || !["dry-run", "stage", "publish"].includes(mode) ||
      !/^[a-f0-9-]{36}$/.test(runId) || !Number.isInteger(seconds) || seconds < 1 || seconds > 7200 ||
      !Number.isSafeInteger(maxCollectionBytes) || maxCollectionBytes < 1 || maxCollectionBytes > 67108864 ||
      !Number.isSafeInteger(maxMediaBytes) || maxMediaBytes < 1 || maxMediaBytes > 2147483648 ||
      state !== join(root, "state") || output !== join(state, "website-v2", runId)) throw new WorkerError("MISCONFIGURED");
  for (const path of [root, state, output]) await privateDirectory(path);
  const controller = new AbortController(), signal = controller.signal, started = Date.now(); let timedOut = false;
  let notion: ReturnType<typeof createRuntimeNotionReader> | undefined;
  const cancel = () => controller.abort(), timeout = setTimeout(() => { timedOut = true; cancel(); }, seconds * 1000);
  process.on("SIGINT", cancel); process.on("SIGTERM", cancel);
  const guard = () => { if (Date.now() - started >= seconds * 1000) { timedOut = true; cancel(); } checkSignal(signal); };
  const report: Record<string, unknown> = { adapter: "private-host-v2", releaseCommit: env.WEBSITE_RELEASE_COMMIT, runId, mode,
    publicationMode: publication, mediaProvider,
    startedAt: new Date().toISOString(), published: false, promoteRequested: false, readerVerified: false, sessionRefreshes: 0 };
  const save = (name: string, value: unknown) => savePrivateJson(output, name, value);
  let pool: ReturnType<typeof createDatabasePool> | undefined, readerPool: typeof pool;
  let progress: ReturnType<typeof setInterval> | undefined, pendingSave: Promise<void> | undefined;
  let discoverySave = Promise.resolve();
  let capture: Awaited<ReturnType<typeof createCollectionCapture>> | undefined;
  let imageStatistics: (() => unknown) | undefined;
  let imageFailure: ReturnType<typeof createWebsiteImageDownloader>["failure"] | undefined;
  let terminalImageFailure: WebsiteImageFailure | undefined;
  let closeImageTransport: (() => void) | undefined;
  let runtimeSql: ReturnType<typeof createRuntimeWriterSql> | undefined;
  try {
    guard();
    for (const path of [join(root, "manual-run.lock"), join(state, "worker.lock")]) {
      const lock = JSON.parse(await readPrivateFile(path));
      if (lock.pid !== process.ppid || lock.runId !== runId || String(process.ppid) !== env.WEBSITE_PARENT_PID) throw new WorkerError("BUSY");
    }
    const sourceBytes = await readPrivateFile(env.NOTION_SOURCES_CONFIG ?? "");
    if (createHash("sha256").update(sourceBytes).digest("hex") !== env.WEBSITE_SOURCE_SHA256) throw new WorkerError("MISCONFIGURED");
    const config = JSON.parse(sourceBytes); parseWebsiteNotionConfig(config);
    if ((env.WEBSITE_RESUME_SOURCE_FILE === undefined) !== (env.WEBSITE_RESUME_SOURCE_SHA256 === undefined)) throw new WorkerError("MISCONFIGURED");
    if ((env.WEBSITE_RESUME_SOURCE_FILE !== undefined || env.WEBSITE_RESUME_SOURCE_SHA256 !== undefined || env.WEBSITE_RESUME_CONSUMER_MANIFEST_SHA256 !== undefined) &&
        !env.WEBSITE_RESUME_RECOVERY_ID) throw new WorkerError("MISCONFIGURED");
    if (env.WEBSITE_RESUME_RECOVERY_ID !== undefined && (!env.WEBSITE_RESUME_RUN_ID ||
        env.WEBSITE_RESUME_QUALIFICATION !== "fresh" || !env.WEBSITE_RESUME_PRODUCER_PROJECT)) throw new WorkerError("MISCONFIGURED");
    const recovery = env.WEBSITE_RESUME_RECOVERY_ID === undefined ? undefined : await prepareHostCaptureRecovery({
      transitionId: env.WEBSITE_RESUME_RECOVERY_ID,
      producerProject: env.WEBSITE_RESUME_PRODUCER_PROJECT!, producerManifest: env.WEBSITE_RESUME_PRODUCER_MANIFEST ?? "",
      producerManifestSha256: env.WEBSITE_RESUME_PRODUCER_MANIFEST_SHA256 ?? "", consumerProject: process.cwd(),
      consumerManifest: env.WEBSITE_CONSUMER_MANIFEST ?? "", consumerManifestSha256: env.WEBSITE_RESUME_CONSUMER_MANIFEST_SHA256 ?? "", currentSourceText: sourceBytes,
      previousSource: env.WEBSITE_RESUME_SOURCE_FILE === undefined ? undefined : {
        file: env.WEBSITE_RESUME_SOURCE_FILE, sha256: env.WEBSITE_RESUME_SOURCE_SHA256 ?? "" },
    });
    if (recovery && recovery.admission.consumerReleaseCommit !== env.WEBSITE_RELEASE_COMMIT) throw new WorkerError("CHECKPOINT_FAILED");
    notion = createRuntimeNotionReader({ token: env.NOTION_TOKEN ?? "", notionVersion: env.NOTION_API_VERSION }, signal,
      { intervalMs: env.WEBSITE_NOTION_INTERVAL_MS === undefined ? undefined : Number(env.WEBSITE_NOTION_INTERVAL_MS) });
    guard();
    if (env.WEBSITE_CAPTURE_COLLECTION !== undefined && !["true", "false"].includes(env.WEBSITE_CAPTURE_COLLECTION)) throw new WorkerError("MISCONFIGURED");
    if (env.WEBSITE_CAPTURE_COLLECTION === "true") capture = await createCollectionCapture(join(output, "collection-private"), {
      runId, sourceSha256: env.WEBSITE_SOURCE_SHA256!, releaseCommit: env.WEBSITE_RELEASE_COMMIT!, configDigest: configDigest(parseWebsiteNotionConfig(config)),
    });
    const cache = await createWebsiteImageCache({ directory: env.SYNC_IMAGE_CACHE_DIRECTORY ?? "", originalsDirectory: env.SYNC_IMAGE_ORIGINALS_DIRECTORY });
    const converterRoot = join(output, "conversion-tmp"); await privateDirectory(converterRoot);
    const download = createWebsiteImageDownloader({ userAgent: env.SYNC_IMAGE_USER_AGENT,
      wikimediaUserAgent: env.SYNC_WIKIMEDIA_USER_AGENT, timeoutMs: 60000, headerTimeoutMs: 10000,
      convertHeic: createHeicConverter({ executable: env.SYNC_HEIC_CONVERTER_PATH ?? "", temporaryRoot: converterRoot }) }, { cache });
    imageStatistics = download.statistics;
    imageFailure = download.failure;
    closeImageTransport = download.close;
    let storageEnv = parseEnv(await readPrivateFile(join(root, "supabase-worker.env"))), refresh: (() => Promise<void>) | undefined, refreshing: Promise<void> | undefined;
    const stableFields = ["SYNC_DATABASE_URL", "STORAGE_URL", "STORAGE_BUCKET", "STORAGE_API_KEY", "DATABASE_CA_CERT"];
    const originalEnv = { ...storageEnv };
    if (stableFields.some(field => originalEnv[field] !== env[field])) throw new WorkerError("MISCONFIGURED");
    const token = async () => {
      guard();
      let expires = 0;
      try { expires = JSON.parse(Buffer.from((storageEnv.STORAGE_WRITE_TOKEN ?? "").split(".")[1] ?? "", "base64url").toString()).exp * 1000; } catch { /* Force the authoritative refresh. */ }
      if (!Number.isFinite(expires) || expires - Date.now() < 120000) {
        if (!refresh) {
          const path = join(root, "refresh-writer-session.mjs"), code = await readPrivateFile(path);
          if (createHash("sha256").update(code).digest("hex") !== env.WEBSITE_REFRESH_SHA256) throw new WorkerError("MISCONFIGURED");
          const module = await import(pathToFileURL(path).href);
          refresh = async () => {
            const result = await module.refreshWriterSession(join(root, "supabase-worker.env"));
            if (result?.serverValidated !== true) throw new WorkerError("MISCONFIGURED");
            const next = parseEnv(await readPrivateFile(join(root, "supabase-worker.env")));
            if (stableFields.some(field => next[field] !== originalEnv[field])) throw new WorkerError("MISCONFIGURED");
            const exp = JSON.parse(Buffer.from((next.STORAGE_WRITE_TOKEN ?? "").split(".")[1] ?? "", "base64url").toString()).exp * 1000;
            if (!Number.isFinite(exp) || exp - Date.now() < 120000) throw new WorkerError("MISCONFIGURED");
            storageEnv = next; report.sessionRefreshes = Number(report.sessionRefreshes) + 1;
          };
        }
        refreshing ??= refresh().finally(() => { refreshing = undefined; }); await refreshing;
      }
      guard(); return storageEnv.STORAGE_WRITE_TOKEN!;
    };
    let writer: WebsiteWriter | undefined, mediaSources: ReturnType<typeof createWebsiteMediaSourceWriter> | undefined;
    let storage: ReturnType<typeof createSupabaseStorage> | undefined;
    const verifyIdentity = async (connection: NonNullable<typeof pool>, role: string) => {
      const client = await connection.connect();
      try {
        const identity = (await client.query("SELECT current_user AS role")).rows[0];
        const stream = (client as unknown as { connection: { stream: { encrypted?: boolean; authorized?: boolean } } }).connection.stream;
        if (identity.role !== role || !stream.encrypted || !stream.authorized) throw new WorkerError("MISCONFIGURED");
      } finally { client.release(); }
    };
    if (mode !== "dry-run") {
      await token(); guard();
      pool = createDatabasePool(env.SYNC_DATABASE_URL, "verify", env.DATABASE_CA_CERT);
      readerPool = createDatabasePool(env.DATABASE_READER_URL, "verify", env.READER_DATABASE_CA_CERT);
      await verifyIdentity(pool, "nb_macmini_writer"); await verifyIdentity(readerPool, "nb_website_reader"); guard();
      runtimeSql = createRuntimeWriterSql(sqlExecutor(pool), signal);
      const base = publicationWriter(runtimeSql.executor, publication);
      writer = { ...base,
        begin: async (_id, digest) => { guard(); const lease = await base.begin(runId, digest); report.cloudRunId = lease.runId; await save("receipt-private.json", report); guard(); return lease; },
        stage: async (...args) => { guard(); await base.stage(...args); guard(); },
        renew: async (...args) => { guard(); await base.renew(...args); guard(); },
        promote: async (...args) => { guard(); report.promoteRequested = true; await save("receipt-private.json", report);
          await base.promote(...args); report.published = true; await save("receipt-private.json", report); },
        // Cleanup remains possible after cancellation or the cooperative deadline.
        fail: base.fail,
      };
      if (mediaProvider === "notion") {
        const bindings = createWebsiteMediaSourceWriter(sqlExecutor(pool));
        mediaSources = { stage: async (...args) => { guard(); await bindings.stage(...args); guard(); } };
      }
      storage = createSupabaseStorage({ url: env.STORAGE_URL ?? "", bucket: env.STORAGE_BUCKET ?? "", apiKey: env.STORAGE_API_KEY ?? "", token, role: "writer" });
    }
    progress = setInterval(() => {
      if (pendingSave) return;
      pendingSave = save("progress-private.json", { runId, seconds: Math.round((Date.now() - started) / 1000), studyDiscovery: report.studyDiscovery, collection: report.collection, resume:report.resume, notion: notion?.statistics(), images: download.statistics() })
        .catch(() => { controller.abort(); }).finally(() => { pendingSave = undefined; });
    }, 30000);
    let resumeCollection: Awaited<ReturnType<typeof prepareCollectionResume>> | undefined;
    let resumeBudget: ReturnType<typeof openSharedBudget> | undefined;
    if(env.WEBSITE_RESUME_QUALIFICATION!==undefined&&(!env.WEBSITE_RESUME_RUN_ID||!["original","fresh"].includes(env.WEBSITE_RESUME_QUALIFICATION)))throw new WorkerError("MISCONFIGURED");
    if(env.WEBSITE_RESUME_RUN_ID!==undefined){
      if(publication!=="qualified"||mediaProvider!=="notion"||mode==="dry-run"||!capture||!runtimeSql||
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(env.WEBSITE_RESUME_RUN_ID))throw new WorkerError("MISCONFIGURED");
      const reserve=Number(env.WEBSITE_RESUME_REQUEST_RESERVE),post=Number(env.WEBSITE_RESUME_POST_SECONDS);
      if(!Number.isSafeInteger(reserve)||reserve<1||reserve>50000||!Number.isSafeInteger(post)||post<0||post>7200)throw new WorkerError("MISCONFIGURED");
      resumeBudget=openSharedBudget({directory:env.WEBSITE_SHARED_BUDGET_DIRECTORY??"",planDigest:env.WEBSITE_SHARED_BUDGET_DIGEST??"",
        nonce:env.WEBSITE_SHARED_BUDGET_NONCE??"",runtimeSha256:env.WEBSITE_SHARED_BUDGET_RUNTIME_SHA256??""});
      if(resumeBudget.plan.parentPid!==process.ppid)throw new WorkerError("MISCONFIGURED");
      const directory=join(state,"website-v2",env.WEBSITE_RESUME_RUN_ID,"collection-private");
      if(createHash("sha256").update(await readPrivateFile(join(directory,"index-private.json"))).digest("hex")!==env.WEBSITE_RESUME_INDEX_SHA256)throw new WorkerError("CHECKPOINT_FAILED");
      let producerReleaseCommit=env.WEBSITE_RELEASE_COMMIT!;
      if(recovery){producerReleaseCommit=recovery.admission.producerReleaseCommit;report.resumeCompatibility=recovery.admission;}
      else if(env.WEBSITE_RESUME_PRODUCER_PROJECT!==undefined){
        const {verifyCaptureProducer}=await import('./capture-release-compatibility.ts');
        const compatibility=await verifyCaptureProducer({producerProject:env.WEBSITE_RESUME_PRODUCER_PROJECT,
          producerManifest:env.WEBSITE_RESUME_PRODUCER_MANIFEST??'',producerManifestSha256:env.WEBSITE_RESUME_PRODUCER_MANIFEST_SHA256??'',
          consumerProject:process.cwd(),consumerManifest:env.WEBSITE_CONSUMER_MANIFEST??''});
        if(compatibility.consumerReleaseCommit!==env.WEBSITE_RELEASE_COMMIT)throw new WorkerError("CHECKPOINT_FAILED");
        producerReleaseCommit=compatibility.producerReleaseCommit;report.resumeCompatibility=compatibility;
      }
      resumeCollection=await prepareCollectionResume({qualification:(env.WEBSITE_RESUME_QUALIFICATION??"original") as ResumeQualification,directory,identity:{runId:env.WEBSITE_RESUME_RUN_ID,sourceSha256:recovery?.mapping?.previousSourceSha256??env.WEBSITE_SOURCE_SHA256!,releaseCommit:producerReleaseCommit,configDigest:recovery?.mapping?.previousConfigDigest??configDigest(parseWebsiteNotionConfig(config))},db:runtimeSql.executor,
        recovery:recovery?{...recovery,current:{sourceSha256:env.WEBSITE_SOURCE_SHA256!,configDigest:configDigest(parseWebsiteNotionConfig(config)),releaseCommit:env.WEBSITE_RELEASE_COMMIT!}}:undefined,
        onBound:async receipt=>{report.resumeQualification=receipt;await save("receipt-private.json",report);
          if(Date.parse(receipt.validUntil)-Date.parse(receipt.serverNow)<(seconds+post)*1000)throw new WorkerError("LIMIT_EXCEEDED");}});
      report.courseProjectionRefresh=resumeCollection.courseProjectionRefresh;
      resumeBudget.guard();
      if(resumeBudget.plan.limits.notionRequests-resumeBudget.read().counters.notionRequests<reserve)throw new WorkerError("LIMIT_EXCEEDED");
    }
    const publicationChecks: PublicationRevalidationProgress[] = [];
    const result = await runWebsiteSync({resumeCollection,
      publicationRepair: capture ? { maxPages: 32, maxPasses: 2 } : undefined,
      onPublicationRevalidation: async value => {
        guard();
        // Private identities are kept out of the normal progress/console DTO.
        report.publicationRevalidation = { pass: value.pass, phase: value.phase, checkedPages: value.checkedPages, repairedPages: value.repairedPages };
        publicationChecks.push(value);
        await save("publication-revalidation-private.json", { checks: publicationChecks });
      },
      onResumeProgress:value=>{guard();report.resume=value;},
      onResumePlan:async plan=>{
        guard();resumeBudget!.guard();
        const remaining=resumeBudget!.plan.limits.notionRequests-resumeBudget!.read().counters.notionRequests;
        const required=Math.max(Number(env.WEBSITE_RESUME_REQUEST_RESERVE),plan.knownWorkEstimate??0);
        report.resumePlan={...plan,remainingNotionRequests:remaining,requiredRequestReserve:required};await save("resume-plan-private.json",report.resumePlan);
        if(remaining<required)throw new WorkerError("LIMIT_EXCEEDED");
      }, captureCollection: capture, client: notion.client, config, mode: mode as "dry-run" | "stage" | "publish", writer, mediaSources, storage, maxMediaBytes, maxCollectionBytes, signal,
      collectionConcurrency: env.WEBSITE_COLLECTION_CONCURRENCY === undefined ? undefined : Number(env.WEBSITE_COLLECTION_CONCURRENCY),
      onCollectionProgress: value => { guard(); report.collection = value; },
      onStudyDiscoveryProgress: value => {
        guard(); report.studyDiscovery = value;
        if (value.phase !== "scanning") {
          const entry = JSON.stringify({ at: new Date().toISOString(), ...value, notion: notion?.statistics() }) + "\n";
          discoverySave = discoverySave.then(() => appendFile(join(output, "discovery-progress-private.jsonl"), entry, { mode: 0o600 }))
            .catch(() => { report.discoveryProgressWriteFailed = true; });
        }
      },
      download: async url => { guard(); const image = await download(url, signal); guard(); return image; } });
    Object.assign(report, result);
    if (mode === "publish") {
      const publishedDb = publicationReader(sqlExecutor(readerPool!), publication);
      const snapshot = (await publishedDb.query<{result: {runId: string; schemaDigest: string}}>(`WITH projection AS MATERIALIZED (
        SELECT nb_v2_api.read_snapshot($1::text[],$2) AS value)
        SELECT jsonb_build_object('runId',value->'runId','schemaDigest',value->'schemaDigest') AS result
        FROM projection`, [[], false])).rows[0].result;
      if (snapshot?.runId !== runId || snapshot?.schemaDigest !== WEBSITE_SCHEMA_DIGEST) throw new WorkerError("CHECKPOINT_FAILED");
      report.readerVerified = true;
      // Read back the explicitly selected server publication; local time cannot prove it.
      await save("receipt-private.json", report);
      try {
        report.thumbnailHandoff = await exportPublicationHandoff({ db: publishedDb, output, runId,
          releaseCommit: env.WEBSITE_RELEASE_COMMIT ?? "", sourceSha256: env.WEBSITE_SOURCE_SHA256 ?? "", guard });
        report.thumbnailHandoffStatus = "ready";
      } catch (error) {
        // This optional file export cannot undo a verified publication. A failed
        // export needs a fresh reader export, never an automatic full re-sync.
        report.thumbnailHandoffStatus = "unavailable";
        report.thumbnailHandoffCode = errorCode(error);
      }
      guard();
    }
    report.outcome = mode === "publish" ? "published-verified" : result.outcome;
  } catch (error) {
    terminalImageFailure = websiteImageFailure(error);
    report.outcome = report.published ? "published-unverified" : "failed";
    report.publicationMayHaveCommitted = report.promoteRequested;
    report.code = timedOut ? "RUN_BUDGET_EXCEEDED" : runtimeErrorCode(error); process.exitCode = 1;
    // Keep diagnostic context private. A diagnostic write must not replace the
    // publication outcome or prevent the normal receipt and connection cleanup.
    try {
      const detail = error instanceof Error ? error : undefined;
      await save("failure-private.json", { runId, name: detail?.name, code: report.code, notion: notion?.failure(), database: runtimeSql?.failure(),
        publicationChange: error instanceof PublicationRevalidationError ? error.publicationChange : undefined,
        message: detail?.message.slice(0, 4096), stack: detail?.stack?.slice(0, 8192) });
      report.failurePath = "failure-private.json";
    } catch { report.diagnosticWriteFailed = true; }
  } finally {
    clearTimeout(timeout); clearInterval(progress); process.off("SIGINT", cancel); process.off("SIGTERM", cancel); await pendingSave; await discoverySave;
    Object.assign(report, { collectionCapture: capture?.statistics(), seconds: Math.round((Date.now() - started) / 1000), notion: notion?.statistics(), database: runtimeSql?.statistics(), imageTransfer: imageStatistics?.(), finishedAt: new Date().toISOString() });
    try {
      const cleaned = await finalizeWebsiteRun({ report, save,
        imageFailure: terminalImageFailure ?? imageFailure?.(), closeImageTransport,
        closeWriter: pool ? () => pool!.end() : undefined,
        closeReader: readerPool ? () => readerPool!.end() : undefined });
      if (!cleaned) process.exitCode = 1;
    } catch (error) {
      report.receiptWriteFailed = true;
      report.code ??= runtimeErrorCode(error);
      process.exitCode = 1;
    }
  }
  console.log(JSON.stringify({ adapter: report.adapter, outcome: report.outcome, published: report.published, readerVerified: report.readerVerified,
    thumbnailHandoffStatus: report.thumbnailHandoffStatus, seconds: report.seconds, code: report.code, receiptWriteFailed: report.receiptWriteFailed }));
}
if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  main().catch(error => { console.error(JSON.stringify({ adapter: "private-host-v2", outcome: "preparation-failed", code: runtimeErrorCode(error) })); process.exitCode = 1; });
}
