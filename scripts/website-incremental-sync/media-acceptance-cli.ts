import { pathToFileURL } from "node:url";
import { isAbsolute } from "node:path";
import { Client } from "pg";
import type { StoredMedia } from "../../contracts/sync.ts";
import { readPrivateFile } from "../notion-sync/state.ts";
import { parseWebsiteNotionConfig } from "../../src/server/notion/website-config.ts";
import { databasePoolConfig } from "../../src/server/database/connection.ts";
import { configuredCosStorage } from "../../src/server/database/cos-config.ts";
import { planMediaAcceptance, verifyMediaAcceptance, type AcceptanceThumbnail } from "./media-acceptance.ts";
import type { AcceptedFullBaseline } from "./full-baseline-artifact.ts";
import { createMediaAcceptanceBudget, MediaAcceptanceError, acceptanceFail as fail } from "./media-acceptance-budget.ts";
import { installRequestBudget } from "./request-budget.ts";
import { parseThumbnailScope, type ThumbnailScope } from "./thumbnail-scope.ts";

export function parseMediaAcceptanceArguments(args: readonly string[]) {
  const [command, ...rest] = args;
  if (!["plan", "verify"].includes(command ?? "") || rest.length % 2) fail("MEDIA_ACCEPTANCE_INPUT_INVALID");
  const allowed = ["config", "artifact", "thumbnails", "duration-ms", "sql-response-bytes", "control-bytes", "plan-sha256", "thumbnail-scope"], values = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i].startsWith("--") ? rest[i].slice(2) : "", value = rest[i + 1];
    if (!allowed.includes(key) || !value || value.startsWith("--") || values.has(key)) fail("MEDIA_ACCEPTANCE_INPUT_INVALID"); values.set(key, value);
  }
  const path = (key: string) => { const v = values.get(key); if (!v || !isAbsolute(v)) fail("MEDIA_ACCEPTANCE_INPUT_INVALID"); return v; };
  const number = (key: string) => { const v = values.get(key); if (!v || !/^(0|[1-9][0-9]*)$/.test(v) || !Number.isSafeInteger(Number(v))) fail("MEDIA_ACCEPTANCE_INPUT_INVALID"); return Number(v); };
  const expectedDigest = values.get("plan-sha256");
  if (command === "verify" ? !expectedDigest || !/^[a-f0-9]{64}$/.test(expectedDigest) : expectedDigest !== undefined) fail("MEDIA_ACCEPTANCE_INPUT_INVALID");
  return { command, config: path("config"), artifact: path("artifact"), thumbnails: path("thumbnails"), expectedDigest,
    thumbnailScope: values.has("thumbnail-scope") ? path("thumbnail-scope") : undefined,
    limits: { durationMs: number("duration-ms"), sqlResponseBytes: number("sql-response-bytes"), controlBytes: number("control-bytes") } };
}

