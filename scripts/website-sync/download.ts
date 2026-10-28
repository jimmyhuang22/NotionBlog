import { Agent, request } from "node:https";
import type { IncomingMessage } from "node:http";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { setTimeout as delay } from "node:timers/promises";
import { createImageDownloader, type Address, type DownloadOptions, type ImageResponse } from "../notion-sync/download.ts";
import { WorkerError, checkSignal } from "../notion-sync/errors.ts";
import { imageCacheKey, imageCacheVary, strongImageEtag, type WebsiteImageCache, type ImageCacheReceipt } from "./image-cache.ts";

const NETWORK_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "EAI_AGAIN", "ABORT_ERR"]);
interface Observation { network: boolean; status?: number; url?: string; host?: string; transportCode?: string; phase?: string; retryAfterMs?: number; timeoutKind?: "image" | "headers" }
interface WebsiteDownloadOptions extends DownloadOptions {
  wikimediaUserAgent?: string;
  /** Only with retry:false: re-send the same read-only GET after a network
   * error, its own timeout or HTTP 500/502/503/504. At most three attempts with
   * 2 s/5 s waits; every attempt keeps all URL/IP/TLS/type/size guards, is
   * counted in the same statistics, and denials or rate limits never retry. */
  imageRetry?: "transient-get-v1";
}
export interface WebsiteImageContext {
  ownerPageId: string;
  locator: { kind: "cover" } | { kind: "property"; name: string } | { kind: "block"; id: string };
}
export interface WebsiteImageFailure {
  inputUrl: string; requestUrl?: string; attempt: number; httpStatus?: number;
  requestHost?: string; transportCode?: string; phase: string;
  elapsedMs: number; attemptElapsedMs: number; attemptTimeoutMs: number;
  timeoutKind?: "image" | "headers";
  context?: WebsiteImageContext;
  retryAfterSeconds?: number;
}
// Bind diagnostics to the error that actually escapes the collector. A shared
// last-failure slot can be reset while already-started peers finish other pages.
// Weak keys also avoid retaining signed URLs for successful later operations.
const failures = new WeakMap<object, WebsiteImageFailure>();
export function websiteImageFailure(error: unknown): WebsiteImageFailure | undefined {
  const value = error && typeof error === "object" ? failures.get(error) : undefined;
  return value && structuredClone(value);
}
export function addWebsiteImageContext(error: unknown, context: WebsiteImageContext): void {
  if (!error || typeof error !== "object") return;
  const value = failures.get(error);
  if (value) value.context = structuredClone({ ownerPageId: context.ownerPageId, locator: context.locator });
}
interface RetryPorts {
  wait?(milliseconds: number, signal?: AbortSignal): Promise<void>;
  onRetry?(event: { attempt: number; networkFailure: boolean; httpStatus?: number }): void;
  cache?: WebsiteImageCache;
  /** Charge every received wire chunk, including unsuccessful attempts. */
  onReceivedBytes?(bytes: number): void;
  now?(): number;
}
const MAX_RATE_LIMIT_WAIT_MS = 120_000;
const noStore = (value: string | undefined) => /(?:^|,)\s*no-store\s*(?:,|$)/i.test(value ?? "");
function retryAfterMilliseconds(value: string | undefined): number | undefined {
  const text = value?.trim();
  const delay = text && /^\d+$/.test(text) ? Number(text) * 1000 :
    text && /^[A-Za-z]+[ ,]/.test(text) && Number.isFinite(Date.parse(text)) ? Date.parse(text) - Date.now() : 60_000;
  // Preserve the advertised delay for diagnostics; the caller rejects waits
  // outside its per-image budget instead of retrying before the upstream limit.
  return Number.isFinite(delay) && delay <= 2_147_483_647 ? Math.max(1000, Math.ceil(delay)) : undefined;
}
function networkError(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && NETWORK_CODES.has(String(error.code));
}
function transportCode(error: unknown): string | undefined {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
  return code && (NETWORK_CODES.has(code) || ["ERR_STREAM_PREMATURE_CLOSE", "EAI_AGAIN", "ENOTFOUND",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID"].includes(code)) ? code : undefined;
}
export function wrapWebsiteImageResponse(response: IncomingMessage): ImageResponse {
  const headers: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(response.headers)) headers[key] = Array.isArray(value) ? value.join(",") : value;
  return { status: response.statusCode ?? 0, headers, bytes: response,
    cancel: () => {
      // Node's HTTP parser guarantees a 304 has no body. Allow its end event
      // to release the verified socket to the pool instead of destroying it.
      if (response.statusCode === 304) { response.resume(); return; }
      if (!response.complete || !response.readableEnded) response.destroy();
    } };
}
/** Receives only addresses already checked by the original downloader. */
function pinned(url: URL, address: Address, signal: AbortSignal, headers: Readonly<Record<string, string>>, agent: Agent): Promise<ImageResponse> {
  return new Promise((resolve, reject) => {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const req = request({ protocol: "https:", hostname: address.address, family: address.family, port: 443,
      servername: isIP(host) ? undefined : host, path: url.pathname + url.search, method: "GET",
      headers, agent, signal, rejectUnauthorized: true }, response => {
      resolve(wrapWebsiteImageResponse(response));
    });
    req.on("error", reject); req.end();
  });
}

/** v2 only: three attempts, with every attempt retaining the v1 URL/IP/TLS/byte guards. */
export function createWebsiteImageDownloader(options: WebsiteDownloadOptions = {}, ports: RetryPorts = {}) {
  const { imageRetry, ...baseOptions } = options;
  if (imageRetry !== undefined && (imageRetry !== "transient-get-v1" || options.retry !== false)) throw new WorkerError("MISCONFIGURED");
  const boundedGet = imageRetry === "transient-get-v1";
  const maxAttempts = options.retry === false && !boundedGet ? 1 : 3;
  createImageDownloader(baseOptions); // Preserve immediate option/header validation.
  if (options.wikimediaUserAgent !== undefined) createImageDownloader({ ...options, userAgent: options.wikimediaUserAgent });
  const agent = new Agent({ keepAlive: true, maxSockets: 4, maxFreeSockets: 1, maxTotalSockets: 4, timeout: 5000 });
  const requester = options.request ?? ((url, address, signal, headers) => pinned(url, address, signal, headers, agent));
  const resolver = options.resolve ?? (hostname => lookup(hostname, { all: true, verbatim: true }));
  const preferred = new Map<string, string>();
  // Resolve on every image. Reorder only an address still present in the fresh
  // complete answer; the original downloader validates every answer before use.
  const resolve = async (hostname: string) => {
    const addresses = await resolver(hostname), known = preferred.get(hostname);
    return known ? [...addresses.filter(a => a.address === known), ...addresses.filter(a => a.address !== known)] : addresses;
  };
  const wait = ports.wait ?? (async (ms, signal) => { await delay(ms, undefined, { signal }); });
  const now = ports.now ?? (() => performance.now());
  const statistics = { requests: 0, receivedBodyBytes: 0, revalidatedImages: 0, reusedBytes: 0, downloadedImages: 0,
    rateLimitResponses: 0, lastRetryAfterSeconds: null as number | null };
  let failure: WebsiteImageFailure | undefined;
  let activeDownloads = 0;
  const performDownload = async (input: string, parentSignal?: AbortSignal) => {
    checkSignal(parentSignal);
    const started = now();
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const attemptStarted = now();
      // A slow TLS/header handshake should get a longer bounded opportunity
      // on retry. The existing total per-image deadline still caps each round.
      const headerTimeoutMs = Math.min(options.timeoutMs ?? 20_000,
        (options.headerTimeoutMs ?? Math.min(5000, options.timeoutMs ?? 20_000)) * 2 ** attempt);
      let last: Observation = { network: false };
      let reused = false, receipt: Omit<ImageCacheReceipt, "sha256" | "byteSize" | "mime"> | undefined;
      const download = createImageDownloader({ ...baseOptions, headerTimeoutMs,
        convertHeic: options.convertHeic ? async (bytes, signal) => {
          last.phase = "conversion";
          try { return await options.convertHeic!(bytes, signal); }
          catch (error) {
            if (signal.aborted && !parentSignal?.aborted) last.timeoutKind = "image";
            throw error;
          }
        } : undefined,
        resolve: async host => {
        const observation: Observation = { network: false, host, phase: "dns" }; last = observation;
        try { return await resolve(host); }
        catch (error) { observation.network = networkError(error); observation.transportCode = transportCode(error); throw error; }
      }, request: async (url, address, signal, headers) => {
        const observation: Observation = { network: false, url: url.href, host: url.hostname, phase: "cache" }; last = observation;
        try {
          // Scope the operator's contact identity to this image host. Changing
          // unrelated User-Agent cache keys would discard reusable originals.
          const outgoing = options.wikimediaUserAgent && url.hostname === "upload.wikimedia.org" ?
            Object.freeze({ ...headers, "User-Agent": options.wikimediaUserAgent }) : headers;
          const key = imageCacheKey(url, outgoing["User-Agent"]);
          const cached = await ports.cache?.read(key, signal); checkSignal(signal);
          statistics.requests++;
          observation.phase = "headers";
          const response = await requester(url, address, signal, cached ? Object.freeze({ ...outgoing, "If-None-Match": cached.receipt.etag }) : outgoing);
          observation.status = response.status;
          observation.phase = "response";
          if (response.status === 429 || response.status === 529) {
            observation.retryAfterMs = retryAfterMilliseconds(response.headers["retry-after"]);
            statistics.rateLimitResponses++;
            statistics.lastRetryAfterSeconds = observation.retryAfterMs === undefined ? null : observation.retryAfterMs / 1000;
          }
          if (response.status === 200 || response.status === 304) preferred.set(url.hostname, address.address);
          if (response.status === 304) {
            response.cancel();
            const mime = response.headers["content-type"]?.split(";")[0].trim().toLowerCase();
            if (!cached || !strongImageEtag(response.headers.etag) || response.headers.etag !== cached.receipt.etag ||
                (mime && mime !== cached.receipt.wireMime) ||
                (response.headers.vary !== undefined && imageCacheVary(response.headers.vary) !== cached.receipt.vary) ||
                noStore(response.headers["cache-control"]) ||
                (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity")) throw new WorkerError("IMAGE_REJECTED");
            reused = true;
            return { status: 200, headers: { "content-type": cached.image.mime, "content-length": String(cached.image.bytes.length) },
              bytes: (async function* () { yield cached.image.bytes; })(), cancel() {} };
          }
          const vary = imageCacheVary(response.headers.vary);
          if (response.status === 200 && strongImageEtag(response.headers.etag) && vary !== undefined && !noStore(response.headers["cache-control"])) {
            receipt = { version: 1, key, etag: response.headers.etag, wireMime: response.headers["content-type"]?.split(";")[0].trim().toLowerCase() ?? "", vary };
          }
          return { ...response, bytes: (async function* () {
            observation.phase = "body";
            try { for await (const chunk of response.bytes) { statistics.receivedBodyBytes += chunk.length; ports.onReceivedBytes?.(chunk.length); yield chunk; } }
            catch (error) { observation.network = networkError(error); observation.transportCode = transportCode(error); throw error; }
          })() };
        } catch (error) {
          observation.network = networkError(error);
          observation.transportCode = transportCode(error);
          if (signal.aborted && !parentSignal?.aborted) {
            observation.timeoutKind = signal.reason?.name === "TimeoutError" ? "image" : "headers";
          }
          if (observation.network && preferred.get(url.hostname) === address.address) preferred.delete(url.hostname);
          throw error instanceof WorkerError ? error : new WorkerError("IMAGE_UNAVAILABLE");
        }
      } });
      try {
        const image = await download(input, parentSignal);
        if (reused) { statistics.revalidatedImages++; statistics.reusedBytes += image.bytes.length; }
        else {
          statistics.downloadedImages++;
          if (ports.cache && receipt && !image.transformed) {
            last.phase = "cache-write";
            await ports.cache.write({ ...receipt,
              sha256: createHash("sha256").update(image.bytes).digest("hex"), byteSize: image.bytes.length, mime: image.mime }, image, parentSignal);
          }
        }
        return image;
      }
      catch (error) {
        checkSignal(parentSignal);
        // The parent is still live. CANCELLED here is an internal image/header
        // deadline (including cache/DNS work), not cancellation of the run.
        const ownDeadline = error instanceof WorkerError && error.code === "CANCELLED";
        const denied = last.status !== undefined && last.status >= 400 && last.status < 500;
        const limited = [429, 529].includes(last.status ?? 0) && last.retryAfterMs !== undefined;
        const transient = !denied && (ownDeadline || last.network || [502, 503, 504].includes(last.status ?? 0));
        const boundedTransient = !denied && (ownDeadline || last.network || last.timeoutKind !== undefined || [500, 502, 503, 504].includes(last.status ?? 0));
        const retryable = error instanceof WorkerError && (boundedGet ?
          boundedTransient && ["IMAGE_UNAVAILABLE", "CANCELLED"].includes(error.code) :
          limited && error.code === "RATE_LIMITED" || transient && ["IMAGE_UNAVAILABLE", "CANCELLED"].includes(error.code));
        if (attempt === maxAttempts - 1 || !boundedGet && limited && last.retryAfterMs! > MAX_RATE_LIMIT_WAIT_MS || !retryable) {
          const detail: WebsiteImageFailure = { inputUrl: input, requestUrl: last.url, requestHost: last.host,
            attempt: attempt + 1, httpStatus: last.status,
            transportCode: last.transportCode, phase: last.phase ?? "validation-or-dns",
            elapsedMs: Math.max(0, now() - started), attemptElapsedMs: Math.max(0, now() - attemptStarted),
            attemptTimeoutMs: options.timeoutMs ?? 20_000,
            ...(ownDeadline || last.timeoutKind ? { timeoutKind: last.timeoutKind ?? "image" as const } : {}),
            ...(limited ? { retryAfterSeconds: last.retryAfterMs! / 1000 } : {}) };
          failure ??= detail;
          // The caller's cancellation was checked above. An image's own
          // bounded deadline cannot be reported as cancelling the whole run.
          const terminal = ownDeadline ? new WorkerError("IMAGE_UNAVAILABLE") : error;
          if (terminal && typeof terminal === "object") failures.set(terminal, detail);
          throw terminal;
        }
        ports.onRetry?.({ attempt: attempt + 1, networkFailure: last.network, httpStatus: last.status });
        try { await wait(!boundedGet && limited ? last.retryAfterMs! : attempt === 0 ? 2000 : 5000, parentSignal); }
        catch (error) {
          checkSignal(parentSignal);
          // A broken wait port is not evidence that the operator cancelled.
          throw error;
        }
        checkSignal(parentSignal);
      }
    }
    throw new WorkerError("IMAGE_UNAVAILABLE");
  };
  const downloadImage = async (input: string, parentSignal?: AbortSignal) => {
    checkSignal(parentSignal);
    // Reset between independent groups, not while concurrent pages are draining.
    if (activeDownloads === 0) failure = undefined;
    activeDownloads++;
    try { return await performDownload(input, parentSignal); }
    finally { activeDownloads--; }
  };
  // URLs may contain private identities or signed parameters. Only the private
  // runtime's failure sidecar consumes them; never add them to numeric metrics.
  return Object.assign(downloadImage, { statistics: () => ({ ...statistics }), failure: () => failure && structuredClone(failure), close: () => agent.destroy() });
}
