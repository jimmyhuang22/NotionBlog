import { createHash } from "node:crypto";
import { dirname, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { privateDirectory, readPrivateFile } from "../notion-sync/state.ts";

type Environment = Readonly<Record<string, string | undefined>>;
const bindings = ["SYNC_DATABASE_URL", "DATABASE_CA_CERT", "STORAGE_URL", "STORAGE_BUCKET", "STORAGE_API_KEY", "STORAGE_WRITER_USER_ID"] as const;
const minimumValidityMs = 120000;

export class WriterStorageSessionError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = "WriterStorageSessionError"; this.code = code; }
}
function fail(code: string): never { throw new WriterStorageSessionError(code); }

export interface WriterStorageSessionOptions {
  /** The same inputs used to construct SQL and ObjectStorage; never process.env implicitly. */
  expected: Environment;
  read: () => Promise<Environment>;
  /** Must persist rotated credentials before returning and validate the user with Auth. */
  refresh: () => Promise<{ serverValidated?: boolean }>;
  /** Caller holds the canonical writer lock and checks its cooperative deadline here. */
  guard: () => void;
  now?: () => number;
}

/** A token getter for StorageOptions. It does not acquire a publisher lock or run on a timer. */
export function createWriterStorageSession(options: WriterStorageSessionOptions) {
  const expected = { ...options.expected }, now = options.now ?? Date.now;
  let origin: string;
  try {
    const url = new URL(expected.STORAGE_URL ?? "");
    const key = expected.STORAGE_API_KEY ?? "";
    let publicKey = key.startsWith("sb_publishable_");
    if (!publicKey && key && !key.startsWith("sb_secret_")) {
      const parts = key.split(".");
      const claims = parts.length === 3 && parts.every(Boolean) ? JSON.parse(Buffer.from(parts[1], "base64url").toString()) : null;
      publicKey = claims?.role === "anon" && url.hostname.endsWith(".supabase.co") &&
        claims.ref === url.hostname.slice(0, -".supabase.co".length);
    }
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      url.pathname.replace(/\/$/, "") !== "/storage/v1" || !expected.SYNC_DATABASE_URL ||
      !expected.STORAGE_BUCKET || !publicKey || !expected.STORAGE_WRITER_USER_ID) throw new Error();
    origin = url.origin;
  } catch { fail("STORAGE_SESSION_INPUT_INVALID"); }
  let pending: Promise<string> | undefined, closed = false, failure: WriterStorageSessionError | undefined, refreshes = 0;
  function guard() {
    if (closed) fail("STORAGE_SESSION_CLOSED");
    options.guard();
    if (failure) throw failure;
  }
  function checkBindings(env: Environment) {
    if (bindings.some(key => env[key] !== expected[key])) fail("STORAGE_SESSION_BINDING_CHANGED");
  }
  function usableToken(env: Environment): string | null {
    const token = env.STORAGE_WRITE_TOKEN;
    if (typeof token !== "string" || token.length > 65536) return null;
    try {
      const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString());
      if (claims.sub !== expected.STORAGE_WRITER_USER_ID || claims.iss !== `${origin}/auth/v1` ||
        claims.role !== "authenticated" || claims.app_metadata?.notionblog_storage_role !== "writer") fail("STORAGE_SESSION_IDENTITY_INVALID");
      if (!Number.isFinite(claims.exp) || claims.exp * 1000 - now() < minimumValidityMs) return null;
      return token;
    } catch (error) {
      if (error instanceof WriterStorageSessionError) throw error;
      return null;
    }
  }
  async function load(): Promise<string> {
    guard();
    const current = await options.read(); guard(); checkBindings(current);
    const token = usableToken(current);
    if (token) return token;
    // Do not race cancellation against refresh: rotated credentials must finish persisting.
    guard();
    let result;
    try { result = await options.refresh(); }
    catch { fail("STORAGE_SESSION_REFRESH_FAILED"); }
    if (result?.serverValidated !== true) fail("STORAGE_SESSION_REFRESH_UNVERIFIED");
    refreshes++;
    guard();
    const next = await options.read(); guard(); checkBindings(next);
    const refreshed = usableToken(next);
    if (!refreshed) fail("STORAGE_SESSION_WINDOW_INVALID");
    return refreshed;
  }
  return {
    async token(): Promise<string> {
      guard();
      // Also coalesce the read/check phase, so simultaneous requests cannot start a second refresh.
      pending ??= load().catch(error => {
        failure = error instanceof WriterStorageSessionError ? error : new WriterStorageSessionError("STORAGE_SESSION_UNAVAILABLE");
        throw failure;
      }).finally(() => { pending = undefined; });
      const token = await pending; guard(); return token;
    },
    /** Must be awaited before releasing the canonical lock, including after cancellation. */
    async close(): Promise<void> { closed = true; await pending?.catch(() => {}); },
    statistics: () => ({ refreshes, closed }),
  };
}

/** Reuses the operator's existing restricted, hash-approved Auth refresh helper. */
export async function openPrivateWriterStorageSession(options: {
  credentialsPath: string;
  refreshModulePath: string;
  refreshModuleSha256: string;
  expected: Environment;
  guard: () => void;
}) {
  options = { ...options, expected: { ...options.expected } };
  options.guard();
  if (![options.credentialsPath, options.refreshModulePath].every(isAbsolute) ||
    dirname(options.credentialsPath) !== dirname(options.refreshModulePath) || !/^[a-f\d]{64}$/.test(options.refreshModuleSha256)) fail("STORAGE_SESSION_INPUT_INVALID");
  await privateDirectory(dirname(options.credentialsPath)); options.guard();
  const read = async () => parseEnv(await readPrivateFile(options.credentialsPath, 1024 * 1024));
  // Reject an incorrect environment before a token getter can reach Auth.
  const initial = await read(); options.guard();
  if (bindings.some(key => initial[key] !== options.expected[key])) fail("STORAGE_SESSION_BINDING_CHANGED");
  return createWriterStorageSession({ expected: options.expected, read, guard: options.guard, refresh: async () => {
    options.guard();
    const source = await readPrivateFile(options.refreshModulePath, 1024 * 1024); options.guard();
    if (createHash("sha256").update(source).digest("hex") !== options.refreshModuleSha256) fail("STORAGE_SESSION_REFRESH_UNVERIFIED");
    const moduleUrl = pathToFileURL(options.refreshModulePath);
    moduleUrl.searchParams.set("sha256", options.refreshModuleSha256);
    const helper = await import(moduleUrl.href); options.guard();
    if (typeof helper.refreshWriterSession !== "function") fail("STORAGE_SESSION_REFRESH_UNVERIFIED");
    return helper.refreshWriterSession(options.credentialsPath);
  } });
}
