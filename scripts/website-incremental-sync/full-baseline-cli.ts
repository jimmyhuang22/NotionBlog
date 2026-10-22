import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { readPrivateFile } from "../notion-sync/state.ts";
import { createHeicConverter } from "../notion-sync/heic.ts";
import { createWebsiteImageCache } from "../website-sync/image-cache.ts";
import { readHostJson } from "./host-state.ts";
import { createFullBaselineSources } from "./full-baseline-sources.ts";
import { runFullBaselineHost, validateFullBaselineReport, type FullBaselineHostOptions } from "./full-baseline-host.ts";
import { hostFail, IncrementalHostError } from "./host-budget.ts";
import { createRuntimeStorage } from "./runtime-storage.ts";

export function parseFullBaselineArguments(args: readonly string[]) {
  const [command, ...rest] = args, allowed = ["config", "lock-dir", "artifact-dir", "duration-ms", "source-requests", "source-bytes", "media-bytes", "max-media-bytes"];
  if (!["publish", "seal", "status"].includes(command ?? "") || rest.length % 2) hostFail("HOST_INPUT_INVALID");
  const values = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i].startsWith("--") ? rest[i].slice(2) : "", value = rest[i + 1];
    if (!allowed.includes(key) || values.has(key) || !value || value.startsWith("--")) hostFail("HOST_INPUT_INVALID"); values.set(key, value);
  }
  const path = (key: string) => { const v = values.get(key); if (!v || !isAbsolute(v)) hostFail("HOST_INPUT_INVALID"); return v; };
  const number = (key: string) => { const v = values.get(key); if (v === undefined) return undefined;
    if (!/^[1-9][0-9]*$/.test(v) || !Number.isSafeInteger(Number(v))) hostFail("HOST_INPUT_INVALID"); return Number(v); };
  const artifactDirectory = path("artifact-dir");
  if (command === "status") { if (values.size !== 1) hostFail("HOST_INPUT_INVALID"); return { command: "status" as const, artifactDirectory }; }
  return { command: command as FullBaselineHostOptions["command"], artifactDirectory, configPath: path("config"), lockDirectory: path("lock-dir"),
    durationMs: number("duration-ms"), sourceRequests: number("source-requests"), sourceBytes: number("source-bytes"), mediaBytes: number("media-bytes"), maxMediaBytes: number("max-media-bytes") };
}
export async function fullBaselineMain(args: readonly string[], env: NodeJS.ProcessEnv = process.env) {
  if (args.length === 1 && args[0] === "--help") {
    console.log("node scripts/website-incremental-sync/full-baseline-cli.ts publish|seal --config ABSOLUTE_PRIVATE_JSON --lock-dir CANONICAL_STATE_DIR --artifact-dir PRIVATE_ONE_RUN_DIR\nnode scripts/website-incremental-sync/full-baseline-cli.ts status --artifact-dir PRIVATE_ONE_RUN_DIR"); return 0;
  }
  const parsed = parseFullBaselineArguments(args);
  if (parsed.command === "status") {
    const r = await readHostJson(parsed.artifactDirectory, "baseline-latest.json"); console.log(JSON.stringify(r === null ? { outcome: "uninitialized" } : validateFullBaselineReport(r))); return 0;
  }
  if (env.SYNC_PUBLICATION_MODE !== "published" || env.SYNC_MEDIA_PROVIDER !== "storage" || !env.SYNC_READER_DATABASE_URL || !env.SYNC_DATABASE_URL) hostFail("HOST_INPUT_INVALID");
  const config = JSON.parse(await readPrivateFile(parsed.configPath)), controller = new AbortController(), abort = () => controller.abort();
  process.once("SIGINT", abort); process.once("SIGTERM", abort);
  try {
    const report = await runFullBaselineHost({ ...parsed, config, signal: controller.signal,
      database: { readerUrl: env.SYNC_READER_DATABASE_URL, writerUrl: env.SYNC_DATABASE_URL, tls: env.DATABASE_TLS, ca: env.DATABASE_CA_CERT } }, {
      async sources({ budget, registerCleanup }) {
        const storage = await createRuntimeStorage({ env, budget, registerCleanup }); budget.guard();
        const imageCache = env.SYNC_IMAGE_CACHE_DIRECTORY ? await createWebsiteImageCache({ directory: env.SYNC_IMAGE_CACHE_DIRECTORY,
          originalsDirectory: env.SYNC_IMAGE_ORIGINALS_DIRECTORY }) : undefined;
        if (env.SYNC_IMAGE_ORIGINALS_DIRECTORY && !imageCache) hostFail("HOST_INPUT_INVALID");
        return createFullBaselineSources({ token: env.NOTION_TOKEN ?? "", notionVersion: env.NOTION_API_VERSION, budget, storage, imageCache,
          userAgent: env.SYNC_IMAGE_USER_AGENT, convertHeic: env.SYNC_HEIC_CONVERTER_PATH ? createHeicConverter({ executable: env.SYNC_HEIC_CONVERTER_PATH,
            temporaryRoot: parsed.artifactDirectory }) : undefined });
      },
    });
    console.log(JSON.stringify(report)); return report.outcome === "accepted" ? 0 : report.outcome === "cancelled" ? 2 : 1;
  } finally { process.removeListener("SIGINT", abort); process.removeListener("SIGTERM", abort); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) fullBaselineMain(process.argv.slice(2))
  .then(code => { process.exitCode = code; }).catch(e => { console.error(JSON.stringify({ outcome: "failed", errorCode: e instanceof IncrementalHostError ? e.code : "FULL_BASELINE_UNAVAILABLE" })); process.exitCode = 1; });
