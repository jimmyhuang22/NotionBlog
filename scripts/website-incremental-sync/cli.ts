import { reviewIncrementalQueue } from "./review.ts";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { readPrivateFile } from "../notion-sync/state.ts";
import { createHeicConverter } from "../notion-sync/heic.ts";
import { createWebsiteImageCache } from "../website-sync/image-cache.ts";
import { runIncrementalHost, type IncrementalHostOptions } from "./host.ts";
import { createRuntimeSources } from "./runtime-sources.ts";
import { readHostJson, validateHostReport } from "./host-state.ts";
import { hostFail, IncrementalHostError } from "./host-budget.ts";
import { createRuntimeStorage } from "./runtime-storage.ts";

export function parseIncrementalArguments(args: readonly string[]) {
  const [command, ...rest] = args;
  if (!["initialize", "recover", "run", "status", "list-review", "resume", "compact-history"].includes(command ?? "") || rest.length % 2) hostFail("HOST_INPUT_INVALID");
  const allowed = ["config", "lock-dir", "runtime-dir", "artifact", "max-tasks", "max-sources", "duration-ms", "source-requests", "source-bytes", "media-bytes", "source", "page", "refresh-group", "freeze-generation", "expected-revision", "baseline-reads"];
  const values = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i].startsWith("--") ? rest[i].slice(2) : "", value = rest[i + 1];
    if (!allowed.includes(name) || values.has(name) || !value || value.startsWith("--")) hostFail("HOST_INPUT_INVALID");
    values.set(name, value);
  }
  const path = (name: string, required = true) => {
    const v = values.get(name); if (required && !v || v && !isAbsolute(v)) hostFail("HOST_INPUT_INVALID"); return v;
  };
  const number = (name: string) => { const v = values.get(name); if (v === undefined) return undefined;
    if (!/^[1-9][0-9]*$/.test(v) || !Number.isSafeInteger(Number(v))) hostFail("HOST_INPUT_INVALID"); return Number(v); };
  const runtimeDirectory = path("runtime-dir")!;
  if (command === "status") {
    if (values.size !== 1) hostFail("HOST_INPUT_INVALID");
    return { command: "status" as const, runtimeDirectory };
  }
  if (command === "list-review" || command === "resume" || command === "compact-history") {
    if ([...values.keys()].some(key => !["config", "lock-dir", "runtime-dir", "source", "page"].includes(key)) ||
      values.has("source") !== values.has("page") || command === "resume" && !values.has("source")) hostFail("HOST_INPUT_INVALID");
    const review = { runtimeDirectory, configPath: path("config")!, lockDirectory: path("lock-dir")!, sourceKey: values.get("source"), pageKey: values.get("page") };
    if (command === "compact-history") {
      if (values.has("source")) hostFail("HOST_INPUT_INVALID");
      return { ...review, command: "compact-history" as const };
    }
    return command === "list-review" ? { ...review, command: "list-review" as const } : { ...review, command: "resume" as const };
  }
  if (values.has("source") !== values.has("page") || values.has("source") && command !== "run" ||
      values.has("refresh-group") !== values.has("freeze-generation") || values.has("refresh-group") && (!values.has("source") || command !== "run")) hostFail("HOST_INPUT_INVALID");
  if (command !== "initialize" && values.has("artifact")) hostFail("HOST_INPUT_INVALID");
  if (values.has("expected-revision") && command !== "run") hostFail("HOST_INPUT_INVALID");
  if (values.has("baseline-reads") && command !== "initialize") hostFail("HOST_INPUT_INVALID");
  return { command: command as IncrementalHostOptions["command"], runtimeDirectory, configPath: path("config")!, lockDirectory: path("lock-dir")!,
    target: values.has("source") ? { sourceKey: values.get("source")!, pageKey: values.get("page")! } : undefined,
    refreshFrozenGroup: values.get("refresh-group"), expectedFreezeGeneration: values.get("freeze-generation"),
    expectedPublicationRevision: values.get("expected-revision"),
    artifactPath: path("artifact", command === "initialize"), maxTasks: number("max-tasks"), maxSources: number("max-sources"), maxBaselineReads: number("baseline-reads"),
    durationMs: number("duration-ms"), sourceRequests: number("source-requests"), sourceBytes: number("source-bytes"), mediaBytes: number("media-bytes") };
}

