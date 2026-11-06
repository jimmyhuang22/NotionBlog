import { get } from "node:http";
import { isSelfHostedRuntime } from "../../../scripts/self-hosted/context.cjs";
import { cacheRouteDeployment } from "./deployment.ts";

/** The pages most visitors open first. Each fills the public cache for the new generation. */
export const WARM_PATHS = ["/", "/works"] as const;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export interface PublicWarmTarget { origin: URL; host: string }
export interface PublicWarmOptions {
  getter?: typeof get;
  selfHosted?: () => boolean;
  timeoutMs?: number;
  maxBytes?: number;
}

/**
 * Only the persistent public server warms itself, and only through the fixed loopback origin its cache
 * routes already use (PUBLIC_CACHE_ORIGIN). Host comes from configuration, never from a request.
 */
export function publicWarmTarget(env: Record<string, string | undefined>, selfHosted: () => boolean = isSelfHostedRuntime): PublicWarmTarget | null {
  if (!selfHosted() || env.SELF_HOSTED_DEPLOYMENT !== "public-website" || env.PUBLIC_CONTENT_CACHE !== "tagged-v1") return null;
  try {
    const origin = new URL(cacheRouteDeployment(env).origin), site = new URL(env.SITE_URL ?? "");
    if (origin.protocol !== "http:" || !LOOPBACK.has(origin.hostname) || origin.pathname !== "/" ||
        origin.username || origin.password || origin.search || origin.hash) return null;
    if (site.protocol !== "https:" || site.username || site.password) return null;
    return { origin, host: site.host };
  } catch { return null; }
}

/** One normal page request, read to the end (a cut-off stream could stop the render), never rejecting. */
function warmOne(target: PublicWarmTarget, path: string, getter: typeof get, timeoutMs: number, maxBytes: number): Promise<void> {
  return new Promise(resolve => {
    let bytes = 0;
    const request = getter({ hostname: target.origin.hostname.replace(/^\[|\]$/g, ""), port: target.origin.port || 80, path,
      agent: false, signal: AbortSignal.timeout(timeoutMs), headers: { Host: target.host, "X-Forwarded-Proto": "https" } }, response => {
      response.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > maxBytes) response.destroy(); });
      response.on("end", () => resolve());
      response.on("close", () => resolve());
      response.on("error", () => resolve());
    });
    request.on("error", () => resolve());
  });
}

let running: Promise<void> | null = null;
let again = false;

/**
 * After a purge, render the first pages once so the next visitor does not pay the cold read. One round runs
 * at a time; purges arriving meanwhile ask for one more round, not one each. Outcomes are not logged:
 * a failed warm-up only leaves the page cold, as it was before.
 */
export function warmPublicPages(env: Record<string, string | undefined> = process.env, options: PublicWarmOptions = {}): Promise<void> | null {
  const target = publicWarmTarget(env, options.selfHosted);
  if (!target) return null;
  if (running) { again = true; return running; }
  const getter = options.getter ?? get, timeoutMs = options.timeoutMs ?? 15_000, maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  running = (async () => {
    do {
      again = false;
      for (const path of WARM_PATHS) await warmOne(target, path, getter, timeoutMs, maxBytes);
    } while (again);
  })().finally(() => { running = null; });
  return running;
}
