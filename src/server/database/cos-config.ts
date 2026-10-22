import { ContentServiceError } from "../../../contracts/repository.ts";
import { createCosStorage, type CosStorage, type CosReadFailure } from "./cos-storage.ts";
import { createCosHttpsFetch } from "./cos-https.ts";

type Environment = Readonly<Record<string, string | undefined>>;
/** Absence preserves Supabase. Unknown providers never silently fall back. */
export function storageProvider(env: Environment): "supabase" | "cos" {
  if (env.STORAGE_PROVIDER === undefined || env.STORAGE_PROVIDER === "supabase") return "supabase";
  if (env.STORAGE_PROVIDER === "cos" && !env.DATABASE_MEDIA_DIRECTORY) return "cos";
  throw new ContentServiceError("MISCONFIGURED", "The independent media provider is not configured.");
}
/** Qualified v2 variants may live separately from converted originals. */
export function thumbnailStorageProvider(env: Environment): "supabase" | "cos" {
  return storageProvider({ ...env, STORAGE_PROVIDER: env.THUMBNAIL_STORAGE_PROVIDER ?? env.STORAGE_PROVIDER });
}
export function configuredCosStorage(env: Environment, role: "reader" | "writer", transport: {
  fetch?: typeof fetch; onControlBytes?: (bytes: number) => void; onReadFailure?: (failure: CosReadFailure) => void;
} = {}): CosStorage {
  const expiry = env.COS_CREDENTIALS_EXPIRES_AT || undefined;
  if (env.COS_READ_TRANSPORT !== undefined && !["fetch", "native-https"].includes(env.COS_READ_TRANSPORT)) {
    throw new ContentServiceError("MISCONFIGURED", "The COS read transport is not configured.");
  }
  if ((env.COS_READ_ENDPOINT !== undefined && !["regional", "accelerate"].includes(env.COS_READ_ENDPOINT)) ||
      (env.COS_WRITE_ENDPOINT !== undefined && !["regional", "accelerate"].includes(env.COS_WRITE_ENDPOINT))) {
    throw new ContentServiceError("MISCONFIGURED", "The COS read endpoint is not configured.");
  }
  if (expiry !== undefined && !/^[1-9][0-9]{0,11}$/.test(expiry)) {
    throw new ContentServiceError("MISCONFIGURED", "The restricted COS media storage is not configured.");
  }
  const readEndpoint = env.COS_READ_ENDPOINT === "accelerate" ? "accelerate" : "regional";
  const nativeFetch = role === "reader" && env.COS_READ_TRANSPORT === "native-https" && !transport.fetch
    ? createCosHttpsFetch(`${env.COS_BUCKET}.cos.${readEndpoint === "accelerate" ? "accelerate" : env.COS_REGION}.myqcloud.com`) : undefined;
  return createCosStorage({ bucket: env.COS_BUCKET ?? "", region: env.COS_REGION ?? "", prefix: env.COS_PREFIX ?? "", role,
    readEndpoint, writeEndpoint: env.COS_WRITE_ENDPOINT === "accelerate" ? "accelerate" : "regional",
    credentials: { secretId: env.COS_SECRET_ID ?? "", secretKey: env.COS_SECRET_KEY ?? "",
      securityToken: env.COS_SECURITY_TOKEN || undefined, expiresAt: expiry === undefined ? undefined : Number(expiry) },
    ...(nativeFetch ? {fetch:nativeFetch} : {}), ...transport });
}
