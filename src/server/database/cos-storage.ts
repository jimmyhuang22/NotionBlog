import { createHash, createHmac } from "node:crypto";
import { ContentServiceError } from "../../../contracts/repository.ts";
import type { StoredMedia } from "../../../contracts/sync.ts";
import { TransientStorageReadError, verifyMediaBytes, type ObjectStorage } from "./storage.ts";
import { validateMedia } from "./validation.ts";

export interface CosCredentials {
  secretId: string; secretKey: string; securityToken?: string;
  /** Unix seconds; required for temporary credentials. */
  expiresAt?: number;
}
export interface CosReadFailure {
  stage: "request" | "status" | "body" | "verify";
  httpStatus?: number;
  networkCode?: string;
}
export interface CosStorageOptions {
  bucket: string; region: string; prefix: string; role: "reader" | "writer";
  /** Explicit reader opt-in; writer acceleration is independently selected. */
  readEndpoint?: "regional" | "accelerate";
  /** Object transfers only; the versioning control request always stays regional. */
  writeEndpoint?: "regional" | "accelerate";
  credentials: CosCredentials | (() => Promise<CosCredentials>);
  fetch?: typeof fetch; onControlBytes?: (bytes: number) => void;
  /** Sanitized operational facts only: never URLs, object keys, credentials or provider bodies. */
  onReadFailure?: (failure: CosReadFailure) => void;
}
export interface CosStorage extends ObjectStorage { verifyWritableTarget(): Promise<void> }
function unavailable(): never { throw new ContentServiceError("CONTENT_UNAVAILABLE", "Media is temporarily unavailable."); }
function misconfigured(): never { throw new ContentServiceError("MISCONFIGURED", "The restricted COS media storage is not configured."); }
const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
function credentialsValid(value: CosCredentials, end: number) {
  if (!value || typeof value.secretId !== "string" || typeof value.secretKey !== "string" ||
      !/^[A-Za-z0-9]{8,128}$/.test(value.secretId) || !/^[\x21-\x7e]{8,128}$/.test(value.secretKey) ||
      value.securityToken !== undefined && (typeof value.securityToken !== "string" || !/^[\x21-\x7e]{1,8192}$/.test(value.securityToken) || value.expiresAt === undefined) ||
      value.expiresAt !== undefined && (!Number.isSafeInteger(value.expiresAt) || value.expiresAt < end + 30)) misconfigured();
}
/** Fixed COS origin and dedicated namespace. No source URLs, redirects,
 * anonymous reads, overwrite, deletion, bucket configuration or implicit STS. */
