import { Agent, request } from "node:https";
import { Readable } from "node:stream";

/** Dedicated COS GET transport: one signed HTTP request, native DNS address
 * selection and bounded connection reuse. It never changes the signed host. */
export function createCosHttpsFetch(host: string): typeof fetch {
  if (!/^[a-z0-9][a-z0-9-]*-[0-9]+\.cos\.[a-z0-9-]+\.myqcloud\.com$/.test(host)) throw new Error("Invalid COS transport host.");
  const agent = new Agent({ keepAlive: true, maxSockets: 4, maxTotalSockets: 4, maxFreeSockets: 2, timeout: 5000,
    autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 250 });
  return async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.protocol !== "https:" || url.hostname !== host || url.port || url.username || url.password ||
        init?.method !== "GET" || init.body != null || init.redirect !== "error" || !init.signal) throw new Error("Invalid COS transport request.");
    const signal = init.signal;
    const headers = Object.fromEntries(new Headers(init.headers));
    if (headers.host !== host) throw new Error("Invalid COS transport signature host.");
    return new Promise<Response>((resolve, reject) => {
      const req = request(url, { method: "GET", headers, agent, signal }, response => {
        const resultHeaders = new Headers();
        for (const [key, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) value.forEach(v => resultHeaders.append(key, v));
          else if (value !== undefined) resultHeaders.set(key, value);
        }
        resolve(new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, { status: response.statusCode ?? 500, headers: resultHeaders }));
      });
      req.on("error", (error: NodeJS.ErrnoException) => {
        if (signal.aborted && signal.reason instanceof Error && signal.reason.name === "TimeoutError") reject(signal.reason);
        else reject(new Error("COS transport request failed.", { cause: { code: error.code } }));
      });
      req.end();
    });
  };
}
