import { ContentServiceError } from "../../../contracts/repository.ts";
import { hasStorageRole, type StorageIdentity } from "./storage-role.ts";

export interface ReaderAuthOptions {
  storageUrl: string;
  apiKey: string;
  email?: string;
  password?: string;
  userId?: string;
  staticToken?: string;
  fetch?: typeof fetch;
  now?: () => number;
  identity?: StorageIdentity;
}

const refreshMarginSeconds = 60;
const maxResponseBytes = 64 * 1024;
const maxTokenBytes = 32 * 1024;
function misconfigured(): never {
  throw new ContentServiceError("MISCONFIGURED", "The server-side reader media authentication is not configured.");
}
function unavailable(): never {
  throw new ContentServiceError("CONTENT_UNAVAILABLE", "Reader media authentication is temporarily unavailable.");
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
  return value as Record<string, unknown>;
}

/** Server runtime only. Never persist or share the rotating refresh token returned by Auth. */
export function createStorageReaderToken(options: ReaderAuthOptions): string | (() => Promise<string>) {
  if (options.identity !== undefined && !["notion", "social"].includes(options.identity)) return misconfigured();
  const configured = [options.email, options.password, options.userId].map(value => value !== undefined && value !== "");
  if (!configured.some(Boolean)) return options.staticToken ?? "";
  let authUrl: string;
  const userId = options.userId?.toLowerCase();
  try {
    if (!configured.every(Boolean) || !options.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(options.email) ||
        options.email.length > 320 || !options.password || options.password.length > 4096 ||
        !userId || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(userId)) throw new Error();
    const storage = new URL(options.storageUrl);
    if (storage.protocol !== "https:" || storage.username || storage.password || storage.search || storage.hash ||
        storage.pathname.replace(/\/$/, "") !== "/storage/v1") throw new Error();
    const apiClaims = options.apiKey.startsWith("sb_publishable_") ? null : object(JSON.parse(Buffer.from(options.apiKey.split(".")[1] ?? "", "base64url").toString()));
    if (!options.apiKey || options.apiKey.startsWith("sb_secret_") || (apiClaims !== null && apiClaims.role !== "anon")) throw new Error();
    authUrl = `${storage.origin}/auth/v1`;
  } catch { return misconfigured(); }

  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  let cached: { token: string; expires: number } | undefined;
  let pending: Promise<string> | undefined;
  function verifyClaims(token: unknown): { token: string; expires: number } {
    if (typeof token !== "string" || token.length > maxTokenBytes || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw new Error();
    const parts = token.split(".");
    const header = object(JSON.parse(Buffer.from(parts[0], "base64url").toString()));
    const claims = object(JSON.parse(Buffer.from(parts[1], "base64url").toString()));
    const audience = claims.aud;
    if (!["HS256", "ES256", "RS256", "EdDSA"].includes(header.alg as string) || claims.iss !== authUrl ||
        !(audience === "authenticated" || (Array.isArray(audience) && audience.includes("authenticated"))) ||
        claims.sub !== userId || claims.role !== "authenticated" ||
        !hasStorageRole(object(claims.app_metadata), "reader", options.identity) ||
        typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp <= now() / 1000 + refreshMarginSeconds) throw new Error();
    return { token, expires: claims.exp };
  }

  async function authenticate(): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    let rejectAbort: () => void;
    const aborted = new Promise<never>((_, reject) => { rejectAbort = () => reject(new Error()); });
    controller.signal.addEventListener("abort", rejectAbort!, { once: true });
    async function json(path: string, init: RequestInit): Promise<Record<string, unknown>> {
      const response = await Promise.race([fetcher(`${authUrl}${path}`, {
        ...init, redirect: "error", cache: "no-store", signal: controller.signal,
      }), aborted]);
      if (!response.ok || response.redirected || !response.body) {
        void response.body?.cancel().catch(() => {});
        throw new Error();
      }
      const reader = response.body.getReader();
      try {
        const declared = response.headers.get("Content-Length");
        if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxResponseBytes)) throw new Error();
        const chunks: Uint8Array[] = [];
        let size = 0;
        while (true) {
          const { value, done } = await Promise.race([reader.read(), aborted]);
          if (done) break;
          size += value.length;
          if (size > maxResponseBytes) throw new Error();
          chunks.push(value);
        }
        return object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch { void reader.cancel().catch(() => {}); throw new Error(); }
      finally { reader.releaseLock(); }
    }
    try {
      const session = await json("/token?grant_type=password", { method: "POST",
        headers: { apikey: options.apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ email: options.email, password: options.password }),
      });
      if (typeof session.token_type !== "string" || session.token_type.toLowerCase() !== "bearer") throw new Error();
      const token = verifyClaims(session.access_token);
      // Decoded claims alone are insufficient: Auth validates the token and current user metadata.
      const user = await json("/user", { headers: { apikey: options.apiKey, Authorization: `Bearer ${token.token}` } });
      if (user.id !== userId || user.role !== "authenticated" || user.is_anonymous === true ||
          !hasStorageRole(object(user.app_metadata), "reader", options.identity)) throw new Error();
      cached = verifyClaims(token.token);
      return cached.token;
    } catch { cached = undefined; return unavailable(); }
    finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", rejectAbort!);
    }
  }
  // Independent password sessions allow concurrent server instances without refresh-token races.
  // The dedicated reader account must not have single-session-per-user enforcement enabled.
  return () => {
    if (cached && cached.expires > now() / 1000 + refreshMarginSeconds) return Promise.resolve(cached.token);
    return pending ??= authenticate().finally(() => { pending = undefined; });
  };
}
