import { ContentServiceError } from "../../../contracts/repository.ts";
import type { ContentProvider } from "./factory.ts";

/** A production configuration omission must never silently select the demo. */
export function getContentProvider(env: NodeJS.ProcessEnv = process.env): ContentProvider {
  if (env.VERCEL_ENV === "production" && !env.CONTENT_PROVIDER) {
    throw new ContentServiceError("MISCONFIGURED", "Production content provider is required.");
  }
  const provider = env.CONTENT_PROVIDER ?? "mock";
  if (provider !== "mock" && provider !== "notion" && provider !== "database") {
    throw new ContentServiceError("MISCONFIGURED", "Unsupported content provider configuration.");
  }
  return provider;
}