export function createCosStorage(input: CosStorageOptions): CosStorage {
  const options = { ...input, credentials: typeof input.credentials === "function" ? input.credentials : { ...input.credentials } };
  if (!/^[a-z0-9][a-z0-9-]{0,49}-[0-9]{5,20}$/.test(options.bucket) ||
      !/^[a-z]{2}-[a-z0-9]+(?:-[a-z0-9]+){0,3}$/.test(options.region) ||
      !/^[a-z0-9][a-z0-9/_-]{0,119}$/.test(options.prefix) || options.prefix.includes("//") ||
      !["reader", "writer"].includes(options.role) ||
      (options.readEndpoint !== undefined && !["regional", "accelerate"].includes(options.readEndpoint)) ||
      (options.writeEndpoint !== undefined && !["regional", "accelerate"].includes(options.writeEndpoint))) misconfigured();
  if (typeof options.credentials !== "function") credentialsValid(options.credentials, Math.floor(Date.now() / 1000) + 120);
  const accelerated = options.role === "reader" ? options.readEndpoint === "accelerate" : options.writeEndpoint === "accelerate";
  const prefix = options.prefix.replace(/\/$/, "");
  const fetcher = options.fetch ?? fetch;
  async function request(method: "GET" | "PUT", path: string, query: string, extra: Record<string, string> = {}, body?: Uint8Array) {
    const host = `${options.bucket}.cos.${!query && accelerated ? "accelerate" : options.region}.myqcloud.com`;
    const credential = typeof options.credentials === "function" ? await options.credentials() : options.credentials;
    const end = Math.floor(Date.now() / 1000) + 120, time = `${end - 150};${end}`;
    credentialsValid(credential, end);
    const headers: Record<string, string> = { host, ...extra };
    if (credential.securityToken) headers["x-cos-security-token"] = credential.securityToken;
    const names = Object.keys(headers).sort(), headerString = names.map(k => `${encode(k)}=${encode(headers[k])}`).join("&");
    const httpString = `${method.toLowerCase()}\n${path}\n${query ? `${query}=` : ""}\n${headerString}\n`;
    const key = createHmac("sha1", credential.secretKey).update(time).digest("hex");
    const toSign = `sha1\n${time}\n${createHash("sha1").update(httpString).digest("hex")}\n`;
    headers.authorization = `q-sign-algorithm=sha1&q-ak=${credential.secretId}&q-sign-time=${time}&q-key-time=${time}&q-header-list=${names.join(";")}&q-url-param-list=${query}&q-signature=${createHmac("sha1", key).update(toSign).digest("hex")}`;
    return fetcher(`https://${host}${path}${query ? `?${query}` : ""}`, {
      method, headers, body: body === undefined ? undefined : Buffer.from(body), redirect: "error", cache: "no-store", signal: AbortSignal.timeout(20000),
    });
  }
  async function boundedBody(response: Response, maximum: number, control = false) {
    if (!response.body) unavailable();
    const declared = response.headers.get("Content-Length");
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
      await response.body.cancel().catch(() => {}); unavailable();
    }
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        if (control) options.onControlBytes?.(value.length);
        length += value.length; if (length > maximum) unavailable(); chunks.push(value);
      }
    } catch { await reader.cancel().catch(() => {}); return unavailable(); }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
  }
  let writableTarget: Promise<void> | undefined;
  async function verifyWritableTarget() {
    if (options.role !== "writer") unavailable();
    return writableTarget ??= (async () => {
      try {
        const response = await request("GET", "/", "versioning");
        if (response.status !== 200) { await response.body?.cancel().catch(() => {}); unavailable(); }
        const xml = Buffer.from(await boundedBody(response, 8192, true)).toString("utf8").replace(/^\uFEFF/, "").trim()
          .replace(/^<\?xml\s[^?]*\?>\s*/, "");
        // COS forbid-overwrite is ineffective for Enabled AND Suspended buckets.
        // Accept only the documented never-versioned response, not a caller flag.
        if (!/^<VersioningConfiguration(?:\s+xmlns="https?:\/\/[^"<>]+")?\s*(?:\/>|>\s*<\/VersioningConfiguration>)$/.test(xml)) unavailable();
      } catch { unavailable(); }
    })();
  }
  async function read(input: StoredMedia) {
    const media = { ...input };
    validateMedia(media);
    let stage: CosReadFailure["stage"] = "request", httpStatus: number | undefined;
    try {
      const response = await request("GET", `/${prefix}/${media.objectKey}`, "");
      httpStatus = response.status; stage = "status";
      if (response.status !== 200) { await response.body?.cancel().catch(() => {}); unavailable(); }
      stage = "body"; const bytes = await boundedBody(response, media.byteSize);
      stage = "verify"; verifyMediaBytes(media, bytes); return bytes;
    } catch (error) {
      const known = new Set(["UND_ERR_CONNECT_TIMEOUT", "ENOTFOUND", "EAI_AGAIN", "ECONNRESET", "ETIMEDOUT", "CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"]);
      const cause = error instanceof Error ? error.cause : undefined;
      const code = cause && typeof cause === "object" && "code" in cause ? cause.code : undefined;
      const networkCode = typeof code === "string" && known.has(code) ? code : error instanceof Error && error.name === "TimeoutError" ? "TIMEOUT" : undefined;
      try { options.onReadFailure?.({ stage, ...(httpStatus === undefined ? {} : { httpStatus }), ...(networkCode ? { networkCode } : {}) }); } catch { /* Diagnostics cannot change the public error. */ }
      if (stage === "request" && networkCode && ["UND_ERR_CONNECT_TIMEOUT", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "TIMEOUT"].includes(networkCode)) throw new TransientStorageReadError();
      return unavailable();
    }
  }
  return { read, verifyWritableTarget,
    async put(input, inputBytes) {
      if (options.role !== "writer") unavailable();
      const media = { ...input }, bytes = Buffer.from(inputBytes);
      validateMedia(media); verifyMediaBytes(media, bytes);
      try {
        await verifyWritableTarget();
        const response = await request("PUT", `/${prefix}/${media.objectKey}`, "", {
          "content-type": media.mime, "content-length": String(bytes.length),
          "content-md5": createHash("md5").update(bytes).digest("base64"), "x-cos-forbid-overwrite": "true",
        }, bytes);
        await response.body?.cancel().catch(() => {});
        if (response.status === 200) return;
        if (response.status === 409) { await read(media); return; }
        unavailable();
      } catch { unavailable(); }
    },
  };
}
