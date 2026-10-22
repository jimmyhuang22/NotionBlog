import { SocialSyncError } from "../social-sync/model.ts";
import { createSocialStorage } from "../../src/server/social/media-storage.ts";
import type { ObjectStorage } from "../../src/server/database/storage.ts";

/** The worker writes with its writer and proves objects through a distinct reader. */
export function createCosCoverSession(env: Readonly<Record<string, string | undefined>>, request: typeof fetch, readerRequest: typeof fetch = request): ObjectStorage {
  const writer = env.SOCIAL_MEDIA_COS_WRITER_SECRET_ID, reader = env.SOCIAL_MEDIA_COS_READER_SECRET_ID;
  if (env.SOCIAL_MEDIA_STORAGE_PROVIDER !== "cos" || !writer || !reader || writer === reader ||
      !env.SOCIAL_MEDIA_COS_WRITER_SECRET_KEY || !env.SOCIAL_MEDIA_COS_READER_SECRET_KEY)
    throw new SocialSyncError("COVER_COS_CONFIG_INVALID");
  const write = createSocialStorage(env, "writer", request), read = createSocialStorage(env, "reader", readerRequest);
  return { put: write.put, read: read.read };
}
