import { ContentServiceError } from "../../../contracts/repository.ts";
import { databasePoolConfig, sqlExecutor } from "../database/connection.ts";
import { sharedContentReaderPool } from "../database/shared-reader-pool.ts";
import { createDirectDenyReader } from "../database/direct-notion-policy.ts";
import { withDirectPolicy } from "./direct-policy.ts";

export function directPolicyRuntime(version: 1 | 2, env: NodeJS.ProcessEnv) {
  if (env.DATABASE_TLS === "disable") throw new ContentServiceError("MISCONFIGURED", "Direct content requires verified policy TLS.");
  // Reject missing/unsafe configuration before constructing a Notion client or performing a read.
  databasePoolConfig(env.DATABASE_READER_URL, "verify", env.DATABASE_CA_CERT);
  const db = sqlExecutor(sharedContentReaderPool(env.DATABASE_READER_URL, "verify", env.DATABASE_CA_CERT));
  const factory = () => createDirectDenyReader(db, version);
  return { factory, run: <T>(read: () => Promise<T>) => withDirectPolicy(factory, read) };
}
