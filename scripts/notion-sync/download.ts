import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpsRequest, Agent } from "node:https";
import { WorkerError, checkSignal } from "./errors.ts";
import type { StoredMedia } from "../../contracts/sync.ts";

export interface Address { address: string; family: number }
export interface ImageResponse {
  status: number;
  headers: Record<string, string | undefined>;
  bytes: AsyncIterable<Uint8Array>;
  cancel(): void;
}
export interface DownloadOptions {
  /** Identify the sync bot; operators can include a public contact URL. */
  userAgent?: string;
  /** HEIC is converted only by an explicitly configured bounded local decoder. */
  convertHeic?: (bytes: Uint8Array, signal: AbortSignal) => Promise<Uint8Array>;
  resolve?: (hostname: string) => Promise<Address[]>;
  request?: (url: URL, address: Address, signal: AbortSignal, headers: Readonly<Record<string, string>>) => Promise<ImageResponse>;
  maxBytes?: number;
  timeoutMs?: number;
  /** Response-header deadline per checked address, within the total image budget. */
  headerTimeoutMs?: number;
  maxRedirects?: number;
  /** Optional operator restriction, exact hosts only; IP checks still apply. */
  allowedHosts?: string[];
}
export interface DownloadedImage {
  bytes: Uint8Array; mime: StoredMedia["mime"];
  /** The browser must use the stored derivative, rather than the original URL. */
  transformed?: true;
}

/** Conservative global-unicast policy, including literal and mapped addresses. */
export function isPublicAddress(input: string): boolean {
  if (isIP(input) === 4) {
    const [a, b, c] = input.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113));
  }
  if (isIP(input) !== 6 || input.includes("%") || input.includes(".")) return false;
  let canonical: string;
  try { canonical = new URL(`https://[${input}]/`).hostname.slice(1, -1); } catch { return false; }
  const [head, tail] = canonical.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = tail === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  const [a, b] = groups.map(x => Number.parseInt(x, 16));
  // Exclude transition/tunnel, benchmarking, protocol assignments and documentation.
  return groups.length === 8 && (a & 0xe000) === 0x2000 && a !== 0x2002 &&
    !(a === 0x2001 && (b < 0x0200 || b === 0x0db8)) &&
    !(a === 0x3fff && b < 0x1000);
}

export function imageMime(bytes: Uint8Array): StoredMedia["mime"] | null {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return "image/jpeg";
  if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (["GIF87a", "GIF89a"].includes(b.subarray(0, 6).toString())) return "image/gif";
  if (b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP") return "image/webp";
  if (b.subarray(4, 8).toString() === "ftyp" && ["avif", "avis"].includes(b.subarray(8, 12).toString())) return "image/avif";
  return null;
}

/** HEVC still-image brands in a bounded ISO-BMFF ftyp box; sequences are not accepted. */
export function isHeic(bytes: Uint8Array): boolean {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length < 20 || b.subarray(4, 8).toString() !== "ftyp") return false;
  const size = b.readUInt32BE(0);
  if (size < 20 || size > Math.min(b.length, 4096) || size % 4 !== 0) return false;
  const brands = [b.subarray(8, 12).toString()];
  for (let offset = 16; offset < size; offset += 4) brands.push(b.subarray(offset, offset + 4).toString());
  return !brands.some(brand => ["hevc", "hevx", "msf1", "avis"].includes(brand)) &&
    brands.some(brand => ["heic", "heix"].includes(brand));
}

/** Connect directly to the checked IP. TLS SNI/certificate and Host retain the URL hostname. */
function pinnedRequest(url: URL, address: Address, signal: AbortSignal, agent: Agent, headers: Readonly<Record<string, string>>): Promise<ImageResponse> {
  return new Promise((resolve, reject) => {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const req = httpsRequest({
      protocol: "https:", hostname: address.address, family: address.family, port: 443,
      servername: isIP(host) ? undefined : host, path: url.pathname + url.search,
      method: "GET", headers,
      agent, signal, rejectUnauthorized: true,
    }, response => {
      const headers: Record<string, string | undefined> = {};
      for (const [key, value] of Object.entries(response.headers)) {
        headers[key] = Array.isArray(value) ? value.join(",") : value;
      }
      resolve({ status: response.statusCode ?? 0, headers, bytes: response, cancel: () => { if (!response.complete || !response.readableEnded) response.destroy(); } });
    });
    req.on("error", () => reject(new WorkerError("IMAGE_UNAVAILABLE")));
    req.end();
  });
}