export async function incrementalMain(args: readonly string[], env: NodeJS.ProcessEnv = process.env) {
  if (args.length === 1 && args[0] === "--help") {
    console.log("node scripts/website-incremental-sync/cli.ts initialize|recover|run --config ABSOLUTE_PRIVATE_JSON --lock-dir CANONICAL_STATE_DIR --runtime-dir PRIVATE_RUNTIME_DIR [--artifact ACCEPTED_BASELINE_JSON]\ninitialize also accepts --baseline-reads NUMBER (default 2000, maximum 20000)\nrun also accepts --source KEY --page KEY [--refresh-group UUID --freeze-generation NUMBER --expected-revision RUN:REVISION]\nnode scripts/website-incremental-sync/cli.ts status --runtime-dir PRIVATE_RUNTIME_DIR\nnode scripts/website-incremental-sync/cli.ts list-review|resume|compact-history --config ABSOLUTE_PRIVATE_JSON --lock-dir CANONICAL_STATE_DIR --runtime-dir PRIVATE_RUNTIME_DIR [--source KEY --page KEY]"); return 0;
  }
  const parsed = parseIncrementalArguments(args);
  if (parsed.command === "status") { const report = await readHostJson(parsed.runtimeDirectory, "incremental-latest.json");
    console.log(JSON.stringify(report === null ? { outcome: "uninitialized" } : validateHostReport(report))); return 0; }
  if (parsed.command === "list-review" || parsed.command === "resume" || parsed.command === "compact-history") {
    console.log(JSON.stringify(await reviewIncrementalQueue(parsed))); return 0;
  }
  if (env.SYNC_PUBLICATION_MODE !== "published" || env.SYNC_MEDIA_PROVIDER !== "storage" || !env.SYNC_READER_DATABASE_URL || !env.SYNC_DATABASE_URL) hostFail("HOST_INPUT_INVALID");
  const config = JSON.parse(await readPrivateFile(parsed.configPath)), controller = new AbortController();
  const abort = () => controller.abort(); process.on("SIGINT", abort); process.on("SIGTERM", abort);
  try {
    const report = await runIncrementalHost({ ...parsed, config, signal: controller.signal, freezeEnabled: env.SYNC_FREEZE_ENABLED === "1",
      database: { readerUrl: env.SYNC_READER_DATABASE_URL, writerUrl: env.SYNC_DATABASE_URL, tls: env.DATABASE_TLS, ca: env.DATABASE_CA_CERT } }, {
      async sources(input) {
        const storage = await createRuntimeStorage({ env, budget: input.budget, registerCleanup: input.registerCleanup }); input.budget.guard();
        const imageCache = env.SYNC_IMAGE_CACHE_DIRECTORY ? await createWebsiteImageCache({ directory: env.SYNC_IMAGE_CACHE_DIRECTORY,
          originalsDirectory: env.SYNC_IMAGE_ORIGINALS_DIRECTORY }) : undefined;
        if (env.SYNC_IMAGE_ORIGINALS_DIRECTORY && !imageCache) hostFail("HOST_INPUT_INVALID");
        return createRuntimeSources({ ...input, storage, imageCache, token: env.NOTION_TOKEN ?? "", notionVersion: env.NOTION_API_VERSION,
          userAgent: env.SYNC_IMAGE_USER_AGENT, convertHeic: env.SYNC_HEIC_CONVERTER_PATH ? createHeicConverter({ executable: env.SYNC_HEIC_CONVERTER_PATH,
            temporaryRoot: parsed.runtimeDirectory }) : undefined });
      },
    });
    console.log(JSON.stringify(report));
    return ["initialized", "recovered", "updated", "unchanged", "partial"].includes(report.outcome) ? 0 : report.outcome === "cancelled" ? 2 : 1;
  } finally { process.removeListener("SIGINT", abort); process.removeListener("SIGTERM", abort); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) incrementalMain(process.argv.slice(2)).then(code => { process.exitCode = code; })
  .catch(error => { console.error(JSON.stringify({ outcome: "failed", errorCode: error instanceof IncrementalHostError ? error.code : "HOST_UNAVAILABLE" })); process.exitCode = 1; });
