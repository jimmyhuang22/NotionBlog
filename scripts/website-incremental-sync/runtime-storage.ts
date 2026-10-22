import { createLocalMediaStorage } from "../../src/server/database/local-storage.ts";
import { createSupabaseStorage, type ObjectStorage } from "../../src/server/database/storage.ts";
import { openPrivateWriterStorageSession, WriterStorageSessionError } from "../website-sync/writer-storage-session.ts";
import { hostFail, IncrementalHostError, type HostBudget } from "./host-budget.ts";
import type { RegisterHostCleanup } from "./host-resources.ts";
import { configuredCosStorage, storageProvider } from "../../src/server/database/cos-config.ts";

const sessionKeys = ["SYNC_STORAGE_WRITER_ENV_FILE", "SYNC_STORAGE_REFRESH_MODULE", "SYNC_STORAGE_REFRESH_SHA256"] as const;

/** Called only inside a tracked source factory while its host holds the lock. */
export async function createRuntimeStorage(input: { env: Readonly<Record<string, string | undefined>>; budget: HostBudget;
  registerCleanup: RegisterHostCleanup; fetch?: typeof fetch }): Promise<ObjectStorage> {
  const env = { ...input.env }, { budget } = input;
  budget.guard();
  const selected = sessionKeys.filter(key => env[key] !== undefined).length;
  const provider = storageProvider(env);
  if (selected !== 0 && selected !== sessionKeys.length || env.DATABASE_MEDIA_DIRECTORY && selected) hostFail("HOST_STORAGE_SESSION_INPUT_INVALID");
  if (env.DATABASE_MEDIA_DIRECTORY) return createLocalMediaStorage(env.DATABASE_MEDIA_DIRECTORY, env.SYNC_DATABASE_URL!, "writer");
  if (provider === "cos") {
    if (selected) hostFail("HOST_STORAGE_SESSION_INPUT_INVALID");
    if (env.COS_CREDENTIALS_EXPIRES_AT && Number(env.COS_CREDENTIALS_EXPIRES_AT) * 1000 - Date.now() < budget.remainingMs() + 150000) {
      hostFail("HOST_STORAGE_SESSION_WINDOW_INVALID");
    }
    const fetcher = input.fetch ?? fetch;
    const boundedFetch: typeof fetch = (url, init) => {
      budget.guard();
      return fetcher(url, { ...init, signal: AbortSignal.any([budget.signal, ...(init?.signal ? [init.signal] : [])]) });
    };
    const storage = configuredCosStorage(env, "writer", { fetch: boundedFetch, onControlBytes: n => budget.observe("mediaBytes", n) });
    await storage.verifyWritableTarget(); budget.guard(); return storage;
  }
  let token: string | (() => Promise<string>) = env.STORAGE_WRITE_TOKEN ?? "";
  if (selected) {
    try {
      const session = await openPrivateWriterStorageSession({ expected: env, guard: budget.guard,
        credentialsPath: env.SYNC_STORAGE_WRITER_ENV_FILE!, refreshModulePath: env.SYNC_STORAGE_REFRESH_MODULE!,
        refreshModuleSha256: env.SYNC_STORAGE_REFRESH_SHA256! });
      // Register before preflight, including if the host is already draining a late factory.
      input.registerCleanup(session.close); budget.guard();
      await session.token(); budget.guard(); token = session.token;
    } catch (error) {
      if (error instanceof IncrementalHostError) throw error;
      if (error instanceof WriterStorageSessionError) hostFail(error.code);
      hostFail("HOST_STORAGE_SESSION_UNAVAILABLE");
    }
  } else {
    // A fixed token cannot renew. Reject an insufficient window before any source work.
    let exp: unknown;
    try { exp = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()).exp; } catch { /* Invalid below. */ }
    if (typeof exp !== "number" || !Number.isFinite(exp) || exp * 1000 - Date.now() < budget.remainingMs() + 120000) hostFail("HOST_STORAGE_SESSION_WINDOW_INVALID");
  }
  const fetcher = input.fetch ?? fetch;
  const boundedFetch: typeof fetch = (url, init) => {
    budget.guard();
    return fetcher(url, { ...init, signal: AbortSignal.any([budget.signal, ...(init?.signal ? [init.signal] : [])]) });
  };
  return createSupabaseStorage({ url: env.STORAGE_URL ?? "", bucket: env.STORAGE_BUCKET ?? "", apiKey: env.STORAGE_API_KEY ?? "",
    token, role: "writer", fetch: boundedFetch });
}