/** Abort DNS waiting too. Late results are ignored and can never start a socket. */
async function resolving<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  checkSignal(signal);
  return new Promise((resolve, reject) => {
    const abort = () => reject(new WorkerError("CANCELLED"));
    signal.addEventListener("abort", abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export function createImageDownloader(options: DownloadOptions = {}) {
  const userAgent = options.userAgent ?? "NotionBlogSyncBot/1.0";
  if (typeof userAgent !== "string" || userAgent.length < 1 || userAgent.length > 512 ||
      userAgent.trim() !== userAgent || /[^\x20-\x7e]/u.test(userAgent)) throw new WorkerError("MISCONFIGURED");
  const maxBytes = options.maxBytes ?? 20 * 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const maxRedirects = options.maxRedirects ?? 3;
  const headerTimeoutMs = options.headerTimeoutMs ?? Math.min(5000, timeoutMs);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 20 * 1024 * 1024 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000 ||
      !Number.isSafeInteger(headerTimeoutMs) || headerTimeoutMs < 1 || headerTimeoutMs > timeoutMs ||
      !Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 5) throw new WorkerError("MISCONFIGURED");
  const resolver = options.resolve ?? (hostname => lookup(hostname, { all: true, verbatim: true }));
  // Pool keys include the checked destination IP AND TLS servername. Current
  // DNS answers are still revalidated before every request, including reuse.
  const agent = options.request ? undefined : new Agent({ keepAlive: true, maxSockets: 1,
    maxFreeSockets: 1, maxTotalSockets: 4, timeout: 5000 });
  const requester = options.request ?? ((url, address, signal, headers) => pinnedRequest(url, address, signal, agent!, headers));
  const allowed = options.allowedHosts?.map(host => host.toLowerCase());
  return async (input: string, externalSignal?: AbortSignal): Promise<DownloadedImage> => {
    const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(externalSignal ? [externalSignal] : [])]);
    let response: ImageResponse | undefined;
    try {
      let location = input;
      for (let hop = 0; hop <= maxRedirects; hop++) {
        checkSignal(signal);
        if (/[\u0000-\u0020\u007f\\]/u.test(location)) throw new WorkerError("IMAGE_REJECTED");
        let url: URL;
        try { url = new URL(location); } catch { throw new WorkerError("IMAGE_REJECTED"); }
        const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
        if (url.protocol !== "https:" || url.username || url.password || url.hash ||
            (url.port && url.port !== "443") || !host || host.endsWith(".") ||
            (allowed && !allowed.includes(host))) throw new WorkerError("IMAGE_REJECTED");
        const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolving(resolver(host), signal);
        checkSignal(signal);
        if (!addresses.length || addresses.some(a => !isPublicAddress(a.address) || a.family !== isIP(a.address))) {
          throw new WorkerError("IMAGE_REJECTED");
        }
        // Try at most two already validated addresses when no headers arrive.
        // HTTP denials, rate limits and body errors never trigger another request.
        for (const address of addresses.slice(0, 2)) {
          checkSignal(signal);
          const attempt = new AbortController();
          const timer = setTimeout(() => attempt.abort(), headerTimeoutMs);
          try {
            response = await requester(url, address, AbortSignal.any([signal, attempt.signal]), Object.freeze({
              Host: url.host, Accept: "image/jpeg,image/png,image/webp,image/gif,image/avif,image/heic,image/heif",
              "Accept-Encoding": "identity", "User-Agent": userAgent,
            }));
            break;
          } catch (error) {
            checkSignal(signal);
            if (!(error instanceof WorkerError) || error.code !== "IMAGE_UNAVAILABLE") throw error;
          } finally { clearTimeout(timer); }
        }
        if (!response) throw new WorkerError("IMAGE_UNAVAILABLE");
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const next = response.headers.location;
          response.cancel(); response = undefined;
          if (!next || hop === maxRedirects) throw new WorkerError("IMAGE_REJECTED");
          try { location = new URL(next, url).href; } catch { throw new WorkerError("IMAGE_REJECTED"); }
          continue;
        }
        if (response.status === 429 || response.status === 529) throw new WorkerError("RATE_LIMITED");
        if (response.status !== 200) throw new WorkerError("IMAGE_UNAVAILABLE");
        const mime = response.headers["content-type"]?.split(";")[0].trim().toLowerCase();
        const heic = mime === "image/heic" || mime === "image/heif";
        if ((!heic && !["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"].includes(mime ?? "")) ||
            (heic && !options.convertHeic) ||
            (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity")) throw new WorkerError("IMAGE_REJECTED");
        const declared = response.headers["content-length"];
        if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) throw new WorkerError("IMAGE_REJECTED");
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of response.bytes) {
          checkSignal(signal); size += chunk.length;
          if (size > maxBytes) throw new WorkerError("IMAGE_REJECTED");
          chunks.push(Buffer.from(chunk));
        }
        checkSignal(signal);
        const bytes = Buffer.concat(chunks, size);
        if (!size || (declared !== undefined && Number(declared) !== size)) throw new WorkerError("IMAGE_UNAVAILABLE");
        const actualHeic = isHeic(bytes);
        if (heic || actualHeic) {
          if (!actualHeic || !options.convertHeic) throw new WorkerError("IMAGE_REJECTED");
          const converted = await options.convertHeic!(bytes, signal);
          checkSignal(signal);
          if (!converted.length || converted.length > maxBytes || imageMime(converted) !== "image/jpeg") throw new WorkerError("IMAGE_REJECTED");
          return { bytes: converted, mime: "image/jpeg", transformed: true };
        }
        const actualMime = imageMime(bytes);
        // Some image hosts label JPEG bytes as PNG (and vice versa). Normalize
        // only this pair of still raster formats; never trust the header alone.
        const stillRaster = (value: string | null | undefined) => value === "image/jpeg" || value === "image/png";
        if (!actualMime || (actualMime !== mime && !(stillRaster(actualMime) && stillRaster(mime)))) throw new WorkerError("IMAGE_REJECTED");
        return { bytes, mime: actualMime };
      }
      throw new WorkerError("IMAGE_REJECTED");
    } catch (error) {
      if (error instanceof WorkerError) throw error;
      throw new WorkerError(signal.aborted ? "CANCELLED" : "IMAGE_UNAVAILABLE");
    } finally { response?.cancel(); }
  };
}