export async function mediaAcceptanceMain(args: readonly string[], env: NodeJS.ProcessEnv = process.env) {
  if (args.length === 1 && args[0] === "--help") {
    console.log("node scripts/website-incremental-sync/media-acceptance-cli.ts plan|verify --config ABS_PRIVATE_JSON --artifact SAME_ACCEPTED_JSON --thumbnails PRIVATE_CANDIDATES_JSON --duration-ms N --sql-response-bytes N --control-bytes N [--thumbnail-scope REVIEWED_PRIVATE_JSON] [--plan-sha256 REVIEWED_DIGEST]"); return 0;
  }
  const parsed = parseMediaAcceptanceArguments(args), config = parseWebsiteNotionConfig(JSON.parse(await readPrivateFile(parsed.config)));
  const artifact = JSON.parse(await readPrivateFile(parsed.artifact, 48 * 1024 ** 2)) as AcceptedFullBaseline;
  let thumbnailScope: ThumbnailScope | undefined;
  if (parsed.thumbnailScope) {
    try { thumbnailScope = parseThumbnailScope(JSON.parse(await readPrivateFile(parsed.thumbnailScope, 1024))); }
    catch { fail("MEDIA_ACCEPTANCE_INPUT_INVALID"); }
  }
  const thumbnails = JSON.parse(await readPrivateFile(parsed.thumbnails, 16 * 1024 ** 2)) as { format: string; entries: AcceptanceThumbnail[] };
  if (!thumbnails || Object.keys(thumbnails).length !== 2 || thumbnails.format !== "media-acceptance-thumbnails-v1") fail("MEDIA_ACCEPTANCE_INPUT_INVALID");
  const plan = planMediaAcceptance(config, artifact, thumbnails.entries, { ...parsed.limits, ...(thumbnailScope ? { thumbnailScope } : {}) });
  if (parsed.command === "plan") { console.log(JSON.stringify({ outcome: "planned", planDigest: plan.digest, ...plan.summary,
    ...(plan.thumbnailScope ? { thumbnailScope: plan.thumbnailScope } : {}) })); return 0; }
  if (parsed.expectedDigest !== plan.digest) fail("MEDIA_ACCEPTANCE_PLAN_CHANGED");
  if (env.STORAGE_PROVIDER !== "cos" || env.DATABASE_MEDIA_DIRECTORY || !env.SYNC_READER_DATABASE_URL) fail("MEDIA_ACCEPTANCE_INPUT_INVALID");
  const readerUrl = env.SYNC_READER_DATABASE_URL;
  const settings = databasePoolConfig(readerUrl, env.DATABASE_TLS, env.DATABASE_CA_CERT);
  // Exactly one physical reader connection, including a server-enforced read-only
  // default on every statement. No writer connection or long snapshot transaction.
  const client = new Client({ ...settings, options: "-c default_transaction_read_only=on" }); client.on("error", () => {});
  const budget = createMediaAcceptanceBudget(plan.summary), deadline = Date.now() + Math.max(1, parsed.limits.durationMs);
  const origin = `https://${env.COS_BUCKET}.cos.${env.COS_REGION}.myqcloud.com`;
  const http = installRequestBudget({ limits: { notion: 0, imageOrigin: 0, storage: plan.summary.httpRequests, total: plan.summary.httpRequests }, storageOrigin: origin, deadline });
  const pending = new Set<Promise<unknown>>();
  const track = <T>(task: Promise<T>): Promise<T> => {
    pending.add(task); task.then(() => pending.delete(task), () => pending.delete(task)); return task;
  };
  let closing: Promise<void> | undefined;
  const close = () => closing ??= client.end(), abort = () => budget.cancel();
  const stop = () => { http.cancel(); void close().catch(() => {}); }, stopHttp = () => budget.cancel("MEDIA_ACCEPTANCE_HTTP_LIMIT");
  budget.signal.addEventListener("abort", stop, { once: true }); http.signal.addEventListener("abort", stopHttp, { once: true });
  process.once("SIGINT", abort); process.once("SIGTERM", abort);
  let result: Record<string, unknown> = { outcome: "failed" }, exitCode = 1;
  try {
    const descriptors = new Map(plan.objects.map(m => [`/${env.COS_PREFIX?.replace(/\/$/, "")}/${m.objectKey}`, m]));
    const fetcher: typeof fetch = async (input, init) => {
      budget.guard(); const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url), expected = descriptors.get(url.pathname);
      if (url.origin !== origin || !expected || url.search || (init?.method ?? "GET") !== "GET") fail("MEDIA_ACCEPTANCE_INPUT_INVALID");
      const response = await http.fetch(input, { ...init, signal: AbortSignal.any([budget.signal, ...(init?.signal ? [init.signal] : [])]) });
      if (!response.body) fail("MEDIA_ACCEPTANCE_OBJECT_UNAVAILABLE");
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
      try {
        while (true) { budget.guard(); const next = await reader.read(); if (next.done) break;
          budget.observe("mediaResponseBytes", next.value.length); bytes += next.value.length;
          if (bytes > (response.status === 200 ? expected.byteSize : parsed.limits.controlBytes)) {
            budget.cancel("MEDIA_ACCEPTANCE_BYTE_LIMIT"); fail("MEDIA_ACCEPTANCE_BYTE_LIMIT");
          }
          chunks.push(next.value);
        }
      } catch (e) { await reader.cancel().catch(() => {}); throw e; }
      budget.guard();
      if (response.status === 200 && (response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== expected.mime ||
        response.headers.get("content-length") !== String(expected.byteSize))) {
        budget.cancel("MEDIA_ACCEPTANCE_OBJECT_MISMATCH"); fail("MEDIA_ACCEPTANCE_OBJECT_MISMATCH");
      }
      return new Response(Buffer.concat(chunks), { status: response.status, headers: response.headers });
    };
    const storage = configuredCosStorage(env, "reader", { fetch: fetcher });
    await budget.wait(() => client.connect());
    const reader = { query: <T>(text: string, values?: unknown[]) => track(client.query(text, values).then(v => ({ rows: v.rows as T[] }))) };
    result = await verifyMediaAcceptance(plan, { reader, readerUrl, storage: { read: (media: StoredMedia) => track(storage.read(media)) }, budget }); budget.guard(); exitCode = 0;
  } catch (error) {
    result = { outcome: "failed", errorCode: budget.statistics().failure ?? (error instanceof MediaAcceptanceError ? error.code : "MEDIA_ACCEPTANCE_UNAVAILABLE") };
  } finally {
    budget.signal.removeEventListener("abort", stop); http.signal.removeEventListener("abort", stopHttp);
    process.removeListener("SIGINT", abort); process.removeListener("SIGTERM", abort);
    http.close();
    try { await close(); } catch { exitCode = 1; result = { outcome: "failed", errorCode: "MEDIA_ACCEPTANCE_CLOSE_FAILED" }; }
    await Promise.allSettled([...pending]);
    try { budget.guard(); } catch { exitCode = 1; result = { outcome: "failed", errorCode: budget.statistics().failure ?? "MEDIA_ACCEPTANCE_UNAVAILABLE" }; }
    const counters = budget.statistics(), requests = http.statistics(); budget.close(); http.restore();
    console.log(JSON.stringify({ format: "independent-media-acceptance-v1", planDigest: plan.digest, ...result, counters,
      ...(plan.thumbnailScope ? { thumbnailScope: plan.thumbnailScope } : {}),
      httpRequests: requests.total, httpFailure: requests.failure }));
  }
  return exitCode;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) mediaAcceptanceMain(process.argv.slice(2))
  .then(code => { process.exitCode = code; }).catch(error => {
    console.error(JSON.stringify({ outcome: "failed", errorCode: error instanceof MediaAcceptanceError ? error.code : "MEDIA_ACCEPTANCE_UNAVAILABLE" })); process.exitCode = 1;
  });
