import { pathToFileURL } from "node:url";
import { installRequestBudget, RequestBudgetError, type RequestLimits } from "./request-budget.ts";

const httpFlags = { "http-notion-requests": "notion", "http-storage-requests": "storage",
  "http-image-requests": "imageOrigin", "http-total-requests": "total" } as const;
const commands = ["publish", "seal", "initialize", "recover", "run", "full-status", "incremental-status"] as const;
type Command = typeof commands[number];
const fail = (): never => { throw new RequestBudgetError("HTTP_BUDGET_INPUT_INVALID"); };
export function parseGuardedArguments(args: readonly string[]) {
  const [name, ...rest] = args;
  if (!commands.includes(name as Command) || rest.length % 2) fail();
  const command = name as Command, limits: RequestLimits = { notion: 0, storage: 0, imageOrigin: 0, total: 0 };
  const original: string[] = [], seen = new Set<string>();
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i].startsWith("--") ? rest[i].slice(2) : "", value = rest[i + 1];
    if (!flag || !value || value.startsWith("--") || seen.has(flag)) fail(); seen.add(flag);
    if (Object.hasOwn(httpFlags, flag)) {
      if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 20000) fail();
      limits[httpFlags[flag as keyof typeof httpFlags]] = Number(value);
    } else original.push(rest[i], value);
  }
  const usesSource = command === "publish" || command === "run";
  if (usesSource ? Object.keys(httpFlags).some(flag => !seen.has(flag)) || !limits.total : Object.keys(httpFlags).some(flag => seen.has(flag))) fail();
  const status = command === "full-status" || command === "incremental-status";
  const index = original.indexOf("--duration-ms"), durationMs = index >= 0 ? Number(original[index + 1]) : status ? 10000 : NaN;
  if (!Number.isSafeInteger(durationMs) || durationMs < 10 || durationMs > (command === "publish" ? 5400000 : 899000)) fail();
  return { command, usesSource, limits, durationMs, args: [status ? "status" : command, ...original],
    full: command === "publish" || command === "seal" || command === "full-status" };
}

/** One invocation, one host lock, one existing command. No stage chaining,
 * policy setup, retry, recollection or implicit runtime installation. */
export async function guardedHostMain(args: readonly string[], env: NodeJS.ProcessEnv = process.env) {
  if (args.length === 1 && args[0] === "--help") {
    console.log("node scripts/website-incremental-sync/guarded-cli.ts publish|run --http-notion-requests N --http-storage-requests N --http-image-requests N --http-total-requests N EXISTING_CLI_ARGUMENTS_WITH_DURATION\nseal|initialize|recover require existing arguments with explicit --duration-ms; all HTTP is forbidden.\nfull-status|incremental-status use the existing status arguments."); return 0;
  }
  const parsed = parseGuardedArguments(args);
  // The reviewed first cutover uses COS. Supabase session HTTP must receive its
  // own reviewed origin/categories before adding support, never become images.
  if (parsed.usesSource && (env.STORAGE_PROVIDER !== "cos" || env.DATABASE_MEDIA_DIRECTORY ||
    !/^[a-z0-9][a-z0-9-]{0,49}-[0-9]{5,20}$/.test(env.COS_BUCKET ?? "") ||
    !/^[a-z]{2}-[a-z0-9]+(?:-[a-z0-9]+){0,3}$/.test(env.COS_REGION ?? ""))) fail();
  const storageOrigin = parsed.usesSource ? `https://${env.COS_BUCKET}.cos.${env.COS_REGION}.myqcloud.com` : "https://offline.invalid";
  const budget = installRequestBudget({ limits: parsed.limits, storageOrigin, deadline: Date.now() + parsed.durationMs });
  const abort = () => budget.cancel(); process.once("SIGINT", abort); process.once("SIGTERM", abort);
  // Use the original CLI's graceful cancellation path as well as cancelling
  // HTTP. A cache hit or pending SQL operation must not continue after expiry.
  const stopHost = () => { process.emit("SIGTERM"); };
  budget.signal.addEventListener("abort", stopHost, { once: true });
  try {
    // Install before module loading: SDK/default-fetch captures and named ESM
    // native request imports must see the guarded transports.
    const main = parsed.full ? (await import("./full-baseline-cli.ts")).fullBaselineMain : (await import("./cli.ts")).incrementalMain;
    budget.guard();
    const code = await main(parsed.args, env);
    const failure = budget.statistics().failure;
    return failure === "HTTP_BUDGET_CANCELLED" ? 2 : failure ? 1 : code;
  } finally {
    budget.signal.removeEventListener("abort", stopHost);
    process.removeListener("SIGINT", abort); process.removeListener("SIGTERM", abort);
    try { console.log(JSON.stringify({ format: "host-http-budget-v1", ...budget.statistics() })); } finally { budget.restore(); }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) guardedHostMain(process.argv.slice(2))
  .then(code => { process.exitCode = code; }).catch(error => {
    console.error(JSON.stringify({ outcome: "failed", errorCode: error instanceof RequestBudgetError ? error.code : "GUARDED_HOST_UNAVAILABLE" })); process.exitCode = 1;
  });
