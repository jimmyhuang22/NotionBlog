import { lookup } from "node:dns/promises";
import { request as httpsRequest, type RequestOptions } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import { createImageDownloader, isPublicAddress, type Address, type DownloadedImage } from "../../../scripts/notion-sync/download.ts";
import { WorkerError, checkSignal } from "../../../scripts/notion-sync/errors.ts";
import { imageDimensions } from "../../../scripts/website-sync/image-dimensions.ts";
import { ContentServiceError } from "../../../contracts/repository.ts";
import sharp from "sharp";

export interface DirectImageTransport {
  resolve?(hostname: string): Promise<Address[]>;
  /** Trusted test transport only. Production always uses native HTTPS with the pinned IP. */
  request?(options: RequestOptions, callback: (response: IncomingMessage) => void): ClientRequest;
}

/** One address per hop, no pooled sockets, and observed request/socket closure before returning. */
export async function downloadDirectImage(url: string, signal: AbortSignal, ports: DirectImageTransport = {}): Promise<DownloadedImage> {
  const requests: ClientRequest[] = [], closed: Promise<void>[] = [];
  const native = ports.request ?? httpsRequest;
  const drain = async () => {
    for (const req of requests) if (!req.destroyed) req.destroy();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([Promise.all(closed), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new WorkerError("IMAGE_UNAVAILABLE")), 1000);
    })]); } finally { clearTimeout(timer); }
  };
  const resolve = ports.resolve ?? (hostname => lookup(hostname, { all: true, verbatim: true }));
  const download = createImageDownloader({ maxBytes: 20 * 1024 * 1024, timeoutMs: 8000, maxRedirects: 2, headerTimeoutMs: 5000,
    resolve: async hostname => {
      const addresses = await resolve(hostname);
      if (!addresses.length || addresses.length > 256 || addresses.some(value => !isPublicAddress(value.address))) throw new WorkerError("IMAGE_REJECTED");
      return addresses.slice(0, 1);
    },
    request: async (location, address, currentSignal, headers) => {
      await drain();checkSignal(currentSignal);
      return new Promise((resolveResponse, reject) => {
        let requestClosed = false, socketClosed = true;
        let finish!: () => void;
        closed.push(new Promise<void>(resolveClosed => { finish = () => { if (requestClosed && socketClosed) resolveClosed(); }; }));
        let req: ClientRequest;
        try {
          req = native({ protocol: "https:", hostname: address.address, family: address.family, port: 443,
            servername: location.hostname, path: location.pathname + location.search, method: "GET", agent: false,
            rejectUnauthorized: true, signal: currentSignal, headers: { ...headers, Connection: "close" } }, response => {
            const selected: Record<string, string | undefined> = {};
            for (const key of ["content-type","content-length","content-encoding","location"]) {
              const value = response.headers[key];selected[key] = Array.isArray(value) ? value.join(",") : value;
            }
            resolveResponse({ status: response.statusCode ?? 0, headers: selected, bytes: response, cancel: () => response.destroy() });
          });
        } catch { requestClosed = true;finish();reject(new WorkerError("IMAGE_UNAVAILABLE"));return; }
        requests.push(req);
        req.on("socket", socket => {
          socketClosed = socket.closed;
          socket.once("close", () => { socketClosed = true;finish(); });
        });
        req.once("close", () => { requestClosed = true;finish(); });
        req.on("error", () => reject(new WorkerError("IMAGE_UNAVAILABLE")));
        req.end();
      });
    },
  });
  try {
    checkSignal(signal);
    const result = await download(url, signal);
    checkSignal(signal);
    const dimensions = await imageDimensions(result.bytes);
    checkSignal(signal);
    if (dimensions.width === null || dimensions.height === null) throw new WorkerError("IMAGE_REJECTED");
    // Decode within the existing pixel ceiling, including animation frames; do not retain raw pixels.
    await sharp(Buffer.from(result.bytes), { animated: true, limitInputPixels: 100_000_000, failOn: "warning" }).stats();
    checkSignal(signal);
    return result;
  } catch (error) {
    if (error instanceof WorkerError && error.code === "RATE_LIMITED") throw new ContentServiceError("RATE_LIMITED", "The image source is busy.");
    throw new ContentServiceError("CONTENT_UNAVAILABLE", "The image source could not be read safely.");
  } finally {
    try { await drain(); } catch { throw new ContentServiceError("CONTENT_UNAVAILABLE", "The image connection did not close cleanly."); }
  }
}
