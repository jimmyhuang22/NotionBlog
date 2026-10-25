import { isSelfHostedRuntime } from "../../../scripts/self-hosted/context.cjs";
import { ContentServiceError } from "../../../contracts/repository.ts";
import { createDisplayStore, type DisplayStore } from "./files.ts";

/** Only the dedicated preload can opt into filesystem delivery. */
export function selfHostedDisplayStore(env: Record<string, string | undefined> = process.env): DisplayStore | undefined {
  if (!isSelfHostedRuntime()) return undefined;
  if (env.SELF_HOSTED_MEDIA_MODE === undefined || env.SELF_HOSTED_MEDIA_MODE === "disabled") return undefined;
  if (env.SELF_HOSTED_MEDIA_MODE !== "display-only" || !env.SELF_HOSTED_MEDIA_ROOT || env.CONTENT_PROVIDER !== "database" ||
      env.DATABASE_CONTENT_VERSION !== "2" || env.DATABASE_PUBLICATION_MODE !== "qualified" || env.SOCIAL_PROVIDER !== "disabled")
    throw new ContentServiceError("MISCONFIGURED", "The self-hosted display mode is not configured.");
  return createDisplayStore(env.SELF_HOSTED_MEDIA_ROOT);
}
