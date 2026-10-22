import { createSupabaseStorage, type ObjectStorage } from "../database/storage.ts";
import { createStorageReaderToken } from "../database/reader-auth.ts";
import { configuredCosStorage, storageProvider } from "../database/cos-config.ts";
import { createCosHttpsFetch } from "../database/cos-https.ts";
import { createLocalMediaStorage } from "../database/local-storage.ts";

/** Explicit social profile; never constructs a Notion database runtime or borrows its credentials. */
export function socialStorageProfile(env: Readonly<Record<string, string | undefined>>) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith("SOCIAL_MEDIA_")).map(([key, value]) => [key.slice("SOCIAL_MEDIA_".length), value]));
}
export function createSocialStorage(env: Readonly<Record<string, string | undefined>>, role: "reader" | "writer", request?: typeof fetch): ObjectStorage {
  const profile = socialStorageProfile(env);
  if (storageProvider(profile) === "cos") {
    const prefix = `COS_${role.toUpperCase()}_`;
    const specific = ["SECRET_ID", "SECRET_KEY", "SECURITY_TOKEN", "CREDENTIALS_EXPIRES_AT"].some(key => profile[prefix + key] !== undefined);
    const selected = specific ? { ...profile, ...Object.fromEntries(["SECRET_ID", "SECRET_KEY", "SECURITY_TOKEN", "CREDENTIALS_EXPIRES_AT"]
      .map(key => ["COS_" + key, profile[prefix + key]])) } : profile;
    return configuredCosStorage(selected, role, { fetch: request });
  }
  if (profile.DATABASE_MEDIA_DIRECTORY) return createLocalMediaStorage(profile.DATABASE_MEDIA_DIRECTORY,
    (role === "reader" ? env.SOCIAL_READER_DATABASE_URL : env.SOCIAL_MEDIA_DATABASE_URL) ?? "", role);
  return createSupabaseStorage({ url: profile.STORAGE_URL ?? "", bucket: profile.STORAGE_BUCKET ?? "", apiKey: profile.STORAGE_API_KEY ?? "", role, identity: "social", fetch: request,
    token: role === "reader" ? createStorageReaderToken({ storageUrl: profile.STORAGE_URL ?? "", apiKey: profile.STORAGE_API_KEY ?? "",
      email: profile.STORAGE_READER_EMAIL, password: profile.STORAGE_READER_PASSWORD, userId: profile.STORAGE_READER_USER_ID,
      staticToken: profile.STORAGE_READ_TOKEN, identity: "social", fetch: request }) : profile.STORAGE_WRITE_TOKEN ?? "" });
}

/** Preserve the configured COS read transport when adding request cancellation. */
export function socialReaderTransport(env: Readonly<Record<string, string | undefined>>): typeof fetch {
  const profile = socialStorageProfile(env);
  if (storageProvider(profile) === "cos" && profile.COS_READ_TRANSPORT === "native-https") {
    const endpoint = profile.COS_READ_ENDPOINT === "accelerate" ? "accelerate" : profile.COS_REGION;
    return createCosHttpsFetch(`${profile.COS_BUCKET}.cos.${endpoint}.myqcloud.com`);
  }
  return fetch;
}
